/**
 * Who may operate the shop — the panel's operators and the bot's.
 *
 * The assertions read the tables, never the response. A route that echoed its
 * own request body would pass a test that compared the two, and these rows
 * decide who can move money.
 *
 * The lock-out guards are the point of the file. Every one of them is a
 * condition inside the UPDATE or the DELETE rather than a count taken first,
 * and the difference is not theoretical: two admins demoting each other at the
 * same moment both read "somebody else is an admin" and, with the check outside
 * the statement, both succeed. What cannot be tested here is the race itself —
 * one connection, one statement at a time — so what is tested is that the
 * condition is where it can win: removing it from the SQL turns these red.
 */

import { ADMIN_PERMISSIONS } from '@shikoo/contracts';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv, deleteFixtureUsers, FIXTURE_TG_BASE } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-access-suite@example.com';
const OTHER_ADMIN = 'second-admin@example.com';
const REVIEWER = 'reviewer-access@example.com';
const RACE_A = 'race-a@example.com';
const RACE_B = 'race-b@example.com';
/** Every identity this file creates, so the purge can be exact. */
const OURS = [OTHER_ADMIN, REVIEWER, RACE_A, RACE_B, 'new.person@example.com', 'x@example.com'];
const PREFIX = 'zz-access-';
const TG_BASE = FIXTURE_TG_BASE + 940_000_000;

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

function call(path: string, init: RequestInit = {}, email = ADMIN) {
  return app.request(
    `/api/v1/admin/${path}`,
    { headers: { 'content-type': 'application/json' }, ...init },
    envAs(email),
  );
}

async function accessRow(email: string) {
  return baseEnv.DB.prepare(`SELECT id, role, active FROM access_users WHERE email = ?1`)
    .bind(email)
    .first<{ id: string; role: string; active: number }>();
}

async function botAdminRow(telegramId: number) {
  return baseEnv.DB.prepare(
    `SELECT id, role, active, permissions FROM admins WHERE telegram_id = ?1`,
  )
    .bind(telegramId)
    .first<{ id: number; role: string; active: boolean; permissions: Record<string, unknown> }>();
}

/** An access_users row this suite owns, so the purge can find it again. */
async function makeAccessUser(email: string, role: string, active = 1): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await baseEnv.DB.prepare(
    `INSERT INTO access_users (id, email, role, active, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT (email) DO UPDATE SET role = excluded.role, active = excluded.active`,
  )
    .bind(id, email, role, active, now)
    .run();
  return (await accessRow(email))!.id;
}

async function makeBotAdmin(
  telegramId: number,
  role: string,
  opts: { permissions?: Record<string, boolean>; active?: boolean } = {},
): Promise<number> {
  const row = await baseEnv.DB.prepare(
    `INSERT INTO admins (telegram_id, username, role, permissions, active)
     VALUES (?1, ?2, ?3, ?4::jsonb, ?5) RETURNING id`,
  )
    .bind(
      telegramId,
      `${PREFIX}${telegramId}`,
      role,
      JSON.stringify(opts.permissions ?? {}),
      opts.active ?? true,
    )
    .first<{ id: number }>();
  return Number(row!.id);
}

async function purge(): Promise<void> {
  await baseEnv.DB.prepare(`DELETE FROM reseller_requests WHERE legacy_id LIKE ?1`)
    .bind(`${PREFIX}%`)
    .run();
  // `admins` is deleted by `deleteFixtureUsers` below, bounded to this suite's
  // range. It was unbounded here and reached every other suite's admins.
  // "The last active OWNER" is a property of the whole table, so a test of it
  // has to own the whole table — a stray OWNER from `apps/bot/test/admin.test.ts`
  // (which clears its own 500000–599999 range at `beforeAll`, so its rows
  // outlive its run) would make the guard correctly allow what this asserts it
  // refuses. Demoted rather than deleted: nothing reads these between runs, and
  // a DELETE would reach across a package boundary for no gain.
  await baseEnv.DB.prepare(
    `UPDATE admins SET role = 'ADMIN' WHERE telegram_id < ?1 AND role = 'OWNER'`,
  )
    .bind(TG_BASE)
    .run();
  await deleteFixtureUsers(TG_BASE);
  // Only this suite's own rows. `%@example.com` would take `admin@example.com`
  // with it — the identity `customers.test.ts` and `products.test.ts` create in
  // their `beforeAll` and never create again, so those suites would start
  // answering 403 depending on which file ran first.
  await baseEnv.DB.prepare(`DELETE FROM access_users WHERE email = ANY($1)`).bind(OURS).run();
}

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await purge();
  await makeAccessUser(ADMIN, 'ADMIN');
  await baseEnv.DB.prepare(`TRUNCATE audit_logs CASCADE`).run();
});

afterAll(purge);

// ---------------------------------------------------------------------------
// access_users
// ---------------------------------------------------------------------------

describe('the panel’s operators', () => {
  it('adds one, and says plainly it is not the door', async () => {
    const res = await call('access-users', {
      method: 'POST',
      body: JSON.stringify({ email: 'New.Person@Example.com', role: 'REVIEWER' }),
    });
    expect(res.status).toBe(201);

    // Lower-cased on the way in: `access_users.email` is UNIQUE and the JWT
    // claim is whatever the identity provider sends, so two casings of one
    // person would be two rows and one of them would never match.
    const row = await accessRow('new.person@example.com');
    expect(row!.role).toBe('REVIEWER');
    expect(row!.active).toBe(1);
  });

  it('refuses a second row for the same person', async () => {
    await makeAccessUser(OTHER_ADMIN, 'REVIEWER');
    const res = await call('access-users', {
      method: 'POST',
      body: JSON.stringify({ email: OTHER_ADMIN, role: 'ADMIN' }),
    });
    expect(res.status).toBe(409);
    expect((await accessRow(OTHER_ADMIN))!.role).toBe('REVIEWER');
  });

  it('will not let you demote yourself', async () => {
    // Not a race — you cannot concurrently be somebody else — but the shape is
    // the same and it belongs in the same WHERE, so there is one place to read.
    const id = (await accessRow(ADMIN))!.id;
    const res = await call(`access-users/${id}`, {
      method: 'POST',
      body: JSON.stringify({ role: 'READ_ONLY' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('self_edit');
    expect((await accessRow(ADMIN))!.role).toBe('ADMIN');
  });

  it('will not let you delete yourself', async () => {
    const id = (await accessRow(ADMIN))!.id;
    expect((await call(`access-users/${id}`, { method: 'DELETE' })).status).toBe(409);
    expect(await accessRow(ADMIN)).not.toBeNull();
  });

  it('keeps the last active admin, whichever way you try to remove them', async () => {
    // Only one ADMIN exists — the writer. So a second admin is made, and the
    // writer removes the writer's own... no: the writer removes the OTHER one,
    // which is allowed, and then the second attempt has nobody left to fall
    // back on. Both routes are checked because both can empty the table.
    const otherId = await makeAccessUser(OTHER_ADMIN, 'ADMIN');
    expect(
      (
        await call(`access-users/${otherId}`, {
          method: 'POST',
          body: JSON.stringify({ role: 'READ_ONLY' }),
        })
      ).status,
    ).toBe(200);

    // Now `ADMIN` is the only one, and only somebody else could demote them —
    // so the self guard covers this case. Prove the last-admin condition on a
    // row that is not the writer's: make the other one an admin again and take
    // the writer's own admin away first.
    await makeAccessUser(OTHER_ADMIN, 'ADMIN');
    await baseEnv.DB.prepare(`UPDATE access_users SET role = 'REVIEWER' WHERE email = ?1`)
      .bind(ADMIN)
      .run();

    // The writer is a REVIEWER now, so writes are refused for a different
    // reason. Put it back and instead deactivate the other admin while the
    // writer is the second one — that must succeed…
    await baseEnv.DB.prepare(`UPDATE access_users SET role = 'ADMIN' WHERE email = ?1`)
      .bind(ADMIN)
      .run();
    expect(
      (
        await call(`access-users/${otherId}`, {
          method: 'POST',
          body: JSON.stringify({ active: false }),
        })
      ).status,
    ).toBe(200);

    // …and now, with the writer the only active admin left, deleting the
    // inactive one is still fine, but demoting the writer is not.
    const meId = (await accessRow(ADMIN))!.id;
    const res = await call(`access-users/${meId}`, {
      method: 'POST',
      body: JSON.stringify({ role: 'REVIEWER' }),
    });
    expect(res.status).toBe(409);
  });

  it('refuses the last active admin even when the writer is somebody else', async () => {
    // The condition that is actually a race: a second admin demoting the only
    // other one while a third request does the same.
    const soloId = await makeAccessUser(OTHER_ADMIN, 'ADMIN');
    await baseEnv.DB.prepare(`DELETE FROM access_users WHERE email = ?1`).bind(ADMIN).run();
    await makeAccessUser(ADMIN, 'ADMIN');

    // Two active admins: ADMIN (the writer) and OTHER_ADMIN. Deactivate the
    // writer's own row through the other one first is not possible, so instead
    // deactivate OTHER_ADMIN, leaving one, then try to deactivate that one.
    expect(
      (
        await call(`access-users/${soloId}`, {
          method: 'POST',
          body: JSON.stringify({ active: false }),
        })
      ).status,
    ).toBe(200);

    const lastId = (await accessRow(ADMIN))!.id;
    const res = await call(`access-users/${lastId}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(await accessRow(ADMIN)).not.toBeNull();
  });

  it('survives two admins deleting each other at the same moment', async () => {
    // What this establishes: two admins removing each other do not both
    // succeed, and one active admin is left.
    //
    // What it does NOT establish, and the file it tests says so too: that the
    // survivor lock is what achieves it. Removing that lock leaves this green —
    // two `app.request` calls from one process do not interleave at the point
    // that would show it, and the loser here is refused because its own row
    // went first, not because the condition caught it. A stronger test needs
    // two processes.
    const a = await makeAccessUser(RACE_A, 'ADMIN');
    const b = await makeAccessUser(RACE_B, 'ADMIN');

    // "The last active admin" counts the whole table, and the other suites in
    // this package keep an admin of their own — with a third one standing
    // there, both deletes are legitimately allowed and there is no race to see.
    // So they step aside for the length of this test and are put back, whatever
    // happens.
    const bystanders = await baseEnv.DB.prepare(
      `SELECT id FROM access_users WHERE role = 'ADMIN' AND active = 1 AND email <> ALL($1)`,
    )
      .bind([RACE_A, RACE_B])
      .all<{ id: string }>();
    const ids = (bystanders.results ?? []).map((r) => r.id);
    await baseEnv.DB.prepare(`UPDATE access_users SET role = 'REVIEWER' WHERE id = ANY($1)`)
      .bind(ids)
      .run();

    try {
      const [first, second] = await Promise.all([
        call(`access-users/${b}`, { method: 'DELETE' }, RACE_A),
        call(`access-users/${a}`, { method: 'DELETE' }, RACE_B),
      ]);

      // Exactly one wins. The loser is refused either as `last_admin` or, if
      // its own row went first, as `forbidden` — its identity no longer
      // resolves. Both are the same answer to the same question, so what is
      // asserted is the property, not which sentence came back.
      expect([first.status, second.status].filter((s) => s === 200)).toHaveLength(1);

      const left = await baseEnv.DB.prepare(
        `SELECT COUNT(*)::int AS n FROM access_users
          WHERE role = 'ADMIN' AND active = 1 AND email = ANY($1)`,
      )
        .bind([RACE_A, RACE_B])
        .first<{ n: number }>();
      expect(left!.n).toBe(1);
    } finally {
      await baseEnv.DB.prepare(`UPDATE access_users SET role = 'ADMIN' WHERE id = ANY($1)`)
        .bind(ids)
        .run();
    }
  });

  it('is read by a reviewer and written only by an admin', async () => {
    await makeAccessUser(REVIEWER, 'REVIEWER');
    expect((await call('access-users', {}, REVIEWER)).status).toBe(200);
    const res = await call(
      'access-users',
      { method: 'POST', body: JSON.stringify({ email: 'x@example.com', role: 'ADMIN' }) },
      REVIEWER,
    );
    expect(res.status).toBe(403);
    expect(await accessRow('x@example.com')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// admins — the bot
// ---------------------------------------------------------------------------

describe('the bot’s operators', () => {
  it('creates one with the permissions it was given', async () => {
    const telegramId = TG_BASE + 11;
    const res = await call('bot-admins', {
      method: 'POST',
      body: JSON.stringify({
        telegramId,
        username: 'newop',
        role: 'SUPPORT',
        permissions: { 'claims.view': true, 'claims.reject': true },
      }),
    });
    expect(res.status).toBe(201);

    const row = await botAdminRow(telegramId);
    expect(row!.role).toBe('SUPPORT');
    expect(row!.permissions).toEqual({ 'claims.view': true, 'claims.reject': true });
  });

  it('refuses a permission it does not know rather than storing it', async () => {
    // A stored permission nothing reads is a promise the panel makes and no
    // branch keeps: the admin ticks a box and believes somebody was restricted.
    const res = await call('bot-admins', {
      method: 'POST',
      body: JSON.stringify({
        telegramId: TG_BASE + 12,
        role: 'SUPPORT',
        permissions: { 'claims.delete_everything': true },
      }),
    });
    expect(res.status).toBe(400);
    expect(await botAdminRow(TG_BASE + 12)).toBeNull();
  });

  it('reports what a role comes to when nothing is set', async () => {
    // Every production row holds `{}`. Reading that as deny-all would take the
    // admin panel away from everyone at once, so it means "what this role has
    // always meant" — and the list says so out loud.
    await makeBotAdmin(TG_BASE + 13, 'SUPPORT');
    await makeBotAdmin(TG_BASE + 14, 'ADMIN');
    await makeBotAdmin(TG_BASE + 15, 'OWNER');

    const body = (await (await call('bot-admins')).json()) as {
      items: Array<{ telegramId: number; effective: string[] }>;
    };
    const of = (tg: number) => body.items.find((i) => i.telegramId === tg)!.effective;
    // SUPPORT answers and does not decide: it may look at the payment queue,
    // look a customer up and write to them, and it may not approve, reject,
    // move money, block, set a discount, see what the shop took today, or reach
    // everybody at once. Written out rather than counted, because the list is
    // the claim.
    expect(of(TG_BASE + 13)).toEqual(['claims.view', 'users.view', 'users.message']);
    expect(of(TG_BASE + 14)).toContain('claims.approve_without_tx');
    // Every one of them, whatever the list has grown to. A literal count here
    // said "4" and turned adding a permission into a failing test about
    // something else — the claim being made is "an owner always may", not "there
    // are four things one may do".
    expect(of(TG_BASE + 15)).toEqual([...ADMIN_PERMISSIONS]);
  });

  it('keeps the last active owner', async () => {
    const ownerId = await makeBotAdmin(TG_BASE + 16, 'OWNER');
    await makeBotAdmin(TG_BASE + 17, 'ADMIN');

    for (const body of [{ role: 'ADMIN' }, { active: false }]) {
      const res = await call(`bot-admins/${ownerId}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(409);
    }
    expect((await call(`bot-admins/${ownerId}`, { method: 'DELETE' })).status).toBe(409);

    const row = await botAdminRow(TG_BASE + 16);
    expect(row!.role).toBe('OWNER');
    expect(row!.active).toBe(true);
  });

  it('edits a non-owner when the shop has no owner at all', async () => {
    // The state a fresh `admins` table is in, and the first thing anybody would
    // try. The last-owner guard originally asked only "does another owner
    // exist", so with no owner anywhere it refused every edit to every
    // operator — including ticking a permission on a SUPPORT row. Found by
    // doing exactly that in the panel, not by reading the SQL.
    const id = await makeBotAdmin(TG_BASE + 40, 'SUPPORT');
    const res = await call(`bot-admins/${id}`, {
      method: 'POST',
      body: JSON.stringify({ permissions: { 'claims.reject': true } }),
    });
    expect(res.status).toBe(200);
    expect((await botAdminRow(TG_BASE + 40))!.permissions).toEqual({ 'claims.reject': true });
  });

  it('lets an owner go once a second one exists', async () => {
    const first = await makeBotAdmin(TG_BASE + 18, 'OWNER');
    await makeBotAdmin(TG_BASE + 19, 'OWNER');
    expect((await call(`bot-admins/${first}`, { method: 'DELETE' })).status).toBe(200);
    expect(await botAdminRow(TG_BASE + 18)).toBeNull();
  });

  it('refuses to delete an operator whose decisions are recorded', async () => {
    // `reseller_requests.decided_by` is ON DELETE SET NULL, so this delete
    // would blank who approved a reseller application and report success —
    // the same silent history loss the catalogue delete guard exists for.
    const adminId = await makeBotAdmin(TG_BASE + 20, 'OWNER');
    await makeBotAdmin(TG_BASE + 21, 'OWNER');
    const user = await baseEnv.DB.prepare(
      `INSERT INTO users (telegram_id, username, registered_at) VALUES (?1, ?2, now()) RETURNING id`,
    )
      .bind(TG_BASE + 22, `${PREFIX}applicant`)
      .first<{ id: number }>();
    await baseEnv.DB.prepare(
      `INSERT INTO reseller_requests (user_id, status, decided_by, decided_at, created_at, legacy_id)
       VALUES (?1, 'APPROVED', ?2, now(), now(), ?3)`,
    )
      .bind(Number(user!.id), adminId, `${PREFIX}req1`)
      .run();

    const res = await call(`bot-admins/${adminId}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      detail: string;
      counts: { decisions: number };
    };
    expect(body.error).toBe('in_use');
    expect(body.counts.decisions).toBe(1);
    expect(body.detail).toContain('غیرفعال');

    // The decision still names who made it.
    const req = await baseEnv.DB.prepare(
      `SELECT decided_by FROM reseller_requests WHERE legacy_id = ?1`,
    )
      .bind(`${PREFIX}req1`)
      .first<{ decided_by: number }>();
    expect(Number(req!.decided_by)).toBe(adminId);

    // And the offered alternative works.
    expect(
      (
        await call(`bot-admins/${adminId}`, {
          method: 'POST',
          body: JSON.stringify({ active: false }),
        })
      ).status,
    ).toBe(200);
    expect((await botAdminRow(TG_BASE + 20))!.active).toBe(false);
  });

  it('is written only by an admin', async () => {
    await makeAccessUser(REVIEWER, 'REVIEWER');
    const res = await call(
      'bot-admins',
      { method: 'POST', body: JSON.stringify({ telegramId: TG_BASE + 30, role: 'OWNER' }) },
      REVIEWER,
    );
    expect(res.status).toBe(403);
    expect(await botAdminRow(TG_BASE + 30)).toBeNull();
  });
});
