/**
 * Deterministic, ambiguity-detecting account resolution.
 *
 * Resolves a single normalized identifier (account number, card last four,
 * IBAN, etc.) to a single active `financial_accounts.id`. NEVER uses
 * `LIMIT 1`: fetches two rows so we can detect when two accounts share
 * the same identifier and return `ACCOUNT_IDENTIFIER_AMBIGUOUS` instead
 * of silently picking one.
 *
 * Resolution priority (first non-empty match wins):
 *   1. `account_hint` exact (full account number on Iranian bank SMS)
 *   2. `card_last_four` exact
 *   3. `account_last_four` exact
 *   4. `iban` exact
 *   5. `financial_account_identifiers.value` exact (any kind)
 *
 * Active accounts only (active = 1) AND operationally eligible (status =
 * 'ACTIVE'). PENDING / MUTED / DECLINED accounts are excluded from
 * automatic resolution so an SMS arriving for a new account lands as
 * `financial_account_id IS NULL` instead of being silently auto-assigned
 * to a row the admin hasn't reviewed yet.
 *
 * When a hint matches no row, returns NOT_FOUND — callers must decide
 * whether to auto-create a candidate with financial_account_id = NULL or
 * surface the warning to the user.
 */

import type { D1Database, FinancialAccountRow } from '@shikoo/database';
import { SQL } from '@shikoo/database';

export type ResolveResult =
  | { status: 'OK'; accountId: string; matchedBy: ResolveMatch }
  | { status: 'NOT_FOUND' }
  | {
      status: 'ACCOUNT_IDENTIFIER_AMBIGUOUS';
      matches: Array<{ id: string; matchedBy: ResolveMatch }>;
    };

export type ResolveMatch =
  | 'account_hint'
  | 'card_last_four'
  | 'account_last_four'
  | 'iban'
  | 'identifier_table';

const RESOLVE_LIMITS = 2;

/**
 * Look up exactly two rows so we can detect ambiguity. The SQL UNION
 * scans each column in priority order — first non-empty result wins.
 *
 * SQLite requires LIMIT to come AFTER the final UNION ALL, not after
 * each sub-select. Each branch is wrapped in a sub-select so the LIMIT
 * applies to the whole union (we want to know whether ≥ 2 rows match,
 * never the order-of-arbitrary-row ordering of any single branch).
 */
/*
 * Every branch filters `status`, and NONE filters `active`. That is a change
 * from 2026-09-03 and it is the money-path half of a bug Sam hit.
 *
 * The two columns are different questions. `status` is «is this one of ours» —
 * a review decision, and DECLINED means the answer is no. `active` is «are we
 * still using it», the operator's own on/off. Only the first can decide what an
 * arriving bank SMS MEANS: money that lands on an account we retired is still
 * our money, and it still arrived there.
 *
 * Four of these branches used to carry `active = 1` as well, and the fifth
 * never did — its own comment says the JOIN is there «to enforce status =
 * 'ACTIVE'», which is the rule the whole statement now follows. The odd four
 * were not a decision anybody wrote down, and they cost:
 *
 *   an SMS for a retired account resolved to NOT_FOUND, so ingest called
 *   `autoCreatePendingAccount` and MINTED A SECOND ACCOUNT for an identifier
 *   the shop already owned. The customer's claim then pointed at the original
 *   and the transaction at the duplicate, and nothing could ever match them.
 *
 * Attributing it to the account it actually arrived on is strictly better than
 * inventing a row. What the operator then sees is a separate question —
 * «آمار مالی» filters `active = 1` and will not show it until the account is
 * switched back on, which is now one button.
 */
const RESOLVE_SQL = `
  SELECT id, matched_by FROM (
    SELECT id, 'account_hint' AS matched_by, 1 AS priority FROM financial_accounts
     WHERE account_hint = ?1 AND status = 'ACTIVE'
    UNION ALL
    SELECT id, 'card_last_four', 2 FROM financial_accounts
     WHERE card_last_four = ?1 AND status = 'ACTIVE'
    UNION ALL
    SELECT id, 'account_last_four', 3 FROM financial_accounts
     WHERE account_last_four = ?1 AND status = 'ACTIVE'
    UNION ALL
    SELECT id, 'iban', 4 FROM financial_accounts
     WHERE iban = ?1 AND status = 'ACTIVE'
    UNION ALL
    SELECT fai.financial_account_id AS id, 'identifier_table', 5
      FROM financial_account_identifiers fai
      JOIN financial_accounts fa ON fa.id = fai.financial_account_id
     WHERE fai.value = ?1 AND fa.status = 'ACTIVE'
  )
  ORDER BY priority
  LIMIT ${RESOLVE_LIMITS}
`;

interface ResolveRow {
  id: string;
  matched_by: ResolveMatch;
}

/** Resolve a single normalized identifier. Empty / null hint → NOT_FOUND. */
export async function resolveAccountByHint(
  db: D1Database,
  hint: string | null | undefined,
): Promise<ResolveResult> {
  if (!hint) return { status: 'NOT_FOUND' };
  const rows = await db.prepare(RESOLVE_SQL).bind(hint).all<ResolveRow>();
  if (rows.results.length === 0) return { status: 'NOT_FOUND' };
  // De-duplicate by id, preserving first-seen priority.
  const seen = new Map<string, ResolveMatch>();
  for (const r of rows.results) {
    if (!seen.has(r.id)) seen.set(r.id, r.matched_by);
  }
  const unique = Array.from(seen.entries()).map(([id, matchedBy]) => ({ id, matchedBy }));
  if (unique.length === 1) {
    return { status: 'OK', accountId: unique[0]!.id, matchedBy: unique[0]!.matchedBy };
  }
  return { status: 'ACCOUNT_IDENTIFIER_AMBIGUOUS', matches: unique };
}

/**
 * Bulk variant: resolve every transaction that currently has
 * financial_account_id = NULL by recomputing the account_hint lookup.
 * Useful after adding a new identifier or after a reparse that surfaces
 * a previously-unresolved hint.
 *
 * Each successful resolve flows through `assignAccountForTx` so the
 * `transaction_account_assignments` history row is written (and is
 * a no-op when the row already has an active assignment). The
 * `financial_account_id IS NULL` predicate on the candidate query
 * ensures we never overwrite a MANUAL/ACCOUNT_MERGE assignment.
 */
export interface BackfillResult {
  resolved: number;
  ambiguous: number;
  notFound: number;
  errors: number;
}

export async function backfillAccountHints(
  db: D1Database,
  opts: { dryRun?: boolean; limit?: number; assignedBy?: string } = {},
): Promise<BackfillResult> {
  const limit = opts.limit ?? 1000;
  const assignedBy = opts.assignedBy ?? 'SYSTEM';
  const candidates = await db
    .prepare(
      `SELECT id, parser_evidence_json FROM transaction_candidates t
        WHERE t.financial_account_id IS NULL
          AND ${SQL.actionableTransactionWhereT}
        ORDER BY t.created_at DESC LIMIT ?1`,
    )
    .bind(limit)
    .all<{ id: string; parser_evidence_json: string }>();
  let resolved = 0,
    ambiguous = 0,
    notFound = 0,
    errors = 0;
  for (const row of candidates.results) {
    try {
      const ev = JSON.parse(row.parser_evidence_json) as { accountHint?: string };
      const hint = ev.accountHint;
      const r = await resolveAccountByHint(db, hint ?? null);
      if (r.status === 'OK') {
        if (!opts.dryRun) {
          // Route through the shared history writer so a HISTORICAL_BACKFILL
          // row is appended (preserves MANUAL and is idempotent on
          // identical triples).
          const { assignAccountForTx } = await import('./assignments.js');
          const result = await assignAccountForTx(
            db,
            {
              transactionCandidateId: row.id,
              financialAccountId: r.accountId,
              source: 'AUTO_IDENTIFIER',
              identifierType: 'ACCOUNT_HINT',
              normalizedIdentifier: hint ?? null,
              assignedBy,
              metadata: { reason: 'backfillAccountHints' },
            },
            Date.now(),
          );
          if (result.status === 'inserted') resolved++;
        } else {
          resolved++;
        }
      } else if (r.status === 'ACCOUNT_IDENTIFIER_AMBIGUOUS') {
        ambiguous++;
      } else {
        notFound++;
      }
    } catch {
      errors++;
    }
  }
  return { resolved, ambiguous, notFound, errors };
}

/**
 * Fetch a full account row by id — used after a successful resolve.
 */
export async function getAccountById(
  db: D1Database,
  id: string,
): Promise<FinancialAccountRow | null> {
  return (
    (await db
      .prepare(`SELECT * FROM financial_accounts WHERE id = ?1`)
      .bind(id)
      .first<FinancialAccountRow>()) ?? null
  );
}

/**
 * Preview how many unassigned transactions would resolve to a specific
 * hint value. Used by the "Add identifier" → "Assign historical" UI flow
 * before the user commits the change.
 */
export async function previewUnassignedForHint(db: D1Database, hint: string): Promise<number> {
  // parser_evidence_json stores accountHint at the top level of evidence.
  // We can't predicate on it efficiently without JSON1, so we approximate
  // by scanning evidence JSON in code. With reasonable row counts this is
  // fine; the dashboard caps the scan at 5000 rows.
  const rows = await db
    .prepare(
      `SELECT parser_evidence_json FROM transaction_candidates t
        WHERE t.financial_account_id IS NULL
          AND ${SQL.actionableTransactionWhereT}
        ORDER BY t.created_at DESC LIMIT 5000`,
    )
    .all<{ parser_evidence_json: string }>();
  let count = 0;
  for (const r of rows.results) {
    try {
      const ev = JSON.parse(r.parser_evidence_json) as { accountHint?: string };
      if (ev.accountHint === hint) count++;
    } catch {
      // ignore malformed evidence
    }
  }
  return count;
}
