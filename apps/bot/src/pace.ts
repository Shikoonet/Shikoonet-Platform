/**
 * The one clock both senders share (#364).
 *
 * Telegram's limit is on the BOT, not on either of the loops that talk to it.
 * `sweepBroadcasts` paced itself with two locals — the next slot and the
 * pause a 429 imposed — and `notify.flush` knew about neither: a receipt went
 * out into the middle of a ban and lengthened it, and the pause itself died
 * with the sweep that held it. Both now read and write here.
 *
 * Two different things, kept apart on purpose:
 *
 *   - `nextSendAt` is the pace: no broadcast send STARTS before it. A worker
 *     reserves its slot from it before it waits.
 *   - `holdUntil` is an outbox send having just happened. A receipt does not
 *     wait for a slot — a customer's receipt is not throttled to one every
 *     two seconds — but it TAKES one: no broadcast send starts within a gap
 *     of it, whatever slot the worker had reserved. That is what «the
 *     broadcast pauses one slot and carries on» means, and it is a separate
 *     field because a reservation already made cannot be moved.
 *   - `pauseUntil` is a ban: nobody sends before it, whichever loop.
 *
 * Process-wide state, which is enough while the bot is one container — the
 * only thing that survives a restart is the pause, and it survives in
 * `settings` because a container that comes back mid-ban and sends at once
 * is how a fifty-minute ban becomes a longer one.
 */

import type { D1Database } from '@shikoo/database';
import { createLogger } from '@shikoo/domain';

const log = createLogger('bot');

const PAUSE_KEY = 'telegram_pause_until';

export const pace = { nextSendAt: 0, holdUntil: 0, pauseUntil: 0 };

/** For the tests: the module is shared state, and a 30-second pause one test
 *  asked for must not be the next test's problem. */
export function resetPace(): void {
  pace.nextSendAt = 0;
  pace.holdUntil = 0;
  pace.pauseUntil = 0;
}

/**
 * Takes the next slot and says how long to wait for it. The reservation is
 * made BEFORE the wait, so twelve workers asking at once get twelve different
 * slots rather than one.
 */
export function reserveSlot(gapMs: number, now = Date.now()): number {
  const wait = pace.nextSendAt - now;
  pace.nextSendAt = Math.max(pace.nextSendAt, now) + gapMs;
  return wait > 0 ? wait : 0;
}

/** An outbox send happened: no broadcast send for one gap. */
export function consumeSlot(gapMs: number, now = Date.now()): void {
  pace.holdUntil = Math.max(pace.holdUntil, now + gapMs);
  pace.nextSendAt = Math.max(pace.nextSendAt, now + gapMs);
}

/** Milliseconds until the ban lifts; 0 when there is none. Both loops. */
export function pausedFor(now = Date.now()): number {
  return Math.max(0, pace.pauseUntil - now);
}

/** Milliseconds a BROADCAST send must still wait: the ban, or the outbox's slot. */
export function heldFor(now = Date.now()): number {
  return Math.max(pausedFor(now), pace.holdUntil - now, 0);
}

/**
 * Telegram said wait. Held in memory for every worker in this process, and
 * written down for the next one. The write is not awaited by the send path —
 * a ban that cannot be recorded is still a ban here — but it is not silent.
 */
export function pauseFor(db: D1Database, waitMs: number, now = Date.now()): void {
  pace.pauseUntil = Math.max(pace.pauseUntil, now + waitMs);
  void db
    .prepare(
      `INSERT INTO settings (scope, key, value, updated_at)
       VALUES ('bot', ?1, to_jsonb(?2::bigint), now())
       ON CONFLICT (scope, key) DO UPDATE
         SET value = GREATEST(settings.value, EXCLUDED.value), updated_at = now()`,
    )
    .bind(PAUSE_KEY, pace.pauseUntil)
    .run()
    .catch((err: unknown) => log.warn('pace.pause_unrecorded', {}, err));
}

/** What the previous container was told. Read once, when a drain starts. */
export async function loadPause(db: D1Database): Promise<void> {
  try {
    const row = await db
      .prepare(`SELECT value FROM settings WHERE scope = 'bot' AND key = ?1`)
      .bind(PAUSE_KEY)
      .first<{ value: unknown }>();
    const until = Number(row?.value ?? 0);
    if (Number.isFinite(until) && until > Date.now()) {
      pace.pauseUntil = Math.max(pace.pauseUntil, until);
      log.warn('pace.pause_resumed', { until_ms: until - Date.now() });
    }
  } catch (err) {
    log.warn('pace.pause_unread', {}, err);
  }
}
