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
import { settleVerifiedPayments, type Notification } from './settle.js';
import { provisionPaidOrders } from './provision.js';
import { syncSubscriptions } from './sync.js';
import { warnExpiringServices } from './warn.js';
import type { TelegramApi, TelegramUpdate } from './telegram.js';

export interface PollResult {
  /** Offset to pass to the next call. */
  offset: number;
  counts: Record<HandleStatus, number>;
  failed: number;
  /** Updates given up on this cycle after exhausting their attempts. */
  abandoned: number;
}

/**
 * How many healthy-cycle failures an update gets before it is dropped.
 *
 * "Healthy" is doing the work here: a cycle in which every update failed is an
 * outage, and its failures are forgiven rather than counted (see `pollOnce`).
 * So this is three failures the database was demonstrably alive for, which no
 * transient fault produces and every genuine poison update does.
 */
export const MAX_UPDATE_ATTEMPTS = 3;

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
 * An update that keeps failing is eventually dropped rather than retried for
 * ever. Retrying for ever was the old behaviour and it is how one customer
 * stops the bot for everybody: the offset never advances, so no update behind
 * the poison one is ever acknowledged. What made that safe to change is
 * separating the two reasons a handler throws. A cycle where EVERY update
 * failed is an outage — the database is down, the update is innocent, and its
 * attempts are forgiven. A failure in a cycle where something else succeeded is
 * the update's own; three of those and it goes.
 */
export async function pollOnce(
  db: D1Database,
  api: TelegramApi,
  offset: number,
  timeoutSec = 25,
  signal?: AbortSignal,
  /** Failures per update id, carried across cycles by `run`. */
  attempts: Map<number, number> = new Map(),
): Promise<PollResult> {
  const updates = await api.getUpdates(offset, timeoutSec, signal);
  const counts = { ...EMPTY_COUNTS };
  let failed = 0;
  let abandoned = 0;
  let confirmedThrough = offset - 1;
  let sawFailure = false;

  for (const update of updates) {
    if ((attempts.get(update.update_id) ?? 0) >= MAX_UPDATE_ATTEMPTS) {
      // Given up on. Acknowledging it is the whole point — it is what lets the
      // offset move past and unblocks every update behind it. The row in
      // `telegram_updates` was rolled back with each failure, so nothing here
      // claims it; if Telegram ever redelivers it the count is gone and it gets
      // a fresh set of attempts, which is the right answer after a restart.
      abandoned++;
      attempts.delete(update.update_id);
      console.error(
        `[bot] update ${update.update_id} failed ${MAX_UPDATE_ATTEMPTS} times and was dropped`,
      );
      if (!sawFailure) confirmedThrough = update.update_id;
      await answer(api, update);
      continue;
    }

    let outcome;
    try {
      outcome = await handleUpdate(db, update);
    } catch (err) {
      failed++;
      sawFailure = true;
      attempts.set(update.update_id, (attempts.get(update.update_id) ?? 0) + 1);
      console.error(`[bot] update ${update.update_id} failed, will be retried`, err);
      // Still stop the client's spinner. A button that keeps spinning through a
      // database outage reads as a bot that died, and answering says nothing
      // about whether the work succeeded.
      await answer(api, update);
      continue;
    }
    attempts.delete(update.update_id);
    if (!sawFailure) confirmedThrough = update.update_id;
    counts[outcome.status]++;
    for (const reply of outcome.replies) {
      try {
        if (reply.editMessageId === undefined) {
          await api.sendMessage(reply.chatId, reply.text, reply.keyboard);
        } else {
          await api.editMessageText(reply.chatId, reply.editMessageId, reply.text, reply.keyboard);
        }
      } catch (err) {
        // The transaction has already committed. Retrying the whole update would
        // now be a no-op against the claim, so the reply is simply lost and said
        // to be lost.
        console.error(`[bot] reply for update ${update.update_id} was not delivered`, err);
      }
    }
    await answer(api, update);
  }

  // Everything failed, so the fault is shared and none of it belongs to any one
  // update. Forgiving the whole batch is what stops a database outage from
  // spending three attempts on every message waiting in it — the case the old
  // comment was right to be afraid of.
  if (updates.length > 0 && failed === updates.length) {
    for (const update of updates) attempts.delete(update.update_id);
  }

  return { offset: confirmedThrough + 1, counts, failed, abandoned };
}

/**
 * Clears the spinner on a button press.
 *
 * Deliberately outside handleUpdate: a redelivered update is answered too, and
 * that one never reaches a handler at all. Telegram spins the button for a few
 * seconds otherwise, which every customer reads as a hung bot.
 */
async function answer(api: TelegramApi, update: TelegramUpdate): Promise<void> {
  if (!update.callback_query) return;
  try {
    await api.answerCallbackQuery(update.callback_query.id);
  } catch (err) {
    // Expired callback ids are normal and not worth a failure; the customer has
    // already seen their reply.
    console.error(`[bot] callback ${update.callback_query.id} was not acknowledged`, err);
  }
}

/**
 * Settles whatever the hub has verified since the last cycle and tells the
 * customers.
 *
 * A sweep that throws must not take the poll loop down with it — the loop's job
 * is to keep answering Telegram, and a database hiccup here is not a reason to
 * stop doing that. It is logged and retried next cycle, because the rows still
 * qualify.
 */
async function sweep(
  api: TelegramApi,
  name: string,
  produce: () => Promise<Notification[]>,
): Promise<void> {
  let notifications;
  try {
    notifications = await produce();
  } catch (err) {
    console.error(`[bot] ${name} failed, will retry`, err);
    return;
  }
  for (const note of notifications) {
    try {
      await api.sendMessage(note.chatId, note.text);
    } catch (err) {
      // The row is already advanced, so this message will not be produced again.
      // Losing it is the cost of not sending it twice, and the payment and the
      // order are both visible on the dashboard either way.
      console.error(`[bot] ${name}: message to chat ${note.chatId} was not delivered`, err);
    }
  }
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
  // Deliberately in memory and deliberately not persisted, like the offset
  // above: a restart is a legitimate second chance, and an update that only
  // fails because of the state a crashed process left behind deserves one.
  const attempts = new Map<number, number>();

  while (!options.signal?.aborted) {
    try {
      const result = await pollOnce(db, api, offset, timeoutSec, options.signal, attempts);
      const stalled = result.failed > 0 && result.offset === offset;
      offset = result.offset;
      // Nothing in the batch could be acknowledged, so getUpdates will hand the
      // same failure straight back — and because there ARE updates waiting, it
      // returns instantly instead of long-polling. Without this pause the loop
      // spins at the speed of the network: a five-minute database outage
      // produced 350 attempts and 6,000 log lines, hammering a database that
      // was trying to come back and earning a 429 from Telegram on the way.
      if (stalled) await sleep(backoffMs, options.signal);
      // A payment is verified by the hub, in another process, with nothing to
      // call us back. Sweeping here rather than adding a cron keeps it to one
      // running service, and a 25-second poll makes "verified" and "the customer
      // was told" at most one cycle apart.
      await sweep(api, 'settling verified payments', () => settleVerifiedPayments(db));
      // Delivery is its own sweep rather than a step inside settlement. The two
      // fail for unrelated reasons — a claim that cannot be settled is a money
      // problem, a panel that will not answer is not — and a panel being down
      // must never hold up telling a customer their payment was confirmed.
      await sweep(api, 'provisioning paid orders', () => provisionPaidOrders(db));
      // Refreshing what «سرویس های من» shows. Produces no messages — it rate
      // limits itself off `last_synced_at`, so calling it every cycle costs one
      // aggregate query on the nine cycles out of ten that do nothing.
      try {
        await syncSubscriptions(db);
      } catch (err) {
        console.error('[bot] subscription sync failed, will retry', err);
      }
      // After the sync, so a service is warned about the volume the panel
      // reports rather than the figure from ten minutes ago.
      await sweep(api, 'warning about services running out', () => warnExpiringServices(db));
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
