/**
 * The catalogue — what the shop sells, and for how much.
 *
 * The screen this replaces (`panel/product.php`) lists one row per *sellable
 * combination*: name, price, volume, days, panel, user group, category. That is
 * the right unit for an admin, and it is what this endpoint returns — but in
 * Mirzabot's schema that row is literally the `product` table, because a second
 * duration means a second product. Here it is `product_plans` joined onto its
 * `products` parent, so the admin sees the same list while the database keeps
 * the product and its SKUs apart.
 *
 * Three deliberate differences from the PHP:
 *
 *   **No delete.** `product.php:159` offers a delete button, and
 *   `orders.plan_id` is `ON DELETE SET NULL` — so removing a plan silently
 *   detaches every order ever placed on it, and the sales history stops being
 *   able to say what was sold. `DISABLED` takes a plan out of the bot and off
 *   the shelf while the orders keep pointing at it — the bot's own filter is
 *   `PURCHASABLE` in `apps/bot/src/catalog.ts:51`, which requires both the
 *   product and the plan to be `ACTIVE`. That is where the panel's promise is
 *   actually kept; this file only writes the column.
 *
 *   **The price has a ceiling.** The PHP takes any integer. The most expensive
 *   thing this shop has ever sold is 750,000 Toman (max of `product.price_product`
 *   in the production dump, read 2026-08-14, over 21 rows); the ceiling here is
 *   13× that. A price is typed by hand, and the failure mode is an extra zero.
 *
 *   **Every write is ADMIN-only and lands in `audit_logs`.** A price change is
 *   the one catalogue edit that costs money in both directions, and the PHP
 *   leaves no trace of who made it.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import { audit, type Ident } from './adminAudit.js';

/**
 * The largest price a plan may carry, in IRR.
 *
 * 100,000,000 IRR = 10,000,000 Toman, which is both the admin's own
 * card-to-card ceiling (`maxbalancecart`) and roughly 13× the priciest real
 * product. A plan priced above what a single payment can settle is not a plan,
 * it is a typo.
 */
export const PLAN_MAX_PRICE_IRR = 100_000_000;

const PAGE_SIZE_MAX = 100;

const ListQuery = z.object({
  q: z.string().trim().max(64).optional(),
  status: z.enum(['ACTIVE', 'HIDDEN', 'DISABLED']).optional(),
  providerId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(25),
});

/**
 * A plan edit. Every field is optional — the form sends only what changed — but
 * an empty body is rejected rather than treated as a no-op write, because an
 * audit row saying "nothing changed" is worse than no audit row.
 *
 * `durationDays` and `volumeGb` accept null on purpose: null volume is an
 * unmetered plan and null duration is one that does not expire. That is a real
 * distinction in the schema, so the API has to be able to express it.
 */
const PlanPatch = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    priceIrr: z.number().int().min(0).max(PLAN_MAX_PRICE_IRR).optional(),
    durationDays: z.number().int().positive().max(3650).nullable().optional(),
    volumeGb: z.number().min(0).max(100_000).nullable().optional(),
    status: z.enum(['ACTIVE', 'HIDDEN', 'DISABLED']).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'no fields to change');

const ProductStatusBody = z
  .object({ status: z.enum(['ACTIVE', 'HIDDEN', 'DISABLED']) })
  .strict();

interface PlanRow {
  id: number;
  plan_name: string;
  price_irr: number;
  duration_days: number | null;
  volume_gb: number | null;
  user_limit: number | null;
  plan_status: string;
  sort_order: number;
  product_id: number;
  product_code: string;
  product_name: string;
  product_kind: string;
  product_status: string;
  resellers_only: boolean;
  once_per_user: boolean;
  provider_id: number | null;
  provider_name: string | null;
  provider_code: string | null;
  provider_status: string | null;
  category_name: string | null;
  orders_count: number;
}

function shape(r: PlanRow) {
  return {
    id: r.id,
    name: r.plan_name,
    priceIrr: Number(r.price_irr),
    durationDays: r.duration_days,
    // numeric(12,3) arrives as a number through the adapter; NULL means
    // unmetered, which is not the same as 0 and must not collapse into it.
    volumeGb: r.volume_gb === null ? null : Number(r.volume_gb),
    userLimit: r.user_limit,
    status: r.plan_status,
    sortOrder: r.sort_order,
    product: {
      id: r.product_id,
      code: r.product_code,
      name: r.product_name,
      kind: r.product_kind,
      status: r.product_status,
      resellersOnly: r.resellers_only,
      oncePerUser: r.once_per_user,
    },
    provider: r.provider_id
      ? { id: r.provider_id, name: r.provider_name, code: r.provider_code, status: r.provider_status }
      : null,
    categoryName: r.category_name,
    ordersCount: Number(r.orders_count),
  };
}

const SELECT_PLAN = `
  SELECT pl.id, pl.name AS plan_name, pl.price_irr, pl.duration_days, pl.volume_gb,
         pl.user_limit, pl.status AS plan_status, pl.sort_order,
         p.id AS product_id, p.code AS product_code, p.name AS product_name,
         p.kind AS product_kind, p.status AS product_status,
         p.resellers_only, p.once_per_user,
         pr.id AS provider_id, pr.name AS provider_name, pr.code AS provider_code,
         pr.status AS provider_status,
         cat.name AS category_name,
         (SELECT COUNT(*) FROM orders o WHERE o.plan_id = pl.id) AS orders_count
    FROM product_plans pl
    JOIN products p ON p.id = pl.product_id
    LEFT JOIN provisioning_providers pr ON pr.id = p.provider_id
    LEFT JOIN product_categories cat ON cat.id = p.category_id`;

export function registerProductRoutes(
  app: Hono<{ Bindings: { DB: D1Database }; Variables: { identity: Ident } }>,
) {
  // --- the catalogue ------------------------------------------------------

  app.get('/api/v1/admin/products', async (c) => {
    const parsed = ListQuery.safeParse({
      q: c.req.query('q') || undefined,
      status: c.req.query('status') || undefined,
      providerId: c.req.query('providerId') || undefined,
      page: c.req.query('page') ?? undefined,
      pageSize: c.req.query('pageSize') ?? undefined,
    });
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_query' }, 400);
    const { q, status, providerId, page, pageSize } = parsed.data;

    const where: string[] = [];
    const params: unknown[] = [];
    if (status) {
      params.push(status);
      where.push(`pl.status = ?${params.length}`);
    }
    if (providerId) {
      params.push(providerId);
      where.push(`p.provider_id = ?${params.length}`);
    }
    if (q) {
      // An admin looking for "آلمان" does not know whether that word is on the
      // product or on the plan, so both are searched.
      params.push(`%${q}%`);
      where.push(`(pl.name ILIKE ?${params.length} OR p.name ILIKE ?${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalRow = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM product_plans pl JOIN products p ON p.id = pl.product_id ${whereSql}`,
    )
      .bind(...params)
      .first<{ n: number }>();

    params.push(pageSize);
    const limitParam = params.length;
    params.push((page - 1) * pageSize);
    const rows = await c.env.DB.prepare(
      `${SELECT_PLAN} ${whereSql}
        ORDER BY p.sort_order, p.id, pl.sort_order, pl.id
        LIMIT ?${limitParam} OFFSET ?${params.length}`,
    )
      .bind(...params)
      .all<PlanRow>();

    // The filter needs the panels, and there are five of them — a second
    // round trip from the browser to fetch a five-row list is not worth it.
    const providers = await c.env.DB.prepare(
      `SELECT id, code, name, status FROM provisioning_providers ORDER BY sort_order, id`,
    ).all<{ id: number; code: string; name: string; status: string }>();

    return c.json({
      ok: true,
      total: totalRow?.n ?? 0,
      page,
      pageSize,
      items: (rows.results ?? []).map(shape),
      providers: (providers.results ?? []).map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        status: p.status,
      })),
    });
  });

  // --- edit one plan ------------------------------------------------------

  app.post('/api/v1/admin/products/plans/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const body = PlanPatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message }, 400);
    }

    const before = await c.env.DB.prepare(`${SELECT_PLAN} WHERE pl.id = ?1`).bind(id).first<PlanRow>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);

    const sets: string[] = [];
    const params: unknown[] = [];
    const patch = body.data;
    const put = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = ?${params.length}`);
    };
    if (patch.name !== undefined) put('name', patch.name);
    if (patch.priceIrr !== undefined) put('price_irr', patch.priceIrr);
    if (patch.durationDays !== undefined) put('duration_days', patch.durationDays);
    if (patch.volumeGb !== undefined) put('volume_gb', patch.volumeGb);
    if (patch.status !== undefined) put('status', patch.status);
    params.push(id);

    await c.env.DB.prepare(
      `UPDATE product_plans SET ${sets.join(', ')}, updated_at = now() WHERE id = ?${params.length}`,
    )
      .bind(...params)
      .run();

    // Read back rather than trusting the patch: a CHECK constraint that
    // rejected a value would otherwise be reported to the admin as applied.
    const after = await c.env.DB.prepare(`${SELECT_PLAN} WHERE pl.id = ?1`).bind(id).first<PlanRow>();
    if (!after) return c.json({ ok: false, error: 'not_found' }, 404);

    await audit(
      c.env.DB,
      ident,
      'catalog.plan_updated',
      'PRODUCT_PLAN',
      String(id),
      {
        name: before.plan_name,
        price_irr: Number(before.price_irr),
        duration_days: before.duration_days,
        volume_gb: before.volume_gb,
        status: before.plan_status,
      },
      {
        name: after.plan_name,
        price_irr: Number(after.price_irr),
        duration_days: after.duration_days,
        volume_gb: after.volume_gb,
        status: after.plan_status,
      },
      null,
    );

    return c.json({ ok: true, plan: shape(after) });
  });

  // --- take a whole product on or off the shelf ---------------------------

  app.post('/api/v1/admin/products/:id/status', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const body = ProductStatusBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ ok: false, error: 'invalid_body' }, 400);

    const before = await c.env.DB.prepare(`SELECT id, name, status FROM products WHERE id = ?1`)
      .bind(id)
      .first<{ id: number; name: string; status: string }>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);

    await c.env.DB.prepare(`UPDATE products SET status = ?1, updated_at = now() WHERE id = ?2`)
      .bind(body.data.status, id)
      .run();

    await audit(
      c.env.DB,
      ident,
      'catalog.product_status_changed',
      'PRODUCT',
      String(id),
      { status: before.status },
      { status: body.data.status },
      null,
    );

    return c.json({ ok: true, status: body.data.status });
  });
}
