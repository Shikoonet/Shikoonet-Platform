/**
 * The long-polling loop.
 *
 * No public port, no TLS certificate, no webhook — which is the point. The one
 * production incident waiting to happen on the PHP bot is an expiring
 * certificate silently killing the webhook; a bot that dials out has nothing to
 * expire.
 *
 * The offset is deliberately NOT persisted. On restart Telegram replays whatever
 * it still holds, and `telegram_updates` rejects the ones already handled. One
 * mechanism for exactly-once, not two that can disagree.
 */

import type { D1Database } from '@shikoo/database';
import { handleUpdate, type HandleStatus } from './handle.js';
import type { TelegramApi } from './telegram.js';

export interface PollResult {
  /** Offset to pass to the next call. */
  offset: number;
  counts: Record<HandleStatus, number>;
  failed: number;
}

export const EMPTY_COUNTS: Record<HandleStatus, number> = {
  processed: 0,
  duplicate: 0,
  ignored: 0,
};

/**
 * One fetch-and-handle cycle.
 *
 * The returned offset is an ACKNOWLEDGEMENT, not a high-water mark. Passing it
 * to the next getUpdates tells Telegram to delete everything below it, so it may
 * only advance to just before the first update whose handler threw.
 *
 * That distinction is the whole safety property. Rolling the claim back buys
 * nothing if we then confirm past the update — Telegram would drop it and the
 * retry we rolled back for would never arrive. With the database down that is
 * not one lost message, it is every message in the batch.
 *
 * Updates after a failure are still handled, so one stuck customer does not
 * block the queue; they simply arrive again next cycle and dedupe to
 * 'duplicate'. Telegram returns updates in ascending update_id order, which is
 * what makes "before the first failure" well defined.
 *
 * ponytail: an update that fails forever is retried forever, loudly, once per
 * cycle. The alternative — confirming past it — loses real work in the far more
 * likely case of a transient database outage. If a genuine poison update ever
 * appears, give it a failure count and skip it after N cycles.
 */
export async function pollOnce(
  db: D1Database,
  api: TelegramApi,
  offset: number,
  timeoutSec = 25,
  signal?: AbortSignal,
): Promise<PollResult> {
  const updates = await api.getUpdates(offset, timeoutSec, signal);
  const counts = { ...EMPTY_COUNTS };
  let failed = 0;
  let confirmedThrough = offset - 1;
  let sawFailure = false;

  for (const update of updates) {
    let outcome;
    try {
      outcome = await handleUpdate(db, update);
    } catch (err) {
      failed++;
      sawFailure = true;
      console.error(`[bot] update ${update.update_id} failed, will be retried`, err);
      continue;
    }
    if (!sawFailure) confirmedThrough = update.update_id;
    counts[outcome.status]++;
    for (const reply of outcome.replies) {
      try {
        await api.sendMessage(reply.chatId, reply.text);
      } catch (err) {
        // The transaction has already committed. Retrying the whole update would
        // now be a no-op against the claim, so the reply is simply lost and said
        // to be lost.
        console.error(`[bot] reply for update ${update.update_id} was not delivered`, err);
      }
    }
  }

  return { offset: confirmedThrough + 1, counts, failed };
}

/** Drops claims old enough that Telegram can no longer redeliver them. */
export async function pruneUpdates(db: D1Database, olderThanDays = 7): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM telegram_updates WHERE processed_at < now() - make_interval(days => ?1)`)
    .bind(olderThanDays)
    .run();
  return result.meta.changes;
}

export interface RunOptions {
  timeoutSec?: number;
  /** Prune every N cycles. At a 25s poll, 200 cycles is roughly 90 minutes. */
  pruneEveryCycles?: number;
  /** Pause after a failed cycle. A knob because tests cannot wait five seconds. */
  backoffMs?: number;
  signal?: AbortSignal;
}

export async function run(
  db: D1Database,
  api: TelegramApi,
  options: RunOptions = {},
): Promise<void> {
  const timeoutSec = options.timeoutSec ?? 25;
  const pruneEvery = options.pruneEveryCycles ?? 200;
  const backoffMs = options.backoffMs ?? 5_000;
  let offset = 0;
  let cycles = 0;

  while (!options.signal?.aborted) {
    try {
      const result = await pollOnce(db, api, offset, timeoutSec, options.signal);
      offset = result.offset;
    } catch (err) {
      // A shutdown aborts the poll in flight, which surfaces here as a fetch
      // error. It is not a failure and must not be logged as one.
      if (options.signal?.aborted) break;
      // Telegram down, network down, database down: back off and keep the
      // process alive. A crash-loop here is indistinguishable from an outage
      // and much harder to read in the logs.
      console.error('[bot] poll cycle failed', err);
      await sleep(backoffMs, options.signal);
    }
    if (++cycles % pruneEvery === 0) {
      await pruneUpdates(db).catch((err: unknown) => {
        console.error('[bot] prune failed', err);
      });
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // Both sides are cleaned up. Without this the listener outlives the sleep,
    // so a long outage — one backoff per failed cycle — piles listeners onto the
    // same signal until Node starts warning about a leak.
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
