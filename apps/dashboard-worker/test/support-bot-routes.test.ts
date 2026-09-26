/**
 * «محدودیت‌های ربات پشتیبانی» routes, with n8n replaced by a spy on fetch.
 *
 * What must hold: the key goes to n8n and never comes back; an answer that is not the admin API's
 * (n8n answers a keyless call with a bare 200) is an error, not an empty list; only ADMIN writes,
 * and a write is audited only after n8n confirmed it; «آزادسازی همه» decides from a fresh read and
 * leaves attackers alone unless asked.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-supportbot@example.com';
const REVIEWER = 'reviewer-supportbot@example.com';
const READER = 'reader-supportbot@example.com';
const URL_ = 'https://n8n.example/webhook/admin';
const KEY = 'test-admin-key-not-real';
const SHOP_TG = 7700000001;

const NOW = Date.parse('2026-09-26T10:00:00Z');
const later = (h: number) => new Date(NOW + h * 3600e3).toISOString();

const READ = {
  ok: true,
  now: '2026-09-26T10:00:00Z',
  cap: 20,
  contacts: [
    { chat_id: SHOP_TG, name: 'shop', username: 'shopper', first_seen: '2026-09-20T00:00:00Z', last_seen: later(-1), msg_count: 30, bot_replies: 20, ai_day: '2026-09-26', ai_count: 20, human_until: later(20), open_ticket: 2, ticket_count: 1 },
    { chat_id: 7700000002, name: 'attacker', username: '', first_seen: null, last_seen: later(-2), msg_count: 3, bot_replies: 1, ai_day: '2026-09-26', ai_count: 1, human_until: later(150), open_ticket: 1, ticket_count: 1 },
    { chat_id: 7700000003, name: 'fine', username: null, first_seen: null, last_seen: later(-3), msg_count: 1, bot_replies: 1, ai_day: '', ai_count: 0, human_until: null, open_ticket: 0, ticket_count: 0 },
  ],
  tickets: [
    { id: 1, chat_id: 7700000002, reason: 'attack', status: 'open', text: "' OR 1=1 --", created_at: '2026-09-26T09:30:00Z' },
    { id: 2, chat_id: SHOP_TG, reason: 'limit', status: 'open', text: 'x', created_at: '2026-09-26T09:40:00Z' },
  ],
};

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

/** A fake admin API that answers by action and remembers what it was sent. */
function fakeN8n(over: Partial<Record<string, () => Response>> = {}) {
  const calls: { url: string; key: string | null; body: Record<string, unknown> }[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url: String(input), key: new Headers(init?.headers).get('x-shikoo-admin-key'), body });
    const action = String(body['action']);
    if (over[action]) return over[action]!();
    if (action === 'read') return json(READ);
    if (action === 'release') {
      const ids = (body['chat_ids'] as number[]).filter((id) => READ.contacts.some((c) => c.chat_id === id));
      return json({ ok: true, released: ids.length, chat_ids: ids });
    }
    if (action === 'set_cap') return json({ ok: true, cap: body['cap'] });
    return json({ ok: false, error: 'bad_request' }, 400);
  });
  return { calls, spy };
}

const envAs = (email: string, configured = true) => ({
  ...baseEnv,
  TEST_ACCESS_USER: email,
  ...(configured ? { SUPPORT_BOT_ADMIN_URL: URL_, SUPPORT_BOT_ADMIN_SECRET: KEY } : {}),
});
const get = (q = '', email = ADMIN, configured = true) =>
  app.request(`/api/v1/admin/support-bot${q}`, {}, envAs(email, configured));
const post = (path: string, body: unknown, email = ADMIN) =>
  app.request(
    `/api/v1/admin/support-bot/${path}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    envAs(email),
  );
const auditRows = async (action: string) =>
  (
    await baseEnv.DB.prepare(
      `SELECT entity_type, entity_id, after_json FROM audit_logs WHERE action = ?1 ORDER BY created_at`,
    )
      .bind(action)
      .all<{ entity_type: string; entity_id: string; after_json: string }>()
  ).results ?? [];

beforeAll(async () => {
  await applySchema();
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
    [REVIEWER, 'REVIEWER'],
    [READER, 'READ_ONLY'],
  ] as const) {
    await baseEnv.DB.prepare(
      `INSERT INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)
       ON CONFLICT (email) DO UPDATE SET role = excluded.role, active = 1`,
    )
      .bind(crypto.randomUUID(), email, role, Date.now())
      .run();
  }
  await baseEnv.DB.prepare(
    `INSERT INTO users (telegram_id, username, registered_at) VALUES (?1, 'shopper', now())
     ON CONFLICT (telegram_id) DO NOTHING`,
  )
    .bind(SHOP_TG)
    .run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await baseEnv.DB.prepare(`DELETE FROM users WHERE telegram_id = ?1`).bind(SHOP_TG).run();
});

describe('reading the support bot’s limits', () => {
  it('lists with statuses, the shop customer’s id, stats and attackers, and sends the key only to n8n', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { calls } = fakeN8n();
    const res = await get('?status=limited&sort=msg_count');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(calls).toEqual([{ url: URL_, key: KEY, body: { action: 'read' } }]);
    expect(JSON.stringify(body)).not.toContain(KEY);
    const shopUser = await baseEnv.DB.prepare(`SELECT id FROM users WHERE telegram_id = ?1`).bind(SHOP_TG).first<{ id: number }>();
    expect(body['items'].map((r: any) => [r.chatId, r.status, r.userId, r.aiToday])).toEqual([
      [SHOP_TG, 'limit', Number(shopUser!.id), 20],
      [7700000002, 'attack', null, 1],
    ]);
    expect([body['total'], body['cap'], body['stats'].limitedToday, body['stats'].attacksTotal]).toEqual([2, 20, 1, 1]);
    expect(body['attackers']).toEqual([
      expect.objectContaining({ chatId: 7700000002, attempts: 1, lastText: "' OR 1=1 --", blockedNow: true }),
    ]);
  });

  it('says «not connected» instead of failing when the server has no n8n address', async () => {
    const { spy } = fakeN8n();
    const res = await get('', ADMIN, false);
    expect([res.status, await res.json()]).toEqual([200, { ok: true, configured: false }]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('treats a keyless-style answer or a dead n8n as an error, never as an empty list', async () => {
    fakeN8n({ read: () => json({ message: 'Webhook call received' }) });
    const bad = await get();
    expect([bad.status, ((await bad.json()) as any).error]).toEqual([502, 'support_bot_bad_answer']);
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
    const dead = await get();
    expect([dead.status, ((await dead.json()) as any).error]).toEqual([502, 'support_bot_unreachable']);
  });

  it('keeps it from a READ_ONLY operator and refuses a bad query', async () => {
    fakeN8n();
    expect((await get('', READER)).status).toBe(403);
    expect((await get('?sort=password')).status).toBe(400);
  });
});

describe('giving chats back to the bot', () => {
  it('releases the chats n8n found, and audits exactly those', async () => {
    const { calls } = fakeN8n();
    const res = await post('release', { chatIds: [SHOP_TG, 7799999999] });
    expect(await res.json()).toEqual({ ok: true, released: 1, chatIds: [SHOP_TG] });
    expect(calls[0]?.body).toEqual({ action: 'release', chat_ids: [SHOP_TG, 7799999999] });
    const [row] = (await auditRows('support_bot.chats_released')).slice(-1);
    expect([row?.entity_type, row?.entity_id, JSON.parse(row!.after_json)]).toEqual([
      'SUPPORT_BOT_CHAT',
      String(SHOP_TG),
      { chatIds: [SHOP_TG] },
    ]);
  });

  it('«آزادسازی همه» reads afresh and leaves attackers limited unless asked', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { calls } = fakeN8n();
    await post('release-all', {});
    expect(calls.map((c) => c.body)).toEqual([{ action: 'read' }, { action: 'release', chat_ids: [SHOP_TG] }]);
    calls.length = 0;
    await post('release-all', { includeAttackers: true });
    expect(calls[1]?.body).toEqual({ action: 'release', chat_ids: [SHOP_TG, 7700000002] });
  });

  it('audits the batches n8n confirmed before a later one failed, and says so', async () => {
    let calls = 0;
    fakeN8n({
      release: () => {
        calls += 1;
        return calls === 1 ? json({ ok: true, released: 1, chat_ids: [SHOP_TG] }) : json({ ok: false }, 500);
      },
    });
    // 600 ids go out as two batches of at most 500.
    const ids = [SHOP_TG, ...Array.from({ length: 599 }, (_, i) => 7710000000 + i)];
    const res = await post('release', { chatIds: ids });
    const body = (await res.json()) as { error: string; detail: string };
    expect([res.status, body.error]).toEqual([502, 'support_bot_unreachable']);
    expect(body.detail).toContain('1 چت پیش از خطا آزاد شده بود');
    const [row] = (await auditRows('support_bot.chats_released')).slice(-1);
    expect([row?.entity_id, JSON.parse(row!.after_json)]).toEqual([
      String(SHOP_TG),
      { chatIds: [SHOP_TG], incomplete: true },
    ]);
  });

  it('audits nothing when n8n did not confirm', async () => {
    const before = (await auditRows('support_bot.chats_released')).length;
    fakeN8n({ release: () => json({ ok: false }, 500) });
    const res = await post('release', { chatIds: [SHOP_TG] });
    expect(res.status).toBe(502);
    expect((await auditRows('support_bot.chats_released')).length).toBe(before);
  });

  it('sets the daily cap with the old value in the audit row', async () => {
    fakeN8n();
    const res = await post('cap', { cap: 12 });
    expect(await res.json()).toEqual({ ok: true, cap: 12 });
    const [row] = (await auditRows('support_bot.cap_set')).slice(-1);
    expect(JSON.parse(row!.after_json)).toEqual({ cap: 12 });
    expect((await post('cap', { cap: 0 })).status).toBe(400);
  });

  it('lets only ADMIN write', async () => {
    const { spy } = fakeN8n();
    for (const email of [REVIEWER, READER]) {
      expect((await post('release', { chatIds: [SHOP_TG] }, email)).status).toBe(403);
      expect((await post('release-all', {}, email)).status).toBe(403);
      expect((await post('cap', { cap: 5 }, email)).status).toBe(403);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
