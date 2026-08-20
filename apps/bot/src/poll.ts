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
import { handleUpdate, refreshShopContent, type HandleStatus } from './handle.js';
import * as notify from './notify.js';
import { settleVerifiedPayments } from './settle.js';
import { provisionPaidOrders } from './provision.js';
import { syncSubscriptions } from './sync.js';
import { warnExpiringServices } from './warn.js';
import { expireUnpaidOrders } from './expire.js';
import {
  claimBroadcastBatch,
  closeFinishedBroadcasts,
  markBroadcastFailed,
  markBroadcastSent,
  strandedSendingCount,
  SEND_GAP_MS,
} from './broadcast.js';
import { sweepDailyReport } from './report.js';
import type { TelegramApi, TelegramUpdate } from './telegram.js';
import { qrPng } from './qr.js';

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

/** What is known about an update that has failed at least once. */
export interface Attempt {
  count: number;
  lastError: string;
}

/**
 * Keeps an update the bot is about to give up on.
 *
 * One row per update id with a running total, not one per drop: Telegram can
 * redeliver an update that was never acknowledged, and a restart loses the
 * in-memory count, so the same id can arrive here twice. Two rows would read
 * like two customers.
 *
 * ponytail: a record, not a retry queue. Nothing reads this back — replaying a
 * dropped update is a decision a person makes with the payload in front of
 * them, and building the button before anyone has needed it once would be
 * guessing at what they would want it to do.
 */
async function recordDeadUpdate(
  db: D1Database,
  update: TelegramUpdate,
  record: Attempt,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO telegram_dead_updates (update_id, payload, attempts, last_error)
       VALUES (?1, ?2::jsonb, ?3, ?4)
       ON CONFLICT (update_id) DO UPDATE
          SET attempts   = telegram_dead_updates.attempts + excluded.attempts,
              last_error = excluded.last_error,
              dropped_at = now()`,
    )
    // Truncated because it is a driver's message, not a document: Postgres
    // errors carry the failing statement, and the statement can be long.
    .bind(update.update_id, JSON.stringify(update), record.count, record.lastError.slice(0, 2_000))
    .run();
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
  /**
   * Failures per update id, carried across cycles by `run`.
   *
   * The reason is carried with the count because the two are separated in
   * time: the third failure happens in one cycle and the update is dropped
   * when it comes round in the next, and by then the error that killed it is
   * only in a log line nobody kept.
   */
  attempts: Map<number, Attempt> = new Map(),
): Promise<PollResult> {
  const updates = await api.getUpdates(offset, timeoutSec, signal);
  const counts = { ...EMPTY_COUNTS };
  let failed = 0;
  let abandoned = 0;
  let confirmedThrough = offset - 1;
  let sawFailure = false;

  for (const update of updates) {
    const record = attempts.get(update.update_id);
    if (record !== undefined && record.count >= MAX_UPDATE_ATTEMPTS) {
      // Given up on. Acknowledging it is the whole point — it is what lets the
      // offset move past and unblocks every update behind it. The row in
      // `telegram_updates` was rolled back with each failure, so nothing here
      // claims it; if Telegram ever redelivers it the count is gone and it gets
      // a fresh set of attempts, which is the right answer after a restart.
      //
      // Kept before it is acknowledged, because acknowledging is final: Telegram
      // deletes the update and will not send it again. Everything this bot does
      // is somebody's money or somebody's service, so "gone, and a log line"
      // was not an answer.
      try {
        await recordDeadUpdate(db, update, record);
      } catch (err) {
        // Not dropped. This used to drop anyway, and the argument for it was
        // that refusing would put the queue back behind a poison update — the
        // freeze this counter exists to prevent.
        //
        // The argument does not survive looking at WHEN this branch is
        // reachable. Three failures accumulate on a single-update batch, which
        // on a quiet bot is a database outage; and a database outage is also
        // the thing that makes this insert fail. So the two conditions do not
        // just co-occur, they are usually the same event — and what is being
        // thrown away is whatever a customer sent during it, which in this bot
        // is «پرداخت کردم» or a receipt.
        //
        // The freeze that replaces it is not the unbounded one the old comment
        // feared. It lasts exactly as long as the database is unreachable,
        // during which nothing could have been processed anyway; the moment the
        // insert succeeds the update is dropped and everything behind it moves.
        // A genuinely poison update still drains, one cycle later.
        console.error(
          `[bot] update ${update.update_id} failed ${MAX_UPDATE_ATTEMPTS} times but could not be ` +
            'recorded; holding it rather than losing the payload',
          err,
        );
        // The same shape as an ordinary failure: the offset does not move past
        // it, the count is left where it is, and the spinner still stops.
        sawFailure = true;
        await answer(api, update);
        continue;
      }
      abandoned++;
      attempts.delete(update.update_id);
      console.error(
        `[bot] update ${update.update_id} failed ${MAX_UPDATE_ATTEMPTS} times and was dropped` +
          ' — kept in telegram_dead_updates',
      );
      if (!sawFailure) confirmedThrough = update.update_id;
      await answer(api, update);
      continue;
    }

    let outcome;
    try {
      // `api` for the membership gate's one call back to Telegram. The default
      // `fetch` is named explicitly only because it sits between them.
      outcome = await handleUpdate(db, update, globalThis.fetch, api);
    } catch (err) {
      failed++;
      sawFailure = true;
      attempts.set(update.update_id, {
        count: (attempts.get(update.update_id)?.count ?? 0) + 1,
        lastError: String(err),
      });
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
        if (reply.qrOf !== undefined) {
          // The only reply here with a fallback, because it is the only one
          // whose text stands on its own: `reply.text` for the QR button IS the
          // subscription link. Nothing on this path is retried — the
          // transaction has committed and re-fetching the update would be a
          // no-op against the claim — so a picture Telegram refuses used to
          // take the link with it and the customer was left with a button that
          // did nothing. The picture is worth trying for and not worth losing
          // the address over.
          try {
            await api.sendPhotoBytes(reply.chatId, await qrPng(reply.qrOf), reply.text, reply.keyboard);
          } catch (err) {
            console.error(`[bot] QR reply for update ${update.update_id} failed; sending the link alone`, err);
            await api.sendMessage(reply.chatId, reply.text, reply.keyboard);
          }
        } else if (reply.photo !== undefined) {
          await api.sendPhoto(reply.chatId, reply.photo, reply.text);
        } else if (reply.document !== undefined) {
          await api.sendDocument(reply.chatId, reply.document, reply.text);
        } else if (reply.editMessageId === undefined) {
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
  //
  // `> 1`, not `> 0`, and the difference is the whole rule. "Everything failed"
  // is evidence about the cause only when there was more than one thing to
  // fail; in a batch of one it is the identical observation whether the
  // database is down or the update is poison, so it distinguishes nothing.
  // Forgiving it anyway wiped the counter every cycle on a quiet bot — which is
  // every night — so MAX_UPDATE_ATTEMPTS was never reached and one bad press
  // froze the bot for everybody, exactly the failure this counter exists to
  // stop. Where the signal is absent the safe default is to count: the cost is
  // a bounded few messages during a real outage, against an unbounded freeze.
  if (updates.length > 1 && failed === updates.length) {
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
 * Runs one sweep and swallows its failure.
 *
 * A sweep that throws must not take the poll loop down with it — the loop's job
 * is to keep answering Telegram, and a database hiccup here is not a reason to
 * stop doing that. It is logged and retried next cycle, because the rows still
 * qualify.
 *
 * It used to send the sweep's messages too, and drop any that Telegram refused.
 * The sweeps now write what the customer is owed into `bot_notifications`, in
 * the transaction that earns it, and `flush` delivers with retries — so this is
 * only error containment.
 */
async function sweep(name: string, produce: () => Promise<number>): Promise<void> {
  try {
    await produce();
  } catch (err) {
    console.error(`[bot] ${name} failed, will retry`, err);
  }
}

/**
 * Sends the next slice of whatever broadcast is outstanding.
 *
 * Its own sweep rather than a `sweep()` call, because the generic helper throws
 * the send result away and a broadcast is the one place the shop is owed a
 * count. A failure here is recorded against the recipient — almost always a
 * customer who blocked the bot — and never retried.
 *
 * Paced rather than fired off at once. `SEND_GAP_MS` keeps this under
 * Telegram's bulk ceiling; the cost is a few seconds added to the cycle while a
 * broadcast is running, which is why the admin is told it takes some minutes.
 */
export async function sweepBroadcasts(
  db: D1Database,
  api: TelegramApi,
  signal?: AbortSignal,
): Promise<number> {
  let batch;
  try {
    batch = await claimBroadcastBatch(db);
  } catch (err) {
    console.error('[bot] broadcast batch could not be claimed, will retry', err);
    return 0;
  }
  let sent = 0;
  for (const message of batch) {
    // Everything still claimed when this breaks stays SENDING rather than
    // being counted as delivered. That is the ordinary shutdown, not a crash,
    // and until 2026-08-19 it silently inflated the number the shop was told.
    if (signal?.aborted) break;
    try {
      await api.sendMessage(message.chatId, message.text);
      // After the send, not before it. A failure here leaves the row SENDING —
      // Telegram has the message and our record does not say so, which is a
      // discrepancy somebody can see, rather than a message nobody sent that
      // the shop was told about.
      await markBroadcastSent(db, message.broadcastId, message.userId).catch((e) =>
        console.error('[bot] a broadcast was sent but could not be recorded', e),
      );
      sent += 1;
    } catch (err) {
      await markBroadcastFailed(db, message.broadcastId, message.userId, String(err)).catch(
        (e) => console.error('[bot] could not record a failed broadcast recipient', e),
      );
    }
    await sleep(SEND_GAP_MS, signal);
  }
  if (batch.length > 0) {
    await closeFinishedBroadcasts(db).catch((err) =>
      console.error('[bot] could not close finished broadcasts', err),
    );
  }
  // The only voice a stranded row has. It is deliberately not retried — whether
  // Telegram accepted the message before the process died is exactly what
  // nobody knows, and guessing wrong spams a paying customer.
  const stranded = await strandedSendingCount(db).catch(() => 0);
  if (stranded > 0) {
    console.error(`[bot] ${stranded} broadcast message(s) were claimed and never finished`);
  }
  return sent;
}

/**
 * Drops claims old enough that Telegram can no longer redeliver them, and dead
 * letters old enough that nobody is going to read them.
 *
 * The two windows are different because they answer different questions. Seven
 * days is how long a claim has to outlive Telegram's redelivery. Thirty is how
 * long a person plausibly has to notice a dropped update and look at it — and
 * it is a ceiling as much as a floor, because a dead letter holds a customer's
 * message verbatim and that is not ours to keep for ever.
 */
export async function pruneUpdates(
  db: D1Database,
  olderThanDays = 7,
  deadLettersOlderThanDays = 30,
): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM telegram_updates WHERE processed_at < now() - make_interval(days => ?1)`)
    .bind(olderThanDays)
    .run();
  await db
    .prepare(
      `DELETE FROM telegram_dead_updates WHERE dropped_at < now() - make_interval(days => ?1)`,
    )
    .bind(deadLettersOlderThanDays)
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
  /**
   * Called once per completed cycle, for the container health check to read.
   * Injected rather than imported so the tests can watch it without touching
   * the filesystem — and so a cycle that never finishes cannot fake one.
   */
  onCycle?: () => void;
  /**
   * Where the nightly report goes. Absent means no report, which is how the
   * legacy behaves when its `Channel_Report` is empty — a shop that does not
   * want it should not be paying six aggregate queries a night to not send it.
   */
  reportChatId?: number;
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
  const attempts = new Map<number, Attempt>();

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
      // Every sweep below sends the customer a sentence the shop is allowed to
      // have rewritten, and the bindings those sentences are built from were
      // only ever refreshed while handling an update. A quiet night — no
      // updates at all — meant a settled payment or an expired invoice was
      // announced in the wording the code ships. Cached for thirty seconds, so
      // on a busy bot this is the same read `handleUpdate` just did.
      await refreshShopContent(db);
      // A payment is verified by the hub, in another process, with nothing to
      // call us back. Sweeping here rather than adding a cron keeps it to one
      // running service, and a 25-second poll makes "verified" and "the customer
      // was told" at most one cycle apart.
      await sweep('settling verified payments', () => settleVerifiedPayments(db));
      // Delivery is its own sweep rather than a step inside settlement. The two
      // fail for unrelated reasons — a claim that cannot be settled is a money
      // problem, a panel that will not answer is not — and a panel being down
      // must never hold up telling a customer their payment was confirmed.
      await sweep('provisioning paid orders', () => provisionPaidOrders(db));
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
      await sweep('warning about services running out', () => warnExpiringServices(db));
      // Last, because it is the only sweep that closes something rather than
      // advancing it, and an order settled or delivered earlier in this same
      // cycle must have moved out of AWAITING_PAYMENT before this looks.
      await sweep('expiring unpaid orders', () => expireUnpaidOrders(db));
      // Yesterday's numbers, once. Cheap on the ~3,400 cycles a day that have
      // nothing to do — it asks whether the report exists before it builds one,
      // which is a primary-key hit against six aggregate queries.
      await sweep('the daily report', async () => {
        const queued = await sweepDailyReport(db, options.reportChatId ?? null);
        if (queued) console.log('[bot] queued the daily report');
        return queued ? 1 : 0;
      });
      // After every sweep that can enqueue, so a payment settled at the top of
      // this cycle is told about at the bottom of the same one — the property
      // the old inline sending had, kept.
      //
      // What is new is that a refusal here is not the end of the message. It
      // stays in `bot_notifications` and is tried again next cycle, so Telegram
      // being unreachable for a minute costs a minute rather than a customer.
      await notify.flush(db, api);
      // Last of all, and after everything that a customer is waiting on. A
      // broadcast is the only sweep that is allowed to take seconds rather than
      // milliseconds, so nothing time-sensitive queues behind it.
      await sweepBroadcasts(db, api, options.signal);
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
    // After the cycle, including after a failed one that backed off — the
    // question the probe asks is "is this loop still turning", and a loop that
    // is retrying a database outage every five seconds IS still turning. What
    // it must not survive is a cycle that never returns, which is exactly the
    // case a liveness check on PID 1 cannot see.
    options.onCycle?.();
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
