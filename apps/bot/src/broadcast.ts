/**
 * Sending the broadcast — the half of it that only the bot can do.
 *
 * Deciding *what* to send and *who* gets it now lives in
 * `@shikoo/domain/bulkCustomers`, because the web panel grew screens for the
 * same two actions and a second implementation is how two panels drift apart.
 * They are re-exported here so this file still reads as one subject and the
 * bot's own imports did not have to move.
 *
 * What is left is the drain loop. Two reasons a broadcast is not sent inline:
 * eleven thousand Telegram calls do not fit in one update, and a process that
 * dies halfway through an inline send has no record of who already heard.
 *
 * Claiming is `UPDATE … WHERE status = 'PENDING' … RETURNING`, so the row that
 * comes back is already spoken for. Two overlapping cycles, or two processes
 * during a rolling deploy, cannot both take it. There is no retry: a failed
 * send is recorded as failed and never offered again, because the ordinary
 * cause is a customer who blocked the bot and the alternative risks the
 * duplicate the whole design exists to prevent.
 */

import type { D1Database } from '@shikoo/database';

export {
  MAX_MESSAGE_LENGTH,
  activeCustomerCount,
  newBatchId,
  creditEveryone,
  queueBroadcast,
} from '@shikoo/domain';

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
