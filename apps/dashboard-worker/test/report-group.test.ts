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
 * «the test message went through and createForumTopic says no» is precisely
 * the case the ordering has to survive.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySchema, env as baseEnv, fixtureCategory } from './helpers/env.js';
import { app } from '../src/index.js';
import { REPORT_KINDS, REPORT_TOPIC_TITLES } from '@shikoo/contracts';

const ADMIN = 'admin-rg@example.com';
const REVIEWER = 'reviewer-rg@example.com';
const KEY_HEX = 'd'.repeat(64);
const TOKEN = '7712345678:AAH9fakeTokenForTestsOnly_not_a_real_one';
const GROUP = -1_001_777_000;
/** A service of this suite's own; whatever other suites left behind is not asserted on. */
const SERVICE = 'zz-topic-test';

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
  const posted: string[] = [];
  const deleted: (number | string)[] = [];
  const renamed: (number | string)[] = [];
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
    if (url.endsWith('/sendMessage')) {
      // Legacy's «تست  اتصال گروه» — the group's own reply says whether it is
      // a forum, which is where the route reads it from.
      const body = JSON.parse(String(init?.body)) as { text: string };
      posted.push(body.text);
      return Promise.resolve(
        json({ ok: true, result: { chat: { is_forum: opts.isForum ?? true } } }),
      );
    }
    if (url.endsWith('/createForumTopic')) {
      const body = JSON.parse(String(init?.body)) as { name: string };
      const answer = queue.length > 0 ? queue.shift()! : next++;
      if (answer === 'fail') return Promise.resolve(json({ ok: false, description: 'no' }));
      madeFor.push(body.name);
      return Promise.resolve(json({ ok: true, result: { message_thread_id: answer } }));
    }
    if (url.endsWith('/deleteForumTopic') || url.endsWith('/editForumTopic')) {
      const body = JSON.parse(String(init?.body)) as { message_thread_id: number; name?: string };
      (url.endsWith('/deleteForumTopic') ? deleted : renamed).push(
        body.name === undefined ? body.message_thread_id : `${body.message_thread_id}:${body.name}`,
      );
      return Promise.resolve(json({ ok: true, result: true }));
    }
    return Promise.resolve(json({ ok: true, result: {} }));
  });
  return { madeFor, posted, deleted, renamed };
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

async function makeService(name: string): Promise<number> {
  const row = await baseEnv.DB.prepare(
    `INSERT INTO products (code, name, kind, category_id) VALUES (?1, ?2, 'manual', ?3)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, report_thread_id = NULL
     RETURNING id`,
  )
    .bind(SERVICE, name, await fixtureCategory())
    .first<{ id: number }>();
  return Number(row!.id);
}

async function topicOf(productId: number): Promise<number | null> {
  const row = await baseEnv.DB.prepare(`SELECT report_thread_id FROM products WHERE id = ?1`)
    .bind(productId)
    .first<{ report_thread_id: number | null }>();
  return row?.report_thread_id ?? null;
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

afterAll(async () => {
  await baseEnv.DB.prepare(`DELETE FROM products WHERE code LIKE ?1`).bind(`${SERVICE}%`).run();
  // Back to «no group»: a suite after this one creates products, and a product
  // born into a configured group asks Telegram for a topic.
  await baseEnv.DB.prepare(
    `UPDATE settings SET value = '""'::jsonb WHERE scope = 'bot' AND key = 'Channel_Report'`,
  ).run();
  await baseEnv.DB.prepare(`DELETE FROM bot_credentials`).run();
});

describe('pointing the bot at a reports group', () => {
  it('makes every topic and then names the group', async () => {
    await connectBot();
    const tg = telegram();

    const res = await setup(GROUP);

    expect(res.status).toBe(200);
    // What the group sees, in legacy's words and legacy's order: the test
    // message first, then the ten topics as `lang/fa.php` spells them.
    expect(tg.posted).toEqual(['تست  اتصال گروه']);
    expect(tg.madeFor.slice(0, REPORT_KINDS.length)).toEqual([
      '🛍 گزارش های خرید',
      '📌 گزارش خرید خدمات',
      '🔑 گزارش اکانت تست',
      '⚙️ سایر گزارشات',
      '❌ گزارش خطا ها',
      '💰 گزارش مالی',
      '🎁 گزارش پورسانت ها',
      '🌙 گزارش شبانه',
      '📝 گزارش اطلاع رسانی ها',
      '🤖 بکاپ ربات',
    ]);
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

  /**
   * Sam, 2026-09-20: «برای هر محصول یه تاپیک» — services and shelves alike,
   * after the ten kinds so the group lists them below. A shelf is a products
   * row of its own, so one column and one loop cover both.
   */
  it('makes a topic per service, after the ten kinds', async () => {
    const id = await makeService('🥇سرویس تیتانیوم');
    await connectBot();
    const tg = telegram();

    const res = await setup(GROUP);

    expect(res.status).toBe(200);
    expect(tg.madeFor.indexOf('🥇سرویس تیتانیوم')).toBeGreaterThanOrEqual(REPORT_KINDS.length);
    expect(await topicOf(id)).toBe(
      ((await res.json()) as { created: Record<string, number> }).created[`product:${id}`],
    );

    // And not again: the service keeps the topic it has.
    const again = telegram();
    await setup(GROUP);
    expect(again.madeFor).toEqual([]);
  });

  it('gives a service born after the group its topic, and takes it away with the service', async () => {
    await connectBot();
    telegram();
    await setup(GROUP);

    const tg = telegram();
    const born = await app.request(
      '/api/v1/admin/products',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: `${SERVICE}-born`,
          name: 'سرویس الماس',
          kind: 'manual',
          providerId: null,
          categoryId: await fixtureCategory(),
        }),
      },
      envAs(),
    );
    expect(born.status).toBe(201);
    const { productId } = (await born.json()) as { productId: number };
    expect(tg.madeFor).toEqual(['سرویس الماس']);
    const threadId = await topicOf(productId);
    expect(threadId).not.toBeNull();

    // A rename follows: the topic must not keep saying the old name.
    await app.request(
      `/api/v1/admin/products/${productId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'سرویس طلایی' }),
      },
      envAs(),
    );
    expect(tg.renamed).toEqual([`${threadId}:سرویس طلایی`]);

    const gone = await app.request(
      `/api/v1/admin/products/${productId}`,
      { method: 'DELETE' },
      envAs(),
    );
    expect(gone.status).toBe(200);
    expect(tg.deleted).toEqual([threadId]);
  });

  it('makes every topic afresh when the shop moves to another group', async () => {
    // A thread id belongs to the chat that made it; Telegram refuses it from
    // another. Moving the shop forgets all of them — the ten and the services'.
    const id = await makeService('🥇سرویس تیتانیوم');
    await connectBot();
    telegram();
    await setup(GROUP);
    const oldTopic = await topicOf(id);

    // Ids the other group never handed out, so «remade» is told apart from
    // «kept» — the stub counts from 100 on every run.
    const moved = telegram({ topics: Array.from({ length: 40 }, (_, i) => 900 + i) });
    const res = await setup(GROUP - 1);

    expect(res.status).toBe(200);
    expect(moved.madeFor.slice(0, REPORT_KINDS.length)).toEqual(
      REPORT_KINDS.map((k) => REPORT_TOPIC_TITLES[k]),
    );
    expect(moved.madeFor).toContain('🥇سرویس تیتانیوم');
    expect(await topicOf(id)).not.toBe(oldTopic);
    expect(Number(await settingOf('topic_buyreport'))).toBe(900);
    expect(String(await settingOf('Channel_Report'))).toBe(String(GROUP - 1));
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

describe('what the screen can tell an operator', () => {
  /**
   * The state «GET /bot» has to carry, and why every kind is listed.
   *
   * An unconfigured topic is silent by design — its report goes to the group's
   * General rather than failing — so an operator has no way to discover a
   * half-finished setup except by being shown it. «۳ از ۱۰» is the sentence
   * that does that, and a response listing only the configured topics could not
   * produce it.
   */
  it('says nothing is configured before anything is', async () => {
    const res = await app.request('/api/v1/admin/bot', {}, envAs(ADMIN));
    const body = (await res.json()) as {
      reportGroup: { chatId: number | null; configured: number; topics: unknown[] };
    };

    expect(body.reportGroup.chatId).toBeNull();
    expect(body.reportGroup.configured).toBe(0);
    // Every kind, including the ones at zero.
    expect(body.reportGroup.topics).toHaveLength(REPORT_KINDS.length);
  });

  it('names the group and counts the topics once it is set up', async () => {
    await connectBot();
    telegram();
    await setup(GROUP);

    const res = await app.request('/api/v1/admin/bot', {}, envAs(ADMIN));
    const body = (await res.json()) as {
      reportGroup: {
        chatId: number | null;
        configured: number;
        topics: { kind: string; title: string; threadId: number | null }[];
      };
    };

    expect(body.reportGroup.chatId).toBe(GROUP);
    expect(body.reportGroup.configured).toBe(REPORT_KINDS.length);
    // The Persian titles, so the screen does not keep a second copy of them.
    expect(body.reportGroup.topics.every((t) => t.title.length > 0)).toBe(true);
    expect(body.reportGroup.topics.every((t) => t.threadId !== null)).toBe(true);
  });

  it('reads a topic left at zero as not configured, not as topic zero', async () => {
    await connectBot();
    telegram();
    await setup(GROUP);
    await baseEnv.DB.prepare(
      `UPDATE settings SET value = '0'::jsonb WHERE scope = 'bot' AND key = 'topic_buyreport'`,
    ).run();

    const res = await app.request('/api/v1/admin/bot', {}, envAs(ADMIN));
    const body = (await res.json()) as {
      reportGroup: { configured: number; topics: { kind: string; threadId: number | null }[] };
    };

    // Zero is legacy's «never made» sentinel. Reporting it as a thread id would
    // put `message_thread_id: 0` on the wire, which Telegram answers 400 to.
    expect(body.reportGroup.topics.find((t) => t.kind === 'buyreport')?.threadId).toBeNull();
    expect(body.reportGroup.configured).toBe(REPORT_KINDS.length - 1);
  });
});
