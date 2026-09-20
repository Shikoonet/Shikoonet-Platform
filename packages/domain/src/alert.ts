/**
 * Telling a human, once, that something broke — through the queue that already
 * exists.
 *
 * `bot_notifications` (migration 0024) is a durable outbox with dedupe, a
 * doubling backoff and a DEAD state, and the bot flushes it every cycle. An
 * alert is a message to one chat that must not be lost and must not repeat, so
 * it is the same problem the table was built for. Writing a second sender —
 * with its own retry, its own rate limit and its own way of failing at 3am —
 * would be one more thing to remember at 3am.
 *
 * ## The rate limit is the UNIQUE constraint
 *
 * `dedupe_key = alert:<evt>:<ref>:<Tehran hour>` means a fault that repeats a
 * thousand times an hour produces one message, and the enforcement is
 * `ON CONFLICT DO NOTHING` on a column that is already unique. No counter, no
 * timer, no state to get wrong — and it survives a restart, which an in-memory
 * limiter does not.
 *
 * The hour is a **Tehran** hour rather than a UTC one because it exists to be
 * legible to the person reading the channel: «one message an hour» should mean
 * the hour on their clock. The boundary therefore lands on the half hour, which
 * is what UTC+3:30 costs and is not worth a second timezone to avoid.
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';
import { reportTopicKey } from '@shikoo/contracts';
import type { LogRecord, SerializedError } from './log.js';

/** Tehran is UTC+3:30 and has no DST — the same constant `historyRange.ts` uses. */
const TEHRAN_OFFSET_MS = 3.5 * 60 * 60 * 1000;

/**
 * The Tehran hour, as the bucket a repeating fault is folded into.
 *
 * Every `error` alerts — the list this used to be (#382) meant a customer's
 * failed order reached Telegram only if its event name had been added here, and
 * `/admin/events` showed the rest to nobody. The list is gone; the level is the
 * filter, the same one the events page has.
 */
export function alertDedupeKey(evt: string, ref: string | undefined, atMs: number): string {
  const hour = new Date(atMs + TEHRAN_OFFSET_MS).toISOString().slice(0, 13);
  // `ref` is in the key so that ten orders failing in one hour are ten
  // messages, and one order failing ten times is one. Without it the second
  // order was silently the first one's duplicate.
  return `alert:${evt}:${ref ?? '-'}:${hour}`;
}

/**
 * How much of the stack and of the fields travel. Telegram's cap is 4096 on
 * the visible text; these two plus the header stay under it, because the bot's
 * `clamp()` runs before the HTML conversion and would otherwise cut through a
 * closing tag — a 400, a plain re-send, and a spurious `markup_refused`.
 */
const MAX_STACK_CHARS = 3000;
const MAX_FIELDS_CHARS = 600;

/**
 * `slice` that never ends on half an emoji — the same rule as `cutTo` in the
 * bot. A lone high surrogate is not valid UTF-8, and Telegram refuses the body
 * on both the rich and the plain send, which makes the row DEAD on attempt one.
 */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = (text.charCodeAt(max - 1) & 0xfc00) === 0xd800 ? max - 1 : max;
  return `${text.slice(0, end)}\n…`;
}

/**
 * The four strings `toTelegramHtml` would pass through as markup, made inert.
 * An upstream HTML error body, or a stack cut between such tags, would
 * otherwise unbalance the quote. Angle quotes keep the text readable.
 */
function inert(text: string): string {
  return text.replace(/<(\/?(?:code|blockquote))>/g, '‹$1›');
}

function tehranTime(atMs: number): string {
  return new Intl.DateTimeFormat('fa-IR', {
    timeZone: 'Asia/Tehran',
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(atMs));
}

/**
 * The error as `/admin/events` prints it: the stack, which on V8 already
 * begins with «Name: message», and the cause under it. The same rule as
 * `ErrorBlock` in `EventsPage.tsx` — a headline printed above a stack that
 * starts with the same sentence reads as two errors that happen to match.
 */
function errorBlock(err: SerializedError): string {
  const headline = `${err.name}: ${err.message}`;
  const body = err.stack?.startsWith(headline)
    ? err.stack
    : `${headline}${err.stack ? `\n${err.stack}` : ''}`;
  const cause = err.cause ? `\ncause: ${errorBlock(err.cause)}` : '';
  return cut(inert(body.trimEnd() + cause), MAX_STACK_CHARS);
}

/**
 * The message body.
 *
 * The bot's own `<blockquote>` and `<code>` — the two tags `toTelegramHtml`
 * knows — and nothing else. Everything between them is escaped by the sender,
 * so a stack full of `<anonymous>` cannot become a 400; and if Telegram refuses
 * the markup anyway, `withEmojiFallback` sends the same text plain. Sam,
 * 2026-09-20 (#382): the error quoted, with its detail, not a 400-character
 * summary of it.
 */
export function alertText(record: LogRecord, atMs: number): string {
  const lines = [
    '⚠️ خطای سامانه',
    `رویداد: ${record.evt}`,
    `سرویس: ${record.svc}`,
    ...(record.ref ? [`مورد: ${record.ref}`] : []),
    ...(record.trace ? [`ردیابی: ${record.trace}`] : []),
    `زمان: ${tehranTime(atMs)}`,
  ];
  if (record.err) lines.push('', `<blockquote>${errorBlock(record.err)}</blockquote>`);
  // The fields are already redacted — this is the same record that was
  // written to stdout, not a second serialisation with its own rules.
  const fields = Object.entries(record.fields);
  if (fields.length > 0) {
    const text = fields
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join('\n');
    lines.push('', `<code>${cut(inert(text), MAX_FIELDS_CHARS)}</code>`);
  }
  return lines.join('\n');
}

/** A topic id as the settings row holds it — a small positive integer, or nothing. */
function topicOf(value: unknown): number | null {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Queue one alert. Returns whether a row was written — `false` means an
 * identical alert is already queued for this hour, which is the intended
 * outcome, not a failure.
 *
 * Takes `db` rather than a transaction: an alert is about something that has
 * already gone wrong, and it must not be able to roll back the handling of it.
 *
 * The topic is «❌ گزارش خطا ها», read from `settings` here rather than
 * handed in: the workers have no settings cache, so until #382 their alerts
 * landed in the group's General while the bot's went to the topic. One read
 * on a path that is already writing a row is the same cost as before.
 */
export async function alert(
  db: D1Database | D1DatabaseSession,
  chatId: number,
  record: LogRecord,
  atMs: number = Date.now(),
): Promise<boolean> {
  const topic = await db
    .prepare(`SELECT value FROM settings WHERE scope = 'bot' AND key = ?1`)
    .bind(reportTopicKey('errorreport'))
    .first<{ value: unknown }>();
  const written = await db
    .prepare(
      // The same table `apps/bot/src/notify.ts` enqueues into and flushes.
      // Written here rather than through its `enqueue` because that one takes
      // a producer's transaction, and this deliberately has none.
      `INSERT INTO bot_notifications (dedupe_key, chat_id, body, message_thread_id)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (dedupe_key) DO NOTHING`,
    )
    .bind(
      // A dead outbox row's `ref` is its own id, so with it in the key a nudge
      // sweep that meets three hundred customers who blocked the bot is three
      // hundred messages in the hour. That one folds to one, as it always did;
      // `/admin/events` still has every row.
      alertDedupeKey(record.evt, record.evt === 'notify.dead' ? undefined : record.ref, atMs),
      chatId,
      alertText(record, atMs),
      topicOf(topic?.value),
    )
    .run();
  return written.meta.changes > 0;
}
