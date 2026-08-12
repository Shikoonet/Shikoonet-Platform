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
 * The offset advances past every update we received, including ones whose
 * handler threw. That is safe precisely because the throw rolled the claim back:
 * the update is unclaimed, so if Telegram redelivers it we try again, and if it
 * does not, we have not silently marked a failure as done.
 */
export async function pollOnce(
  db: D1Database,
  api: TelegramApi,
  offset: number,
  timeoutSec = 25,
): Promise<PollResult> {
  const updates = await api.getUpdates(offset, timeoutSec);
  const counts = { ...EMPTY_COUNTS };
  let failed = 0;
  let highest = offset - 1;

  for (const update of updates) {
    if (update.update_id > highest) highest = update.update_id;
    let outcome;
    try {
      outcome = await handleUpdate(db, update);
    } catch (err) {
      // One bad update must not stop the queue behind it.
      failed++;
      console.error(`[bot] update ${update.update_id} failed`, err);
      continue;
    }
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

  return { offset: highest + 1, counts, failed };
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
      const result = await pollOnce(db, api, offset, timeoutSec);
      offset = result.offset;
    } catch (err) {
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
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
