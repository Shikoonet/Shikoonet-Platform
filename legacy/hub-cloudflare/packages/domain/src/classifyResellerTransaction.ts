/**
 * Atomically classify a bank transaction as reseller income.
 *
 * Marks the transaction ADMIN_EXCLUDED so ingest auto-matching (ACTIONABLE-only)
 * and manual bot verification both reject it afterward.
 */

import type { D1Database, D1PreparedStatement } from '@hub/database';
import { CONSUMING_MATCH_STATUSES } from './incomeEligibility.js';

export type ClassifyResellerFailure =
  | 'TRANSACTION_NOT_FOUND'
  | 'TRANSACTION_NOT_ACTIONABLE'
  | 'TRANSACTION_ALREADY_CONSUMED'
  | 'TRANSACTION_ALREADY_RESELLER'
  | 'RESELLER_NOT_FOUND'
  | 'RESELLER_NAME_REQUIRED';

export type ClassifyResellerResult =
  | { ok: true; resellerTransactionId: string; transactionId: string; resellerId: string }
  | { ok: false; error: ClassifyResellerFailure };

export async function classifyResellerTransaction(
  db: D1Database,
  args: {
    transactionId: string;
    resellerId: string;
    actorEmail: string;
    note?: string | null;
  },
): Promise<ClassifyResellerResult> {
  const tx = await db
    .prepare(
      `SELECT id, direction, processing_disposition, amount_irr, financial_account_id
       FROM transaction_candidates WHERE id = ?1`,
    )
    .bind(args.transactionId)
    .first<{
      id: string;
      direction: string;
      processing_disposition: string;
      amount_irr: number | null;
      financial_account_id: string | null;
    }>();
  if (!tx) return { ok: false, error: 'TRANSACTION_NOT_FOUND' };
  if (tx.direction !== 'CREDIT' || tx.processing_disposition !== 'ACTIONABLE') {
    return { ok: false, error: 'TRANSACTION_NOT_ACTIONABLE' };
  }

  const consumed = await db
    .prepare(
      `SELECT id FROM reconciliation_matches
       WHERE transaction_candidate_id = ?1 AND status IN ${CONSUMING_MATCH_STATUSES}`,
    )
    .bind(args.transactionId)
    .first<{ id: string }>();
  if (consumed) return { ok: false, error: 'TRANSACTION_ALREADY_CONSUMED' };

  const existing = await db
    .prepare(`SELECT id FROM reseller_transactions WHERE transaction_candidate_id = ?1`)
    .bind(args.transactionId)
    .first<{ id: string }>();
  if (existing) return { ok: false, error: 'TRANSACTION_ALREADY_RESELLER' };

  const reseller = await db
    .prepare(`SELECT id, status FROM resellers WHERE id = ?1`)
    .bind(args.resellerId)
    .first<{ id: string; status: string }>();
  if (!reseller || reseller.status !== 'ACTIVE') {
    return { ok: false, error: 'RESELLER_NOT_FOUND' };
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  const batch: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO reseller_transactions
           (id, transaction_candidate_id, reseller_id, classified_by, classified_at, note, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5)`,
      )
      .bind(id, args.transactionId, args.resellerId, args.actorEmail, now, args.note ?? null),
    db
      .prepare(
        `UPDATE transaction_candidates
           SET processing_disposition = 'ADMIN_EXCLUDED', updated_at = ?2
         WHERE id = ?1 AND processing_disposition = 'ACTIONABLE'`,
      )
      .bind(args.transactionId, now),
    db
      .prepare(
        `UPDATE reconciliation_matches
           SET status = 'REJECTED', reviewed_by = ?2, reviewed_at = ?3, updated_at = ?3
         WHERE transaction_candidate_id = ?1 AND status = 'SUGGESTED'`,
      )
      .bind(args.transactionId, args.actorEmail, now),
  ];

  try {
    await db.batch(batch);
  } catch {
    return { ok: false, error: 'TRANSACTION_ALREADY_RESELLER' };
  }

  const marked = await db
    .prepare(`SELECT processing_disposition FROM transaction_candidates WHERE id = ?1`)
    .bind(args.transactionId)
    .first<{ processing_disposition: string }>();
  if (marked?.processing_disposition !== 'ADMIN_EXCLUDED') {
    return { ok: false, error: 'TRANSACTION_NOT_ACTIONABLE' };
  }

  return { ok: true, resellerTransactionId: id, transactionId: args.transactionId, resellerId: args.resellerId };
}

export async function createReseller(
  db: D1Database,
  args: { name: string },
): Promise<{ ok: true; id: string; name: string } | { ok: false; error: 'RESELLER_NAME_REQUIRED' | 'DUPLICATE' }> {
  const name = args.name.trim();
  if (!name) return { ok: false, error: 'RESELLER_NAME_REQUIRED' };
  const now = Date.now();
  const id = crypto.randomUUID();
  try {
    await db
      .prepare(
        `INSERT INTO resellers (id, name, status, created_at, updated_at)
         VALUES (?1, ?2, 'ACTIVE', ?3, ?3)`,
      )
      .bind(id, name, now)
      .run();
  } catch {
    return { ok: false, error: 'DUPLICATE' };
  }
  return { ok: true, id, name };
}
