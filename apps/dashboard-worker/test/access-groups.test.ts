/**
 * Custom access groups (issue #363): the section map, the gate, the group
 * routes and the owner's account actions.
 *
 * The built-in groups are not asserted here — they are the three roles, and
 * `write-roles.test.ts` / `read-roles.test.ts` already pin those unchanged.
 * What is new is that a group the owner makes reaches exactly the pages it
 * was given, which is asked of every registered route rather than a sample.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BUILT_IN_GROUPS, SECTION_IDS } from '@shikoo/contracts';
import { hashPassword } from '@shikoo/domain';
import { applySchema, env as baseEnv, signIn } from './helpers/env.js';
import { app } from '../src/index.js';
import { ALSO_EDITED_BY, VIEW_POSTS, customGroupRole, sectionEntry } from '../src/access.js';

const WRITER = 'groups-writer@example.com';
const MEMBER = 'groups-member@example.com';
const WRITER_PASSWORD = 'writer-password-long-enough';
const db = baseEnv.DB;

/** Answered before the gate, so no section can apply to them. */
const UNGATED = /^\/api\/v1\/(auth\/|health$|brand$)/;

const fill = (p: string) => p.replace(/:[A-Za-z]+/g, '1');

function apiRoutes(): { method: string; path: string }[] {
  const rs = (app as unknown as { routes: { method: string; path: string }[] }).routes;
  const seen = new Set<string>();
  return rs.filter((r) => {
    const k = `${r.method} ${r.path}`;
    if (r.method === 'ALL' || !r.path.startsWith('/api/') || UNGATED.test(r.path) || seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });
}

const writes = () => apiRoutes().filter((r) => r.method !== 'GET');

async function call(method: string, path: string, email: string, body: unknown = {}) {
  const res = await app.fetch(
    new Request(`https://example.com${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: 'https://example.com' },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    }),
    { ...baseEnv, TEST_ACCESS_USER: email },
  );
  return res;
}

async function makeGroup(id: string, permissions: Record<string, string>) {
  await db
    .prepare(
      `INSERT INTO access_groups (id, name, permissions, created_at, updated_at)
       VALUES (?1, ?1, ?2::jsonb, 0, 0)
       ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
    )
    .bind(id, JSON.stringify(permissions))
    .run();
}

async function joinGroup(email: string, groupId: string) {
  await db
    .prepare(
      `INSERT INTO access_users (id, email, group_id, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, 0, 0)
       ON CONFLICT (email) DO UPDATE SET group_id = EXCLUDED.group_id, active = 1`,
    )
    .bind(crypto.randomUUID(), email, groupId)
    .run();
}

async function cleanup() {
  await db.prepare(`DELETE FROM access_users WHERE email LIKE 'groups-%'`).run();
  await db
    .prepare(`DELETE FROM access_groups WHERE id <> ALL($1)`)
    .bind([...BUILT_IN_GROUPS])
    .run();
}

beforeAll(applySchema);
beforeEach(async () => {
  await cleanup();
  await signIn(WRITER, 'ADMIN');
  await db
    .prepare(`UPDATE access_users SET password_hash = ?2 WHERE email = ?1`)
    .bind(WRITER, await hashPassword(WRITER_PASSWORD))
    .run();
});
afterAll(cleanup);

describe('the section map', () => {
  it('places every gated route, so a new page is closed until somebody decides', () => {
    const unplaced = apiRoutes()
      .filter((r) => !sectionEntry(r.path))
      .map((r) => `${r.method} ${r.path}`);
    expect(unplaced).toEqual([]);
  });

  it('reads a level by its value, and the database refuses any other', async () => {
    const odd = { orders: null, customers: 1 } as unknown as Record<string, 'view'>;
    expect(customGroupRole(odd, 'GET', '/api/v1/admin/orders')).toBeNull();
    expect(customGroupRole(odd, 'GET', '/api/v1/admin/customers')).toBeNull();
    for (const bad of ['{"orders":1}', '{"orders":["edit"]}', '{"orders":true}', '{"orders":"EDIT"}']) {
      await expect(makeGroup('odd', JSON.parse(bad))).rejects.toThrow(/permissions_check/);
    }
  });

  it('draws the prefix on a / boundary', () => {
    expect(sectionEntry('/api/v1/admin/bot-admins')?.[1]).toBe('access');
    expect(sectionEntry('/api/v1/admin/bot/token')?.[1]).toBe('bot');
  });
});

describe('a custom group at the gate', () => {
  it('refuses every write to a group that may only read every page', async () => {
    const all = Object.fromEntries(SECTION_IDS.map((s) => [s, 'view']));
    await makeGroup('all_view', all);
    await joinGroup(MEMBER, 'all_view');

    const leaked: string[] = [];
    for (const r of writes()) {
      if (VIEW_POSTS.has(`${r.method} ${r.path}`)) continue;
      const res = await call(r.method, fill(r.path), MEMBER);
      if (res.status !== 403) leaked.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(leaked).toEqual([]);
  }, 60_000);

  it('lets edit on a page reach every write that page owns, and nothing else', async () => {
    const wrong: string[] = [];
    for (const section of SECTION_IDS) {
      if (section === 'access') continue; // never editable by a custom group
      await makeGroup(`only_${section}`, { [section]: 'edit' });
      await joinGroup(MEMBER, `only_${section}`);
      for (const r of writes()) {
        const key = `${r.method} ${r.path}`;
        const owns =
          [sectionEntry(r.path)?.[1]].flat().includes(section) ||
          (ALSO_EDITED_BY.get(key) ?? []).includes(section);
        // A view-only POST is decided by read access, asserted elsewhere.
        if (!owns && VIEW_POSTS.has(key)) continue;
        // Owning a route is getting past every authorization check on it —
        // the handler's own `role !== 'ADMIN'` included. What it then says
        // about an empty body is not this test's business.
        const status = (await call(r.method, fill(r.path), MEMBER)).status;
        if (owns === (status === 403)) wrong.push(`${section}: ${key} → ${status}`);
      }
    }
    expect(wrong).toEqual([]);
  }, 180_000);

  it('shows a page it may read and refuses one it may not', async () => {
    await makeGroup('catalog_reader', { catalog: 'view' });
    await joinGroup(MEMBER, 'catalog_reader');
    expect((await call('GET', '/api/v1/admin/catalog', MEMBER)).status).toBe(200);
    expect((await call('GET', '/api/v1/admin/orders', MEMBER)).status).toBe(403);
    expect((await call('GET', '/api/v1/admin/customers', MEMBER)).status).toBe(403);
    // Every page draws these.
    expect((await call('GET', '/api/v1/admin/me', MEMBER)).status).toBe(200);
    expect((await call('GET', '/api/v1/version', MEMBER)).status).toBe(200);
  });

  it('hands a reader the REVIEWER view, so an export stays with edit', async () => {
    await makeGroup('orders_reader', { orders: 'view' });
    await joinGroup(MEMBER, 'orders_reader');
    expect((await call('GET', '/api/v1/admin/orders', MEMBER)).status).toBe(200);
    expect((await call('GET', '/api/v1/admin/orders?format=csv', MEMBER)).status).toBe(403);

    await makeGroup('orders_reader', { orders: 'edit' });
    expect((await call('GET', '/api/v1/admin/orders?format=csv', MEMBER)).status).toBe(200);
  });

  it('reads the route Hono runs, not a lookalike path', async () => {
    // `POST /accounts/analyze` is view-only; `DELETE /accounts/analyze` is
    // `DELETE /accounts/:id`, and must not ride on the POST's pass.
    await makeGroup('accounts_reader', { accounts: 'view' });
    await joinGroup(MEMBER, 'accounts_reader');
    expect((await call('DELETE', '/api/v1/accounts/analyze', MEMBER)).status).toBe(403);
  });

  it('answers /admin/me with the group and its pages', async () => {
    await makeGroup('bulk_only', { bulk: 'edit' });
    await joinGroup(MEMBER, 'bulk_only');
    const me = (await (await call('GET', '/api/v1/admin/me', MEMBER)).json()) as {
      role: string;
      groupId: string;
      perms: Record<string, string>;
    };
    expect(me.groupId).toBe('bulk_only');
    expect(me.perms).toEqual({ bulk: 'edit' });
    // The stored role, which an older image would read: the narrowest.
    const row = await db
      .prepare(`SELECT role FROM access_users WHERE email = ?1`)
      .bind(MEMBER)
      .first<{ role: string }>();
    expect(row?.role).toBe('READ_ONLY');
  });
});

describe('the group routes', () => {
  it('makes, renames and deletes a group, and refuses edit on «دسترسی‌ها»', async () => {
    const bad = await call('POST', '/api/v1/admin/access-groups', WRITER, {
      name: 'x',
      permissions: { access: 'edit' },
    });
    expect(bad.status).toBe(400);
    const unknown = await call('POST', '/api/v1/admin/access-groups', WRITER, {
      name: 'x',
      permissions: { nope: 'view' },
    });
    expect(unknown.status).toBe(400);

    const made = await call('POST', '/api/v1/admin/access-groups', WRITER, {
      name: 'پشتیبانی',
      permissions: { bulk: 'edit', panels: 'view', orders: 'none' },
    });
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };
    const stored = await db
      .prepare(`SELECT permissions FROM access_groups WHERE id = ?1`)
      .bind(id)
      .first<{ permissions: Record<string, string> }>();
    expect(stored?.permissions).toEqual({ bulk: 'edit', panels: 'view' });

    const dup = await call('POST', '/api/v1/admin/access-groups', WRITER, {
      name: 'پشتیبانی',
      permissions: {},
    });
    expect(dup.status).toBe(409);

    expect(
      (await call('PATCH', `/api/v1/admin/access-groups/${id}`, WRITER, { name: 'پشتیبان' }))
        .status,
    ).toBe(200);

    await joinGroup(MEMBER, id);
    const inUse = await call('DELETE', `/api/v1/admin/access-groups/${id}`, WRITER);
    expect(inUse.status).toBe(409);
    expect(((await inUse.json()) as { error: string }).error).toBe('in_use');

    await db.prepare(`DELETE FROM access_users WHERE email = ?1`).bind(MEMBER).run();
    expect((await call('DELETE', `/api/v1/admin/access-groups/${id}`, WRITER)).status).toBe(200);

    const audits = await db
      .prepare(`SELECT action FROM audit_logs WHERE entity_id = ?1 ORDER BY created_at`)
      .bind(id)
      .all<{ action: string }>();
    expect(audits.results?.map((r) => r.action)).toEqual([
      'access.group_created',
      'access.group_updated',
      'access.group_deleted',
    ]);
  });

  it('leaves the built-in groups alone', async () => {
    for (const id of ['admin', 'reviewer', 'read_only']) {
      expect(
        (await call('PATCH', `/api/v1/admin/access-groups/${id}`, WRITER, { name: 'x' })).status,
      ).toBe(409);
      expect((await call('DELETE', `/api/v1/admin/access-groups/${id}`, WRITER)).status).toBe(409);
    }
  });
});

describe('the owner’s account actions', () => {
  async function member(groupId = 'reviewer') {
    await joinGroup(MEMBER, groupId);
    return (await db
      .prepare(`SELECT id FROM access_users WHERE email = ?1`)
      .bind(MEMBER)
      .first<{ id: string }>())!.id;
  }

  it('moves an operator into a custom group, and the stored role follows', async () => {
    await makeGroup('bulk_only', { bulk: 'edit' });
    const id = await member();
    const res = await call('POST', `/api/v1/admin/access-users/${id}`, WRITER, {
      groupId: 'bulk_only',
    });
    expect(res.status).toBe(200);
    const row = await db
      .prepare(`SELECT role, group_id FROM access_users WHERE id = ?1`)
      .bind(id)
      .first<{ role: string; group_id: string }>();
    expect(row).toEqual({ role: 'READ_ONLY', group_id: 'bulk_only' });
  });

  it('sets a password only against the writer’s own, and signs the operator out', async () => {
    const id = await member();
    await db
      .prepare(
        `INSERT INTO operator_sessions (id, access_user_id, token_hash, expires_at)
         VALUES (?1, ?2, ?3, now() + interval '1 hour')`,
      )
      .bind(crypto.randomUUID(), id, `h-${crypto.randomUUID()}`)
      .run();
    const next = 'a-fresh-password-for-them';

    const missing = await call('POST', `/api/v1/admin/access-users/${id}`, WRITER, {
      password: next,
    });
    expect(missing.status).toBe(401);
    const wrong = await call('POST', `/api/v1/admin/access-users/${id}`, WRITER, {
      password: next,
      currentPassword: 'not-it-at-all-no',
    });
    expect(wrong.status).toBe(401);

    const ok = await call('POST', `/api/v1/admin/access-users/${id}`, WRITER, {
      password: next,
      totpRequired: true,
      currentPassword: WRITER_PASSWORD,
    });
    expect(ok.status).toBe(200);
    const row = await db
      .prepare(
        `SELECT password_hash IS NOT NULL AS has, totp_required,
                (SELECT COUNT(*)::int FROM operator_sessions
                  WHERE access_user_id = ?1 AND revoked_at IS NULL) AS live
           FROM access_users WHERE id = ?1`,
      )
      .bind(id)
      .first<{ has: boolean; totp_required: boolean; live: number }>();
    expect(row).toEqual({ has: true, totp_required: true, live: 0 });
    // The wrong guess above counts towards the writer's own lockout.
    const owner = await db
      .prepare(`SELECT failed_attempts FROM access_users WHERE email = ?1`)
      .bind(WRITER)
      .first<{ failed_attempts: number }>();
    expect(owner?.failed_attempts).toBe(1);
  });

  it('creates an operator in a group, with a password', async () => {
    await makeGroup('bulk_only', { bulk: 'edit' });
    const res = await call('POST', '/api/v1/admin/access-users', WRITER, {
      email: 'groups-new@example.com',
      groupId: 'bulk_only',
      password: 'a-fresh-password-for-them',
      currentPassword: WRITER_PASSWORD,
    });
    expect(res.status).toBe(201);
    const legacy = await call('POST', '/api/v1/admin/access-users', WRITER, {
      email: 'groups-legacy@example.com',
      role: 'REVIEWER',
    });
    expect(legacy.status).toBe(201);
    const rows = await db
      .prepare(
        `SELECT email, role, group_id, password_hash IS NOT NULL AS has
           FROM access_users WHERE email IN ('groups-new@example.com', 'groups-legacy@example.com')
          ORDER BY email`,
      )
      .all<{ email: string; role: string; group_id: string; has: boolean }>();
    expect(rows.results).toEqual([
      { email: 'groups-legacy@example.com', role: 'REVIEWER', group_id: 'reviewer', has: false },
      { email: 'groups-new@example.com', role: 'READ_ONLY', group_id: 'bulk_only', has: true },
    ]);
  });
});

describe('the owner above the admins', () => {
  const OWNER = 'groups-owner@example.com';
  const OWNER_PASSWORD = 'owner-password-long-enough';
  const OTHER_ADMIN = 'groups-admin@example.com';

  async function idOf(email: string) {
    return (await db
      .prepare(`SELECT id FROM access_users WHERE email = ?1`)
      .bind(email)
      .first<{ id: string }>())!.id;
  }

  async function makeOwner() {
    await joinGroup(OWNER, 'owner');
    await db
      .prepare(`UPDATE access_users SET password_hash = ?2 WHERE email = ?1`)
      .bind(OWNER, await hashPassword(OWNER_PASSWORD))
      .run();
  }

  it('is an ADMIN everywhere else, and there is only one', async () => {
    await makeOwner();
    const row = await db
      .prepare(`SELECT role FROM access_users WHERE email = ?1`)
      .bind(OWNER)
      .first<{ role: string }>();
    expect(row?.role).toBe('ADMIN');
    await expect(joinGroup(WRITER, 'owner')).rejects.toThrow(/access_users_one_owner/);
  });

  it('leaves admins managing admins until there is an owner, and takes it over after', async () => {
    await joinGroup(OTHER_ADMIN, 'admin');
    const other = await idOf(OTHER_ADMIN);
    // No owner yet: as before 0101.
    expect(
      (await call('POST', `/api/v1/admin/access-users/${other}`, WRITER, { active: false })).status,
    ).toBe(200);

    await makeOwner();
    for (const [method, path, body] of [
      ['POST', `/api/v1/admin/access-users/${other}`, { active: true }],
      ['POST', `/api/v1/admin/access-users/${other}`, { groupId: 'reviewer' }],
      ['DELETE', `/api/v1/admin/access-users/${other}`, {}],
      ['POST', '/api/v1/admin/access-users', { email: 'groups-new@example.com', role: 'ADMIN' }],
    ] as const) {
      const res = await call(method, path, WRITER, body);
      expect(`${method} ${path} → ${res.status}`).toBe(`${method} ${path} → 403`);
      expect(((await res.json()) as { error: string }).error).toBe('owner_only');
    }
    // A reviewer is still the admin's to manage.
    await joinGroup(MEMBER, 'reviewer');
    expect(
      (await call('POST', `/api/v1/admin/access-users/${await idOf(MEMBER)}`, WRITER, {
        active: false,
      })).status,
    ).toBe(200);

    expect(
      (await call('POST', `/api/v1/admin/access-users/${other}`, OWNER, { groupId: 'reviewer' }))
        .status,
    ).toBe(200);
  });

  it('alone hands out an admin’s password or clears their second factor', async () => {
    await joinGroup(OTHER_ADMIN, 'admin');
    const other = await idOf(OTHER_ADMIN);
    // Not even before there is an owner: the panel never could.
    const byAdmin = await call('POST', `/api/v1/admin/access-users/${other}`, WRITER, {
      resetTotp: true,
      currentPassword: WRITER_PASSWORD,
    });
    expect(byAdmin.status).toBe(403);

    await makeOwner();
    const byOwner = await call('POST', `/api/v1/admin/access-users/${other}`, OWNER, {
      password: 'a-fresh-password-for-them',
      resetTotp: true,
      currentPassword: OWNER_PASSWORD,
    });
    expect(byOwner.status).toBe(200);
    const audits = await db
      .prepare(`SELECT action FROM audit_logs WHERE entity_id = ?1 ORDER BY action`)
      .bind(other)
      .all<{ action: string }>();
    expect(audits.results?.map((r) => r.action)).toEqual([
      'access.password_set',
      'access.totp_reset',
      'access.user_updated',
    ]);
  });

  it('is made and unmade only from the CLI', async () => {
    await makeOwner();
    const owner = await idOf(OWNER);
    await joinGroup(MEMBER, 'reviewer');
    for (const [method, path, body, who] of [
      ['POST', `/api/v1/admin/access-users/${owner}`, { groupId: 'admin' }, WRITER],
      ['DELETE', `/api/v1/admin/access-users/${owner}`, {}, WRITER],
      ['POST', `/api/v1/admin/access-users/${await idOf(MEMBER)}`, { groupId: 'owner' }, OWNER],
      ['POST', '/api/v1/admin/access-users', { email: 'groups-new@example.com', groupId: 'owner' }, OWNER],
    ] as const) {
      const res = await call(method, path, who, body);
      expect(`${method} ${path} → ${res.status}`).toBe(`${method} ${path} → 409`);
      expect(((await res.json()) as { error: string }).error).toBe('owner_via_cli');
    }
  });

  it('never sets their own password from the panel either', async () => {
    await makeOwner();
    const res = await call('POST', `/api/v1/admin/access-users/${await idOf(WRITER)}`, WRITER, {
      password: 'a-fresh-password-for-me',
      currentPassword: WRITER_PASSWORD,
    });
    expect(res.status).toBe(403); // the writer is an admin, and an owner exists
  });
});

describe('the trigger from 0101', () => {
  it('moves the group when a writer sets only the role', async () => {
    await signIn(MEMBER, 'ADMIN');
    await signIn(MEMBER, 'READ_ONLY'); // ON CONFLICT … SET role, as ~80 tests do
    const row = await db
      .prepare(`SELECT role, group_id FROM access_users WHERE email = ?1`)
      .bind(MEMBER)
      .first<{ role: string; group_id: string }>();
    expect(row).toEqual({ role: 'READ_ONLY', group_id: 'read_only' });
  });
});
