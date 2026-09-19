/**
 * The three-hourly backup, against the real database.
 *
 * `pg_dump` itself is injected: what is under test is WHEN a backup goes and
 * WHERE, and a box without the right `pg_dump` must not turn that into a red
 * suite. The cadence is measured against rows this test writes into
 * `app_events`, because that table — not memory — is what the sweep reads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_CAPTION,
  BACKUP_EVERY_MS,
  BACKUP_FAILED_TEXT,
  backupFilename,
  sweepBackup,
} from '../src/backup.js';
import { invalidateShopSettings } from '../src/settings.js';
import { db } from './helpers/env.js';
import { stubApi } from './helpers/telegram.js';

/** 2026-09-19 11:30:00 UTC — 15:00 in Tehran (UTC+3:30). */
const NOW_MS = Date.UTC(2026, 8, 19, 11, 30, 0);
const GROUP = -1_001_555_000;
const TOPIC = 77;

async function setting(key: string, value: unknown): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (scope, key, value) VALUES ('bot', ?1, ?2::jsonb)
       ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value`,
    )
    .bind(key, JSON.stringify(value))
    .run();
  invalidateShopSettings();
}

async function acted(evt: 'sweep.acted' | 'backup.failed', agoMs: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_events (at, level, svc, evt, fields)
       VALUES (to_timestamp(?1 / 1000.0), 'info', 'bot', ?2, ?3::jsonb)`,
    )
    .bind(NOW_MS - agoMs, evt, JSON.stringify(evt === 'sweep.acted' ? { job: 'backup' } : {}))
    .run();
}

function fakes() {
  const dump = vi.fn(async (_url: string) => new Uint8Array([1, 2, 3]));
  const sent: unknown[][] = [];
  const said: unknown[][] = [];
  const api = stubApi({
    sendDocumentBytes: async (...args) => {
      sent.push(args);
    },
    sendMessage: async (...args) => {
      said.push(args);
      return { messageId: null };
    },
  });
  return { dump, api, sent, said };
}

beforeEach(async () => {
  await db.prepare(`DELETE FROM app_events WHERE evt IN ('sweep.acted', 'backup.failed')`).run();
  await db.prepare(`DELETE FROM settings WHERE scope = 'bot' AND key = 'Channel_Report'`).run();
  await setting('topic_backupfile', TOPIC);
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  process.env['DATABASE_URL'] ??= 'postgres://unused';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the three-hourly backup', () => {
  it('does nothing without a reports group — legacy’s rule', async () => {
    const { dump, api, sent } = fakes();
    expect(await sweepBackup(db, api, { dump })).toBe(0);
    expect(dump).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('posts the dump into the backup topic with legacy’s caption', async () => {
    await setting('Channel_Report', String(GROUP));
    const { dump, api, sent } = fakes();

    expect(await sweepBackup(db, api, { dump })).toBe(1);

    expect(dump).toHaveBeenCalledWith(process.env['DATABASE_URL']);
    expect(sent).toEqual([
      [GROUP, new Uint8Array([1, 2, 3]), 'backup_2026-09-19_1500.sql.gz', BACKUP_CAPTION, TOPIC],
    ]);
  });

  it('waits three hours after the last one, measured from app_events', async () => {
    await setting('Channel_Report', String(GROUP));
    await acted('sweep.acted', BACKUP_EVERY_MS - 60_000);
    const early = fakes();
    expect(await sweepBackup(db, early.api, { dump: early.dump })).toBe(0);
    expect(early.dump).not.toHaveBeenCalled();

    await db.prepare(`DELETE FROM app_events WHERE evt = 'sweep.acted'`).run();
    await acted('sweep.acted', BACKUP_EVERY_MS + 60_000);
    const due = fakes();
    expect(await sweepBackup(db, due.api, { dump: due.dump })).toBe(1);
  });

  it('says so in the topic when the dump fails, and not again for three hours', async () => {
    await setting('Channel_Report', String(GROUP));
    const { api, sent, said } = fakes();
    const dump = vi.fn(async () => {
      throw new Error('pg_dump: connection refused');
    });

    expect(await sweepBackup(db, api, { dump })).toBe(0);
    expect(sent).toEqual([]);
    expect(said).toEqual([[GROUP, BACKUP_FAILED_TEXT, undefined, TOPIC]]);

    // The failure is a persisted error; here the row is written by hand, since
    // the test process has no event sink attached.
    await acted('backup.failed', 60_000);
    const again = fakes();
    expect(await sweepBackup(db, again.api, { dump: again.dump })).toBe(0);
    expect(again.dump).not.toHaveBeenCalled();
  });

  it('names the file by the Tehran clock — rule 6, against Intl', () => {
    const tehran = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tehran',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .format(new Date(NOW_MS))
      .replace(/(\d{4}-\d{2}-\d{2}), (\d{2}):(\d{2})/, '$1_$2$3');
    expect(backupFilename(NOW_MS)).toBe(`backup_${tehran}.sql.gz`);
    expect(backupFilename(NOW_MS)).toBe('backup_2026-09-19_1500.sql.gz');
  });
});
