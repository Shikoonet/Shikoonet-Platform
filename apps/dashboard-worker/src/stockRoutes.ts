/**
 * قفسهٔ انبار — the pre-made configs that keep the shop selling when a panel is
 * unreachable.
 *
 * `migrations/0010_provisioning_stock.sql` built the shelf and the bot has sold
 * from it since; `docs/STATUS.md` has said "no interface for filling it" ever
 * since, and filling it meant an `INSERT` by hand. This is that interface.
 *
 * The shelf is the one place in this platform where the ROW is the product: a
 * `subscription_url` here is a working account somebody paid for the moment it
 * is handed over. So three things are true of every route below.
 *
 * **A sold row is never edited or removed.** `status = 'USED'` names the order
 * that took it, and `subscriptions` points at the same account — deleting the
 * shelf row would leave the customer's service with no record of where it came
 * from. Retiring is the action for a config that must not be sold again;
 * deletion is only ever for one that never was.
 *
 * **The plan decides the panel.** `provider_id` is not a form field: the shelf
 * hands a config to an order for a specific plan, and a config filed under a
 * plan whose product lives on a different panel is a customer receiving an
 * account on a server they did not buy. It is read from the plan's own product.
 *
 * **The database decides duplicates.** `idx_stock_account_once` refuses the same
 * `(provider_id, remote_username)` twice, and the insert lets it answer rather
 * than looking first — two admins pasting the same export at once is exactly the
 * case a read-then-write misses.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import { audit, type Ident } from './adminAudit.js';

const StockBody = z
  .object({
    planId: z.number().int().positive(),
    remoteUsername: z.string().trim().min(1).max(200),
    subscriptionUrl: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .refine((v) => /^https?:\/\//i.test(v), 'لینک اشتراک باید با http یا https شروع شود'),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

const StockQuery = z.object({
  planId: z.coerce.number().int().positive().optional(),
  status: z.enum(['AVAILABLE', 'USED', 'RETIRED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

interface StockRow {
  id: number;
  plan_id: number;
  plan_name: string;
  product_name: string;
  provider_name: string;
  remote_username: string;
  subscription_url: string;
  status: string;
  order_public_id: string | null;
  note: string | null;
  created_at: string;
  used_at: string | null;
}

/**
 * The subscription link is a live credential: whoever holds it holds the
 * service. It is returned only for a row that is still on the shelf, and only
 * to an ADMIN — a REVIEWER counting stock does not need to be handed the
 * accounts, and a sold row's link belongs to the customer who bought it.
 */
function shape(r: StockRow, withUrl: boolean) {
  return {
    id: Number(r.id),
    planId: Number(r.plan_id),
    planName: r.plan_name,
    productName: r.product_name,
    providerName: r.provider_name,
    remoteUsername: r.remote_username,
    subscriptionUrl: withUrl && r.status === 'AVAILABLE' ? r.subscription_url : null,
    status: r.status,
    orderPublicId: r.order_public_id,
    note: r.note,
    createdAt: r.created_at,
    usedAt: r.used_at,
  };
}

const SELECT_STOCK = `
  SELECT st.id, st.plan_id, st.remote_username, st.subscription_url, st.status,
         st.note, st.created_at, st.used_at,
         pl.name AS plan_name, p.name AS product_name, pr.name AS provider_name,
         o.public_id AS order_public_id
    FROM provisioning_stock st
    JOIN product_plans pl ON pl.id = st.plan_id
    JOIN products p ON p.id = pl.product_id
    JOIN provisioning_providers pr ON pr.id = st.provider_id
    LEFT JOIN orders o ON o.id = st.order_id`;

export function registerStockRoutes(
  app: Hono<{ Bindings: { DB: D1Database }; Variables: { identity: Ident } }>,
) {
  app.get('/api/v1/admin/stock', async (c) => {
    const q = StockQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!q.success) return c.json({ ok: false, error: 'invalid_query' }, 400);
    const ident = c.get('identity');

    const where: string[] = [];
    const binds: unknown[] = [];
    if (q.data.planId !== undefined) {
      binds.push(q.data.planId);
      where.push(`st.plan_id = ?${binds.length}`);
    }
    if (q.data.status !== undefined) {
      binds.push(q.data.status);
      where.push(`st.status = ?${binds.length}`);
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';

    const total = await c.env.DB.prepare(
      `SELECT COUNT(*)::int AS n FROM provisioning_stock st${clause}`,
    )
      .bind(...binds)
      .first<{ n: number }>();

    binds.push(q.data.pageSize, (q.data.page - 1) * q.data.pageSize);
    const rows = await c.env.DB.prepare(
      `${SELECT_STOCK}${clause} ORDER BY st.status, st.id DESC
        LIMIT ?${binds.length - 1} OFFSET ?${binds.length}`,
    )
      .bind(...binds)
      .all<StockRow>();

    // What an admin actually needs from this screen: how deep the shelf is per
    // plan. Counting rows on the page would count the page, not the shelf.
    const counts = await c.env.DB.prepare(
      `SELECT pl.id AS plan_id, pl.name AS plan_name, p.name AS product_name,
              COUNT(*) FILTER (WHERE st.status = 'AVAILABLE')::int AS available,
              COUNT(*) FILTER (WHERE st.status = 'USED')::int AS used
         FROM provisioning_stock st
         JOIN product_plans pl ON pl.id = st.plan_id
         JOIN products p ON p.id = pl.product_id
        GROUP BY pl.id, pl.name, p.name
        ORDER BY available, pl.name`,
    ).all<{
      plan_id: number;
      plan_name: string;
      product_name: string;
      available: number;
      used: number;
    }>();

    return c.json({
      ok: true,
      total: total?.n ?? 0,
      page: q.data.page,
      pageSize: q.data.pageSize,
      items: (rows.results ?? []).map((r) => shape(r, ident.role === 'ADMIN')),
      shelves: (counts.results ?? []).map((r) => ({
        planId: Number(r.plan_id),
        planName: r.plan_name,
        productName: r.product_name,
        available: Number(r.available),
        used: Number(r.used),
      })),
    });
  });

  app.post('/api/v1/admin/stock', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const body = StockBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message }, 400);
    }

    // The panel comes from the plan, never from the request. A config filed
    // under a plan whose product lives elsewhere is a customer being handed an
    // account on a server they did not buy.
    const plan = await c.env.DB.prepare(
      `SELECT pl.id, p.provider_id FROM product_plans pl
         JOIN products p ON p.id = pl.product_id
        WHERE pl.id = ?1`,
    )
      .bind(body.data.planId)
      .first<{ id: number; provider_id: number }>();
    if (!plan) return c.json({ ok: false, error: 'plan_not_found' }, 404);

    const row = await c.env.DB.prepare(
      `INSERT INTO provisioning_stock
         (plan_id, provider_id, remote_username, subscription_url, note, status)
       VALUES (?1, ?2, ?3, ?4, ?5, 'AVAILABLE')
       ON CONFLICT DO NOTHING
       RETURNING id`,
    )
      .bind(
        body.data.planId,
        plan.provider_id,
        body.data.remoteUsername,
        body.data.subscriptionUrl,
        body.data.note ?? null,
      )
      .first<{ id: number }>();
    if (!row) {
      return c.json(
        {
          ok: false,
          error: 'already_shelved',
          detail: 'این نام کاربری از قبل روی همین پنل در قفسه است.',
        },
        409,
      );
    }

    // The username identifies the account; the link is the credential and is
    // not written to a table anyone can read afterwards.
    await audit(c.env.DB, ident, 'stock.added', 'PROVISIONING_STOCK', String(row.id), null, {
      plan_id: body.data.planId,
      remote_username: body.data.remoteUsername,
    }, null);
    return c.json({ ok: true, id: Number(row.id) });
  });

  /**
   * Takes a config off the shelf without pretending it was never there.
   *
   * Guarded inside the UPDATE rather than by reading the status first: the sale
   * that claims a row runs `... WHERE status = 'AVAILABLE'` in its own
   * statement, and an admin retiring the same row at the same moment must lose
   * that race rather than both succeeding.
   */
  app.post('/api/v1/admin/stock/:id/retire', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const done = await c.env.DB.prepare(
      `UPDATE provisioning_stock SET status = 'RETIRED'
        WHERE id = ?1 AND status = 'AVAILABLE'`,
    )
      .bind(id)
      .run();
    if (done.meta.changes === 0) {
      const row = await c.env.DB.prepare(`SELECT status FROM provisioning_stock WHERE id = ?1`)
        .bind(id)
        .first<{ status: string }>();
      if (!row) return c.json({ ok: false, error: 'not_found' }, 404);
      return c.json(
        {
          ok: false,
          error: 'not_available',
          detail:
            row.status === 'USED'
              ? 'این کانفیگ فروخته شده و به یک سفارش وصل است.'
              : 'این کانفیگ از قبل بازنشسته شده است.',
        },
        409,
      );
    }

    await audit(c.env.DB, ident, 'stock.retired', 'PROVISIONING_STOCK', String(id), null, null, null);
    return c.json({ ok: true });
  });

  app.delete('/api/v1/admin/stock/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    // Only a config that was never sold. A USED row names the order that took
    // it and the customer's subscription points at the same account — removing
    // it loses the only record of where their service came from.
    const done = await c.env.DB.prepare(
      `DELETE FROM provisioning_stock WHERE id = ?1 AND status <> 'USED'`,
    )
      .bind(id)
      .run();
    if (done.meta.changes === 0) {
      const row = await c.env.DB.prepare(`SELECT status FROM provisioning_stock WHERE id = ?1`)
        .bind(id)
        .first<{ status: string }>();
      if (!row) return c.json({ ok: false, error: 'not_found' }, 404);
      return c.json(
        { ok: false, error: 'sold', detail: 'کانفیگ فروخته‌شده حذف نمی‌شود — تاریخچهٔ سفارش است.' },
        409,
      );
    }

    await audit(c.env.DB, ident, 'stock.deleted', 'PROVISIONING_STOCK', String(id), null, null, null);
    return c.json({ ok: true });
  });
}
