/**
 * Auto-create a PENDING financial_accounts row.
 *
 * Invoked by the ingest worker when a parsed SMS carries an
 * `accountHint` (or a detected ACCOUNT_HINT / ACCOUNT_NUMBER identifier)
 * that doesn't resolve to any existing active=1 account. The new row
 * lands in PENDING so an admin can review it in the Accounts review
 * queue before it auto-joins Today / matching / totals.
 *
 * Concurrency: the partial unique index
 * `idx_fa_unique_active_account_hint` enforces that `account_hint`
 * is unique across all `active = 1` rows — so two concurrent ingests
 * racing for the same hint cannot both create a duplicate. The
 * retry-after-unique-violation path re-fetches the winner via the
 * same resolver that the next ingest would use.
 *
 * Plain placeholders: the auto-created row has a placeholder
 * `display_name` ("Auto: <masked hint>") and no `bank_name` unless the
 * parser supplied one. The admin fills these in when they Accept the
 * row. The Placeholder is sufficient to make the row appear in the
 * review queue and to receive the auto-assigned transaction.
 */

import type { D1Database } from '@shikoo/database';

export interface AutoCreatePendingInput {
  /** The account hint extracted from the SMS (e.g. "310057795083"). */
  hint: string;
  /** Optional bank name from the parser (may be null). */
  bankName?: string | null;
  /** Optional account_type. Defaults to 'OTHER' for auto-created. */
  accountType?: 'CARD' | 'ACCOUNT' | 'IBAN' | 'OTHER';
  /** Optional device id (the device that first surfaced this hint). */
  deviceId?: string | null;
  /** Timestamp (epoch ms). Caller supplies so the same batch runs coherently. */
  now: number;
}

export interface AutoCreatePendingResult {
  /** stable id of the PENDING account (existing or newly created) */
  accountId: string;
  /** true when a new row was created; false when the resolver already returned this row */
  created: boolean;
}

/**
 * Idempotent upsert: find the existing active PENDING / ACTIVE row with
 * this hint, or create a new PENDING row. Race-safe via the partial
 * unique index — if two concurrent ingests both try to create, exactly
 * one INSERT succeeds and the second retries the SELECT.
 */
export async function autoCreatePendingAccount(
  db: D1Database,
  input: AutoCreatePendingInput,
): Promise<AutoCreatePendingResult> {
  const existing = await db
    .prepare(
      `SELECT id FROM financial_accounts
        WHERE account_hint = ?1 AND active = 1
        LIMIT 1`,
    )
    .bind(input.hint)
    .first<{ id: string }>();
  if (existing) {
    return { accountId: existing.id, created: false };
  }

  const id = crypto.randomUUID();
  const masked = `Auto: ${maskHint(input.hint)}`;
  const type = input.accountType ?? 'OTHER';
  // bank_name is NOT NULL in the schema. Empty string is the placeholder
  // until the admin Accepts the row and fixes it in the review queue.
  const bank = input.bankName?.trim() || '';

  // The unique partial index protects us. If two concurrent ingests
  // race, exactly one INSERT succeeds; the loser catches the UNIQUE
  // error and the retry loop below falls back to the SELECT.
  const insertStmt = db.prepare(
    `INSERT INTO financial_accounts
       (id, bank_name, display_name, owner_label, account_type,
        account_hint, card_last_four, account_last_four, iban, device_id,
        active, parser_configuration, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, NULL, ?4, ?5, NULL, NULL, NULL, ?6, 1, '{}', 'PENDING', ?7, ?7)`,
  );
  // Reflect the hint as an fai ACCOUNT_HINT row so the resolver (which
  // probes both the canonical column AND financial_account_identifiers)
  // picks it up either way.
  const faiInsert = db.prepare(
    `INSERT INTO financial_account_identifiers
       (id, financial_account_id, kind, value, label, created_at)
     VALUES (?1, ?2, 'ACCOUNT_HINT', ?3, NULL, ?4)`,
  );

  try {
    await db.batch([
      insertStmt.bind(id, bank, masked, type, input.hint, input.deviceId ?? null, input.now),
      faiInsert.bind(crypto.randomUUID(), id, input.hint, input.now),
    ]);
    return { accountId: id, created: true };
  } catch (e) {
    // Race loser — re-fetch the winner.
    const winner = await db
      .prepare(
        `SELECT id FROM financial_accounts WHERE account_hint = ?1 AND active = 1 LIMIT 1`,
      )
      .bind(input.hint)
      .first<{ id: string }>();
    if (winner) {
      return { accountId: winner.id, created: false };
    }
    throw e;
  }
}

/**
 * Mask the hint for the placeholder display name. Reveals only the
 * trailing 4 digits — same convention as the SMS-identifiers module.
 */
function maskHint(hint: string): string {
  if (hint.length <= 4) return '****';
  return `****${hint.slice(-4)}`;
}
