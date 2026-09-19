import type { EnvName } from '@shikoo/contracts';
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
import { tehranDayFromUtc } from '@shikoo/domain';
import { loadCounts } from './mirzabotRoutes.js';

type Ident = { email: string; role: import('@shikoo/contracts').AccessRole };

/** Rows for the two "most recent" tables. Small and fixed — this is a summary. */
const RECENT = 8;

/**
 * What still needs a person — the queues a shop can actually be blocked on.
 *
 * The dashboard answered «how is the shop doing» and nothing about what is
 * waiting, so the first act of every morning was visiting four screens to
 * find out whether there was anything to do.
 *
 * One function, two callers: the dashboard's «نیاز به توجه» strip through
 * `/overview`, and the sidebar's badges through `/attention` (#334). The
 * sidebar is on every screen and polls, and the overview also runs `shopStats`
 * and two recent lists that a badge has no use for — so the counts got a
 * route of their own rather than the sidebar paying for the dashboard every
 * thirty seconds. Same numbers, by construction: there is one query.
 */
export async function loadAttention(
  db: D1Database,
  now: number,
  /**
   * When this operator last opened «لیست درخواست‌ها», epoch ms — what
   * `newRequests` counts from. Absent means never, and then it is the whole
   * pending queue (#370).
   */
  requestsSeenAt: number | null = null,
) {
  // `openClaims` is READ from the payments surface rather than counted here,
  // and that is deliberate: a badge and its list disagreeing is the oldest
  // bug on that surface, and it was fixed by making them one number. A third
  // query would be a third answer.
  const { start: dayStart, end: dayEnd } = tehranDayFromUtc(now);
  const counts = await loadCounts(db, dayStart, dayEnd);

  const waiting = await db
    .prepare(
      `SELECT
         (SELECT count(*) FROM reseller_requests WHERE status = 'PENDING') AS pending_requests,
         -- The sidebar badge (#370). «۴» beside the entry for a week is a
         -- number nobody reads; what an operator wants beside it is «since
         -- you last looked». The page and the dashboard strip keep the whole
         -- queue.
         (SELECT count(*) FROM reseller_requests
           WHERE status = 'PENDING'
             AND (?2::bigint IS NULL OR created_at > to_timestamp(?2 / 1000.0))) AS new_requests,
         -- ACTIVE only: a REMOVED service is not expiring, it is gone. And
         -- bounded below by now(), so an expiry that already passed is not
         -- counted as something to act on today — that is a different queue.
         (SELECT count(*) FROM subscriptions
           WHERE status = 'ACTIVE' AND expires_at IS NOT NULL
             AND expires_at BETWEEN now() AND now() + interval '7 days') AS expiring_7d,
         -- A device that has not reported for a day is one the shop is not
         -- hearing bank SMS from, which is silent by nature: nothing errors,
         -- payments simply stop verifying.
         (SELECT count(*) FROM devices
           WHERE active = 1
             AND (last_seen_at IS NULL OR last_seen_at < ?1)) AS stale_devices,
         -- An ACTIVE panel with no secret cannot provision. The catalogue
         -- will happily sell from it.
         (SELECT count(*) FROM provisioning_providers
           WHERE status = 'ACTIVE' AND secret_ref IS NULL) AS panels_without_secret`,
    )
    .bind(now - 24 * 60 * 60 * 1000, requestsSeenAt)
    .first<{
      pending_requests: number;
      new_requests: number;
      expiring_7d: number;
      stale_devices: number;
      panels_without_secret: number;
    }>();

  /*
   * «ممکنه یکسری از پرداختی‌ها رو بررسی نکرده باشیم» — Sam, 2026-09-16.
   *
   * Three queues, one number. A receipt nobody has decided about, a
   * continuity delivery whose bank SMS has not been matched, and a bank
   * credit no order claimed and nobody declined: each is money that a
   * person still has to look at, and each lived on its own tab with its
   * own count, so «is there anything unreviewed» took three visits. Sam
   * chose all three for the sum. The parts travel with it so the payments
   * screen can draw the same breakdown from the same numbers.
   */
  const unreviewed = {
    openClaims: counts.total.open,
    unreconciledContinuity: counts.total.continuityPending,
    unassignedIncome: counts.total.income,
  };

  return {
    unreviewedPayments:
      unreviewed.openClaims + unreviewed.unreconciledContinuity + unreviewed.unassignedIncome,
    ...unreviewed,
    pendingRequests: Number(waiting?.pending_requests ?? 0),
    newRequests: Number(waiting?.new_requests ?? 0),
    expiringSubscriptions7d: Number(waiting?.expiring_7d ?? 0),
    staleDevices: Number(waiting?.stale_devices ?? 0),
    panelsWithoutSecret: Number(waiting?.panels_without_secret ?? 0),
  };
}

export function registerAdminOverviewRoutes(
  app: Hono<{ Bindings: { DB: D1Database; ENV_NAME: EnvName }; Variables: { identity: Ident } }>,
) {
  app.get('/api/v1/admin/attention', async (c) => {
    // A bad or absent value is «never looked», never a 400: a badge is a hint.
    // Bounded by now as well: a stamp from the future says nothing, and one
    // large enough overflows to_timestamp — seen with a 19-digit value.
    const now = Date.now();
    const seen = Number(c.req.query('requestsSeenAt'));
    return c.json({
      ok: true,
      attention: await loadAttention(
        c.env.DB,
        now,
        Number.isFinite(seen) && seen > 0 && seen <= now ? seen : null,
      ),
    });
  });

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
    // `shop_books` and not the table: a voided row is one an admin has taken
    // off the books on purpose, and it must not keep moving this figure. The
    // view is where that rule lives, so no reader has to remember it —
    // `verify.ts` deliberately reads the table instead, because it is asking
    // whether the import landed every Rial rather than what the books say.
    const adjustment = await db
      .prepare(`SELECT COALESCE(SUM(amount_irr), 0) AS net FROM shop_books`)
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
        // `plan_name_at_sale` is the fallback rather than an afterthought:
        // an imported order has no `plan_id` at all, so without it every row
        // on this list reads as a dash. Safe to join because
        // `idx_subscriptions_one_per_order` is UNIQUE on `order_id`.
        `SELECT o.public_id, u.id AS user_id, u.telegram_id,
                COALESCE(p.name, s.plan_name_at_sale) AS plan_name,
                o.total_irr, o.status, o.created_at
           FROM orders o
           LEFT JOIN users u ON u.id = o.user_id
           LEFT JOIN product_plans p ON p.id = o.plan_id
           LEFT JOIN subscriptions s ON s.order_id = o.id
          ORDER BY o.id DESC
          LIMIT ?1`,
      )
      .bind(RECENT)
      .all<{
        public_id: string;
        user_id: number | null;
        telegram_id: number | null;
        plan_name: string | null;
        total_irr: number;
        status: string;
        created_at: string;
      }>();

    const attention = await loadAttention(db, Date.now());

    return c.json({
      ok: true,
      attention,
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
        // The internal id as well as the telegram one, so this row can link
        // to the customer exactly rather than by a search that matches a
        // fragment. LEFT JOIN, so an order whose user row is gone keeps null.
        userId: r.user_id,
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
