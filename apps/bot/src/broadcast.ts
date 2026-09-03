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
 * second, and the pacing below keeps this under it.
 */
export const BROADCAST_BATCH = 200;

/**
 * How many sends are in flight at once.
 *
 * ## The arithmetic that made this necessary
 *
 * The loop was `await sendMessage(...)` followed by `await sleep(40)`, and the
 * comment here used to reason about the 40ms as though it were the limit. It
 * was not. A round trip to Telegram from Iran is 200ms and up, so each message
 * cost latency + gap ≈ 240ms — about four per second against a ceiling of
 * thirty. Nine tenths of a broadcast was this process waiting.
 *
 * Sam asked for mirzabot's «7.5× faster». Their code has no such change: it
 * still sends twenty per cron tick (`cronbot/sendmessage.php`) with the cron
 * running once a minute (`function.php:1734`), which is 1,200 an hour, and
 * there is not one
 * `curl_multi` in their repository. The number is not in the source. What
 * reading it did show is that they have the same shape of loop we did — so the
 * fix below is ours rather than theirs.
 *
 * ## Why a pool is safe here and would not be there
 *
 * Every recipient is claimed by its own `UPDATE … SKIP LOCKED` and marked by
 * its own statement, so two sends share no state. That is what makes running
 * them at once ordinary rather than daring. Mirzabot rewrites a `users.json`
 * after each tick; parallel sends against that file would lose or duplicate
 * whatever the last writer did not see.
 *
 * Twelve rather than thirty: the pool's throughput is bounded by the pace below
 * as soon as the connection is fast, and twelve is enough to hide a 250ms round
 * trip at that pace (12 / 0.25s ≈ 48/s of capacity against a 25/s pace) while
 * keeping the number of open sockets small on a box that is also polling.
 */
export const SEND_CONCURRENCY = 12;

/**
 * The floor on the gap between two sends STARTING, across the whole pool.
 *
 * 40ms is 25 messages a second, which is what the old per-message gap was aiming
 * at and never reached. Kept as a pace rather than a sleep-after-each-send: with
 * a pool the two are different things, and it is the RATE Telegram limits.
 */
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
 * That policy is unchanged. What changed on 2026-08-19 is that the claim writes
 * SENDING rather than SENT. With two states there was no way to tell a message
 * somebody received from one that was claimed and never sent — and the case
 * that made it matter is not a crash: `sweepBroadcasts` breaks its loop on
 * `signal.aborted`, so an ordinary shutdown mid-broadcast marked every
 * remaining claimed row delivered and told the shop a number larger than the
 * number of people who heard. A stranded SENDING row is still never retried,
 * because whether Telegram accepted it before the process died is precisely
 * what nobody knows. It is simply no longer invisible.
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
      // `AS MATERIALIZED` is the guard, and it is a fence rather than a hint.
      //
      // This was written as `UPDATE … FROM (SELECT … LIMIT n)`. The planner put
      // that subquery on the INNER side of a nested loop and re-executed it
      // once per candidate row, so the limit bounded each re-execution and
      // every pending row matched some execution of it: asking for one
      // recipient returned eleven, and on a real shop one sweep claims the
      // whole broadcast — exactly what `BROADCAST_BATCH` and `SEND_GAP_MS`
      // exist to prevent.
      //
      // Rewriting it as row-wise `IN (SELECT …)` was tried next and is NOT the
      // fix: it passed on a near-empty table and returned nine for a limit of
      // two once the suite filled the table, because the planner is free to
      // turn that into a per-row SubPlan too. A limit that holds only for the
      // plan the planner happened to pick is not a limit.
      //
      // `WITH … AS MATERIALIZED` is documented as an optimisation fence: the
      // CTE is evaluated exactly once, whatever the plan around it. That is a
      // guarantee, not a hope, which is the only kind worth writing down.
      //
      // The plain join to `broadcasts` is safe in a way the original was not:
      // it is on a primary key, so it cannot multiply rows and carries no LIMIT.
      `WITH picked AS MATERIALIZED (
          SELECT rr.broadcast_id, rr.user_id
            FROM broadcast_recipients rr
            JOIN broadcasts bb ON bb.id = rr.broadcast_id
           WHERE rr.status = 'PENDING'
           ORDER BY bb.created_at, rr.user_id
           LIMIT ?1
           FOR UPDATE OF rr SKIP LOCKED
        )
        UPDATE broadcast_recipients r
           SET status = 'SENDING', claimed_at = now()
          FROM picked p, broadcasts b
         WHERE r.broadcast_id = p.broadcast_id
           AND r.user_id = p.user_id
           AND r.status = 'PENDING'
           AND b.id = r.broadcast_id
       RETURNING r.broadcast_id, r.user_id, r.telegram_id, b.body`,
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

/** Records that a claimed message reached Telegram. */
export async function markBroadcastSent(
  db: D1Database,
  broadcastId: string,
  userId: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE broadcast_recipients
          SET status = 'SENT', sent_at = now()
        WHERE broadcast_id = ?1 AND user_id = ?2 AND status = 'SENDING'`,
    )
    .bind(broadcastId, userId)
    .run();
}

/**
 * Rows somebody claimed and never finished, older than `olderThanMs`.
 *
 * The age matters: a row claimed a second ago belongs to the sweep that is
 * running right now, and reporting it would make every healthy broadcast look
 * stuck.
 */
export async function strandedSendingCount(
  db: D1Database,
  olderThanMs = 10 * 60 * 1000,
  now: number = Date.now(),
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT count(*)::int AS n FROM broadcast_recipients
        WHERE status = 'SENDING' AND claimed_at < to_timestamp(?1 / 1000.0)`,
    )
    .bind(now - olderThanMs)
    .first<{ n: number }>();
  return row?.n ?? 0;
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
        WHERE broadcast_id = ?1 AND user_id = ?2 AND status = 'SENDING'`,
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
          -- SENDING counts as outstanding. Closing a broadcast that still has
          -- one would stamp it finished while somebody is mid-send, and a
          -- stranded row would make the shop's own record say it completed.
          AND NOT EXISTS (SELECT 1 FROM broadcast_recipients r
                           WHERE r.broadcast_id = b.id
                             AND r.status IN ('PENDING', 'SENDING'))`,
    )
    .run();
}
