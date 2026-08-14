/**
 * The admin side of the bot.
 *
 * Two rules, and neither is negotiable.
 *
 * **The button is not the permission.** Every admin action re-reads `admins`
 * for the Telegram id that sent it, and an inactive or absent row means the
 * update is ignored exactly as an ordinary customer's would be. Nothing here
 * trusts that a keyboard was ever drawn — `callback_data` is a field anyone can
 * post, and the admin actions are the ones worth forging.
 *
 * **Everything is written down.** `audit_logs` is append-only in the schema
 * (0005 refuses UPDATE and DELETE with a trigger), so an admin decision about
 * somebody's money leaves a row that even the admin cannot edit afterwards.
 *
 * Approving a payment does NOT happen here. `verifyMirzabotClaim` in
 * `@shikoo/domain` is the only path allowed to settle a Mirzabot claim — it
 * re-checks the hard facts and writes through the partial unique indexes that
 * stop one bank transaction paying for two orders. This file finds the claim,
 * offers the transactions that could be it, and records who chose.
 */

import { randomUUID } from 'node:crypto';
import type { D1Database, D1DatabaseSession } from '@shikoo/database';

type Db = D1Database | D1DatabaseSession;

export interface BotAdmin {
  id: number;
  telegramId: number;
  username: string | null;
  role: 'OWNER' | 'ADMIN' | 'SUPPORT';
}

/** The admin row for a Telegram id, or null. Inactive rows are not admins. */
export async function adminFor(db: Db, telegramId: number): Promise<BotAdmin | null> {
  const row = await db
    .prepare(
      `SELECT id, telegram_id, username, role FROM admins
        WHERE telegram_id = ?1 AND active`,
    )
    .bind(telegramId)
    .first<{ id: number; telegram_id: number; username: string | null; role: string }>();
  if (!row) return null;
  return {
    id: row.id,
    telegramId: row.telegram_id,
    username: row.username,
    role: row.role as BotAdmin['role'],
  };
}

/**
 * Records that an admin did something.
 *
 * `actor_role` is the dashboard's vocabulary, not `admins.role` — the column
 * has a CHECK listing ADMIN/REVIEWER/READ_ONLY/SYSTEM and the two sets are not
 * the same. SUPPORT maps to REVIEWER, which is what it is.
 */
export async function audit(
  db: Db,
  admin: BotAdmin,
  action: string,
  entityType: string,
  entityId: string,
  extra: { before?: unknown; after?: unknown; reason?: string } = {},
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_logs
         (id, actor_email, actor_telegram_id, actor_role, action, entity_type, entity_id,
          before_json, after_json, reason, created_at)
       VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(
      randomUUID(),
      admin.telegramId,
      admin.role === 'SUPPORT' ? 'REVIEWER' : 'ADMIN',
      action,
      entityType,
      entityId,
      extra.before === undefined ? null : JSON.stringify(extra.before),
      extra.after === undefined ? null : JSON.stringify(extra.after),
      extra.reason ?? null,
      Date.now(),
    )
    .run();
}

export interface PendingClaim {
  id: string;
  external_order_id: string;
  expected_amount_irr: number;
  card_digits: string | null;
  paid_clicked_at: number | null;
  suspect_reason: string | null;
  status: string;
  telegram_id: number | null;
  username: string | null;
}

/** What a claim's `customer_reference` is: the Telegram id of whoever paid. */
const CLAIM_JOIN = `
  LEFT JOIN users u ON u.telegram_id = nullif(c.customer_reference, '')::bigint
`;

/**
 * Payments waiting for a person.
 *
 * `MATCH_SUGGESTED` is included: the engine found something and declined to act
 * on it alone, which is precisely the queue an admin exists for.
 */
export async function claimsAwaitingReview(db: Db, limit: number, offset = 0): Promise<PendingClaim[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.external_order_id, c.expected_amount_irr, c.card_digits,
              c.paid_clicked_at, c.suspect_reason, c.status,
              u.telegram_id, u.username
         FROM payment_claims c ${CLAIM_JOIN}
        WHERE c.status IN ('PENDING', 'MATCH_SUGGESTED')
        ORDER BY c.paid_clicked_at DESC NULLS LAST, c.created_at DESC
        LIMIT ?1 OFFSET ?2`,
    )
    .bind(limit, offset)
    .all<PendingClaim>();
  return results ?? [];
}

export async function countClaimsAwaitingReview(db: Db): Promise<number> {
  const row = await db
    .prepare(
      `SELECT count(*)::int AS n FROM payment_claims
        WHERE status IN ('PENDING', 'MATCH_SUGGESTED')`,
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function claimById(db: Db, claimId: string): Promise<PendingClaim | null> {
  return db
    .prepare(
      `SELECT c.id, c.external_order_id, c.expected_amount_irr, c.card_digits,
              c.paid_clicked_at, c.suspect_reason, c.status,
              u.telegram_id, u.username
         FROM payment_claims c ${CLAIM_JOIN}
        WHERE c.id = ?1`,
    )
    .bind(claimId)
    .first<PendingClaim>();
}

export interface CandidateTransaction {
  id: string;
  amount_irr: number;
  bank_timestamp: number;
  sender: string | null;
}

/**
 * The bank transactions this claim could plausibly be.
 *
 * Deliberately NOT the auto-matcher's rules: those decide what may settle
 * without a human, and an admin is here because they did not fire. What this
 * offers is the same account, the same amount, unconsumed — and a wide window,
 * because "the SMS arrived nine minutes late" is the ordinary reason a payment
 * reaches this screen at all.
 *
 * The amount is still exact. An admin who needs to settle a claim against a
 * different amount is doing something this screen should not make easy; the
 * "no transaction" path exists for that, and it says what it is.
 */
export async function candidateTransactions(
  db: Db,
  claimId: string,
  windowMs = 6 * 60 * 60 * 1000,
): Promise<CandidateTransaction[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.amount_irr, t.bank_timestamp, s.sender
         FROM payment_claims c
         JOIN transaction_candidates t
           ON t.financial_account_id = c.target_financial_account_id
          AND t.amount_irr = c.expected_amount_irr
          AND t.direction = 'CREDIT'
          AND t.processing_disposition = 'ACTIONABLE'
         LEFT JOIN raw_sms_events s ON s.id = t.raw_sms_event_id
        WHERE c.id = ?1
          AND c.target_financial_account_id IS NOT NULL
          AND abs(t.bank_timestamp - coalesce(c.paid_clicked_at, c.submitted_at)) <= ?2
          AND NOT EXISTS (
                SELECT 1 FROM reconciliation_matches m
                 WHERE m.transaction_candidate_id = t.id
                   AND m.status IN ('CONFIRMED', 'AUTO_VERIFIED'))
        ORDER BY abs(t.bank_timestamp - coalesce(c.paid_clicked_at, c.submitted_at))
        LIMIT 5`,
    )
    .bind(claimId, windowMs)
    .all<CandidateTransaction>();
  return results ?? [];
}

/**
 * Refuses a claim.
 *
 * Never automatic — reaching here takes an admin pressing a button and then
 * confirming it. The claim is left in a terminal state so the matcher stops
 * offering it, and the payment goes back to needing a human decision rather
 * than being marked paid.
 */
export async function rejectClaim(
  tx: D1DatabaseSession,
  claimId: string,
): Promise<boolean> {
  const done = await tx
    .prepare(
      `UPDATE payment_claims
          SET status = 'REJECTED', updated_at = ?2
        WHERE id = ?1 AND status IN ('PENDING', 'MATCH_SUGGESTED')`,
    )
    .bind(claimId, Date.now())
    .run();
  return done.meta.changes > 0;
}
