/**
 * The four admin calls the reseller sale makes, against a fake that behaves
 * the way PasarGuard 5.2.1 was MEASURED to behave in the #474 probe — a
 * throwaway `pasarguard/panel:v5.2.1` container, 30 of 30 assertions:
 *
 *   - `GET /api/admins?username=ali` is a case-insensitive SUBSTRING match
 *     (it returned `ali`, `Ali` and `alireza`); `usernames=ali` is exact;
 *   - `POST /api/admin` answers 409 for a taken username or Telegram id;
 *   - `PUT /api/admin/{u}` applies only the fields it is sent;
 *   - a `data_limit` of 0 is stored as NULL — unlimited.
 *
 * The fake is the panel's contract, written down; the adapter is what is under
 * test.
 */

import { describe, expect, it } from 'vitest';
import { marzbanAdapter, type ProviderContext } from '../src/index.js';

interface Admin {
  username: string;
  data_limit: number | null;
  used_traffic: number;
  note: string | null;
  telegram_id: number | null;
  role: { id: number; is_owner: boolean; permissions: unknown } | null;
}

function fakeAdminPanel(seed: Admin[] = []) {
  const admins = new Map(seed.map((a) => [a.username, { ...a }]));
  const bodies: { method: string; url: string; body: unknown }[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    bodies.push({ method, url: url.pathname + url.search, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

    if (url.pathname === '/api/admin/token') return json({ access_token: 't' });
    if (method === 'GET' && url.pathname === '/api/admins') {
      const exact = url.searchParams.getAll('usernames');
      const like = url.searchParams.get('username');
      let rows = [...admins.values()];
      if (exact.length > 0) rows = rows.filter((a) => exact.includes(a.username));
      if (like !== null) {
        rows = rows.filter((a) => a.username.toLowerCase().includes(like.toLowerCase()));
      }
      return json({ admins: rows });
    }
    if (method === 'GET' && url.pathname.startsWith('/api/admin-role/')) {
      const id = Number(url.pathname.split('/').pop());
      return id === 4
        ? json({ id: 4, is_owner: false, permissions: { users: { read: { scope: 1 } } } })
        : json({ detail: 'Role not found' }, 404);
    }
    if (method === 'POST' && url.pathname === '/api/admin') {
      if (body.role_id === 1) return json({ detail: 'Owner role' }, 403);
      if (admins.has(body.username)) return json({ detail: 'Admin already exists' }, 409);
      if ([...admins.values()].some((a) => a.telegram_id === body.telegram_id)) {
        return json({ detail: 'Telegram ID is already assigned to another admin.' }, 409);
      }
      admins.set(body.username, {
        username: body.username,
        data_limit: body.data_limit > 0 ? body.data_limit : null,
        used_traffic: 0,
        note: body.note ?? null,
        telegram_id: body.telegram_id ?? null,
        role: { id: body.role_id, is_owner: false, permissions: {} },
      });
      return json(admins.get(body.username), 201);
    }
    if (method === 'PUT' && url.pathname.startsWith('/api/admin/')) {
      const name = decodeURIComponent(url.pathname.slice('/api/admin/'.length));
      const admin = admins.get(name);
      if (!admin) return json({ detail: 'Admin not found' }, 404);
      if (body.data_limit !== undefined && body.data_limit !== null) {
        admin.data_limit = body.data_limit > 0 ? body.data_limit : null;
      }
      return json(admin);
    }
    return json({ detail: 'unexpected' }, 500);
  }) as typeof globalThis.fetch;

  return { fetchImpl, admins, bodies };
}

function provider(fetchImpl: typeof globalThis.fetch): ProviderContext {
  return {
    id: 1,
    code: 'pg',
    name: 'pg',
    baseUrl: 'https://panel.invalid',
    credentials: { username: 'bot', password: 'pw' },
    config: {},
    fetch: fetchImpl,
  };
}

const RESELLER_ROLE = { id: 4, is_owner: false, permissions: {} };
const TIB = 1024 ** 4;

describe('getPanelAdmin — exact, never a substring', () => {
  const panel = fakeAdminPanel([
    {
      username: 'ali',
      data_limit: TIB,
      used_traffic: 0,
      note: null,
      telegram_id: 11,
      role: RESELLER_ROLE,
    },
    {
      username: 'alireza',
      data_limit: 5 * TIB,
      used_traffic: 0,
      note: null,
      telegram_id: 22,
      role: RESELLER_ROLE,
    },
    {
      username: 'Ali',
      data_limit: null,
      used_traffic: 0,
      note: null,
      telegram_id: 33,
      role: RESELLER_ROLE,
    },
  ]);

  it('finds `ali` and only `ali`', async () => {
    const found = await marzbanAdapter.getPanelAdmin!(provider(panel.fetchImpl), 'ali');
    expect(found).toMatchObject({
      ok: true,
      admin: { username: 'ali', telegramId: 11, dataLimitBytes: TIB },
    });
    // The request is the exact filter, not the one that would have matched three.
    expect(panel.bodies.at(-1)!.url).toContain('usernames=ali');
    expect(panel.bodies.at(-1)!.url).not.toMatch(/[?&]username=/);
  });

  it('reads the role and the note off the row', async () => {
    const found = await marzbanAdapter.getPanelAdmin!(provider(panel.fetchImpl), 'alireza');
    expect(found.ok && found.admin?.role).toEqual({ id: 4, isOwner: false, permissions: {} });
  });

  it('says «no such admin» rather than failing', async () => {
    expect(await marzbanAdapter.getPanelAdmin!(provider(panel.fetchImpl), 'nobody')).toEqual({
      ok: true,
      admin: null,
    });
  });
});

describe('createPanelAdmin', () => {
  it('sends the whole admin, role and Telegram id included', async () => {
    const panel = fakeAdminPanel();
    const out = await marzbanAdapter.createPanelAdmin!(provider(panel.fetchImpl), {
      username: 'shop1',
      password: 'Ab12!Cd34#Ef',
      roleId: 4,
      dataLimitBytes: 2 * TIB,
      telegramId: 777,
      note: 'shikoo:reseller:9',
    });
    expect(out).toEqual({ ok: true });
    expect(panel.admins.get('shop1')).toMatchObject({
      data_limit: 2 * TIB,
      telegram_id: 777,
      note: 'shikoo:reseller:9',
      role: { id: 4 },
    });
  });

  it('reports a taken name as a conflict, not as something to retry', async () => {
    const panel = fakeAdminPanel([
      {
        username: 'shop1',
        data_limit: TIB,
        used_traffic: 0,
        note: null,
        telegram_id: 1,
        role: RESELLER_ROLE,
      },
    ]);
    const out = await marzbanAdapter.createPanelAdmin!(provider(panel.fetchImpl), {
      username: 'shop1',
      password: 'Ab12!Cd34#Ef',
      roleId: 4,
      dataLimitBytes: TIB,
      telegramId: 2,
      note: 'shikoo:reseller:9',
    });
    expect(out).toMatchObject({ ok: false, conflict: true, retryable: false });
  });

  it('never puts the password in the reason', async () => {
    const panel = fakeAdminPanel();
    const out = await marzbanAdapter.createPanelAdmin!(provider(panel.fetchImpl), {
      username: 'shop2',
      password: 'Secret-Pass-99xx',
      roleId: 1,
      dataLimitBytes: TIB,
      telegramId: 3,
      note: 'n',
    });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain('Secret-Pass-99xx');
  });

  it('refuses a zero limit before asking — the panel would read it as unlimited', async () => {
    const panel = fakeAdminPanel();
    const out = await marzbanAdapter.createPanelAdmin!(provider(panel.fetchImpl), {
      username: 'shop3',
      password: 'Ab12!Cd34#Ef',
      roleId: 4,
      dataLimitBytes: 0,
      telegramId: 4,
      note: 'n',
    });
    expect(out).toMatchObject({ ok: false, retryable: false });
    expect(panel.bodies).toHaveLength(0);
  });
});

describe('setPanelAdmin', () => {
  const seed = (): Admin[] => [
    {
      username: 'shop',
      data_limit: TIB,
      used_traffic: 0,
      note: 'shikoo:reseller:1',
      telegram_id: 5,
      role: RESELLER_ROLE,
    },
  ];

  it('changes the limit and nothing else', async () => {
    const panel = fakeAdminPanel(seed());
    expect(
      await marzbanAdapter.setPanelAdmin!(provider(panel.fetchImpl), 'shop', {
        dataLimitBytes: 3 * TIB,
      }),
    ).toEqual({ ok: true });
    expect(panel.bodies.at(-1)!.body).toEqual({ data_limit: 3 * TIB });
    expect(panel.admins.get('shop')).toMatchObject({
      data_limit: 3 * TIB,
      note: 'shikoo:reseller:1',
      telegram_id: 5,
    });
  });

  it('refuses zero and negative limits without a request', async () => {
    const panel = fakeAdminPanel(seed());
    for (const bad of [0, -1, 1.5]) {
      const out = await marzbanAdapter.setPanelAdmin!(provider(panel.fetchImpl), 'shop', {
        dataLimitBytes: bad,
      });
      expect(out.ok).toBe(false);
    }
    expect(panel.bodies).toHaveLength(0);
    expect(panel.admins.get('shop')!.data_limit).toBe(TIB);
  });

  it('sends a password change as the password alone', async () => {
    const panel = fakeAdminPanel(seed());
    await marzbanAdapter.setPanelAdmin!(provider(panel.fetchImpl), 'shop', {
      password: 'Ab12!Cd34#Ef',
    });
    expect(panel.bodies.at(-1)!.body).toEqual({ password: 'Ab12!Cd34#Ef' });
  });
});

describe('getPanelRole', () => {
  it('reads a role, and says «none» for a missing id', async () => {
    const panel = fakeAdminPanel();
    expect(await marzbanAdapter.getPanelRole!(provider(panel.fetchImpl), 4)).toMatchObject({
      ok: true,
      role: { id: 4, isOwner: false },
    });
    expect(await marzbanAdapter.getPanelRole!(provider(panel.fetchImpl), 99)).toEqual({
      ok: true,
      role: null,
    });
  });
});
