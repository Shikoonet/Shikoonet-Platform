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
import { settingText } from './settings.js';
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

let limiter: RateLimit = makeLimiter();

/**
 * Whether this customer has just gone over the limit.
 *
 * One call per update, and it counts. A caller that asks twice about the same
 * message spends two of the customer's 35.
 */
export async function overSpamLimit(telegramId: number): Promise<boolean> {
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
 * Where it goes is `setting.Channel_Report`, which is the legacy's own column
 * for this and needs no plumbing through the poll loop. (The nightly report
 * reads `REPORT_CHAT_ID` from the environment instead; that was a choice for a
 * thing the poll loop already owned, and these two should be reconciled when
 * one of them is next touched.) An empty column means no report — the same
 * thing `index.php:326` does with `strlen(...) > 0`.
 *
 * Returns whether the customer was newly blocked, which is what the caller
 * needs to decide whether to say anything at all.
 */
export async function blockForSpam(
  tx: D1DatabaseSession,
  opts: { userId: number; telegramId: number; updateId: number },
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

  const channel = await settingText(tx, 'bot', 'Channel_Report');
  if (channel !== null) {
    const chatId = Number(channel);
    if (Number.isSafeInteger(chatId)) {
      await enqueue(tx, {
        // The update that tripped it. Unique per block event, so an operator
        // who unblocks and is flooded again does get told the second time.
        dedupeKey: `spam:${opts.userId}:${opts.updateId}`,
        chatId,
        text: menu.spamBlockedReport(opts.telegramId),
        // The same button the legacy attaches, pointing at our own admin user
        // screen. `usr` takes the internal id and re-checks the presser's
        // permission, so a channel member who is not an admin gets nothing.
        keyboard: [[{ text: menu.ADMIN_OPEN_USER, callback_data: encode('usr', opts.userId) }]],
      });
    }
  }
  return true;
}
