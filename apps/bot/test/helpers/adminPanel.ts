/**
 * A PasarGuard admin API for the reseller tests (#474), behaving the way
 * 5.2.1 was measured to behave in the #474 probe: `usernames=` is exact and
 * `username=` a substring, a taken name or Telegram id is a 409, `PUT` applies
 * only what it is sent, and a `data_limit` of 0 means unlimited.
 *
 * Every request is recorded, bodies included, so a test can say what reached
 * the panel — and prove what did not.
 */

export interface FakeAdmin {
  username: string;
  data_limit: number | null;
  used_traffic: number;
  note: string | null;
  telegram_id: number | null;
  role: { id: number; is_owner: boolean; permissions: unknown } | null;
}

export const RESELLER_ROLE_ID = 7;

/** What Sam's runbook asks for: own users only, nothing else. */
export const RESELLER_ROLE = {
  id: RESELLER_ROLE_ID,
  is_owner: false,
  permissions: {
    users: {
      create: { scope: 1 },
      read: { scope: 1 },
      update: { scope: 1 },
      delete: { scope: 1 },
    },
  },
};

export interface PanelCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

export function adminPanel(seed: FakeAdmin[] = []) {
  const admins = new Map(seed.map((a) => [a.username, { ...a }]));
  const roles = new Map<number, typeof RESELLER_ROLE>([[RESELLER_ROLE_ID, RESELLER_ROLE]]);
  const calls: PanelCall[] = [];
  /** The next request of this method answers this status instead. */
  const failNext: Record<string, number | undefined> = {};

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const raw = typeof init?.body === 'string' ? init.body : null;
    const body = raw !== null && raw.startsWith('{') ? (JSON.parse(raw) as Record<string, unknown>) : null;
    calls.push({ method, path: url.pathname + url.search, body });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status });

    if (url.pathname === '/api/admin/token') return json({ access_token: 'tok' });
    const forced = failNext[method];
    if (forced !== undefined) {
      delete failNext[method];
      return json({ detail: 'forced' }, forced);
    }
    if (method === 'GET' && url.pathname === '/api/admins') {
      const exact = url.searchParams.getAll('usernames');
      const like = url.searchParams.get('username');
      let rows = [...admins.values()];
      if (exact.length > 0) rows = rows.filter((a) => exact.includes(a.username));
      if (like !== null) {
        rows = rows.filter((a) => a.username.toLowerCase().includes(like.toLowerCase()));
      }
      const offset = Number(url.searchParams.get('offset') ?? 0);
      return json({ admins: rows.slice(offset) });
    }
    if (method === 'GET' && url.pathname.startsWith('/api/admin-role/')) {
      const role = roles.get(Number(url.pathname.split('/').pop()));
      return role ? json(role) : json({ detail: 'Role not found' }, 404);
    }
    if (method === 'POST' && url.pathname === '/api/admin' && body) {
      if (body['role_id'] === 1) return json({ detail: 'Owner role' }, 403);
      if (admins.has(String(body['username']))) return json({ detail: 'Admin already exists' }, 409);
      if ([...admins.values()].some((a) => a.telegram_id === body['telegram_id'])) {
        return json({ detail: 'Telegram ID is already assigned to another admin.' }, 409);
      }
      const limit = Number(body['data_limit']);
      admins.set(String(body['username']), {
        username: String(body['username']),
        data_limit: limit > 0 ? limit : null,
        used_traffic: 0,
        note: (body['note'] as string | undefined) ?? null,
        telegram_id: (body['telegram_id'] as number | undefined) ?? null,
        role: roles.get(Number(body['role_id'])) ?? null,
      });
      return json(admins.get(String(body['username'])), 201);
    }
    if (method === 'PUT' && url.pathname.startsWith('/api/admin/') && body) {
      const name = decodeURIComponent(url.pathname.slice('/api/admin/'.length));
      const admin = admins.get(name);
      if (!admin) return json({ detail: 'Admin not found' }, 404);
      if (typeof body['data_limit'] === 'number') {
        admin.data_limit = body['data_limit'] > 0 ? body['data_limit'] : null;
      }
      return json(admin);
    }
    return json({ detail: 'unexpected' }, 500);
  }) as typeof globalThis.fetch;

  return { fetchImpl, admins, roles, calls, failNext };
}
