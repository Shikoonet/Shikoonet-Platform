/**
 * «نمایندگان» — the franchises, and what their meters say.
 *
 * ## What this screen is NOT
 *
 * It is not a tenant view. A reseller runs their own installation — their own
 * bot, their own database, their own dashboard — and their customers never
 * reach this database at all. Sam was explicit: we do not need to know who a
 * reseller's users are, only how much they used and what they were sold.
 *
 * So there is nothing here that lists somebody else's customers, and there is
 * no route that could grow into one.
 *
 * ## Where the numbers come from
 *
 * `reseller_usage_snapshots`, written by the bot's meter sweep from the
 * PANEL's own counters. This worker makes no outbound call — a property of the
 * dashboard worth keeping — so everything below is a read of rows that are
 * already here.
 *
 * The billable figure is `max(lifetime_used_bytes)` and never a `sum`. Reading
 * the meter twice writes two rows and must move no total; that is the only
 * reason the sweep is safe to re-run.
 *
 * ## Why the writes are ADMIN and the read is not
 *
 * Reading which franchises exist and what they used is shop operation, the
 * same line «تنظیمات» and «کرون‌جاب‌ها» sit on — no customer's name appears on
 * this screen. Creating one, changing its capacity or suspending it decides
 * whether somebody's business keeps running, so those are ADMIN, checked per
 * route the way every other write on this panel is.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import type { EnvName } from '@shikoo/contracts';
import { audit, type Ident } from './adminAudit.js';

interface ResellerListRow {
  id: number;
  name: string;
  status: string;
  telegram_id: string | null;
  username: string | null;
  provider_id: number;
  provider_name: string;
  panel_admin_username: string;
  data_limit_bytes: string | number | null;
  expires_at: string | null;
  installation_url: string | null;
  note: string | null;
  /** `max(lifetime_used_bytes)`, or NULL when the meter has never been read. */
  billable_bytes: string | number | null;
  latest_used_bytes: string | number | null;
  latest_total_users: number | null;
  latest_panel_status: string | null;
  latest_panel_is_limited: boolean | null;
  last_read_at: string | null;
  readings: number;
}

/** `bigint` arrives as a string from the driver when it is large. */
function asNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

const Capacity = z
  .object({
    name: z.string().trim().min(1).max(80),
    /** NULL is unlimited, matching the panel's own `data_limit: null`. */
    dataLimitBytes: z.number().int().positive().nullable(),
    /** NULL is open-ended. Milliseconds, so the browser sends what it has. */
    expiresAtMs: z.number().int().positive().nullable(),
    installationUrl: z.string().trim().max(300).nullable(),
    note: z.string().trim().max(500).nullable(),
  })
  .strict();

const NewReseller = Capacity.extend({
  userId: z.number().int().positive(),
  providerId: z.number().int().positive(),
  panelAdminUsername: z.string().trim().min(1).max(120),
}).strict();

const StatusChange = z
  .object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']) })
  .strict();

export function registerResellerRoutes(
  app: Hono<{ Bindings: { DB: D1Database; ENV_NAME: EnvName }; Variables: { identity: Ident } }>,
) {
  /**
   * Every franchise, with its latest reading.
   *
   * `DISTINCT ON` for the latest snapshot rather than a correlated subquery
   * per reseller: one scan of an index that is already `(reseller_id,
   * taken_at DESC)`. The billable total is a separate aggregate because it is
   * a MAX over the whole history, not a field of the newest row — a panel that
   * reset its counter would otherwise make the bill go down.
   */
  app.get('/api/v1/admin/resellers', async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT r.id, r.name, r.status, r.panel_admin_username, r.provider_id,
              r.data_limit_bytes, r.expires_at::text AS expires_at,
              r.installation_url, r.note,
              u.telegram_id::text AS telegram_id, u.username,
              pv.name AS provider_name,
              agg.billable_bytes, agg.readings,
              latest.used_bytes      AS latest_used_bytes,
              latest.total_users     AS latest_total_users,
              latest.panel_status    AS latest_panel_status,
              latest.panel_is_limited AS latest_panel_is_limited,
              latest.taken_at::text  AS last_read_at
         FROM reseller_accounts r
         JOIN users u ON u.id = r.user_id
         JOIN provisioning_providers pv ON pv.id = r.provider_id
         LEFT JOIN LATERAL (
           SELECT max(lifetime_used_bytes) AS billable_bytes, count(*)::int AS readings
             FROM reseller_usage_snapshots s WHERE s.reseller_id = r.id
         ) agg ON true
         LEFT JOIN LATERAL (
           SELECT used_bytes, total_users, panel_status, panel_is_limited, taken_at
             FROM reseller_usage_snapshots s
            WHERE s.reseller_id = r.id
            ORDER BY s.taken_at DESC, s.id DESC
            LIMIT 1
         ) latest ON true
        ORDER BY r.status, r.name`,
    ).all<ResellerListRow>();

    return c.json({
      ok: true,
      items: (results ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        // The telegram id is the person behind the business, and it is already
        // on every customer screen. No customer OF THEIRS appears anywhere.
        telegramId: r.telegram_id,
        username: r.username,
        providerId: r.provider_id,
        providerName: r.provider_name,
        panelAdminUsername: r.panel_admin_username,
        dataLimitBytes: asNumber(r.data_limit_bytes),
        expiresAt: r.expires_at,
        installationUrl: r.installation_url,
        note: r.note,
        // NULL, not 0, when nothing has been read. The screen has to be able
        // to say «not read yet» rather than «used nothing» — they look the
        // same on an invoice and only one of them is true.
        billableBytes: asNumber(r.billable_bytes),
        latestUsedBytes: asNumber(r.latest_used_bytes),
        latestTotalUsers: r.latest_total_users,
        latestPanelStatus: r.latest_panel_status,
        latestPanelIsLimited: r.latest_panel_is_limited,
        lastReadAt: r.last_read_at,
        readings: r.readings ?? 0,
      })),
    });
  });

  /**
   * The readings behind one franchise's number.
   *
   * The whole reason the ledger is append-only: when a reseller asks why the
   * bill is what it is, the answer has to be a list of readings with times on
   * them rather than one figure nobody can check.
   */
  app.get('/api/v1/admin/resellers/:id/readings', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'bad id' }, 400);

    const { results } = await c.env.DB.prepare(
      `SELECT used_bytes, lifetime_used_bytes, data_limit_bytes, total_users,
              panel_status, panel_is_limited, taken_at::text AS taken_at
         FROM reseller_usage_snapshots
        WHERE reseller_id = ?1
        ORDER BY taken_at DESC, id DESC
        LIMIT 200`,
    )
      .bind(id)
      .all<Record<string, string | number | boolean | null>>();

    return c.json({
      ok: true,
      items: (results ?? []).map((r) => ({
        usedBytes: asNumber(r.used_bytes as string | number | null),
        lifetimeUsedBytes: asNumber(r.lifetime_used_bytes as string | number | null),
        dataLimitBytes: asNumber(r.data_limit_bytes as string | number | null),
        totalUsers: r.total_users,
        panelStatus: r.panel_status,
        panelIsLimited: r.panel_is_limited,
        takenAt: r.taken_at,
      })),
    });
  });

  app.post('/api/v1/admin/resellers', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const parsed = NewReseller.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'bad request' }, 400);
    const body = parsed.data;

    // The unique index on `(provider_id, lower(panel_admin_username))` is what
    // actually enforces this; the check here exists to answer with a sentence
    // rather than a constraint violation. Two rows on one panel admin would be
    // two meters reading one number and both billing it.
    const clash = await c.env.DB.prepare(
      `SELECT name FROM reseller_accounts
        WHERE provider_id = ?1 AND lower(panel_admin_username) = lower(?2)`,
    )
      .bind(body.providerId, body.panelAdminUsername)
      .first<{ name: string }>();
    if (clash) return c.json({ ok: false, error: 'that panel admin is already taken' }, 409);

    const row = await c.env.DB.prepare(
      `INSERT INTO reseller_accounts
         (user_id, provider_id, panel_admin_username, name, data_limit_bytes,
          expires_at, installation_url, note)
       VALUES (?1, ?2, ?3, ?4, ?5,
               CASE WHEN ?6::bigint IS NULL THEN NULL ELSE to_timestamp(?6 / 1000.0) END,
               ?7, ?8)
       RETURNING id`,
    )
      .bind(
        body.userId,
        body.providerId,
        body.panelAdminUsername,
        body.name,
        body.dataLimitBytes,
        body.expiresAtMs,
        body.installationUrl,
        body.note,
      )
      .first<{ id: number }>();
    if (!row) return c.json({ ok: false, error: 'could not create' }, 500);

    await audit(c.env.DB, ident, 'reseller.create', 'reseller', String(row.id), null, body, null);
    return c.json({ ok: true, id: row.id });
  });

  /** Capacity and term. Not the panel admin — that would move the meter. */
  app.patch('/api/v1/admin/resellers/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'bad id' }, 400);

    const parsed = Capacity.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'bad request' }, 400);
    const body = parsed.data;

    const before = await c.env.DB.prepare(
      `SELECT name, data_limit_bytes, expires_at::text AS expires_at, installation_url, note
         FROM reseller_accounts WHERE id = ?1`,
    )
      .bind(id)
      .first<Record<string, unknown>>();
    if (!before) return c.json({ ok: false, error: 'not found' }, 404);

    await c.env.DB.prepare(
      `UPDATE reseller_accounts
          SET name = ?2, data_limit_bytes = ?3,
              expires_at = CASE WHEN ?4::bigint IS NULL THEN NULL
                                ELSE to_timestamp(?4 / 1000.0) END,
              installation_url = ?5, note = ?6, updated_at = now()
        WHERE id = ?1`,
    )
      .bind(id, body.name, body.dataLimitBytes, body.expiresAtMs, body.installationUrl, body.note)
      .run();

    await audit(c.env.DB, ident, 'reseller.update', 'reseller', String(id), before, body, null);
    return c.json({ ok: true });
  });

  /**
   * Suspend, reactivate, or close.
   *
   * This changes a row here and calls no panel. Disabling a panel admin cuts
   * every one of that franchise's customers off at once, and that is an act an
   * operator performs on the panel with the consequence in front of them — not
   * a side effect of a status dropdown.
   */
  app.post('/api/v1/admin/resellers/:id/status', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'bad id' }, 400);

    const parsed = StatusChange.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'bad request' }, 400);

    const before = await c.env.DB.prepare(
      `SELECT status FROM reseller_accounts WHERE id = ?1`,
    )
      .bind(id)
      .first<{ status: string }>();
    if (!before) return c.json({ ok: false, error: 'not found' }, 404);

    await c.env.DB.prepare(
      `UPDATE reseller_accounts SET status = ?2, updated_at = now() WHERE id = ?1`,
    )
      .bind(id, parsed.data.status)
      .run();

    await audit(
      c.env.DB,
      ident,
      'reseller.status',
      'reseller',
      String(id),
      before,
      parsed.data,
      null,
    );
    return c.json({ ok: true });
  });
}
