/**
 * «🤖 بکاپ ربات» — the database, into the reports group, every three hours.
 *
 * Mirzabot's `cronbot/backupbot.php`: `mysqldump` the whole database, post the
 * file into the `backupfile` topic of `Channel_Report` with the caption
 * «📌 خروجی دیتابیس ربات اصلی», or post «❌❌❌❌❌❌ خطا در بکاپ گیری» when the dump
 * fails. Same words here, `pg_dump` instead. Sam, 2026-09-19: three hours.
 *
 * ## When it is due
 *
 * Measured from the last `sweep.acted` row for this job in `app_events` — the
 * same row the cron panel reads for «آخرین اجرا» — and from the last
 * `backup.failed`. Not from memory: a poller restarted every two hours would
 * otherwise never back up, and one restarted every two minutes would back up
 * every two minutes. A failure counts as a run so a broken `pg_dump` is one
 * message per three hours, not one per sweep round.
 *
 * ## What it does not do
 *
 * No group configured, nothing happens — legacy's rule (`backupbot.php`
 * returns when `Channel_Report` is empty) and the same one every other report
 * follows. No topic configured, the file lands in General, like every other
 * report. Nothing is written to disk: the dump is piped into memory and gzipped
 * there, which the image's read-only working directory requires anyway.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import type { D1Database } from '@shikoo/database';
import { createLogger } from '@shikoo/domain';
import { loadShopSettings } from './settings.js';
import type { TelegramApi } from './telegram.js';

const log = createLogger('bot');

export const BACKUP_EVERY_MS = 3 * 60 * 60 * 1000;

/** `lang/fa.php` › `Admin.report.backupCaption`, trailing space dropped. */
export const BACKUP_CAPTION = '📌 خروجی دیتابیس ربات اصلی';
/** `lang/fa.php` › `keyboard.backupError`, trailing space dropped. */
export const BACKUP_FAILED_TEXT = '❌❌❌❌❌❌ خطا در بکاپ گیری';

const run = promisify(execFile);

/**
 * The whole database as plain SQL, gzipped.
 *
 * `--no-owner --no-privileges` because the file is for restoring into whatever
 * Postgres is at hand, not for reproducing this one's roles. The URL is passed
 * as an argument — visible to `ps` inside the container, which only the `node`
 * user runs — rather than through `PGDATABASE`, which libpq does not expand
 * into a connection string.
 */
export async function pgDump(databaseUrl: string): Promise<Uint8Array> {
  const { stdout } = await run('pg_dump', ['--no-owner', '--no-privileges', databaseUrl], {
    encoding: 'buffer',
    // ponytail: the whole dump in memory. Production is a few megabytes; if it
    // ever nears this, stream it to a temp file and upload from there.
    maxBuffer: 512 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  });
  return gzipSync(stdout);
}

/** `backup_2026-09-19_1500.sql.gz` — Tehran wall clock, like legacy's date. */
export function backupFilename(nowMs: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `backup_${p['year']}-${p['month']}-${p['day']}_${p['hour']}${p['minute']}.sql.gz`;
}

export interface BackupOptions {
  now?: number;
  /** The dump itself, replaceable so a test needs no `pg_dump` on the box. */
  dump?: (databaseUrl: string) => Promise<Uint8Array>;
}

/**
 * Posts one backup when one is due. Returns 1 when it did, 0 otherwise — the
 * shape `poll.ts`'s `sweep()` records as `sweep.acted`.
 */
export async function sweepBackup(
  db: D1Database,
  api: TelegramApi,
  options: BackupOptions = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  const { reportChatId: chatId, reportTopics } = await loadShopSettings(db);
  if (chatId === null) return 0;

  const recent = await db
    .prepare(
      `SELECT 1 AS one FROM app_events
        WHERE ((evt = 'sweep.acted' AND fields->>'job' = 'backup') OR evt = 'backup.failed')
          AND at > to_timestamp(?1 / 1000.0)
        LIMIT 1`,
    )
    .bind(now - BACKUP_EVERY_MS)
    .first<{ one: number }>();
  if (recent !== null) return 0;

  const databaseUrl = process.env['DATABASE_URL'];
  const threadId = reportTopics.backupfile;
  try {
    if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is not set');
    const bytes = await (options.dump ?? pgDump)(databaseUrl);
    await api.sendDocumentBytes(chatId, bytes, backupFilename(now), BACKUP_CAPTION, threadId);
    return 1;
  } catch (err) {
    // Persisted (`error` always is), and that row is what makes the next
    // attempt three hours away rather than 25 seconds. Legacy's own sentence
    // goes into the backup topic; the alert sink puts the error itself into
    // «❌ گزارش خطا ها».
    log.error('backup.failed', {}, err);
    await api.sendMessage(chatId, BACKUP_FAILED_TEXT, undefined, threadId).catch(() => undefined);
    return 0;
  }
}
