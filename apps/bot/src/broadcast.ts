/**
 * One message to every customer, and one credit to every wallet.
 *
 * Two operations that share nothing technically and everything in risk: they
 * are the only two things in the bot that touch every row at once, and neither
 * has an undo. So both are written the same way — the whole effect is decided
 * in one statement, and the guarantee that nobody is hit twice is a database
 * constraint rather than a loop that intends to be careful.
 *
 * ## The credit
 *
 * One `INSERT … SELECT`. Not a loop over eleven thousand customers inside the
 * transaction that is holding the bot's claim on a Telegram update, and not a
 * read-modify-write of any balance: `wallets.balance_irr` is derived by a
 * trigger from append-only `wallet_entries`, here as everywhere.
 *
 * The idempotency key is `bulk:<batch>:<user>`, so pressing the button twice on
 * a flaky connection credits each customer once. The batch id is generated when
 * the amount is typed and stored in the session, which is what makes it stable
 * across a redelivered confirmation.
 *
 * ## The message
 *
 * The recipient list is snapshotted at confirmation time into
 * `broadcast_recipients`, then drained by the poll loop a batch at a time. Two
 * reasons it is not sent inline: eleven thousand Telegram calls do not fit in
 * one update, and a process that dies halfway through an inline send has no
 * record of who already heard.
 *
 * Claiming is `UPDATE … WHERE status = 'PENDING' … RETURNING`, so the row that
 * comes back is already spoken for. Two overlapping cycles, or two processes
 * during a rolling deploy, cannot both take it. There is no retry: a failed
 * send is recorded as failed and never offered again, because the ordinary
 * cause is a customer who blocked the bot and the alternative risks the
 * duplicate the whole design exists to prevent.
 */

import { randomUUID } from 'node:crypto';
import type { D1Database, D1DatabaseSession } from '@shikoo/database';

type Db = D1Database | D1DatabaseSession;

/**
 * How many messages one poll cycle sends.
 *
 * Telegram's documented ceiling for bulk sending is around 30 messages per
 * second; `SEND_GAP_MS` keeps this well under it. At a 25-second cycle these
 * numbers drain 11,000 customers in about twenty minutes while adding eight
 * seconds to each cycle — the bot stays responsive, a little slower, and is
 * never rate limited.
 */
export const BROADCAST_BATCH = 200;
export const SEND_GAP_MS = 40;

/** Telegram refuses a longer message outright rather than truncating it. */
export const MAX_MESSAGE_LENGTH = 4096;

/** How many customers a bulk action would reach, before committing to it. */
export async function activeCustomerCount(db: Db): Promise<number> {
  const row = await db
    .prepare(`SELECT count(*)::int AS n FROM users WHERE status = 'ACTIVE'`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** A batch id, generated once and kept in the session so a retry reuses it. */
export function newBatchId(): string {
  return randomUUID();
}

/**
 * Credits every active customer, once each.
 *
 * Returns how many wallets moved. A second call with the same batch returns 0,
 * which is the honest answer: nothing moved this time.
 */
export async function creditEveryone(
  db: Db,
  batchId: string,
  amountIrr: number,
  actor: string,
  note: string,
): Promise<number> {
  const done = await db
    .prepare(
      `INSERT INTO wallet_entries (user_id, amount_irr, kind, actor, note, idempotency_key)
       SELECT u.id, ?2, 'ADMIN_ADJUST', ?3, ?4, 'bulk:' || ?1 || ':' || u.id
         FROM users u
        WHERE u.status = 'ACTIVE'
       ON CONFLICT (idempotency_key) DO NOTHING`,
    )
    .bind(batchId, amountIrr, actor, note)
    .run();
  return done.meta.changes;
}

/**
 * Writes the broadcast and its recipient list down. Returns how many will get
 * it, which is fixed from this moment: somebody who presses /start during the
 * send does not receive a notice about something that started before they
 * existed.
 */
export async function queueBroadcast(
  db: Db,
  broadcastId: string,
  body: string,
  createdBy: number,
): Promise<number> {
  await db
    .prepare(`INSERT INTO broadcasts (id, body, created_by) VALUES (?1, ?2, ?3)
              ON CONFLICT (id) DO NOTHING`)
    .bind(broadcastId, body, createdBy)
    .run();
  const done = await db
    .prepare(
      `INSERT INTO broadcast_recipients (broadcast_id, user_id, telegram_id)
       SELECT ?1, u.id, u.telegram_id FROM users u WHERE u.status = 'ACTIVE'
       ON CONFLICT (broadcast_id, user_id) DO NOTHING`,
    )
    .bind(broadcastId)
    .run();
  return done.meta.changes;
}

export interface BroadcastMessage {
  broadcastId: string;
  userId: number;
  chatId: number;
  text: string;
}

/**
 * Takes the next batch, claiming it in the same statement that returns it.
 *
 * `SET status = 'SENT'` before the message is actually sent is deliberate and
 * is the same trade-off every other sweep in this bot makes out loud: at most
 * once, never twice. A customer who does not receive a broadcast has missed an
 * announcement; a customer who receives it twice has been spammed by a shop
 * they trust with their money.
 *
 * The `AND r.status = 'PENDING'` on the outer statement is the one guard in
 * this file that no test turns red, and that is worth saying rather than
 * leaving to be discovered: `SKIP LOCKED` already means a row another
 * transaction is holding is never picked, so a single process cannot reach it.
 * It is there for the second process — a rolling deploy, which this project
 * has already flagged as the way two pollers end up on one token — where the
 * subquery's snapshot and the update's re-check are taken at different moments.
 */
export async function claimBroadcastBatch(
  db: D1Database,
  limit = BROADCAST_BATCH,
): Promise<BroadcastMessage[]> {
  const { results } = await db
    .prepare(
      `UPDATE broadcast_recipients r
          SET status = 'SENT', sent_at = now()
         FROM (SELECT b.id AS broadcast_id, b.body, rr.user_id
                 FROM broadcast_recipients rr
                 JOIN broadcasts b ON b.id = rr.broadcast_id
                WHERE rr.status = 'PENDING'
                ORDER BY b.created_at, rr.user_id
                LIMIT ?1
                FOR UPDATE OF rr SKIP LOCKED) picked
        WHERE r.broadcast_id = picked.broadcast_id
          AND r.user_id = picked.user_id
          AND r.status = 'PENDING'
       RETURNING r.broadcast_id, r.user_id, r.telegram_id, picked.body`,
    )
    .bind(limit)
    .all<{ broadcast_id: string; user_id: number; telegram_id: number; body: string }>();
  return (results ?? []).map((r) => ({
    broadcastId: r.broadcast_id,
    userId: r.user_id,
    chatId: r.telegram_id,
    text: r.body,
  }));
}

/** Records that a claimed message did not get through, with the reason. */
export async function markBroadcastFailed(
  db: D1Database,
  broadcastId: string,
  userId: number,
  error: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE broadcast_recipients
          SET status = 'FAILED', error = ?3
        WHERE broadcast_id = ?1 AND user_id = ?2`,
    )
    .bind(broadcastId, userId, error.slice(0, 500))
    .run();
}

/** Stamps a broadcast finished once nothing is pending. Cheap and idempotent. */
export async function closeFinishedBroadcasts(db: D1Database): Promise<void> {
  await db
    .prepare(
      `UPDATE broadcasts b SET finished_at = now()
        WHERE b.finished_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM broadcast_recipients r
                           WHERE r.broadcast_id = b.id AND r.status = 'PENDING')`,
    )
    .run();
}
