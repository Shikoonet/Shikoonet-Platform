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
import { RESELLER_USERNAME } from '@shikoo/domain';
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

/**
 * A franchise, as the operator registers it (#474).
 *
 * `ACTIVE` links an admin that already exists on the panel; `PENDING` names
 * the admin the bot will create on the reseller's first paid order. A PENDING
 * row has bought nothing, so it carries no volume, and its name must be one
 * the bot can create: PasarGuard validates admin names not at all and stores
 * 34 characters at most, so the rule is ours (`RESELLER_USERNAME`). 34, not
 * the 120 this used to allow, for an existing admin too — no panel admin is
 * longer.
 */
const NewReseller = Capacity.extend({
  userId: z.number().int().positive(),
  providerId: z.number().int().positive(),
  panelAdminUsername: z.string().trim().min(1).max(34),
  status: z.enum(['ACTIVE', 'PENDING']).default('ACTIVE'),
})
  .strict()
  .refine(
    (b) => b.status !== 'PENDING' || (RESELLER_USERNAME.test(b.panelAdminUsername) && b.dataLimitBytes === null),
    { message: 'a new panel needs a username of 3–34 of A-Z a-z 0-9 . _ - and no volume yet' },
  );

/**
 * A change to a franchise — only the fields that are sent (#474).
 *
 * The volume is the one that moves by itself now: the bot adds to it on every
 * sale. So a volume edit says what the operator SAW (`expectedDataLimitBytes`)
 * and is refused when the row has moved since — an edit from a list loaded
 * before a sale must not wipe that sale's terabytes. It is the way to settle a
 * reseller whose panel limit was changed by hand, and nothing else writes it.
 */
const CapacityPatch = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    dataLimitBytes: z.number().int().positive().nullable().optional(),
    expectedDataLimitBytes: z.number().int().positive().nullable().optional(),
    expiresAtMs: z.number().int().positive().nullable().optional(),
    installationUrl: z.string().trim().max(300).nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .refine((b) => b.dataLimitBytes === undefined || b.expectedDataLimitBytes !== undefined, {
    message: 'a volume change needs the volume it replaces',
  });

const StatusChange = z
  .object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']) })
  .strict();

/**
 * Which statuses each target may be reached from (#474).
 *
 * PENDING → ACTIVE is not a button: a PENDING row has no admin on the panel,
 * and ACTIVE is what the bot sets once it has created one. Calling it active
 * by hand would meter an admin that does not exist and sell to it. CLOSED is
 * the end — reopening a franchise is registering it again.
 */
const REACHABLE_FROM: Record<'ACTIVE' | 'SUSPENDED' | 'CLOSED', readonly string[]> = {
  ACTIVE: ['SUSPENDED'],
  SUSPENDED: ['ACTIVE'],
  CLOSED: ['PENDING', 'ACTIVE', 'SUSPENDED'],
};

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
          expires_at, installation_url, note, status)
       VALUES (?1, ?2, ?3, ?4, ?5,
               CASE WHEN ?6::bigint IS NULL THEN NULL ELSE to_timestamp(?6 / 1000.0) END,
               ?7, ?8, ?9)
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
        body.status,
      )
      .first<{ id: number }>();
    if (!row) return c.json({ ok: false, error: 'could not create' }, 500);

    await audit(c.env.DB, ident, 'reseller.create', 'reseller', String(row.id), null, body, null);
    return c.json({ ok: true, id: row.id });
  });

  /**
   * Name, term, notes — and the volume, by compare-and-set. Only what is sent
   * changes, so moving a deadline cannot rewrite anything else. Not the panel
   * admin — that would move the meter.
   */
  app.patch('/api/v1/admin/resellers/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'bad id' }, 400);

    const parsed = CapacityPatch.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'bad request' }, 400);
    const body = parsed.data;

    const before = await c.env.DB.prepare(
      `SELECT name, data_limit_bytes, expires_at::text AS expires_at, installation_url, note
         FROM reseller_accounts WHERE id = ?1`,
    )
      .bind(id)
      .first<Record<string, unknown>>();
    if (!before) return c.json({ ok: false, error: 'not found' }, 404);

    // `?k::boolean` says whether field k was sent; the value beside it is only
    // read when it was. The volume's guard is in the same statement, so a sale
    // that lands between the read above and this write makes it match nothing.
    const changed = await c.env.DB.prepare(
      `UPDATE reseller_accounts
          SET name             = CASE WHEN ?2::boolean  THEN ?3 ELSE name END,
              data_limit_bytes = CASE WHEN ?4::boolean  THEN ?5::bigint ELSE data_limit_bytes END,
              expires_at       = CASE WHEN ?7::boolean
                                      THEN CASE WHEN ?8::bigint IS NULL THEN NULL
                                                ELSE to_timestamp(?8 / 1000.0) END
                                      ELSE expires_at END,
              installation_url = CASE WHEN ?9::boolean  THEN ?10 ELSE installation_url END,
              note             = CASE WHEN ?11::boolean THEN ?12 ELSE note END,
              updated_at = now()
        WHERE id = ?1
          -- A PENDING row has bought nothing (the rule NewReseller states):
          -- volume written onto it would reach the panel with the first sale
          -- as terabytes nobody paid for.
          AND (NOT ?4::boolean
               OR (status <> 'PENDING' AND data_limit_bytes IS NOT DISTINCT FROM ?6::bigint))`,
    )
      .bind(
        id,
        body.name !== undefined,
        body.name ?? null,
        body.dataLimitBytes !== undefined,
        body.dataLimitBytes ?? null,
        body.expectedDataLimitBytes ?? null,
        body.expiresAtMs !== undefined,
        body.expiresAtMs ?? null,
        body.installationUrl !== undefined,
        body.installationUrl ?? null,
        body.note !== undefined,
        body.note ?? null,
      )
      .run();
    if (changed.meta.changes === 0) {
      const now = await c.env.DB.prepare(
        `SELECT status, data_limit_bytes FROM reseller_accounts WHERE id = ?1`,
      )
        .bind(id)
        .first<{ status: string; data_limit_bytes: string | number | null }>();
      return c.json(
        {
          ok: false,
          error: now?.status === 'PENDING' ? 'pending_has_no_volume' : 'volume_moved',
          status: now?.status ?? null,
          currentDataLimitBytes: asNumber(now?.data_limit_bytes ?? null),
        },
        409,
      );
    }

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
    // Pressing the status it already has is an answer, not a refusal.
    if (before.status === parsed.data.status) return c.json({ ok: true });

    // The allowed «from» is in the WHERE, not only in the check above it: a
    // row the bot activates between the read and this write is not then
    // flipped by a button drawn for the old status.
    // Not CLOSED while an order of theirs is still on its way: delivery
    // fails a closed account, and card money cannot be given back by the
    // bot — it would sit in the bank against a sale that never happened.
    // Asked in the same statement, so an order placed in between is seen.
    const moved = await c.env.DB.prepare(
      `UPDATE reseller_accounts SET status = ?2, updated_at = now()
        WHERE id = ?1 AND status = ANY(?3::text[])
          AND (?2 <> 'CLOSED' OR NOT EXISTS (
                SELECT 1 FROM orders o
                 WHERE o.target_reseller_id = ?1
                   AND o.status IN ('AWAITING_PAYMENT', 'PAID', 'PROVISIONING')))`,
    )
      .bind(id, parsed.data.status, REACHABLE_FROM[parsed.data.status])
      .run();
    if (moved.meta.changes === 0) {
      const inFlight =
        parsed.data.status === 'CLOSED' &&
        (await c.env.DB.prepare(
          `SELECT 1 AS n FROM orders
            WHERE target_reseller_id = ?1 AND status IN ('AWAITING_PAYMENT', 'PAID', 'PROVISIONING')
            LIMIT 1`,
        )
          .bind(id)
          .first<{ n: number }>()) !== null;
      return c.json(
        { ok: false, error: inFlight ? 'orders_in_flight' : 'transition_refused', from: before.status },
        409,
      );
    }

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
