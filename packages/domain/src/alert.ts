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
 * `dedupe_key = alert:<evt>:<Tehran hour>` means a fault that repeats a
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
import type { LogRecord } from './log.js';

/** Tehran is UTC+3:30 and has no DST — the same constant `historyRange.ts` uses. */
const TEHRAN_OFFSET_MS = 3.5 * 60 * 60 * 1000;

/**
 * The events worth waking someone for.
 *
 * Explicitly listed, not «every error». An alert on every error is an alert on
 * nothing: the channel fills with noise, the noise gets muted, and the one
 * message that mattered is muted with it. Each of these means a customer is
 * already worse off — money taken and nothing delivered, an SMS that never
 * became a payment, a message that has stopped being retried.
 */
export const ALERTING_EVENTS: ReadonlySet<string> = new Set([
  'ingest.sms.failed',
  'match.failed',
  'settle.failed',
  'provision.failed',
  'notify.dead',
  'webhook.dead',
  'boot.schema_behind',
]);

/** `alert:<evt>:<YYYY-MM-DDTHH in Tehran>` — the hour bucket that is also the rate limit. */
export function alertDedupeKey(evt: string, atMs: number): string {
  return `alert:${evt}:${new Date(atMs + TEHRAN_OFFSET_MS).toISOString().slice(0, 13)}`;
}

/** How much of an error message travels to Telegram. The rest is in `app_events`. */
const MAX_ERROR_CHARS = 400;

function tehranTime(atMs: number): string {
  return new Intl.DateTimeFormat('fa-IR', {
    timeZone: 'Asia/Tehran',
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(atMs));
}

/**
 * The message body.
 *
 * Plain text with no `parse_mode`, matching the rest of this bot (`menu.ts`):
 * an alert whose own formatting can make `sendMessage` fail is an alert that
 * arrives as a 400 in a log nobody is reading — which is the situation this
 * whole feature exists to end.
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
  if (record.err) {
    lines.push('', `${record.err.name}: ${record.err.message}`.slice(0, MAX_ERROR_CHARS));
  }
  // The fields are already redacted — this is the same record that was
  // written to stdout, not a second serialisation with its own rules.
  const fields = Object.entries(record.fields);
  if (fields.length > 0) {
    lines.push('', fields.map(([k, v]) => `${k}=${String(v)}`).join(' · ').slice(0, 300));
  }
  return lines.join('\n');
}

/**
 * Queue one alert. Returns whether a row was written — `false` means an
 * identical alert is already queued for this hour, which is the intended
 * outcome, not a failure.
 *
 * Takes `db` rather than a transaction: an alert is about something that has
 * already gone wrong, and it must not be able to roll back the handling of it.
 */
export async function alert(
  db: D1Database | D1DatabaseSession,
  chatId: number,
  record: LogRecord,
  atMs: number = Date.now(),
): Promise<boolean> {
  const written = await db
    .prepare(
      // The same table `apps/bot/src/notify.ts` enqueues into and flushes.
      // Written here rather than through its `enqueue` because that one takes
      // a producer's transaction, and this deliberately has none.
      `INSERT INTO bot_notifications (dedupe_key, chat_id, body)
       VALUES (?1, ?2, ?3)
       ON CONFLICT (dedupe_key) DO NOTHING`,
    )
    .bind(alertDedupeKey(record.evt, atMs), chatId, alertText(record, atMs))
    .run();
  return written.meta.changes > 0;
}
