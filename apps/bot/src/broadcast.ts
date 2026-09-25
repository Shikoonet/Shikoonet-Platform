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
import { createLogger } from '@shikoo/domain';

const log = createLogger('bot');

export {
  MAX_MESSAGE_LENGTH,
  activeCustomerCount,
  newBatchId,
  creditEveryone,
  queueBroadcast,
} from '@shikoo/domain';

/**
 * How many recipients one sweep claims.
 *
 * A batch, not a budget: since 2026-09-16 `drainBroadcasts` runs sweep after
 * sweep while anything is pending, so this only bounds how many rows sit
 * claimed as SENDING at once — what a crash mid-batch can strand. The rate is
 * the pace below, and Telegram's documented ceiling for bulk sending is around
 * 30 messages a second.
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
 * trip at that pace (12 / 0.25s ≈ 48/s of capacity against a 20/s pace) while
 * keeping the number of open sockets small on a box that is also polling.
 */
export const SEND_CONCURRENCY = 12;

/**
 * The floor on the gap between two sends STARTING, across the whole pool.
 *
 * 2,000ms is one message every two seconds: 1,800 an hour, a 16k broadcast in
 * about nine hours. That is Telegram's own guidance for bulk sends — «spread
 * over 8–12 hours» — and it is within sight of the one number this shop has
 * actually seen survive: mirzabot's 1,200 an hour, which never met a limit.
 *
 * The history, because every faster number here was argued from the wrong
 * limit. 50ms (20/s) was Telegram's documented per-bot ceiling; on the first
 * real 16k broadcast (2026-09-17) it drew 429s of ~30s on every batch and,
 * after ~2,000 messages, one 429 with retry_after ≈ 3,000s — fifty minutes of
 * nothing with the shop's bar frozen at 12%. 250ms (4/s) was the next guess,
 * and the same evening Telegram did it again after the same ~2,000: the
 * trigger looks like VOLUME in a window, not rate, and no pace above a few a
 * minute is known to be safe. Sam, 2026-09-17: «یه کاری کن بن نشه».
 *
 * A default, not a constant: `BROADCAST_SEND_GAP_MS` overrides it, so the
 * pace can be moved on the server the day Telegram's threshold is known,
 * without a deploy — see `sendGapMs`. Kept as a pace rather than a
 * sleep-after-each-send: with a pool the two are different things, and it is
 * the RATE Telegram limits. Exceeding it is not silent either way: a 429
 * pauses the whole pool and returns the row to the queue
 * (`markBroadcastRetryable`).
 */
export const SEND_GAP_MS = 2_000;

/**
 * The pace in force: `BROADCAST_SEND_GAP_MS` if it is a positive integer, the
 * default otherwise. Read per sweep rather than at import, so the tests can
 * set it and so a bad value is a default rather than a crash-loop —
 * `server.ts` refuses a bad value at boot, where somebody is watching.
 */
export function sendGapMs(): number {
  const n = Number(process.env['BROADCAST_SEND_GAP_MS']);
  return Number.isInteger(n) && n > 0 ? n : SEND_GAP_MS;
}

/**
 * What one queued message actually is.
 *
 * A union rather than a nullable `text` beside a nullable pair, because the two
 * are answered by two different Telegram methods and the send loop has to pick
 * one. `broadcasts` says the same thing in SQL — one payload or the other,
 * never both, never neither — and this is that CHECK in the type system, so a
 * row that somehow held both could not be turned into a message at all.
 */
export type BroadcastPayload =
  | { kind: 'text'; text: string }
  | { kind: 'forward'; fromChat: string; messageId: number };

export interface BroadcastMessage {
  broadcastId: string;
  userId: number;
  chatId: number;
  payload: BroadcastPayload;
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
             -- Taken out of the queue by an admin (0100). Checked here and not
             -- only by the cancel route flipping its rows: a row in a worker's
             -- hands at that moment can come back PENDING from a 429.
             AND bb.cancelled_at IS NULL
             -- A row Telegram told us to come back to later. NULL is «due now»,
             -- which every ordinary queued message is and stays. Without this
             -- the deadline lived only inside one sweep: the next poll cycle,
             -- twenty-five seconds later, would claim the row again however
             -- long Telegram had asked for -- and a sixty-second rate limit
             -- would burn all five attempts inside two minutes.
             AND (rr.next_attempt_at IS NULL OR rr.next_attempt_at <= now())
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
       RETURNING r.broadcast_id, r.user_id, r.telegram_id,
                 b.body, b.source_chat, b.source_message_id`,
    )
    .bind(limit)
    .all<{
      broadcast_id: string;
      user_id: number;
      telegram_id: number;
      body: string | null;
      source_chat: string | null;
      source_message_id: number | null;
    }>();
  return (results ?? []).flatMap((r) => {
    const payload = payloadOf(r);
    // A row that satisfies neither branch cannot exist — the CHECK on
    // `broadcasts` refuses it — so this is unreachable rather than a case. It
    // is dropped rather than sent as something invented, and it stays claimed
    // as SENDING, which is the state that means «somebody has to look».
    if (payload === null) {
      log.error('broadcast.payload_unreadable', { ref: r.broadcast_id });
      return [];
    }
    return [{
      broadcastId: r.broadcast_id,
      userId: r.user_id,
      chatId: r.telegram_id,
      payload,
    }];
  });
}

/** The one place a stored broadcast row becomes a thing that can be sent. */
function payloadOf(r: {
  body: string | null;
  source_chat: string | null;
  source_message_id: number | null;
}): BroadcastPayload | null {
  if (r.body !== null) return { kind: 'text', text: r.body };
  if (r.source_chat !== null && r.source_message_id !== null) {
    return { kind: 'forward', fromChat: r.source_chat, messageId: Number(r.source_message_id) };
  }
  return null;
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
 * Puts back the rows a stopping sweep claimed and never offered to Telegram.
 *
 * SENDING means «nobody knows whether Telegram has this», and for a send that
 * was in flight when the shutdown signal came that is exactly true — those
 * rows are left alone, and the worker awaits the call anyway so in the normal
 * case they end SENT before `stop()` returns. It is NOT true of the rest of
 * the batch: a row the worker took and then saw the signal on, or never took
 * at all, was never sent, because the worker returned before the call.
 *
 * Until 2026-09-17 those were stranded too. `claimBroadcastBatch` takes 200
 * rows and the pool holds twelve, so every restart mid-broadcast — a
 * `Promote Production` is one — left up to ~190 rows SENDING for ever: never
 * retried by policy, never closed by `closeFinishedBroadcasts`, and shown to
 * the shop as «مانده» on a number that stopped moving. Sam, 2026-09-17: «مدتی
 * است روی همین عدد مانده».
 *
 * Only ever called with rows THIS sweep claimed, and guarded by `status =
 * 'SENDING'` so a row another path already settled is not reopened.
 */
export async function releaseBroadcastClaims(
  db: D1Database,
  messages: BroadcastMessage[],
): Promise<void> {
  if (messages.length === 0) return;
  await db
    .prepare(
      `UPDATE broadcast_recipients r
          SET status = 'PENDING', claimed_at = NULL
         FROM unnest(?1::uuid[], ?2::bigint[]) AS u(broadcast_id, user_id)
        WHERE r.broadcast_id = u.broadcast_id
          AND r.user_id = u.user_id
          AND r.status = 'SENDING'`,
    )
    .bind(
      messages.map((m) => m.broadcastId),
      messages.map((m) => m.userId),
    )
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

/**
 * How many times one recipient may be offered to Telegram.
 *
 * Only a 429 ever consumes one of these — see `markBroadcastRetryable` — so in
 * a healthy send nothing reaches two. The ceiling exists for the shop that is
 * rate-limited for longer than it is patient: without it, a broadcast that
 * cannot get through neither finishes nor fails, and no screen ever changes.
 */
export const MAX_SEND_ATTEMPTS = 5;

/**
 * Puts a rate-limited recipient back in the queue, and says whether it stayed.
 *
 * Called for a 429 and nothing else. That narrowness is the whole design:
 * Telegram is stating it did NOT deliver this message, which is what makes
 * offering it again safe. A 5xx or a dropped socket leaves delivery unknown,
 * and sending again there is the duplicate `PRIMARY KEY (broadcast_id,
 * user_id)` exists to prevent — a shop that spams a paying customer has done
 * worse than miss them once.
 *
 * The count and the decision are in ONE statement rather than a read followed
 * by a write. Two sweeps overlapping on one row is the case that makes a
 * count-then-act wrong, and this project has been bitten by that shape before.
 *
 * Returns the status the row ended on, so the caller can log the give-up
 * without asking the database a second question.
 */
export async function markBroadcastRetryable(
  db: D1Database,
  broadcastId: string,
  userId: number,
  error: string,
  /**
   * Seconds Telegram asked for, written onto the row.
   *
   * The sweep's own pause covers the workers already holding rows; this covers
   * the NEXT sweep, which starts with no memory of anything. Both are needed
   * and they stop different things.
   */
  retryAfterSec: number,
): Promise<'PENDING' | 'FAILED' | null> {
  const row = await db
    .prepare(
      `UPDATE broadcast_recipients
          SET attempts = attempts + 1,
              status = CASE WHEN attempts + 1 >= ?3 THEN 'FAILED' ELSE 'PENDING' END,
              -- Cleared on the way back to PENDING: the row is nobody's now,
              -- and a stale claim time would make strandedSendingCount report
              -- a queued message as one somebody abandoned. (No backticks in
              -- this comment: the SQL is a template literal and one would end
              -- it -- the same trap warn.ts names.)
              claimed_at = NULL,
              -- Cleared on the way out, so a row that gave up is not left
              -- carrying a deadline nobody will ever read.
              next_attempt_at = CASE WHEN attempts + 1 >= ?3
                                     THEN NULL
                                     ELSE now() + make_interval(secs => ?5)
                                END,
              -- The reason is written only at the end, where it is the final
              -- word an operator reads, and it names the attempts as well as
              -- the refusal: "gave up" and "failed once" are different facts.
              error = CASE WHEN attempts + 1 >= ?3
                           THEN 'after ' || ?3 || ' attempts: ' || ?4
                           ELSE NULL END
        WHERE broadcast_id = ?1 AND user_id = ?2 AND status = 'SENDING'
    RETURNING status`,
    )
    .bind(broadcastId, userId, MAX_SEND_ATTEMPTS, error.slice(0, 500), retryAfterSec)
    .first<{ status: 'PENDING' | 'FAILED' }>();
  return row?.status ?? null;
}

/**
 * Writes down that Telegram refused this customer for good — blocked, or the
 * chat deleted — so nothing queues them again.
 *
 * `notify_enabled` is the shop's one «reachable» flag: every sweep that sends
 * to customers filters on it, and `handle.ts` sets it back on any inbound
 * update, which is the only proof a block is over. The outbox learned to
 * write it on a 403 first; the broadcast sweep did not, and the broadcast is
 * where most blocks are discovered — sixteen thousand sends, and every one
 * that came back 403 was offered a fresh row, and a two-second slot, on the
 * next announcement (#381).
 */
export async function markUnreachable(db: D1Database, telegramId: number): Promise<void> {
  await db
    .prepare(
      `UPDATE users SET notify_enabled = false, updated_at = now()
        WHERE telegram_id = ?1 AND notify_enabled`,
    )
    .bind(telegramId)
    .run();
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
  // A cancelled broadcast's stragglers: rows a 429 handed back to PENDING
  // after the cancel route had already closed the rest. Nothing will claim
  // them (`cancelled_at` above), so without this the broadcast never finishes.
  await db
    .prepare(
      `UPDATE broadcast_recipients r
          SET status = 'FAILED', error = 'cancelled'
         FROM broadcasts b
        WHERE b.id = r.broadcast_id
          AND b.cancelled_at IS NOT NULL
          AND b.finished_at IS NULL
          AND r.status = 'PENDING'`,
    )
    .run();
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
