/**
 * The papers on a shelf (#377): the config file and the tutorial the bot
 * sends after every sale from it.
 *
 * Nothing is stored but Telegram's `file_id`, obtained by sending the file to
 * the reports group once. So the assertions are about that round trip — the
 * multipart upload and the forwarded post both end as a row the bot can send
 * back — and about what must NOT leave: the `file_id` never reaches the
 * browser, and a REVIEWER touches none of it.
 *
 * Needs DATABASE_URL (`pnpm sim:up`).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-papers@example.com';
const REVIEWER = 'reviewer-papers@example.com';
const KEY_HEX = 'e'.repeat(64);
const TOKEN = '7712345678:AAH9fakeTokenForTestsOnly_not_a_real_one';
const GROUP = '-1003992817118';
const TOPIC = 175;
const NOW_MS = Date.UTC(2026, 8, 20, 6, 0, 0);
const PREFIX = 'zz-papers-';

function envAs(email = ADMIN) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Every call the routes made: the method, and the body as Telegram got it. */
let calls: { method: string; body: FormData | Record<string, unknown> }[] = [];

/**
 * A Telegram that answers every send with the message the caller asked for.
 * `result` is what a real reply carries — the file, under the key of its kind.
 */
function telegram(result: Record<string, unknown> | { refusal: string }) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const method = String(input).split('/').at(-1) ?? '';
      const body =
        init?.body instanceof FormData
          ? init.body
          : (JSON.parse(String(init?.body)) as Record<string, unknown>);
      calls.push({ method, body });
      return Promise.resolve(
        'refusal' in result
          ? json({ ok: false, description: result.refusal })
          : json({ ok: true, result: { message_id: 9, ...result } }),
      );
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

/** A shelf as «قفسهٔ تازه» builds one, and a plan on a real panel beside it. */
let shelf: number;
let panelPlan: number;

async function makePlans(): Promise<void> {
  const category = await baseEnv.DB.prepare(
    `SELECT id FROM product_categories WHERE name = '__fixture'`,
  ).first<{ id: number }>();
  const res = await app.request(
    '/api/v1/admin/stock/shelves',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'قفسهٔ OpenVPN', priceIrr: 100000, categoryId: category!.id }),
    },
    envAs(),
  );
  shelf = ((await res.json()) as { planId: number }).planId;

  const panel = await baseEnv.DB.prepare(
    `INSERT INTO provisioning_providers (code, name, kind, status, base_url)
     VALUES (?1, 'پنل', 'pasarguard', 'ACTIVE', 'https://panel.invalid') RETURNING id`,
  )
    .bind(`${PREFIX}panel`)
    .first<{ id: number }>();
  const product = await baseEnv.DB.prepare(
    `INSERT INTO products (code, name, kind, provider_id, category_id, status)
     VALUES (?1, 'محصول', 'vpn', ?2, ?3, 'ACTIVE') RETURNING id`,
  )
    .bind(`${PREFIX}product`, Number(panel!.id), category!.id)
    .first<{ id: number }>();
  const plan = await baseEnv.DB.prepare(
    `INSERT INTO product_plans (product_id, name, price_irr, duration_days, status)
     VALUES (?1, 'پلن', 1950000, 30, 'ACTIVE') RETURNING id`,
  )
    .bind(Number(product!.id))
    .first<{ id: number }>();
  panelPlan = Number(plan!.id);
}

async function purge(): Promise<void> {
  for (const like of ['shelf-%', `${PREFIX}%`]) {
    await baseEnv.DB.prepare(
      `DELETE FROM product_plans WHERE product_id IN (SELECT id FROM products WHERE code LIKE ?1)`,
    )
      .bind(like)
      .run();
    await baseEnv.DB.prepare(`DELETE FROM products WHERE code LIKE ?1`).bind(like).run();
    await baseEnv.DB.prepare(`DELETE FROM provisioning_providers WHERE code LIKE ?1`)
      .bind(like)
      .run();
  }
}

const upload = (planId: number, name: string, kind: string, bytes: Uint8Array, email = ADMIN) =>
  app.request(
    `/api/v1/admin/stock/shelves/${planId}/attachments?name=${encodeURIComponent(name)}&kind=${kind}`,
    { method: 'POST', body: bytes, headers: { 'content-type': 'application/octet-stream' } },
    envAs(email),
  );

const link = (planId: number, postLink: string, email = ADMIN) =>
  app.request(
    `/api/v1/admin/stock/shelves/${planId}/attachments/link`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ postLink }),
    },
    envAs(email),
  );

const list = (planId: number, email = ADMIN) =>
  app.request(`/api/v1/admin/stock/shelves/${planId}/attachments`, {}, envAs(email));

const remove = (planId: number, id: number, email = ADMIN) =>
  app.request(
    `/api/v1/admin/stock/shelves/${planId}/attachments/${id}`,
    { method: 'DELETE' },
    envAs(email),
  );

async function stored(planId: number) {
  const { results } = await baseEnv.DB.prepare(
    `SELECT kind, file_id, file_name, size_bytes FROM shelf_attachments WHERE plan_id = ?1 ORDER BY id`,
  )
    .bind(planId)
    .all<{ kind: string; file_id: string; file_name: string; size_bytes: number }>();
  return results ?? [];
}

beforeAll(async () => {
  await applySchema();
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
    [REVIEWER, 'REVIEWER'],
  ] as const) {
    await baseEnv.DB.prepare(
      `INSERT INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)
       ON CONFLICT (email) DO UPDATE SET role = excluded.role, active = 1`,
    )
      .bind(crypto.randomUUID(), email, role, NOW_MS)
      .run();
  }
});

beforeEach(async () => {
  calls = [];
  process.env['PANEL_SECRET_KEY'] = KEY_HEX;
  await baseEnv.DB.prepare(`DELETE FROM bot_credentials`).run();
  await baseEnv.DB.prepare(`DELETE FROM shelf_attachments`).run();
  await purge();
  await makePlans();
  await setting('Channel_Report', GROUP);
  await setting('topic_otherreport', String(TOPIC));
  Object.assign(baseEnv, { TELEGRAM_BOT_TOKEN: TOKEN });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['PANEL_SECRET_KEY'];
});

describe('filing a paper on a shelf', () => {
  it('uploads the file to the reports group as multipart and keeps what Telegram named it', async () => {
    telegram({ document: { file_id: 'BQACdoc1', file_name: 'client.ovpn', file_size: 4321 } });

    const res = await upload(
      shelf,
      'client.ovpn',
      'document',
      new TextEncoder().encode('client\nremote x'),
    );

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('sendDocument');
    // Multipart, not JSON: the bytes are the body. Into the group's «سایر
    // گزارشات», where an operator sees a wrong file before a customer does.
    const form = calls[0]!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('chat_id')).toBe(GROUP);
    expect(form.get('message_thread_id')).toBe(String(TOPIC));
    expect((form.get('document') as File).name).toBe('client.ovpn');

    expect(await stored(shelf)).toEqual([
      { kind: 'document', file_id: 'BQACdoc1', file_name: 'client.ovpn', size_bytes: 4321 },
    ]);
  });

  it('sends a video with sendVideo, so it plays in the chat rather than downloading', async () => {
    telegram({ video: { file_id: 'BAACvid1', file_name: 'howto.mp4', file_size: 99 } });
    const res = await upload(shelf, 'howto.mp4', 'video', new Uint8Array([1, 2, 3]));
    expect(res.status).toBe(200);
    expect(calls[0]!.method).toBe('sendVideo');
    expect((await stored(shelf))[0]).toMatchObject({ kind: 'video', file_id: 'BAACvid1' });
  });

  it('takes a channel post by link, forwards it once, and keeps the file it carried', async () => {
    telegram({ video: { file_id: 'BAACvid2', file_size: 50_000_000 } });

    const res = await link(shelf, 'https://t.me/shikoonet/137');

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('forwardMessage');
    expect(calls[0]!.body).toMatchObject({
      chat_id: Number(GROUP),
      from_chat_id: '@shikoonet',
      message_id: 137,
      message_thread_id: TOPIC,
    });
    // No `file_name` on a video post; the kind stands in for it.
    expect((await stored(shelf))[0]).toMatchObject({
      kind: 'video',
      file_id: 'BAACvid2',
      file_name: 'video',
    });
  });

  it('refuses a post with nothing the bot could send back', async () => {
    telegram({ text: 'just words' });
    const res = await link(shelf, 'https://t.me/shikoonet/138');
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('no_file');
    expect(await stored(shelf)).toEqual([]);
  });

  it('passes on what Telegram said when it refused', async () => {
    telegram({ refusal: 'Bad Request: message to forward not found' });
    const res = await link(shelf, 'https://t.me/shikoonet/139');
    expect(res.status).toBe(422);
    expect(((await res.json()) as { detail: string }).detail).toContain(
      'message to forward not found',
    );
  });

  it('refuses a link that is not a channel post', async () => {
    telegram({});
    expect((await link(shelf, 'https://example.com/137')).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('needs the reports group first — the file has to land somewhere the bot can see', async () => {
    telegram({ document: { file_id: 'x' } });
    await baseEnv.DB.prepare(
      `DELETE FROM settings WHERE scope = 'bot' AND key = 'Channel_Report'`,
    ).run();
    const res = await upload(shelf, 'a.ovpn', 'document', new Uint8Array([1]));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('no_report_group');
    expect(calls).toHaveLength(0);
  });

  it('cuts an upload past the 48 MiB the server takes, before Telegram is asked', async () => {
    telegram({ document: { file_id: 'x' } });
    const res = await upload(shelf, 'big.bin', 'document', new Uint8Array(48 * 1024 * 1024 + 1));
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it('refuses an empty body and an unknown kind', async () => {
    telegram({ document: { file_id: 'x' } });
    expect((await upload(shelf, 'a.ovpn', 'document', new Uint8Array(0))).status).toBe(400);
    expect((await upload(shelf, 'a.ovpn', 'sticker', new Uint8Array([1]))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('is only for a shelf — a plan on a real panel is not found', async () => {
    telegram({ document: { file_id: 'x' } });
    expect((await upload(panelPlan, 'a.ovpn', 'document', new Uint8Array([1]))).status).toBe(404);
    expect((await list(panelPlan)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe('reading and removing the papers', () => {
  it('lists them in the order they were filed, without the file_id', async () => {
    telegram({ document: { file_id: 'BQACdoc1', file_name: 'client.ovpn', file_size: 10 } });
    await upload(shelf, 'client.ovpn', 'document', new Uint8Array([1]));
    telegram({ video: { file_id: 'BAACvid1', file_size: 20 } });
    await link(shelf, 'https://t.me/shikoonet/1');
    await baseEnv.DB.prepare(
      `UPDATE product_plans SET attrs = COALESCE(attrs, '{}'::jsonb) || '{"delivery_note":"اول کانفیگ، بعد ویدیو."}' WHERE id = ?1`,
    )
      .bind(shelf)
      .run();

    const res = await list(shelf);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deliveryNote: string;
      items: Record<string, unknown>[];
    };
    expect(body.deliveryNote).toBe('اول کانفیگ، بعد ویدیو.');
    expect(body.items.map((i) => [i['kind'], i['fileName'], i['sizeBytes']])).toEqual([
      ['document', 'client.ovpn', 10],
      ['video', 'video', 20],
    ]);
    // The handle is the bot's, and the browser has no use for it.
    expect(JSON.stringify(body)).not.toContain('BQACdoc1');
    expect(JSON.stringify(body)).not.toContain('file_id');
  });

  it('removes one by both ids, so one shelf cannot take another’s paper', async () => {
    telegram({ document: { file_id: 'BQACdoc1', file_size: 10 } });
    await upload(shelf, 'a.ovpn', 'document', new Uint8Array([1]));
    const [{ id }] = ((await (await list(shelf)).json()) as { items: { id: number }[] }).items as [
      { id: number },
    ];

    expect((await remove(shelf + 1, id)).status).toBe(404);
    expect(await stored(shelf)).toHaveLength(1);
    expect((await remove(shelf, id)).status).toBe(200);
    expect(await stored(shelf)).toHaveLength(0);
    expect((await remove(shelf, id)).status).toBe(404);
  });

  it('goes with the shelf when the shelf goes', async () => {
    telegram({ document: { file_id: 'BQACdoc1', file_size: 10 } });
    await upload(shelf, 'a.ovpn', 'document', new Uint8Array([1]));
    await baseEnv.DB.prepare(`DELETE FROM product_plans WHERE id = ?1`).bind(shelf).run();
    expect(await stored(shelf)).toHaveLength(0);
  });

  it('lets nobody but an admin near them', async () => {
    telegram({ document: { file_id: 'x' } });
    expect((await list(shelf, REVIEWER)).status).toBe(403);
    expect((await upload(shelf, 'a', 'document', new Uint8Array([1]), REVIEWER)).status).toBe(403);
    expect((await link(shelf, 'https://t.me/shikoonet/1', REVIEWER)).status).toBe(403);
    expect((await remove(shelf, 1, REVIEWER)).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});
