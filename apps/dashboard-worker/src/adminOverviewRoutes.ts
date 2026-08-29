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
import { parseStatsDay, parseStatsRange, shopReport, shopStats } from '@shikoo/domain';

type Ident = { email: string; role: import('@shikoo/contracts').AccessRole };

/** Rows for the two "most recent" tables. Small and fixed — this is a summary. */
const RECENT = 8;

export function registerAdminOverviewRoutes(
  app: Hono<{ Bindings: { DB: D1Database }; Variables: { identity: Ident } }>,
) {
  app.get('/api/v1/admin/overview', async (c) => {
    const db = c.env.DB;

    // The six numbers come from `shopStats`, not from SQL written here. The bot
    // draws the same figures on its own «آمار» screen, and two definitions of
    // "revenue" or of "today" is how an admin ends up with two answers and
    // trusts neither. What stays here is the two recent lists, which only this
    // screen has.
    const stats = await shopStats(db);

    /**
     * What the admin has added to or taken off the revenue figure by hand.
     *
     * Returned beside `revenueIrr` rather than folded into it, and the split is
     * what keeps the comment above true. `shopStats` is the bot's «آمار» screen
     * as well as this one, and it means completed sales on both; changing what
     * it counts to keep this screen at parity would change what the bot tells an
     * operator, which nobody asked for.
     *
     * Parity is still met, because `panel/index.php:28` does exactly this split
     * too — `$totalRevenue = $baseRevenue + $manualRevenueAdjustment`, with a
     * line underneath naming the adjustment whenever it is not zero. Production
     * currently carries −309,070,750 Toman of it, so a dashboard that quietly
     * dropped it would show a revenue figure 309 million higher than the one the
     * admin reads today, on the first morning after the cutover.
     */
    const adjustment = await db
      .prepare(`SELECT COALESCE(SUM(amount_irr), 0) AS net FROM revenue_adjustments`)
      .first<{ net: string | number }>();

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
      customers: stats.customers,
      customersToday: stats.customersToday,
      activeSubscriptions: stats.activeSubscriptions,
      revenueIrr: stats.revenueIrr,
      revenueAdjustmentIrr: Number(adjustment?.net ?? 0),
      ordersToday: stats.ordersToday,
      walletHeldIrr: stats.walletHeldIrr,
      walletOwedToShopIrr: stats.walletOwedToShopIrr,
      walletDebtors: stats.walletDebtors,
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

  /**
   * The «آمار» screen — the shop's figures over a chosen window.
   *
   * Not role-guarded beyond the session, like `/overview` above. Every field it
   * returns is an aggregate; nothing here names a customer, so it stays on the
   * readable side of the `READ_ONLY` boundary — which is «shop operations» in
   * one hand and «its customers' personal data» in the other, not «numbers» and
   * «no numbers».
   *
   * An unknown `range` becomes `all` rather than a 400. This is a screen with
   * eight buttons on it: the only way to send something else is a hand-typed
   * URL, and answering that with the widest honest window is better than an
   * error page. `day` is read for `range=day` and as the opening edge of
   * `range=between`; `to` closes that one. A malformed date falls back to today
   * inside `statsRangeBounds` rather than throwing.
   */
  app.get('/api/v1/admin/stats', async (c) => {
    const range = parseStatsRange(c.req.query('range'));
    const day = parseStatsDay(c.req.query('day') ?? c.req.query('from'));
    const to = parseStatsDay(c.req.query('to'));
    const report = await shopReport(c.env.DB, range, Date.now(), day, to);

    return c.json({
      ok: true,
      ...report,
      /**
       * The three figures the legacy screen has and this one will not compute,
       * sent as data rather than hardcoded in the page.
       *
       * The screen renders each as a struck-through row with its reason. A
       * missing number that says why it is missing is the whole point; a `0`
       * would be indistinguishable from «none in this window», which is exactly
       * the kind of silence that costs this project weeks.
       */
      notMeasured: [
        {
          label: 'نمایندگان نوع N و N2',
          reason: 'این‌جا نمایندگی یک وضعیت است، نه دو نوع — ستون `is_reseller` یک بله/خیر است.',
        },
        {
          label: 'اکانت‌های تست',
          reason: 'ربات قدیمی آن‌ها را از روی نامِ محصول («تست») می‌شمارد؛ ما سرویس تست را مدل نکرده‌ایم.',
        },
      ],
    });
  });
}
