/**
 * Persist detected identifiers, resolve them to a financial account, and
 * expose the helpers that ingest-worker and the dashboard endpoints share.
 *
 * Two public entry points:
 *
 *   - `persistDetectedIdentifiers(db, txId, identifiers)` writes rows via
 *     `INSERT OR IGNORE` on the UNIQUE(tx, type, value) index — idempotent
 *     on re-ingest.
 *
 *   - `resolveDetectedIdentifiers(db, identifiers)` runs the same UNION
 *     logic as `resolveAccountByHint` but across both the
 *     `financial_account_identifiers.value` set and the canonical columns
 *     on `financial_accounts` (account_hint, card_last_four,
 *     account_last_four, iban). Returns OK / NOT_FOUND / AMBIGUOUS plus
 *     the set of detected-identifier values that drove the verdict.
 *
 * `assignAccountForTx` is the atomic write that:
 *   1. Updates `transaction_candidates.financial_account_id` if currently
 *      NULL (never overwrites a different non-NULL id — caller decides).
 *   2. Optionally records the identifier on the assigned account.
 *   3. Returns the list of affected transaction ids so the caller can
 *      re-run matching.
 */

import type { D1Database, IdentifierType } from '@shikoo/database';
import { SQL } from '@shikoo/database';

export interface DetectedIdentifierInput {
  type: IdentifierType;
  normalizedValue: string;
  maskedValue: string;
  confidence: number;
  parserId: string;
}

/**
 * Write one row per detected identifier. Skips duplicates via
 * INSERT OR IGNORE on the UNIQUE(tx, type, value) index.
 */
export async function persistDetectedIdentifiers(
  db: D1Database,
  txId: string,
  ids: DetectedIdentifierInput[],
  createdAt: number,
): Promise<void> {
  if (ids.length === 0) return;
  const stmts = ids.map((id) =>
    db
      .prepare(SQL.insertDetectedIdentifier)
      .bind(
        crypto.randomUUID(),
        txId,
        id.type,
        id.normalizedValue,
        id.maskedValue,
        id.parserId,
        id.confidence,
        createdAt,
      ),
  );
  await db.batch(stmts);
}

export type ResolveIdentifiersResult =
  | { status: 'OK'; accountId: string }
  | { status: 'NOT_FOUND' }
  | {
      status: 'ACCOUNT_IDENTIFIER_AMBIGUOUS';
      matches: Array<{ accountId: string; matchedIdentifier: DetectedIdentifierInput }>;
    };

const RESOLVE_SQL = `
  WITH input_matches AS (
    SELECT lower(?1) AS input_kind, ?2 AS normalized_value
    UNION ALL SELECT lower(?3), ?4
    UNION ALL SELECT lower(?5), ?6
    UNION ALL SELECT lower(?7), ?8
    UNION ALL SELECT lower(?9), ?10
  ),
  fa_hits AS (
    -- ACcount_NUMBER is the most common input type emitted by parsers;
    -- it lives on financial_accounts.account_hint. Also accept
    -- ACCOUNT_HINT (a synonym emitted by some legacy parsers).
    SELECT fa.id AS account_id, 'ACCOUNT_HINT' AS matched_kind
      FROM financial_accounts fa
      JOIN input_matches m ON m.input_kind IN ('account_number', 'account_hint')
                          AND fa.account_hint = m.normalized_value
                          AND fa.active = 1 AND fa.status = 'ACTIVE'
    UNION ALL
    SELECT fa.id, 'CARD_LAST_FOUR'
      FROM financial_accounts fa
      JOIN input_matches m ON m.input_kind = 'card_last_four'
                          AND fa.card_last_four = m.normalized_value
                          AND fa.active = 1 AND fa.status = 'ACTIVE'
    UNION ALL
    SELECT fa.id, 'ACCOUNT_LAST_FOUR'
      FROM financial_accounts fa
      JOIN input_matches m ON m.input_kind = 'account_last_four'
                          AND fa.account_last_four = m.normalized_value
                          AND fa.active = 1 AND fa.status = 'ACTIVE'
    UNION ALL
    SELECT fa.id, 'IBAN'
      FROM financial_accounts fa
      JOIN input_matches m ON m.input_kind = 'iban'
                          AND fa.iban = m.normalized_value
                          AND fa.active = 1 AND fa.status = 'ACTIVE'
    UNION ALL
    -- financial_account_identifiers stores ACCOUNT_HINT for the
    -- account-number kind. Match the input via the fai table when the
    -- canonical column is empty. JOIN financial_accounts to enforce
    -- status = 'ACTIVE' on the target account (PENDING / MUTED /
    -- DECLINED accounts are excluded from automatic resolution).
    SELECT fai.financial_account_id AS account_id, fai.kind AS matched_kind
      FROM financial_account_identifiers fai
      JOIN financial_accounts fa ON fa.id = fai.financial_account_id
      JOIN input_matches m
        ON ((m.input_kind = 'account_number' AND lower(fai.kind) = 'account_hint')
            OR lower(fai.kind) = m.input_kind)
       AND fai.value = m.normalized_value
       AND fa.status = 'ACTIVE'
  )
  SELECT account_id, matched_kind FROM fa_hits
`;

/**
 * Resolve every detected identifier against the active financial_account
 * universe. If all *unique* matches collapse to a single account_id,
 * return OK; if more than one distinct account_id matches, return
 * AMBIGUOUS with the per-account matches for the caller.
 *
 * Ponytail: ≤ 5 detected identifiers per call → a single bounded UNION ALL
 * with `?1..?10` parameters. The alternative (dynamic IN list per
 * identifier type) is more expensive and adds no value here.
 */
export async function resolveDetectedIdentifiers(
  db: D1Database,
  ids: DetectedIdentifierInput[],
): Promise<ResolveIdentifiersResult> {
  if (ids.length === 0) return { status: 'NOT_FOUND' };
  // Pad to 5 entries; missing entries get a unique placeholder kind that
  // cannot match any row.
  const slots: Array<[string, string]> = [];
  for (let i = 0; i < 5; i++) {
    const v = ids[i];
    slots.push(v ? [v.type, v.normalizedValue] : ['__none__', `__${i}__`]);
  }
  const rows = await db
    .prepare(RESOLVE_SQL)
    .bind(...slots.flat())
    .all<{ account_id: string; matched_kind: string }>();
  const byAccount = new Map<string, Set<string>>();
  for (const r of rows.results) {
    if (!byAccount.has(r.account_id)) byAccount.set(r.account_id, new Set());
    byAccount.get(r.account_id)!.add(r.matched_kind);
  }
  if (byAccount.size === 0) return { status: 'NOT_FOUND' };
  if (byAccount.size === 1) {
    const [accountId] = byAccount.keys();
    return { status: 'OK', accountId: accountId! };
  }
  // Multiple distinct accounts matched — return the per-account identifier
  // that drove the match (best effort: first input that produced a hit).
  const matches: Array<{ accountId: string; matchedIdentifier: DetectedIdentifierInput }> = [];
  for (const [accountId, kinds] of byAccount) {
    const ident = ids.find((i) => kinds.has(i.type.toUpperCase())) ?? ids[0]!;
    matches.push({ accountId, matchedIdentifier: ident });
  }
  return { status: 'ACCOUNT_IDENTIFIER_AMBIGUOUS', matches };
}

/**
 * Count unassigned transactions whose detected identifier matches
 * (type, normalizedValue). Used by the dashboard "Assign historical"
 * preview.
 */
export async function countUnassignedForIdentifier(
  db: D1Database,
  type: IdentifierType,
  normalizedValue: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM transaction_detected_identifiers tdi
              JOIN transaction_candidates tc ON tc.id = tdi.transaction_candidate_id
              WHERE tdi.identifier_type = ?1 AND tdi.normalized_value = ?2
                AND tc.financial_account_id IS NULL
                AND ${SQL.actionableTransactionWhereTc}`,
    )
    .bind(type, normalizedValue)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export interface ListBackfillTarget {
  txId: string;
  identifierType: IdentifierType;
  normalizedValue: string;
}

/**
 * Same query but returns the ids (capped at 5000 per the index plan) so the
 * caller can apply the assignment atomically.
 */
export async function listUnassignedForIdentifier(
  db: D1Database,
  type: IdentifierType,
  normalizedValue: string,
  limit = 5000,
): Promise<ListBackfillTarget[]> {
  const rows = await db
    .prepare(
      `SELECT tdi.transaction_candidate_id AS tx_id, tdi.identifier_type, tdi.normalized_value
         FROM transaction_detected_identifiers tdi
         JOIN transaction_candidates tc ON tc.id = tdi.transaction_candidate_id
        WHERE tdi.identifier_type = ?1
          AND tdi.normalized_value = ?2
          AND tc.financial_account_id IS NULL
          AND ${SQL.actionableTransactionWhereTc}
        LIMIT ?3`,
    )
    .bind(type, normalizedValue, limit)
    .all<ListBackfillTarget>();
  return rows.results;
}
