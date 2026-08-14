/**
 * تنظیمات and لیست درخواست‌ها.
 *
 * ## The settings table holds live payment credentials
 *
 * `migrateSettings` copies every column of the legacy `setting` row and every
 * row of `PaySetting` and `shopSetting` into this table verbatim. `setting` is
 * all switches and numbers, but `PaySetting` is not: it carries
 * `apinowpayment`, `apiiranpay`, `apiternado`, `merchant_zarinpal`,
 * `merchant_id_aqayepardakht`, `marchent_floypay`, `marchent_tronseller` and
 * `walletaddress` — live gateway API keys and merchant identifiers, in
 * plaintext.
 *
 * So this route cannot simply list the table. A key that matches
 * `SECRET_KEY_PATTERN` is reported as configured or not, and its value never
 * leaves the server; the same key cannot be written from here either. The
 * project rule is that an apiKey is never logged or rendered, and a settings
 * screen is the most obvious place to break it by accident.
 *
 * The masking is a stopgap for reading, not a fix for storage. Those values are
 * still plaintext in Postgres and belong in the secret store beside
 * `provisioning_providers.secret_ref`; that needs a migration, which is not
 * this slice's call to make.
 *
 * ## Only existing keys can be edited
 *
 * The bot reads specific keys (`apps/bot/src/settings.ts`). A key this screen
 * invents is a row nothing will ever read, which looks like a setting that does
 * not work. Creation is therefore refused; the migration and the code decide
 * what keys exist.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import { audit, type Ident } from './adminAudit.js';

/**
 * Keys whose value must never reach the browser.
 *
 * Deliberately broad and matched case-insensitively: a false positive costs an
 * admin the ability to read one switch from this screen, a false negative puts
 * a live payment credential in a browser tab. `marchent` is not a typo — it is
 * how the legacy column is spelled, and matching only the correct spelling
 * would miss three real keys.
 */
export const SECRET_KEY_PATTERN =
  /(api|token|secret|password|passwd|merchant|marchent|walletaddress|privkey|hmac)/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

const SCOPES = ['bot', 'shop', 'pay', 'panel'] as const;

const ListQuery = z.object({
  scope: z.enum(SCOPES).optional(),
  q: z.string().trim().max(64).optional(),
});

const UpdateBody = z
  .object({
    scope: z.enum(SCOPES),
    key: z.string().trim().min(1).max(120),
    // JSON, because the column is jsonb and the migration stored MySQL text as
    // JSON strings — `"10"`, not `10`. A string is the common case and the only
    // one the form produces.
    value: z.union([z.string().max(4000), z.number(), z.boolean(), z.null()]),
  })
  .strict();

const DecisionBody = z
  .object({
    status: z.enum(['APPROVED', 'REJECTED']),
  })
  .strict();

interface SettingRow {
  scope: string;
  key: string;
  value: unknown;
  updated_at: string;
  updated_by: string | null;
}

function shapeSetting(r: SettingRow) {
  const secret = isSecretKey(r.key);
  return {
    scope: r.scope,
    key: r.key,
    // For a secret key: whether something is set, never what. `""` and JSON
    // null both count as unset, matching `settingText`.
    secret,
    value: secret ? null : (r.value ?? null),
    isSet: r.value !== null && r.value !== undefined && String(r.value).trim() !== '',
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

export function registerSettingsRoutes(
  app: Hono<{ Bindings: { DB: D1Database }; Variables: { identity: Ident } }>,
) {
  // --- تنظیمات -------------------------------------------------------------

  app.get('/api/v1/admin/settings', async (c) => {
    const parsed = ListQuery.safeParse({
      scope: c.req.query('scope') || undefined,
      q: c.req.query('q') || undefined,
    });
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_query' }, 400);
    const { scope, q } = parsed.data;

    const where: string[] = [];
    const params: unknown[] = [];
    if (scope) {
      params.push(scope);
      where.push(`scope = ?${params.length}`);
    }
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where.push(`lower(key) LIKE ?${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await c.env.DB.prepare(
      `SELECT scope, key, value, updated_at, updated_by FROM settings ${whereSql}
        ORDER BY scope, key`,
    )
      .bind(...params)
      .all<SettingRow>();

    const items = (rows.results ?? []).map(shapeSetting);
    return c.json({
      ok: true,
      items,
      // Named so the caller can say how many values it is deliberately not
      // showing, rather than leaving a silent gap in the list.
      hiddenCount: items.filter((i) => i.secret).length,
    });
  });

  app.post('/api/v1/admin/settings', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const parsed = UpdateBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const { scope, key, value } = parsed.data;

    if (isSecretKey(key)) {
      return c.json({ ok: false, error: 'secret_key' }, 403);
    }

    const before = await c.env.DB.prepare(
      `SELECT scope, key, value, updated_at, updated_by FROM settings
        WHERE scope = ?1 AND key = ?2`,
    )
      .bind(scope, key)
      .first<SettingRow>();
    // No insert: the bot reads a fixed set of keys and a new one would be a
    // row nothing reads.
    if (!before) return c.json({ ok: false, error: 'unknown_setting' }, 404);

    await c.env.DB.prepare(
      `UPDATE settings SET value = ?1::jsonb, updated_at = now(), updated_by = ?2
        WHERE scope = ?3 AND key = ?4`,
    )
      .bind(JSON.stringify(value), ident.email, scope, key)
      .run();

    const after = await c.env.DB.prepare(
      `SELECT scope, key, value, updated_at, updated_by FROM settings
        WHERE scope = ?1 AND key = ?2`,
    )
      .bind(scope, key)
      .first<SettingRow>();

    await audit(
      c.env.DB,
      ident,
      'setting.updated',
      'SETTING',
      `${scope}:${key}`,
      { value: before.value },
      { value: after!.value },
      null,
    );

    return c.json({ ok: true, setting: shapeSetting(after!) });
  });

  // --- لیست درخواست‌ها -----------------------------------------------------

  app.get('/api/v1/admin/reseller-requests', async (c) => {
    const status = c.req.query('status');
    const where: string[] = [];
    const params: unknown[] = [];
    if (status) {
      if (!['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
        return c.json({ ok: false, error: 'invalid_query' }, 400);
      }
      params.push(status);
      where.push(`r.status = ?${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await c.env.DB.prepare(
      `SELECT r.id, r.description, r.kind, r.status, r.created_at, r.decided_at,
              u.id AS user_id, u.telegram_id, u.username, u.is_reseller
         FROM reseller_requests r
         JOIN users u ON u.id = r.user_id
         ${whereSql}
        ORDER BY CASE WHEN r.status = 'PENDING' THEN 0 ELSE 1 END, r.id DESC
        LIMIT 200`,
    )
      .bind(...params)
      .all<{
        id: number;
        description: string | null;
        kind: string | null;
        status: string;
        created_at: string;
        decided_at: string | null;
        user_id: number;
        telegram_id: number;
        username: string | null;
        is_reseller: boolean;
      }>();

    return c.json({
      ok: true,
      items: (rows.results ?? []).map((r) => ({
        id: r.id,
        description: r.description,
        kind: r.kind,
        status: r.status,
        createdAt: r.created_at,
        decidedAt: r.decided_at,
        customer: {
          id: r.user_id,
          telegramId: r.telegram_id,
          username: r.username,
          isReseller: r.is_reseller,
        },
      })),
    });
  });

  app.post('/api/v1/admin/reseller-requests/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const parsed = DecisionBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const { status } = parsed.data;

    const before = await c.env.DB.prepare(
      `SELECT r.id, r.status, r.user_id, u.is_reseller
         FROM reseller_requests r JOIN users u ON u.id = r.user_id
        WHERE r.id = ?1`,
    )
      .bind(id)
      .first<{ id: number; status: string; user_id: number; is_reseller: boolean }>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);
    // Decided once. Re-deciding would flip a reseller flag from a stale screen.
    if (before.status !== 'PENDING') {
      return c.json({ ok: false, error: 'already_decided', detail: before.status }, 409);
    }

    await c.env.DB.prepare(
      `UPDATE reseller_requests SET status = ?1, decided_at = now() WHERE id = ?2`,
    )
      .bind(status, id)
      .run();

    // Approving is what actually makes someone a reseller — the flag the
    // catalogue's `resellers_only` reads. Rejecting changes nothing about them.
    if (status === 'APPROVED') {
      await c.env.DB.prepare(`UPDATE users SET is_reseller = true, updated_at = now() WHERE id = ?1`)
        .bind(before.user_id)
        .run();
    }

    await audit(
      c.env.DB,
      ident,
      status === 'APPROVED' ? 'reseller_request.approved' : 'reseller_request.rejected',
      'RESELLER_REQUEST',
      String(id),
      { status: before.status, is_reseller: before.is_reseller },
      { status, is_reseller: status === 'APPROVED' ? true : before.is_reseller },
      null,
    );

    return c.json({ ok: true, status });
  });
}
