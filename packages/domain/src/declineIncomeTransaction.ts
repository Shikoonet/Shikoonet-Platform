/**
 * Reversible Income decline disposition (operator queue only).
 *
 * Does NOT delete transaction_candidates or raw_sms_events.
 * Does NOT change processing_disposition — bot matching unchanged.
 */

import type { D1Database } from '@shikoo/database';
import { INCOME_TX_WHERE, TX_INCOME_DECLINED } from './incomeEligibility.js';

export { TX_INCOME_DECLINED };

export type DeclineIncomeFailure =
  | 'TRANSACTION_NOT_FOUND'
  | 'NOT_INCOME_ELIGIBLE'
  | 'ALREADY_DECLINED';

export type DeclineIncomeResult =
  | { ok: true; id: string; transactionId: string }
  | { ok: false; error: DeclineIncomeFailure };

export type RestoreIncomeFailure = 'NOT_DECLINED' | 'TRANSACTION_NOT_FOUND';

export type RestoreIncomeResult =
  | { ok: true; transactionId: string; returnedToIncome: boolean }
  | { ok: false; error: RestoreIncomeFailure };

export async function isIncomeEligible(db: D1Database, transactionId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS ok FROM transaction_candidates t WHERE t.id = ?1 AND ${INCOME_TX_WHERE}`)
    .bind(transactionId)
    .first<{ ok: number }>();
  return row?.ok === 1;
}

export async function wouldReturnToIncome(db: D1Database, transactionId: string): Promise<boolean> {
  return isIncomeEligible(db, transactionId);
}

export async function declineIncomeTransaction(
  db: D1Database,
  args: { transactionId: string; actorEmail: string; reason?: string | null },
): Promise<DeclineIncomeResult> {
  const tx = await db
    .prepare(`SELECT id FROM transaction_candidates WHERE id = ?1`)
    .bind(args.transactionId)
    .first<{ id: string }>();
  if (!tx) return { ok: false, error: 'TRANSACTION_NOT_FOUND' };

  const eligible = await isIncomeEligible(db, args.transactionId);
  if (!eligible) {
    const declined = await db
      .prepare(
        `SELECT id FROM income_declined_transactions
         WHERE transaction_candidate_id = ?1 AND restored_at IS NULL`,
      )
      .bind(args.transactionId)
      .first<{ id: string }>();
    if (declined) return { ok: false, error: 'ALREADY_DECLINED' };
    return { ok: false, error: 'NOT_INCOME_ELIGIBLE' };
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  try {
    await db
      .prepare(
        `INSERT INTO income_declined_transactions
           (id, transaction_candidate_id, declined_by, declined_at, reason, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(id, args.transactionId, args.actorEmail, now, args.reason ?? null, now)
      .run();
  } catch {
    return { ok: false, error: 'ALREADY_DECLINED' };
  }
  return { ok: true, id, transactionId: args.transactionId };
}

export async function restoreIncomeTransaction(
  db: D1Database,
  args: { transactionId: string; actorEmail: string },
): Promise<RestoreIncomeResult> {
  const row = await db
    .prepare(
      `SELECT id FROM income_declined_transactions
       WHERE transaction_candidate_id = ?1 AND restored_at IS NULL`,
    )
    .bind(args.transactionId)
    .first<{ id: string }>();
  if (!row) return { ok: false, error: 'NOT_DECLINED' };

  const now = Date.now();
  await db
    .prepare(
      `UPDATE income_declined_transactions
       SET restored_by = ?2, restored_at = ?3
       WHERE id = ?1`,
    )
    .bind(row.id, args.actorEmail, now)
    .run();

  const returnedToIncome = await wouldReturnToIncome(db, args.transactionId);
  return { ok: true, transactionId: args.transactionId, returnedToIncome };
}

export async function declineIncomeBulk(
  db: D1Database,
  args: { transactionIds: string[]; actorEmail: string; reason?: string | null },
): Promise<{ declined: string[]; skipped: Array<{ id: string; error: DeclineIncomeFailure }> }> {
  const declined: string[] = [];
  const skipped: Array<{ id: string; error: DeclineIncomeFailure }> = [];
  for (const id of args.transactionIds) {
    const result = await declineIncomeTransaction(db, {
      transactionId: id,
      actorEmail: args.actorEmail,
      reason: args.reason ?? null,
    });
    if (result.ok) declined.push(id);
    else skipped.push({ id, error: result.error });
  }
  return { declined, skipped };
}

export async function restoreIncomeBulk(
  db: D1Database,
  args: { transactionIds: string[]; actorEmail: string },
): Promise<{ restored: string[]; returnedToIncome: string[]; skipped: string[] }> {
  const restored: string[] = [];
  const returnedToIncome: string[] = [];
  const skipped: string[] = [];
  for (const id of args.transactionIds) {
    const result = await restoreIncomeTransaction(db, {
      transactionId: id,
      actorEmail: args.actorEmail,
    });
    if (result.ok) {
      restored.push(id);
      if (result.returnedToIncome) returnedToIncome.push(id);
    } else {
      skipped.push(id);
    }
  }
  return { restored, returnedToIncome, skipped };
}

export async function declineAllActiveIncome(
  db: D1Database,
  args: { actorEmail: string; reason?: string | null },
): Promise<{ declined: number; transactionIds: string[] }> {
  const rows = await db
    .prepare(`SELECT t.id FROM transaction_candidates t WHERE ${INCOME_TX_WHERE}`)
    .all<{ id: string }>();
  const ids = (rows.results ?? []).map((r) => r.id);
  const result = await declineIncomeBulk(db, {
    transactionIds: ids,
    actorEmail: args.actorEmail,
    reason: args.reason ?? null,
  });
  return { declined: result.declined.length, transactionIds: result.declined };
}

export async function restoreAllDeclinedIncome(
  db: D1Database,
  args: { actorEmail: string },
): Promise<{ restored: number; returnedToIncome: number }> {
  const rows = await db
    .prepare(
      `SELECT transaction_candidate_id AS id FROM income_declined_transactions
       WHERE restored_at IS NULL`,
    )
    .all<{ id: string }>();
  const ids = (rows.results ?? []).map((r) => r.id);
  const result = await restoreIncomeBulk(db, { transactionIds: ids, actorEmail: args.actorEmail });
  return { restored: result.restored.length, returnedToIncome: result.returnedToIncome.length };
}
