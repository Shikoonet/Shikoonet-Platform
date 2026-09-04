/**
 * ارسال گروهی، وقتی محتوایش یک پست کانال است.
 *
 * The link is the easy half and it is not what these are about. A forward fails
 * for reasons no amount of validating the URL can see: the bot was never added
 * to the channel, it was removed last week, the post was deleted, the channel
 * went private. Every one of those fails PER RECIPIENT — eleven thousand
 * identical rows marked FAILED, hours later, with the operator long gone.
 *
 * So the route forwards the post once, into the shop's own report topic, before
 * a single recipient row is written. The assertion that matters in this file is
 * therefore an ORDER one, and it is asserted the only way an order can be: by
 * making the rehearsal fail and proving the queue is empty.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-post@example.com';
const KEY_HEX = 'e'.repeat(64);
const TOKEN = '7712345678:AAH9fakeTokenForTestsOnly_not_a_real_one';
const GROUP = '-1003992817118';
const TEST_TOPIC = 174;

function envAs(email = ADMIN) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Every `forwardMessage` the route made, as Telegram received it. */
let forwards: Record<string, unknown>[] = [];

/**
 * A Telegram that answers `forwardMessage` as told.
 *
 * `refusal` is Telegram's own `description`, because that string is the whole
 * point of the rehearsal — «bot is not a member of the channel chat» tells an
 * operator what to go and do, and «it did not work» does not.
 */
function telegram(refusal: string | null = null) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/forwardMessage')) {
        forwards.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Promise.resolve(
          refusal === null
            ? json({ ok: true, result: { message_id: 9 } })
            : json({ ok: false, description: refusal }),
        );
      }
      return Promise.resolve(json({ ok: true, result: {} }));
    },
  );
}

async function setting(key: string, value: string): Promise<void> {
  await baseEnv.DB.prepare(
    `INSERT INTO settings (scope, key, value) VALUES ('bot', ?1, to_jsonb(?2::text))
     ON CONFLICT (scope, key) DO UPDATE SET value = to_jsonb(?2::text)`,
  )
    .bind(key, value)
    .run();
}

async function send(body: unknown): Promise<Response> {
  return app.request(
    '/api/v1/admin/bulk/broadcast',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    envAs(),
  );
}

async function queued(): Promise<{ broadcasts: number; recipients: number }> {
  const b = await baseEnv.DB.prepare(`SELECT count(*)::int AS n FROM broadcasts`).first<{
    n: number;
  }>();
  const r = await baseEnv.DB.prepare(
    `SELECT count(*)::int AS n FROM broadcast_recipients`,
  ).first<{ n: number }>();
  return { broadcasts: Number(b?.n ?? 0), recipients: Number(r?.n ?? 0) };
}

const uuid = () => crypto.randomUUID();

beforeAll(async () => {
  await applySchema();
  await baseEnv.DB.prepare(
    `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
     VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)`,
  )
    .bind(uuid(), ADMIN, Date.now())
    .run();
  // One active customer, so «nothing queued» is a real claim rather than the
  // route's `no_active_customers` refusal wearing the same shape.
  await baseEnv.DB.prepare(
    `INSERT INTO users (telegram_id, username, status, registered_at)
     VALUES (994000001, 'post-1', 'ACTIVE', now())
     ON CONFLICT (telegram_id) DO UPDATE SET status = 'ACTIVE'`,
  ).run();
});

beforeEach(async () => {
  forwards = [];
  process.env['PANEL_SECRET_KEY'] = KEY_HEX;
  await baseEnv.DB.prepare(`TRUNCATE broadcast_recipients, broadcasts CASCADE`).run();
  await baseEnv.DB.prepare(`DELETE FROM bot_credentials`).run();
  await setting('Channel_Report', GROUP);
  await setting('topic_reporttest', String(TEST_TOPIC));
  // A bot the panel can speak as. `TELEGRAM_BOT_TOKEN` on the env rather than a
  // sealed row: the sealing is `botRoutes`' subject, not this one's.
  Object.assign(baseEnv, { TELEGRAM_BOT_TOKEN: TOKEN });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['PANEL_SECRET_KEY'];
});

describe('a broadcast built from a channel post link', () => {
  it('rehearses the post where the shop can see it, then queues the forward', async () => {
    telegram();
    const broadcastId = uuid();

    const res = await send({ postLink: 'https://t.me/shikoonet/137', broadcastId });

    expect(res.status).toBe(200);
    // Once, and into the report group's own test topic — a place the shop's
    // people watch and no customer does.
    expect(forwards).toHaveLength(1);
    expect(forwards[0]).toMatchObject({
      chat_id: Number(GROUP),
      from_chat_id: '@shikoonet',
      message_id: 137,
      message_thread_id: TEST_TOPIC,
    });

    const row = await baseEnv.DB.prepare(
      `SELECT body, source_chat, source_message_id FROM broadcasts WHERE id = ?1`,
    )
      .bind(broadcastId)
      .first<{ body: string | null; source_chat: string; source_message_id: number }>();
    expect(row?.body).toBeNull();
    expect(row?.source_chat).toBe('@shikoonet');
    expect(Number(row?.source_message_id)).toBe(137);
    expect((await queued()).recipients).toBeGreaterThan(0);
  });

  /**
   * The order, asserted the only way an order can be.
   *
   * If the rehearsal ran after the queue — or not at all — this passes with
   * rows in the table. Empty is the proof that nothing was committed to a post
   * Telegram had already refused.
   */
  it('queues nothing when Telegram refuses the post, and quotes Telegram', async () => {
    telegram('Bad Request: bot is not a member of the channel chat');

    const res = await send({ postLink: 'https://t.me/shikoonet/137', broadcastId: uuid() });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe('post_unreachable');
    expect(body.detail).toContain('not a member of the channel chat');
    expect(await queued()).toEqual({ broadcasts: 0, recipients: 0 });
  });

  it('refuses to send at all when there is nowhere to rehearse', async () => {
    telegram();
    await baseEnv.DB.prepare(
      `DELETE FROM settings WHERE scope = 'bot' AND key = 'Channel_Report'`,
    ).run();

    const res = await send({ postLink: 'https://t.me/shikoonet/137', broadcastId: uuid() });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('no_report_group');
    expect(forwards).toEqual([]);
    expect(await queued()).toEqual({ broadcasts: 0, recipients: 0 });
  });

  it('reads a link that is not one without asking Telegram', async () => {
    telegram();

    const res = await send({ postLink: 'https://t.me/shikoonet', broadcastId: uuid() });

    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_post_link');
    // Not a single call: an unreadable link is decided here, and the rehearsal
    // exists for the failures only Telegram knows about.
    expect(forwards).toEqual([]);
    expect(await queued()).toEqual({ broadcasts: 0, recipients: 0 });
  });

  /**
   * Both payloads at once is refused by the schema, before the CHECK on
   * `broadcasts` would have turned it into a 500.
   */
  it('refuses a request that is both a text and a post', async () => {
    telegram();

    const res = await send({
      body: 'سلام',
      postLink: 'https://t.me/shikoonet/137',
      broadcastId: uuid(),
    });

    expect(res.status).toBe(400);
    expect(await queued()).toEqual({ broadcasts: 0, recipients: 0 });
  });

  it('still queues a plain text broadcast, and asks Telegram nothing', async () => {
    telegram();
    const broadcastId = uuid();

    const res = await send({ body: 'سلام', broadcastId });

    expect(res.status).toBe(200);
    expect(forwards).toEqual([]);
    const row = await baseEnv.DB.prepare(
      `SELECT body, source_chat FROM broadcasts WHERE id = ?1`,
    )
      .bind(broadcastId)
      .first<{ body: string; source_chat: string | null }>();
    expect(row?.body).toBe('سلام');
    expect(row?.source_chat).toBeNull();
  });
});
