import type { EnvName } from '@shikoo/contracts';
/**
 * Who may use the panel, and who may use the bot's admin screens.
 *
 * Two tables, two audiences, and until now neither had a single line of
 * interface. `access_users` was written by the seed runner and by hand;
 * `admins` — the bot's own operators, with OWNER/ADMIN/SUPPORT and a
 * `permissions` column that has existed since `0005_ops.sql` — held **zero
 * rows**, which is to say the bot's admin panel was unreachable by anybody.
 *
 * ## What this screen does and does not decide
 *
 * `access_users.role` decides what a signed-in operator may *do*. It does not
 * decide who may sign in: that is a Cloudflare Access policy, configured
 * somewhere this code cannot see, and adding a row here does not let anybody
 * through the door. The panel says so in as many words, because an admin who
 * believes they granted access and did not is worse off than one who knows they
 * have another step.
 *
 * ## Three guards, all inside the statement
 *
 * Locking yourself out is one edit, and the edit that does it looks ordinary.
 * So:
 *
 *   **You do not demote, deactivate or delete yourself.** Not a race — you
 *   cannot concurrently be someone else — but it belongs in the same WHERE as
 *   the others so there is one place to read.
 *
 *   **The last active ADMIN does not go.** This one IS a race: two admins
 *   demoting each other at the same moment both read "there is another admin"
 *   and both succeed. `NOT EXISTS` inside the UPDATE is evaluated under the
 *   row locks the UPDATE takes, so one of them loses.
 *
 *   **The last active OWNER does not go**, same shape, for `admins`.
 *
 * Zero rows back means a guard refused. Which one is worked out afterwards, and
 * only to word the message.
 *
 * ## Deleting a bot admin is guarded too
 *
 * `reseller_requests.decided_by` and `support_tickets.assigned_to` both
 * reference `admins` with `ON DELETE SET NULL`. Deleting an operator therefore
 * blanks the record of who decided a reseller application — the same silent
 * history loss the catalogue delete guard exists for, in a different table. The
 * delete refuses and «غیرفعال» is offered instead.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import {
  ADMIN_PERMISSIONS,
  ADMIN_PERMISSION_FA,
  SECTION_IDS,
  cleanPermissions,
  isBuiltInGroup,
  permissionsOf,
  type BotAdminRole,
  type SectionLevel,
} from '@shikoo/contracts';
import { hashPassword, passwordProblem } from '@shikoo/domain';
import { audit, type Ident } from './adminAudit.js';
import { confirmPassword } from './operatorSession.js';
import { faNum } from './fa.js';

const ACCESS_ROLES = ['ADMIN', 'REVIEWER', 'READ_ONLY'] as const;
const BOT_ROLES = ['OWNER', 'ADMIN', 'SUPPORT'] as const;

/** The built-in group a legacy role names — what the panel still sends. */
const GROUP_OF_ROLE = { ADMIN: 'admin', REVIEWER: 'reviewer', READ_ONLY: 'read_only' } as const;

const AccessUserCreate = z
  .object({
    email: z.string().trim().toLowerCase().email().max(200),
    displayName: z.string().trim().max(120).nullable().default(null),
    // One or the other: `role` for the built-in groups, `groupId` for any.
    role: z.enum(ACCESS_ROLES).optional(),
    groupId: z.string().min(1).max(64).optional(),
    // Without one the account cannot sign in until `operator.ts
    // set-password` gives it one — as before.
    password: z.string().max(200).optional(),
    totpRequired: z.boolean().default(false),
    currentPassword: z.string().max(200).optional(),
  })
  .strict()
  .refine((b) => (b.role === undefined) !== (b.groupId === undefined), 'role or groupId');

const AccessUserPatch = z
  .object({
    role: z.enum(ACCESS_ROLES).optional(),
    groupId: z.string().min(1).max(64).optional(),
    active: z.boolean().optional(),
    displayName: z.string().trim().max(120).nullable().optional(),
    password: z.string().max(200).optional(),
    totpRequired: z.boolean().optional(),
    resetTotp: z.literal(true).optional(),
    currentPassword: z.string().max(200).optional(),
  })
  .strict()
  .refine((b) => !(b.role && b.groupId), 'role or groupId')
  .refine(
    (b) => Object.keys(b).some((k) => k !== 'currentPassword'),
    'no fields to change',
  );

const SECTION_LEVELS = ['none', 'view', 'edit'] as const;

/**
 * A custom group's permissions: every key a section, «none» dropped.
 *
 * «دسترسی‌ها» may be read but never edited by a custom group — edit there is
 * setting another operator's password or rewriting your own group. The CHECK
 * in migration 0101 says the same; this says it with a sentence.
 */
const GroupPermissions = z
  .record(z.string(), z.enum(SECTION_LEVELS))
  .refine((p) => Object.keys(p).every((k) => (SECTION_IDS as readonly string[]).includes(k)), {
    message: 'بخش ناشناخته',
  })
  .refine((p) => p.access !== 'edit', { message: 'ویرایش «دسترسی‌ها» فقط برای گروه مدیر است.' })
  .transform(
    (p) =>
      Object.fromEntries(Object.entries(p).filter(([, v]) => v !== 'none')) as Record<
        string,
        SectionLevel
      >,
  );

const AccessGroupCreate = z
  .object({ name: z.string().trim().min(1).max(60), permissions: GroupPermissions })
  .strict();

const AccessGroupPatch = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    permissions: GroupPermissions.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'no fields to change');

const BotAdminCreate = z
  .object({
    telegramId: z.number().int().positive(),
    username: z.string().trim().max(64).nullable().default(null),
    role: z.enum(BOT_ROLES),
    permissions: z.record(z.string(), z.boolean()).default({}),
  })
  .strict();

const BotAdminPatch = z
  .object({
    username: z.string().trim().max(64).nullable().optional(),
    role: z.enum(BOT_ROLES).optional(),
    active: z.boolean().optional(),
    permissions: z.record(z.string(), z.boolean()).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'no fields to change');

/**
 * Somebody other than this row is still an active ADMIN / OWNER.
 *
 * SQL fragments rather than a function of the row, because the whole point is
 * that they are evaluated inside the UPDATE and the DELETE. `?1` is the row
 * being changed, and excluding it is what makes "somebody ELSE" mean that.
 */
const KEEPS_AN_ADMIN = `EXISTS (
  SELECT 1 FROM access_users o
   WHERE o.id <> ?1 AND o.role = 'ADMIN' AND o.active = 1)`;

const KEEPS_AN_OWNER = `EXISTS (
  SELECT 1 FROM admins o WHERE o.id <> ?1 AND o.role = 'OWNER' AND o.active)`;

/**
 * Locks every row that could be the last one, then runs the write.
 *
 * The condition inside the statement is necessary and, on its own, not
 * sufficient. Two admins deleting each other at the same moment each ask "is
 * there an active ADMIN other than the one I am deleting?" — and each sees the
 * other, so both succeed and the table is empty. Row locks on the two different
 * target rows do not help; the `EXISTS` reads a snapshot.
 *
 * Taking a lock on the whole set of survivors first makes the second writer
 * wait, re-read, and find that its answer has changed.
 *
 * **This lock is reasoned, not demonstrated.** Removing it leaves the whole
 * suite green, including the concurrent-delete test — two `app.request` calls
 * from one process do not interleave at the point that would show it, and the
 * loser there is refused for a different reason (its own identity is gone by
 * the time the middleware looks it up). So the test below establishes the
 * invariant "not both deletes succeed" and does not establish that this lock is
 * what enforces it. Said plainly rather than left as a comment claiming safety,
 * which is the failure this project keeps finding.
 *
 * Kept because it is cheap — `admins` is edited a few times a year — and
 * because the alternative is a guard that is provably insufficient on paper.
 */
async function lockingSurvivors<T>(
  db: D1Database,
  table: 'access_users' | 'admins',
  run: (tx: Parameters<Parameters<D1Database['withSession']>[0]>[0]) => Promise<T>,
): Promise<T> {
  const sql =
    table === 'access_users'
      ? `SELECT id FROM access_users WHERE role = 'ADMIN' AND active = 1 FOR UPDATE`
      : `SELECT id FROM admins WHERE role = 'OWNER' AND active FOR UPDATE`;
  return db.withSession(async (tx) => {
    await tx.prepare(sql).all();
    return run(tx);
  });
}

function builtIn(c: { json: (body: unknown, status: 409) => Response }) {
  return c.json(
    {
      ok: false,
      error: 'built_in',
      detail: 'گروه‌های پیش‌فرض همان نقش‌های قبلی‌اند و عوض نمی‌شوند؛ گروه تازه بسازید.',
    },
    409,
  );
}

/**
 * Who may touch an admin (Sam, 2026-09-25): the owner, and nobody else once
 * there is one. Until `operator.ts set-owner` has named one, any admin may, as
 * before 0101 — except handing out an admin's password or clearing their
 * second factor, which was never possible from the panel and is the owner's
 * from the start. The owner themselves is changed only from the CLI, so there
 * is never an owner-against-owner fight and never a shop left without one.
 *
 * `null` when allowed.
 */
async function adminGuard(
  db: D1Database,
  ident: Ident,
  change: { from?: string; to?: string; credentials: boolean },
): Promise<Response | null> {
  if (change.from === 'owner' || change.to === 'owner') {
    return Response.json(
      { ok: false, error: 'owner_via_cli', detail: 'مالک فقط با CLI سرور تعیین یا عوض می‌شود.' },
      { status: 409 },
    );
  }
  const touchesAdmin = change.from === 'admin' || change.to === 'admin';
  if (!touchesAdmin || ident.groupId === 'owner') return null;
  if (!change.credentials && !(await hasOwner(db))) return null;
  return Response.json(
    { ok: false, error: 'owner_only', detail: 'مدیرها را فقط مالک مدیریت می‌کند.' },
    { status: 403 },
  );
}

async function hasOwner(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 FROM access_users WHERE group_id = 'owner' AND active = 1`)
    .first();
  return row !== null;
}

async function groupExists(db: D1Database, id: string): Promise<boolean> {
  return (await db.prepare(`SELECT 1 FROM access_groups WHERE id = ?1`).bind(id).first()) !== null;
}

/**
 * The acting operator's own password, asked again before handing somebody a
 * way in. A session is a bearer token; without this a stolen cookie ends in an
 * account with a password the thief chose. `null` when it checks out.
 */
async function reauth(
  db: D1Database,
  ident: Ident,
  current: string | undefined,
): Promise<Response | null> {
  if (!current) {
    return Response.json(
      { ok: false, error: 'current_password_required', detail: 'رمز خودتان را وارد کنید.' },
      { status: 401 },
    );
  }
  const r = await confirmPassword(db, ident.email, current);
  if (r.ok) return null;
  return Response.json({ ok: false, error: r.error, until: r.until }, { status: r.status });
}

export function registerAdminAccessRoutes(
  app: Hono<{ Bindings: { DB: D1Database; ENV_NAME: EnvName }; Variables: { identity: Ident } }>,
) {
  /**
   * Who the caller is, according to the door they came through.
   *
   * The panel had no way to ask. So it drew every button for everybody and let
   * the server answer 403 — which is safe, and reads to the operator as a
   * broken panel rather than as a boundary. Readable by every role on purpose:
   * a reader must be able to find out that they are a reader.
   */
  app.get('/api/v1/admin/me', async (c) => {
    const ident = c.get('identity');
    const row = await c.env.DB.prepare(
      `SELECT g.id, g.name, u.totp_enabled, u.totp_required
         FROM access_users u JOIN access_groups g ON g.id = u.group_id
        WHERE u.email = ?1`,
    )
      .bind(ident.email)
      .first<{ id: string; name: string; totp_enabled: boolean; totp_required: boolean }>();
    return c.json({
      ok: true,
      email: ident.email,
      role: ident.role,
      groupId: row?.id ?? null,
      groupName: row?.name ?? null,
      // null for a built-in group: the panel draws those from `role`, as before.
      perms: ident.perms ?? null,
      totp: { enabled: Boolean(row?.totp_enabled), required: Boolean(row?.totp_required) },
    });
  });

  // -------------------------------------------------------------------------
  // access_users — the web panel
  // -------------------------------------------------------------------------

  app.get('/api/v1/admin/access-users', async (c) => {
    const rows = await c.env.DB.prepare(
      `SELECT id, email, display_name, role, group_id, active, created_at, updated_at,
              totp_enabled, totp_required, password_hash IS NOT NULL AS has_password
         FROM access_users ORDER BY role, email`,
    ).all<{
      id: string;
      email: string;
      display_name: string | null;
      role: string;
      group_id: string;
      active: number;
      created_at: number;
      updated_at: number;
      totp_enabled: boolean;
      totp_required: boolean;
      has_password: boolean;
    }>();
    return c.json({
      ok: true,
      you: c.get('identity').email,
      items: (rows.results ?? []).map((r) => ({
        id: r.id,
        email: r.email,
        displayName: r.display_name,
        role: r.role,
        groupId: r.group_id,
        active: r.active === 1,
        totpEnabled: r.totp_enabled,
        totpRequired: r.totp_required,
        hasPassword: r.has_password,
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
      })),
    });
  });

  app.post('/api/v1/admin/access-users', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const body = AccessUserCreate.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }
    const { email, displayName, password, totpRequired } = body.data;
    const groupId = body.data.groupId ?? GROUP_OF_ROLE[body.data.role!];
    if (!(await groupExists(c.env.DB, groupId))) {
      return c.json({ ok: false, error: 'unknown_group' }, 400);
    }
    const refused = await adminGuard(c.env.DB, ident, {
      to: groupId,
      credentials: password !== undefined,
    });
    if (refused) return refused;
    let hash: string | null = null;
    if (password !== undefined) {
      const problem = passwordProblem(password);
      if (problem) return c.json({ ok: false, error: 'weak_password', detail: problem }, 400);
      const again = await reauth(c.env.DB, ident, body.data.currentPassword);
      if (again) return again;
      hash = await hashPassword(password);
    }
    const now = Date.now();
    const id = crypto.randomUUID();

    // `role` follows `group_id` — the trigger from migration 0101 writes it.
    const row = await c.env.DB.prepare(
      `INSERT INTO access_users (id, email, display_name, group_id, password_hash,
                                 password_updated_at, totp_required, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, CASE WHEN ?5::text IS NULL THEN NULL ELSE now() END, ?6, 1, ?7, ?7)
       ON CONFLICT (email) DO NOTHING RETURNING id, role`,
    )
      .bind(id, email, displayName, groupId, hash, totpRequired, now)
      .first<{ id: string; role: string }>();
    if (!row) {
      return c.json(
        { ok: false, error: 'duplicate_email', detail: 'این ایمیل از قبل در فهرست هست.' },
        409,
      );
    }

    await audit(
      c.env.DB,
      ident,
      'access.user_created',
      'ACCESS_USER',
      id,
      null,
      { email, role: row.role, group: groupId, totp_required: totpRequired, password_set: hash !== null },
      null,
    );
    return c.json({ ok: true, id }, 201);
  });

  app.post('/api/v1/admin/access-users/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = c.req.param('id');
    const body = AccessUserPatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }

    const before = await c.env.DB.prepare(
      `SELECT id, email, display_name, role, group_id, active, totp_required
         FROM access_users WHERE id = ?1`,
    )
      .bind(id)
      .first<{
        id: string;
        email: string;
        display_name: string | null;
        role: string;
        group_id: string;
        active: number;
        totp_required: boolean;
      }>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);

    const { password, resetTotp } = body.data;
    const groupId =
      body.data.groupId ?? (body.data.role ? GROUP_OF_ROLE[body.data.role] : before.group_id);
    if (groupId !== before.group_id && !(await groupExists(c.env.DB, groupId))) {
      return c.json({ ok: false, error: 'unknown_group' }, 400);
    }
    const active = body.data.active ?? before.active === 1;
    const displayName =
      body.data.displayName === undefined ? before.display_name : body.data.displayName;
    const totpRequired = body.data.totpRequired ?? before.totp_required;

    // Handing out a way in. Never for yourself — «رمز عبور» on your own card
    // asks for the old one — and for an admin only by the owner.
    const credentials = password !== undefined || resetTotp === true;
    const refused = await adminGuard(c.env.DB, ident, {
      from: before.group_id,
      to: groupId,
      credentials,
    });
    if (refused) return refused;
    let hash: string | null = null;
    if (credentials) {
      if (before.email === ident.email) {
        return c.json(
          {
            ok: false,
            error: 'self_credentials',
            detail: 'رمز و ورود دومرحله‌ای خودتان را از کارت «رمز عبور» عوض کنید.',
          },
          409,
        );
      }
      if (password !== undefined) {
        const problem = passwordProblem(password);
        if (problem) return c.json({ ok: false, error: 'weak_password', detail: problem }, 400);
      }
      const again = await reauth(c.env.DB, ident, body.data.currentPassword);
      if (again) return again;
      if (password !== undefined) hash = await hashPassword(password);
    }

    const done = await lockingSurvivors(c.env.DB, 'access_users', async (tx) => {
      const row = await tx
        .prepare(
          `UPDATE access_users
              SET group_id = ?2, active = ?3, display_name = ?4, updated_at = ?5,
                  totp_required = ?7,
                  password_hash       = COALESCE(?8::text, password_hash),
                  password_updated_at = CASE WHEN ?8::text IS NULL THEN password_updated_at ELSE now() END,
                  failed_attempts     = CASE WHEN ?8::text IS NULL THEN failed_attempts ELSE 0 END,
                  locked_until        = CASE WHEN ?8::text IS NULL THEN locked_until ELSE NULL END,
                  totp_secret    = CASE WHEN ?9::boolean THEN NULL  ELSE totp_secret END,
                  totp_enabled   = CASE WHEN ?9::boolean THEN false ELSE totp_enabled END,
                  totp_last_step = CASE WHEN ?9::boolean THEN NULL  ELSE totp_last_step END
            WHERE id = ?1
              AND email <> ?6
              AND ((?2 = 'admin' AND ?3 = 1) OR ${KEEPS_AN_ADMIN})
            RETURNING id, role`,
        )
        .bind(
          id,
          groupId,
          active ? 1 : 0,
          displayName,
          Date.now(),
          ident.email,
          totpRequired,
          hash,
          resetTotp === true,
        )
        .first<{ id: string; role: string }>();
      // A new password or a cleared second factor ends every session the old
      // ones opened — the reason anybody resets them.
      if (row && credentials) {
        await tx
          .prepare(
            `UPDATE operator_sessions SET revoked_at = now()
              WHERE access_user_id = ?1 AND revoked_at IS NULL`,
          )
          .bind(id)
          .run();
      }
      return row;
    });

    if (!done) {
      const mine = before.email === ident.email;
      return c.json(
        {
          ok: false,
          error: mine ? 'self_edit' : 'last_admin',
          detail: mine
            ? 'نقش و وضعیت خودتان را از همین‌جا عوض نکنید — ادمین دیگری این کار را انجام دهد.'
            : 'این تنها ادمین فعال است؛ اول یک ادمین دیگر بسازید.',
        },
        409,
      );
    }

    await audit(
      c.env.DB,
      ident,
      'access.user_updated',
      'ACCESS_USER',
      id,
      {
        role: before.role,
        group: before.group_id,
        active: before.active === 1,
        totp_required: before.totp_required,
      },
      { role: done.role, group: groupId, active, totp_required: totpRequired },
      null,
    );
    if (hash !== null) {
      await audit(c.env.DB, ident, 'access.password_set', 'ACCESS_USER', id, null, null, null);
    }
    if (resetTotp) {
      await audit(c.env.DB, ident, 'access.totp_reset', 'ACCESS_USER', id, null, null, null);
    }
    return c.json({ ok: true });
  });

  // ── Access groups (issue #363) ───────────────────────────────────────────
  //
  // The three built-in groups are listed and never changed here: they mean the
  // three roles, which the rest of the worker still reads. A custom group is a
  // name and a page → none/view/edit map, enforced by `customGroupRole`.

  app.get('/api/v1/admin/access-groups', async (c) => {
    const rows = await c.env.DB.prepare(
      `SELECT g.id, g.name, g.permissions, g.created_at, g.updated_at,
              (SELECT COUNT(*) FROM access_users u WHERE u.group_id = g.id) AS members
         FROM access_groups g
        ORDER BY g.created_at, g.name`,
    ).all<{
      id: string;
      name: string;
      permissions: Record<string, SectionLevel>;
      created_at: number;
      updated_at: number;
      members: number;
    }>();
    return c.json({
      ok: true,
      sections: SECTION_IDS,
      items: (rows.results ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        builtIn: isBuiltInGroup(r.id),
        permissions: isBuiltInGroup(r.id) ? null : r.permissions,
        members: Number(r.members),
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
      })),
    });
  });

  app.post('/api/v1/admin/access-groups', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const body = AccessGroupCreate.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    const row = await c.env.DB.prepare(
      `INSERT INTO access_groups (id, name, permissions, created_at, updated_at)
       VALUES (?1, ?2, ?3::jsonb, ?4, ?4)
       ON CONFLICT (name) DO NOTHING RETURNING id`,
    )
      .bind(id, body.data.name, JSON.stringify(body.data.permissions), now)
      .first<{ id: string }>();
    if (!row) {
      return c.json(
        { ok: false, error: 'duplicate_name', detail: 'گروهی با این نام هست.' },
        409,
      );
    }
    await audit(
      c.env.DB,
      ident,
      'access.group_created',
      'ACCESS_GROUP',
      id,
      null,
      { name: body.data.name, permissions: body.data.permissions },
      null,
    );
    return c.json({ ok: true, id }, 201);
  });

  app.patch('/api/v1/admin/access-groups/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const id = c.req.param('id');
    if (isBuiltInGroup(id)) return builtIn(c);
    const body = AccessGroupPatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }
    const before = await c.env.DB.prepare(
      `SELECT name, permissions FROM access_groups WHERE id = ?1`,
    )
      .bind(id)
      .first<{ name: string; permissions: Record<string, SectionLevel> }>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);

    const name = body.data.name ?? before.name;
    const permissions = body.data.permissions ?? before.permissions;
    const row = await c.env.DB.prepare(
      `UPDATE access_groups SET name = ?2, permissions = ?3::jsonb, updated_at = ?4
        WHERE id = ?1
          AND NOT EXISTS (SELECT 1 FROM access_groups o WHERE o.name = ?2 AND o.id <> ?1)
        RETURNING id`,
    )
      .bind(id, name, JSON.stringify(permissions), Date.now())
      .first<{ id: string }>();
    if (!row) {
      return c.json(
        { ok: false, error: 'duplicate_name', detail: 'گروهی با این نام هست.' },
        409,
      );
    }
    await audit(
      c.env.DB,
      ident,
      'access.group_updated',
      'ACCESS_GROUP',
      id,
      { name: before.name, permissions: before.permissions },
      { name, permissions },
      null,
    );
    return c.json({ ok: true });
  });

  app.delete('/api/v1/admin/access-groups/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const id = c.req.param('id');
    if (isBuiltInGroup(id)) return builtIn(c);
    // The FK from access_users is RESTRICT, so a member added between this
    // check and the DELETE still stops it — as an error rather than a 409.
    const row = await c.env.DB.prepare(
      `DELETE FROM access_groups
        WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM access_users WHERE group_id = ?1)
        RETURNING name, permissions`,
    )
      .bind(id)
      .first<{ name: string; permissions: Record<string, SectionLevel> }>();
    if (!row) {
      const exists = await groupExists(c.env.DB, id);
      return exists
        ? c.json(
            {
              ok: false,
              error: 'in_use',
              detail: 'این گروه عضو دارد؛ اول اعضایش را به گروه دیگری ببرید.',
            },
            409,
          )
        : c.json({ ok: false, error: 'not_found' }, 404);
    }
    await audit(
      c.env.DB,
      ident,
      'access.group_deleted',
      'ACCESS_GROUP',
      id,
      { name: row.name, permissions: row.permissions },
      null,
      null,
    );
    return c.json({ ok: true });
  });

  app.delete('/api/v1/admin/access-users/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = c.req.param('id');
    const before = await c.env.DB.prepare(
      `SELECT id, email, role, group_id FROM access_users WHERE id = ?1`,
    )
      .bind(id)
      .first<{ id: string; email: string; role: string; group_id: string }>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);
    const refused = await adminGuard(c.env.DB, ident, {
      from: before.group_id,
      credentials: false,
    });
    if (refused) return refused;

    const done = await lockingSurvivors(c.env.DB, 'access_users', (tx) =>
      tx
        .prepare(
          `DELETE FROM access_users
            WHERE id = ?1 AND email <> ?2
              AND (role <> 'ADMIN' OR active <> 1 OR ${KEEPS_AN_ADMIN})
            RETURNING id`,
        )
        .bind(id, ident.email)
        .first<{ id: string }>(),
    );

    if (!done) {
      const mine = before.email === ident.email;
      return c.json(
        {
          ok: false,
          error: mine ? 'self_edit' : 'last_admin',
          detail: mine
            ? 'خودتان را از فهرست حذف نکنید — ادمین دیگری این کار را انجام دهد.'
            : 'این تنها ادمین فعال است؛ اول یک ادمین دیگر بسازید.',
        },
        409,
      );
    }

    await audit(
      c.env.DB,
      ident,
      'access.user_deleted',
      'ACCESS_USER',
      id,
      { email: before.email, role: before.role },
      null,
      null,
    );
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // admins — the bot
  // -------------------------------------------------------------------------

  app.get('/api/v1/admin/bot-admins', async (c) => {
    const rows = await c.env.DB.prepare(
      `SELECT a.id, a.telegram_id, a.username, a.role, a.permissions, a.active, a.created_at,
              (SELECT COUNT(*) FROM reseller_requests r WHERE r.decided_by = a.id) AS decisions,
              (SELECT COUNT(*) FROM support_tickets t WHERE t.assigned_to = a.id) AS tickets
         FROM admins a ORDER BY a.role, a.id`,
    ).all<{
      id: number;
      telegram_id: number;
      username: string | null;
      role: string;
      permissions: unknown;
      active: boolean;
      created_at: string;
      decisions: number;
      tickets: number;
    }>();

    return c.json({
      ok: true,
      // The vocabulary, sent with the list so the screen never hard-codes a
      // permission the server does not know about.
      permissions: ADMIN_PERMISSIONS.map((p) => ({ key: p, label: ADMIN_PERMISSION_FA[p] })),
      items: (rows.results ?? []).map((r) => {
        const raw =
          r.permissions !== null &&
          typeof r.permissions === 'object' &&
          !Array.isArray(r.permissions)
            ? (r.permissions as Record<string, unknown>)
            : {};
        return {
          id: Number(r.id),
          telegramId: Number(r.telegram_id),
          username: r.username,
          role: r.role,
          active: r.active,
          // Both: what was stored, and what it comes to once the role's own
          // meaning is applied. The screen shows the second and edits the first.
          permissions: raw,
          effective: permissionsOf(r.role as BotAdminRole, raw),
          decisionsCount: Number(r.decisions),
          ticketsCount: Number(r.tickets),
        };
      }),
    });
  });

  app.post('/api/v1/admin/bot-admins', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const body = BotAdminCreate.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }
    const permissions = cleanPermissions(body.data.permissions);
    if (permissions === null) {
      return c.json({ ok: false, error: 'invalid_body', detail: 'دسترسی ناشناخته' }, 400);
    }

    const row = await c.env.DB.prepare(
      `INSERT INTO admins (telegram_id, username, role, permissions, active)
       VALUES (?1, ?2, ?3, ?4::jsonb, true)
       ON CONFLICT (telegram_id) DO NOTHING RETURNING id`,
    )
      .bind(body.data.telegramId, body.data.username, body.data.role, JSON.stringify(permissions))
      .first<{ id: number }>();
    if (!row) {
      return c.json(
        {
          ok: false,
          error: 'duplicate_telegram_id',
          detail: 'این شناسهٔ تلگرام از قبل ادمین است.',
        },
        409,
      );
    }

    await audit(
      c.env.DB,
      ident,
      'access.bot_admin_created',
      'BOT_ADMIN',
      String(row.id),
      null,
      { telegram_id: body.data.telegramId, role: body.data.role, permissions },
      null,
    );
    return c.json({ ok: true, id: Number(row.id) }, 201);
  });

  app.post('/api/v1/admin/bot-admins/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const body = BotAdminPatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }

    const before = await c.env.DB.prepare(
      `SELECT id, telegram_id, username, role, permissions, active FROM admins WHERE id = ?1`,
    )
      .bind(id)
      .first<{
        id: number;
        telegram_id: number;
        username: string | null;
        role: string;
        permissions: unknown;
        active: boolean;
      }>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);

    const role = body.data.role ?? (before.role as BotAdminRole);
    const active = body.data.active ?? before.active;
    const username = body.data.username === undefined ? before.username : body.data.username;
    const permissions =
      body.data.permissions === undefined
        ? (before.permissions as Record<string, boolean>)
        : cleanPermissions(body.data.permissions);
    if (permissions === null) {
      return c.json({ ok: false, error: 'invalid_body', detail: 'دسترسی ناشناخته' }, 400);
    }

    // Only an edit that takes the LAST active owner away is refused. The first
    // version left out `role <> 'OWNER' OR NOT active` and so refused every
    // edit to every operator whenever no owner existed at all — which is the
    // state a fresh `admins` table is in, so the first thing anybody would have
    // tried was the thing it broke. Found by ticking a permission in the panel.
    const done = await lockingSurvivors(c.env.DB, 'admins', (tx) =>
      tx
        .prepare(
          `UPDATE admins
              SET role = ?2, active = ?3, username = ?4, permissions = ?5::jsonb
            WHERE id = ?1
              AND (role <> 'OWNER' OR NOT active
                   OR (?2 = 'OWNER' AND ?3) OR ${KEEPS_AN_OWNER})
            RETURNING id`,
        )
        .bind(id, role, active, username, JSON.stringify(permissions))
        .first<{ id: number }>(),
    );

    if (!done) {
      return c.json(
        {
          ok: false,
          error: 'last_owner',
          detail: 'این تنها مالک فعال ربات است؛ اول یک مالک دیگر بسازید.',
        },
        409,
      );
    }

    await audit(
      c.env.DB,
      ident,
      'access.bot_admin_updated',
      'BOT_ADMIN',
      String(id),
      { role: before.role, active: before.active, permissions: before.permissions },
      { role, active, permissions },
      null,
    );
    return c.json({ ok: true });
  });

  app.delete('/api/v1/admin/bot-admins/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const before = await c.env.DB.prepare(`SELECT id, telegram_id, role FROM admins WHERE id = ?1`)
      .bind(id)
      .first<{ id: number; telegram_id: number; role: string }>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);

    // Both FKs are ON DELETE SET NULL, so a delete here silently blanks who
    // decided a reseller application or who a ticket was assigned to. Same
    // failure as deleting a sold plan, different table.
    const done = await lockingSurvivors(c.env.DB, 'admins', (tx) =>
      tx
        .prepare(
          `DELETE FROM admins WHERE id = ?1
             AND (role <> 'OWNER' OR NOT active OR ${KEEPS_AN_OWNER})
             AND NOT EXISTS (SELECT 1 FROM reseller_requests WHERE decided_by = ?1)
             AND NOT EXISTS (SELECT 1 FROM support_tickets  WHERE assigned_to = ?1)
           RETURNING id`,
        )
        .bind(id)
        .first<{ id: number }>(),
    );

    if (!done) {
      const refs = await c.env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM reseller_requests WHERE decided_by = ?1) AS decisions,
                (SELECT COUNT(*) FROM support_tickets  WHERE assigned_to = ?1) AS tickets`,
      )
        .bind(id)
        .first<{ decisions: number; tickets: number }>();
      const decisions = Number(refs?.decisions ?? 0);
      const tickets = Number(refs?.tickets ?? 0);
      const parts: string[] = [];
      if (decisions > 0) parts.push(`${faNum(decisions)} تصمیم نمایندگی`);
      if (tickets > 0) parts.push(`${faNum(tickets)} تیکت`);
      return c.json(
        {
          ok: false,
          error: parts.length > 0 ? 'in_use' : 'last_owner',
          detail:
            parts.length > 0
              ? `${parts.join(' و ')} به این ادمین وصل است؛ حذف نام تصمیم‌گیرنده را پاک می‌کند. «غیرفعال» دسترسی را می‌بندد و تاریخچه سر جایش می‌ماند.`
              : 'این تنها مالک فعال ربات است؛ اول یک مالک دیگر بسازید.',
          counts: { decisions, tickets },
        },
        409,
      );
    }

    await audit(
      c.env.DB,
      ident,
      'access.bot_admin_deleted',
      'BOT_ADMIN',
      String(id),
      { telegram_id: Number(before.telegram_id), role: before.role },
      null,
      null,
    );
    return c.json({ ok: true });
  });
}
