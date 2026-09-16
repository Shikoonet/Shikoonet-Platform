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
 * ## The threshold is the legacy's default, and a setting since 2026-09-16
 *
 * 35 and one minute are hardcoded in `index.php`. The window still is; the
 * limit is «حداکثر پیام یک مشتری در دقیقه» in the dashboard now, read through
 * `ShopSettings.spamLimitPerMinute`, and 35 is what a shop that never touches
 * it gets. Sam asked after mashing buttons on the test bot and hearing
 * nothing: the block was the first thing a flooder was ever told. So there is
 * a warning at half the limit too, once per window, in place of that
 * message's answer.
 */

import type { D1DatabaseSession } from '@shikoo/db';
import { fixedWindowRateLimit, setCustomerStatus, type RateLimit } from '@shikoo/domain';
import { enqueue } from './notify.js';
import * as menu from './menu.js';

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
 * One customer's minute: how many updates, until when, and whether they have
 * already been warned in it.
 *
 * A map of its own rather than `fixedWindowRateLimit`, because that limiter
 * answers only «over or not» and the warning needs the count. The limit is
 * not baked in at construction either — it is a setting now, and an admin
 * who lowers it must not wait for a restart.
 */
interface Minute {
  count: number;
  resetAt: number;
  warned: boolean;
}
let minutes = new Map<number, Minute>();
let sweepAt = 0;

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

let seen: RateLimit = makeSeen();

export type SpamVerdict = 'ok' | 'warn' | 'block';

/** Where the warning lands: halfway, so 35 warns on the 18th message. */
export function spamWarnAt(limit: number): number {
  return Math.ceil(limit / 2);
}

/**
 * What this update earns its sender: nothing, a warning, or the block.
 *
 * One call per update, and it counts — but only once per update, however many
 * times that update is delivered. A redelivered update was under the limit the
 * first time (being over it ends in a block and a return, not an exception), so
 * answering `ok` for a repeat is the same answer it got before.
 *
 * `warn` fires exactly once per window, on the message that reaches
 * `spamWarnAt(limit)`; the messages after it are `ok` until the limit.
 */
export async function spamVerdict(
  telegramId: number,
  updateId: number,
  limit: number,
): Promise<SpamVerdict> {
  const first = await seen.limit({ key: `${telegramId}:${updateId}` });
  if (!first.success) return 'ok';
  const t = Date.now();
  // The same sweep `fixedWindowRateLimit` does: nothing until the map is
  // big, then dead minutes go, at most once a window.
  if (minutes.size >= 1000 && t >= sweepAt) {
    for (const [id, m] of minutes) if (m.resetAt <= t) minutes.delete(id);
    sweepAt = t + SPAM_WINDOW_MS;
  }
  let m = minutes.get(telegramId);
  if (m === undefined || m.resetAt <= t) {
    m = { count: 0, resetAt: t + SPAM_WINDOW_MS, warned: false };
    minutes.set(telegramId, m);
  }
  m.count += 1;
  if (m.count > limit) return 'block';
  if (!m.warned && m.count >= spamWarnAt(limit)) {
    m.warned = true;
    return 'warn';
  }
  return 'ok';
}

/**
 * Forgets every window.
 *
 * For tests, which share one process: a suite that floods a customer would
 * otherwise leave them over the limit for every file after it.
 */
export function resetSpamWindows(): void {
  minutes = new Map();
  sweepAt = 0;
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
  opts: {
    userId: number;
    telegramId: number;
    updateId: number;
    reportChatId: number | null;
    /** «⚙️ سایر گزارشات» — legacy's home for everything without a topic. */
    reportThreadId?: number | null;
  },
): Promise<boolean> {
  const outcome = await setCustomerStatus(tx, {
    userId: opts.userId,
    status: 'BLOCKED',
    reason: SPAM_BLOCK_REASON,
    // Nobody pressed anything. `SYSTEM` rather than an invented email, for the
    // reason 0013 gave Telegram admins their own column instead of writing a
    // fabricated address into a table whose purpose is being believed later.
    //
    // This is the caller the audit exists for: until now a flood block left
    // `users.blocked_reason` and nothing else — no actor, no timestamp, no row
    // anywhere — so «چرا این مشتری مسدود است؟» had no answer for exactly the
    // blocks no human witnessed.
    actor: { kind: 'SYSTEM' },
    note: `flood guard, update ${opts.updateId}`,
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
      threadId: opts.reportThreadId ?? null,
    });
  }
  return true;
}
