/**
 * «گروه گزارش‌ها» — pointing the bot at a forum group and making the topics.
 *
 * The assertion this file exists for is the ORDER. `Channel_Report` is what
 * every producer reads to decide whether to report at all, so writing it before
 * the topics exist would make the shop start publishing into a group whose
 * topics are all zero — every report in General, which is the state this route
 * exists to leave behind. A run that fails half way must leave the shop
 * reporting exactly where it was.
 *
 * Telegram is stubbed per method rather than with one blanket answer, because
 * «getChat says yes and createForumTopic says no» is precisely the case the
 * ordering has to survive.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';
import { REPORT_KINDS } from '@shikoo/contracts';

const ADMIN = 'admin-rg@example.com';
const REVIEWER = 'reviewer-rg@example.com';
const KEY_HEX = 'd'.repeat(64);
const TOKEN = '7712345678:AAH9fakeTokenForTestsOnly_not_a_real_one';
const GROUP = -1_001_777_000;

function envAs(email = ADMIN) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A Telegram that answers each method as told, and counts what it was asked.
 *
 * `topics` is a queue: one entry per `createForumTopic`, so a run can be made
 * to fail on the fourth and be asserted about.
 */
function telegram(opts: { isForum?: boolean; topics?: (number | 'fail')[] } = {}) {
  const madeFor: string[] = [];
  let next = 100;
  const queue = [...(opts.topics ?? [])];
  // `Parameters<typeof fetch>[0]`, not `RequestInfo`: this package's lib does
  // not declare the DOM globals, and `tsc` catches that where vitest does not.
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/getMe')) {
      return Promise.resolve(
        json({ ok: true, result: { id: 7712345678, is_bot: true, username: 'b' } }),
      );
    }
    if (url.endsWith('/getChat')) {
      return Promise.resolve(json({ ok: true, result: { is_forum: opts.isForum ?? true } }));
    }
    if (url.endsWith('/createForumTopic')) {
      const body = JSON.parse(String(init?.body)) as { name: string };
      const answer = queue.length > 0 ? queue.shift()! : next++;
      if (answer === 'fail') return Promise.resolve(json({ ok: false, description: 'no' }));
      madeFor.push(body.name);
      return Promise.resolve(json({ ok: true, result: { message_thread_id: answer } }));
    }
    return Promise.resolve(json({ ok: true, result: {} }));
  });
  return { madeFor };
}

async function setup(chatId: number, email = ADMIN) {
  return app.request(
    '/api/v1/admin/bot/report-group',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId }),
    },
    envAs(email),
  );
}

async function settingOf(key: string): Promise<unknown> {
  const row = await baseEnv.DB.prepare(
    `SELECT value FROM settings WHERE scope = 'bot' AND key = ?1`,
  )
    .bind(key)
    .first<{ value: unknown }>();
  return row?.value ?? null;
}

async function connectBot(): Promise<void> {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    json({ ok: true, result: { id: 7712345678, is_bot: true, username: 'b', first_name: 'S' } }),
  );
  await app.request(
    '/api/v1/admin/bot/token',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    },
    envAs(),
  );
  vi.restoreAllMocks();
}

beforeAll(async () => {
  await applySchema();
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
    [REVIEWER, 'REVIEWER'],
  ] as const) {
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
    )
      .bind(crypto.randomUUID(), email, role, Date.now())
      .run();
  }
});

beforeEach(async () => {
  process.env['PANEL_SECRET_KEY'] = KEY_HEX;
  await baseEnv.DB.prepare(`DELETE FROM bot_credentials`).run();
  // Back to «nothing configured», which is what 0049 seeds — written as an
  // upsert because other suites in this package truncate `settings`, and a test
  // that assumed the migration's rows were still there would pass alone and
  // fail in the full run.
  for (const kind of REPORT_KINDS) {
    await baseEnv.DB.prepare(
      `INSERT INTO settings (scope, key, value) VALUES ('bot', ?1, '0'::jsonb)
       ON CONFLICT (scope, key) DO UPDATE SET value = '0'::jsonb`,
    )
      .bind(`topic_${kind}`)
      .run();
  }
  await baseEnv.DB.prepare(
    `INSERT INTO settings (scope, key, value) VALUES ('bot', 'Channel_Report', '""'::jsonb)
     ON CONFLICT (scope, key) DO UPDATE SET value = '""'::jsonb`,
  ).run();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['PANEL_SECRET_KEY'];
});

describe('pointing the bot at a reports group', () => {
  it('makes every topic and then names the group', async () => {
    await connectBot();
    const tg = telegram();

    const res = await setup(GROUP);

    expect(res.status).toBe(200);
    expect(tg.madeFor).toHaveLength(REPORT_KINDS.length);
    for (const kind of REPORT_KINDS) {
      expect(Number(await settingOf(`topic_${kind}`))).toBeGreaterThan(0);
    }
    expect(String(await settingOf('Channel_Report'))).toBe(String(GROUP));
  });

  it('leaves the shop reporting where it was when a topic cannot be made', async () => {
    // THE assertion. `Channel_Report` still empty means every producer stays
    // silent — rather than the shop publishing into a group whose topics are
    // half made and half zero.
    await connectBot();
    telegram({ topics: [101, 102, 'fail'] });

    const res = await setup(GROUP);

    expect(res.status).toBe(502);
    expect(await settingOf('Channel_Report')).toBe('');
    // What did happen is kept — a re-run makes only the rest.
    expect(Number(await settingOf('topic_buyreport'))).toBe(101);
  });

  it('makes only the topics that are missing on a second run', async () => {
    await connectBot();
    telegram();
    await setup(GROUP);

    const again = telegram();
    const res = await setup(GROUP);

    expect(res.status).toBe(200);
    // Nothing created: a second run must not leave the group with twenty topics.
    expect(again.madeFor).toEqual([]);
  });

  it('refuses a group that is not a forum, in the words legacy uses', async () => {
    await connectBot();
    const tg = telegram({ isForum: false });

    const res = await setup(GROUP);

    expect(res.status).toBe(422);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'not_a_forum' });
    expect(tg.madeFor).toEqual([]);
    expect(await settingOf('Channel_Report')).toBe('');
  });

  it('refuses before it asks Telegram anything when no bot is connected', async () => {
    const tg = telegram();

    const res = await setup(GROUP);

    expect(res.status).toBe(409);
    expect(tg.madeFor).toEqual([]);
  });

  it('is not a reviewer’s decision', async () => {
    expect((await setup(GROUP, REVIEWER)).status).toBe(403);
  });
});
