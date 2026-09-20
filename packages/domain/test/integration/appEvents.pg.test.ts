/**
 * The durable half, against a real Postgres.
 *
 * Nothing here can be faked usefully. What is being asserted is engine
 * behaviour: that `jsonb` accepts the redacted fields, that the `CHECK` on
 * `level` refuses anything outside the three, that `at::timestamptz` takes an
 * ISO string from `Date`, and — the one that matters most — that the hourly
 * alert rate limit is enforced by a `UNIQUE` constraint rather than by code
 * that could be called twice.
 *
 * Needs DATABASE_URL and the migrations applied (`pnpm sim:up`).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPostgresD1 } from '@shikoo/db';
import { hasMarkup, reportTopicKey, toTelegramHtml } from '@shikoo/contracts';
import { alert, alertDedupeKey, alertText } from '../../src/alert.js';
import { createPostgresEventSink, pruneAppEvents } from '../../src/eventSink.js';
import { createLogger, setEventSink, type LogRecord } from '../../src/log.js';

const { db, pool } = createPostgresD1();

const SVC = 'e2e-log';
const ALERT_CHAT = -100_777_000_111;
const NOW_MS = Date.UTC(2026, 7, 22, 18, 40, 0);

const TOPIC_KEY = reportTopicKey('errorreport');

async function cleanup(): Promise<void> {
  await db.prepare(`DELETE FROM app_events WHERE svc = ?1`).bind(SVC).run();
  await db.prepare(`DELETE FROM bot_notifications WHERE chat_id = ?1`).bind(ALERT_CHAT).run();
  await db.prepare(`DELETE FROM settings WHERE scope = 'bot' AND key = ?1`).bind(TOPIC_KEY).run();
}

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  await cleanup();
});

afterEach(() => {
  setEventSink(null);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

async function rows(): Promise<
  {
    level: string;
    evt: string;
    trace: string | null;
    ref: string | null;
    fields: unknown;
    err: string | null;
  }[]
> {
  const res = await db
    .prepare(
      `SELECT level, evt, trace, ref, fields, err FROM app_events
        WHERE svc = ?1 ORDER BY id`,
    )
    .bind(SVC)
    .all<{
      level: string;
      evt: string;
      trace: string | null;
      ref: string | null;
      fields: unknown;
      err: string | null;
    }>();
  return res.results;
}

/** The sink is fire-and-forget by design, so the test waits for the row, not for a promise. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50 && (await rows()).length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('app_events', () => {
  it('stores a record the way the log wrote it', async () => {
    setEventSink(createPostgresEventSink(db));
    createLogger(SVC)
      .with({ trace: 'u991' })
      .error(
        'provision.failed',
        { ref: 'ORD-42', kind: 'pasarguard', apiKey: 'must-not-appear' },
        new Error('panel refused'),
      );

    await settle();
    const [row] = await rows();
    expect(row?.level).toBe('error');
    expect(row?.trace).toBe('u991');
    expect(row?.ref).toBe('ORD-42');
    expect(row?.fields).toEqual({ kind: 'pasarguard', apiKey: '[redacted]' });
    expect(row?.err).toContain('panel refused');
    // Postgres, not the logger, is the witness that the secret never landed.
    const raw = await db
      .prepare(
        `SELECT count(*)::int AS n FROM app_events WHERE svc = ?1 AND fields::text LIKE '%must-not-appear%'`,
      )
      .bind(SVC)
      .first<{ n: number }>();
    expect(raw?.n).toBe(0);
  });

  it('lets the process carry on when the insert fails', async () => {
    // A sink pointed at a table that does not exist — the same shape as a
    // database that has gone away mid-incident.
    const broken = createPostgresEventSink(db);
    setEventSink((record: LogRecord) => {
      broken({ ...record, level: 'catastrophe' as LogRecord['level'] });
    });

    expect(() => createLogger(SVC).error('settle.failed', { claim: 'c-1' })).not.toThrow();
    // Give the rejected insert time to be swallowed rather than to surface as
    // an unhandled rejection, which would fail this file.
    await new Promise((r) => setTimeout(r, 200));
    expect(await rows()).toHaveLength(0);
  });

  it('prunes what is older than the window and keeps what is not', async () => {
    await db
      .prepare(
        `INSERT INTO app_events (at, level, svc, evt) VALUES
           (now() - interval '40 days', 'warn', ?1, 'old.one'),
           (now() - interval '2 days',  'warn', ?1, 'recent.one')`,
      )
      .bind(SVC)
      .run();

    expect(await pruneAppEvents(db, 30)).toBe(1);
    expect((await rows()).map((r) => r.evt)).toEqual(['recent.one']);
  });
});

describe('alerting', () => {
  it('queues one message an hour for a repeating fault, by constraint', async () => {
    const record: LogRecord = {
      ts: new Date(NOW_MS).toISOString(),
      level: 'error',
      svc: SVC,
      evt: 'provision.failed',
      fields: {},
    };

    expect(await alert(db, ALERT_CHAT, record, NOW_MS)).toBe(true);
    expect(await alert(db, ALERT_CHAT, record, NOW_MS + 60_000)).toBe(false);
    // The hour turns over and the shop hears about it again — a limit that
    // silenced the fault permanently would be worse than no limit.
    expect(await alert(db, ALERT_CHAT, record, NOW_MS + 3_600_000)).toBe(true);

    const queued = await db
      .prepare(`SELECT count(*)::int AS n FROM bot_notifications WHERE chat_id = ?1`)
      .bind(ALERT_CHAT)
      .first<{ n: number }>();
    expect(queued?.n).toBe(2);
  });

  it('buckets by the Tehran hour, which is what the admin reads on their clock', () => {
    // 18:40 UTC is 22:10 in Tehran. Measured against `Intl` rather than
    // against the function under test.
    const tehranHour = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Tehran',
      hour: '2-digit',
      hour12: false,
    }).format(new Date(NOW_MS));
    expect(alertDedupeKey('x', undefined, NOW_MS)).toBe(`alert:x:-:2026-08-22T${tehranHour}`);
  });

  it('is one message per failing thing, not one per event name', async () => {
    const at = (ref: string): LogRecord => ({
      ts: new Date(NOW_MS).toISOString(),
      level: 'error',
      svc: SVC,
      evt: 'provision.failed',
      ref,
      fields: {},
    });
    // Two orders failing in the same hour are two customers, and were one
    // message before #382.
    expect(await alert(db, ALERT_CHAT, at('ORD-1'), NOW_MS)).toBe(true);
    expect(await alert(db, ALERT_CHAT, at('ORD-2'), NOW_MS)).toBe(true);
    expect(await alert(db, ALERT_CHAT, at('ORD-1'), NOW_MS + 60_000)).toBe(false);
  });

  it('alerts on every error and on no warning, with a chat configured', async () => {
    setEventSink(createPostgresEventSink(db, { alertChatId: ALERT_CHAT }));
    const log = createLogger(SVC);
    log.warn('panel.slow', {});
    // Not on any list — before #382 this reached `/admin/events` and nobody.
    log.error('panel.unreachable', { ref: 'ORD-9', host: 'p1' }, new Error('ECONNREFUSED'));

    await settle();
    await new Promise((r) => setTimeout(r, 200));
    const queued = await db
      .prepare(`SELECT body, message_thread_id FROM bot_notifications WHERE chat_id = ?1`)
      .bind(ALERT_CHAT)
      .all<{ body: string; message_thread_id: number | null }>();
    expect(queued.results).toHaveLength(1);
    const body = queued.results[0]?.body ?? '';
    expect(body).toContain('panel.unreachable');
    expect(body).toContain('ORD-9');
    // The detail the events page shows: the stack, quoted, and the fields.
    expect(body).toMatch(/<blockquote>Error: ECONNREFUSED\n\s+at /);
    expect(body).toContain('<code>host=p1</code>');
    // No topic configured → the group's General, never `0`.
    expect(queued.results[0]?.message_thread_id).toBeNull();
  });

  it('does not alert about an alert that died — the one error that would breed for ever', async () => {
    setEventSink(createPostgresEventSink(db, { alertChatId: ALERT_CHAT }));
    const log = createLogger(SVC);
    // The shape `notify.ts` logs for a DEAD row, `kind` being the key prefix.
    log.error('notify.dead', { ref: '5', kind: 'alert', destination: 'report' });
    log.error('notify.dead', { ref: '6', kind: 'invoice', destination: 'customer' });

    await settle();
    await new Promise((r) => setTimeout(r, 200));
    const queued = await db
      .prepare(`SELECT body FROM bot_notifications WHERE chat_id = ?1`)
      .bind(ALERT_CHAT)
      .all<{ body: string }>();
    expect(queued.results.map((r) => /مورد: (\S+)/.exec(r.body)?.[1])).toEqual(['6']);
  });

  it('lands in «❌ گزارش خطا ها» from any service, read from settings', async () => {
    await db
      .prepare(`INSERT INTO settings (scope, key, value) VALUES ('bot', ?1, '77'::jsonb)`)
      .bind(TOPIC_KEY)
      .run();
    const record: LogRecord = {
      ts: new Date(NOW_MS).toISOString(),
      level: 'error',
      svc: SVC,
      evt: 'ingest.parse_failed',
      fields: {},
    };
    expect(await alert(db, ALERT_CHAT, record, NOW_MS)).toBe(true);
    const row = await db
      .prepare(`SELECT message_thread_id FROM bot_notifications WHERE chat_id = ?1`)
      .bind(ALERT_CHAT)
      .first<{ message_thread_id: number | null }>();
    expect(row?.message_thread_id).toBe(77);
  });

  it('survives the HTML escaper: a stack full of angle brackets is markup only where we put it', () => {
    const err = new Error('boom <b>not markup</b>');
    err.stack = 'Error: boom <b>not markup</b>\n    at <anonymous> (file.ts:1:1)';
    const text = alertText(
      {
        ts: new Date(NOW_MS).toISOString(),
        level: 'error',
        svc: SVC,
        evt: 'x.failed',
        fields: { note: 'a < b & c' },
      },
      NOW_MS,
    );
    const withErr = alertText(
      {
        ts: new Date(NOW_MS).toISOString(),
        level: 'error',
        svc: SVC,
        evt: 'x.failed',
        fields: {},
        err: { name: err.name, message: err.message, stack: err.stack },
      },
      NOW_MS,
    );
    // Measured against the sender's own converter, not against this module.
    expect(hasMarkup(text)).toBe(true);
    expect(toTelegramHtml(text)).toContain('<code>note=a &lt; b &amp; c</code>');
    expect(toTelegramHtml(withErr)).toContain('&lt;anonymous&gt;');
    expect(toTelegramHtml(withErr)).toContain('&lt;b&gt;not markup&lt;/b&gt;');
    expect(toTelegramHtml(withErr)).toMatch(/^[^<]*<blockquote>[^<]*<\/blockquote>[^<]*$/s);
  });

  it('cuts a runaway stack inside the quote, never through its closing tag', () => {
    const text = alertText(
      {
        ts: new Date(NOW_MS).toISOString(),
        level: 'error',
        svc: SVC,
        evt: 'x.failed',
        fields: {},
        err: { name: 'Error', message: 'deep', stack: 'Error: deep\n' + '    at f (a.ts:1:1)\n'.repeat(400) },
      },
      NOW_MS,
    );
    expect(text.length).toBeLessThan(4096);
    expect(text).toMatch(/…<\/blockquote>$/);
  });
});
