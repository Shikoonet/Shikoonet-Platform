/**
 * The admin panel's home screen, in one request.
 *
 * Six numbers and two short lists, which is what the panel this replaces puts
 * on its dashboard. It is one route rather than eight because the screen is
 * useless in pieces — a half-drawn set of stat cards is worse than a spinner,
 * and eight round trips through Cloudflare Access is eight times the latency
 * for a page nobody stays on.
 *
 * Everything counted here excludes nothing silently. Where a filter exists
 * (test services, unpaid orders) it is stated in the SQL and named in the
 * label the panel shows, because a headline number an admin cannot reproduce
 * is a number they will eventually distrust.
 */

import type { Hono } from 'hono';
import type { D1Database } from '@shikoo/database';

type Ident = { email: string; role: import('@shikoo/contracts').AccessRole };

/** Rows for the two "most recent" tables. Small and fixed — this is a summary. */
const RECENT = 8;

export function registerAdminOverviewRoutes(
  app: Hono<{ Bindings: { DB: D1Database }; Variables: { identity: Ident } }>,
) {
  app.get('/api/v1/admin/overview', async (c) => {
    const db = c.env.DB;

    // Tehran's day, not UTC's and not the browser's. `date_trunc` at a named
    // zone is the database answering the question, which is the only source
    // that agrees with what the bot told the customer.
    const sinceToday = `date_trunc('day', now() AT TIME ZONE 'Asia/Tehran') AT TIME ZONE 'Asia/Tehran'`;

    const [customers, subs, revenue, orders, wallet] = await Promise.all([
      db
        .prepare(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE registered_at >= ${sinceToday})::int AS today
             FROM users`,
        )
        .first<{ total: number; today: number }>(),
      db
        .prepare(`SELECT COUNT(*)::int AS n FROM subscriptions WHERE status = 'ACTIVE'`)
        .first<{ n: number }>(),
      // Completed orders only. An order that is merely PAID has money against
      // it but nothing delivered, and counting it as revenue is how a refund
      // later makes the headline wrong.
      db
        .prepare(
          `SELECT COALESCE(SUM(total_irr), 0)::bigint AS irr
             FROM orders WHERE status = 'COMPLETED'`,
        )
        .first<{ irr: number }>(),
      db
        .prepare(`SELECT COUNT(*)::int AS n FROM orders WHERE created_at >= ${sinceToday}`)
        .first<{ n: number }>(),
      // What the shop owes its customers. Negative balances are included as
      // they are — netting them out would hide exactly the accounts worth
      // looking at.
      db
        .prepare(`SELECT COALESCE(SUM(balance_irr), 0)::bigint AS irr FROM wallets`)
        .first<{ irr: number }>(),
    ]);

    const recentCustomers = await db
      .prepare(
        `SELECT u.id, u.telegram_id, u.username, u.phone, u.status, u.is_reseller,
                u.discount_percent, w.balance_irr, u.registered_at, u.last_seen_at
           FROM users u
           LEFT JOIN wallets w ON w.user_id = u.id
          ORDER BY u.id DESC
          LIMIT ?1`,
      )
      .bind(RECENT)
      .all<{
        id: number;
        telegram_id: number;
        username: string | null;
        phone: string | null;
        status: string;
        is_reseller: boolean;
        discount_percent: number;
        balance_irr: number | null;
        registered_at: string;
        last_seen_at: string | null;
      }>();

    const recentOrders = await db
      .prepare(
        `SELECT o.public_id, u.telegram_id, p.name AS plan_name,
                o.total_irr, o.status, o.created_at
           FROM orders o
           LEFT JOIN users u ON u.id = o.user_id
           LEFT JOIN product_plans p ON p.id = o.plan_id
          ORDER BY o.id DESC
          LIMIT ?1`,
      )
      .bind(RECENT)
      .all<{
        public_id: string;
        telegram_id: number | null;
        plan_name: string | null;
        total_irr: number;
        status: string;
        created_at: string;
      }>();

    return c.json({
      ok: true,
      customers: customers?.total ?? 0,
      customersToday: customers?.today ?? 0,
      activeSubscriptions: subs?.n ?? 0,
      revenueIrr: Number(revenue?.irr ?? 0),
      ordersToday: orders?.n ?? 0,
      walletHeldIrr: Number(wallet?.irr ?? 0),
      recentCustomers: (recentCustomers.results ?? []).map((r) => ({
        id: r.id,
        telegramId: r.telegram_id,
        username: r.username,
        phone: r.phone,
        status: r.status,
        isReseller: r.is_reseller,
        discountPercent: Number(r.discount_percent),
        balanceIrr: r.balance_irr ?? 0,
        registeredAt: r.registered_at,
        lastSeenAt: r.last_seen_at,
      })),
      recentOrders: (recentOrders.results ?? []).map((r) => ({
        publicId: r.public_id,
        telegramId: r.telegram_id,
        planName: r.plan_name,
        totalIrr: Number(r.total_irr),
        status: r.status,
        createdAt: r.created_at,
      })),
    });
  });
}
