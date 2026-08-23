/**
 * The flood guard, and the block it ends in.
 *
 * Parity with `index.php:307–341`, which sits above every dispatch: 35 messages
 * inside one minute and the customer is blocked, told why, and reported to the
 * shop's channel with a button that opens them in the admin panel.
 *
 * ## Why the counter is in memory and the block is not
 *
 * The legacy keeps `user.last_message_time` and `user.message_count` on the row
 * and writes BOTH on every single update. That is two writes per message on the
 * hottest path in the bot, and it is the same shape we took out of the operator
 * session on 2026-08-19 — where the cost turned out not to be churn but row
 * locks, because two updates from one customer then queue behind each other.
 *
 * Nothing is lost by counting in memory. `singleton.ts` holds a Postgres
 * advisory lock on the bot token, so exactly one process polls; a counter in
 * that process is the whole truth. A restart forgets who was mid-flood, and
 * that is an acceptable trade for a guard whose job is to stop 35 messages a
 * minute: somebody who can restart our bot is not being held back by this.
 *
 * The block itself is a row, because it has to outlive everything.
 *
 * ## The threshold is the legacy's, and it is not a setting
 *
 * 35 and one minute are hardcoded in `index.php` — there is no column for
 * either in `setting`, so there is nothing for an admin to have configured and
 * nothing to read. They are named here rather than spelled inline so a test can
 * measure against the same two numbers this file acts on.
 */

import type { D1DatabaseSession } from '@shikoo/db';
import { fixedWindowRateLimit, setCustomerStatus, type RateLimit } from '@shikoo/domain';
import { enqueue } from './notify.js';
import * as menu from './menu.js';
import { encode } from './callback.js';

/** `index.php:317` — `if ($user['message_count'] >= "35")`. */
export const SPAM_LIMIT = 35;
/** `index.php:310` — `floor((now - last_message_time) / 60) >= 1`. */
export const SPAM_WINDOW_MS = 60_000;

/**
 * What `blocked_reason` records.
 *
 * English and machine-ish, like the panel's own `blocked from the bot admin
 * panel`, because this column is read by operators in the dashboard and never
 * shown to the customer. The customer gets `SPAM_BLOCKED` instead.
 */
export const SPAM_BLOCK_REASON = 'auto-blocked for flooding the bot';

/**
 * `now` is a closure, not `Date.now` itself.
 *
 * `fixedWindowRateLimit` captures whatever it is handed at construction, so
 * passing the function directly would pin the REAL clock into a limiter built
 * at module load — and then a test that pins the clock to prove the window
 * reopens would be measuring nothing. The indirection is one call deep and it
 * is the difference between a testable guard and a green test about a guard
 * that never resets.
 */
function makeLimiter(): RateLimit {
  return fixedWindowRateLimit({
    limit: SPAM_LIMIT,
    windowMs: SPAM_WINDOW_MS,
    now: () => Date.now(),
  });
}

/**
 * A second window whose only job is to answer "have I charged for this update
 * already?".
 *
 * The counter lives in memory and the update's claim lives in a transaction,
 * and the two do not roll back together. `handleUpdate` claims the update id
 * first and spends a token a few lines later, so a handler that threw below
 * rolled the claim back, Telegram redelivered the same update, the claim
 * succeeded again — and the customer paid a second token for one message. Up
 * to `MAX_UPDATE_ATTEMPTS`, so one update could cost three of thirty-five. A
 * short database outage was enough to auto-block somebody for traffic they
 * never sent.
 *
 * A limit of one per update id, in the same kind of map for the same window, so
 * it inherits the sweep instead of needing a second thing to prune. An update
 * older than the window cannot still be inside a flood.
 */
function makeSeen(): RateLimit {
  return fixedWindowRateLimit({ limit: 1, windowMs: SPAM_WINDOW_MS, now: () => Date.now() });
}

let limiter: RateLimit = makeLimiter();
let seen: RateLimit = makeSeen();

/**
 * Whether this customer has just gone over the limit.
 *
 * One call per update, and it counts — but only once per update, however many
 * times that update is delivered. A redelivered update was under the limit the
 * first time (being over it ends in a block and a return, not an exception), so
 * answering `false` for a repeat is the same answer it got before.
 */
export async function overSpamLimit(telegramId: number, updateId: number): Promise<boolean> {
  const first = await seen.limit({ key: `${telegramId}:${updateId}` });
  if (!first.success) return false;
  const { success } = await limiter.limit({ key: String(telegramId) });
  return !success;
}

/**
 * Forgets every window.
 *
 * For tests, which share one process: a suite that floods a customer would
 * otherwise leave them over the limit for every file after it.
 */
export function resetSpamWindows(): void {
  limiter = makeLimiter();
  seen = makeSeen();
}

/**
 * Blocks the customer and tells the two people who need to know.
 *
 * `setCustomerStatus` rather than an `UPDATE` here: it is the same helper the
 * admin panel and the dashboard block with, so there is one statement in the
 * codebase that can put a customer in this state and one place to change what
 * that means.
 *
 * The channel line goes through `bot_notifications`, not straight out. A flood
 * is exactly when Telegram is most likely to refuse us, and the report is the
 * only trace an operator has that a customer was cut off — losing it would
 * leave somebody blocked with nobody told.
 *
 * Where it goes is `ShopSettings.reportChatId` — one field, read by the nightly
 * report too. For a day there were two answers to "which channel?", this one
 * and an environment variable, and nothing made them agree. Null means the shop
 * has not configured one, which is the same thing `index.php:326` does with
 * `strlen(...) > 0`: no report, and the block still happens.
 *
 * Returns whether the customer was newly blocked, which is what the caller
 * needs to decide whether to say anything at all.
 */
export async function blockForSpam(
  tx: D1DatabaseSession,
  opts: { userId: number; telegramId: number; updateId: number; reportChatId: number | null },
): Promise<boolean> {
  const outcome = await setCustomerStatus(tx, {
    userId: opts.userId,
    status: 'BLOCKED',
    reason: SPAM_BLOCK_REASON,
  });
  // Already blocked, or the row is gone. Either way there is nothing to
  // announce: an operator who unblocks somebody must not be told again on the
  // next message that they were blocked.
  if (!outcome || !outcome.changed) return false;

  if (opts.reportChatId !== null) {
    await enqueue(tx, {
      // The update that tripped it. Unique per block event, so an operator
      // who unblocks and is flooded again does get told the second time.
      dedupeKey: `spam:${opts.userId}:${opts.updateId}`,
      chatId: opts.reportChatId,
      // The report itself, with no button under it. It used to carry «open
      // this user», which opened the bot's own admin panel — and that panel is
      // the dashboard now. A button pointing at a screen that no longer exists
      // is worse than no button: it looks like the bot is broken rather than
      // like the screen moved.
      text: menu.spamBlockedReport(opts.telegramId),
    });
  }
  return true;
}
