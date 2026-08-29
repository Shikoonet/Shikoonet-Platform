/**
 * The «آمار» screen: what the shop did in a window, and what is true right now.
 *
 * ## Stocks and flows are not the same question, and the legacy screen mixes them
 *
 * `legacy/mirzabot-php/admin.php:200-274` draws eighteen figures under one set
 * of period buttons. Some of them are **flows** — sales, renewals, new
 * customers — and a period genuinely changes them. The rest are **stocks**:
 * the wallet balance, the number of live services, how many resellers exist,
 * how many panels are configured. A stock has no «last hour» value; there is
 * only what is true now.
 *
 * The legacy screen does not say which is which, so «موجودی کل کاربران» sits
 * under «یک ساعت اخیر» looking like an hourly figure while being a running
 * total. Here the two are separate fields on the response and the screen labels
 * the stocks «هم‌اکنون», because an admin who cannot tell them apart is being
 * invited to read a balance as an hour's takings.
 *
 * ## Every stock comes from `shopStats`
 *
 * Not from SQL written here. `shopStats` already answers the dashboard home
 * screen and the bot's own «آمار», and its header explains at length why one
 * definition of «wallet» and «today» matters: an admin who sees two figures
 * concludes one is lying and then trusts neither. This module adds the flows
 * and the ratios; it does not redefine anything that already had a definition.
 *
 * ## Three figures from the legacy screen are deliberately absent
 *
 * «نمایندگان نوع N / N2» and «اکانت‌های تست» are not computed, and the screen
 * says so rather than showing a zero. `users.is_reseller` is a boolean — there
 * is no second reseller tier to count — and the legacy counts test accounts by
 * matching a product **name** string, which is not a thing this schema models.
 * A `0` under either label is indistinguishable from «none this month», and
 * that is the kind of silence this project keeps paying for. Sam's call,
 * 2026-08-29.
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';
import { shopStats } from './shopStats.js';
import { statsRangeBounds, type StatsRange } from './statsRange.js';

type Db = D1Database | D1DatabaseSession;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One payment method and what came in through it. */
export interface GatewayTotal {
  method: string;
  count: number;
  irr: number;
}

export interface ShopReport {
  range: StatsRange;
  /** The window actually measured. `null` on both means everything. */
  startMs: number | null;
  endMs: number | null;

  /* ---- flows: these move with the range ---- */
  newCustomers: number;
  buyers: number;
  salesCount: number;
  salesIrr: number;
  renewalsCount: number;
  renewalsIrr: number;
  topupsIrr: number;

  /* ---- ratios derived from the flows above ---- */
  conversionPercent: number;
  avgPerBuyerIrr: number;
  renewalSharePercent: number;
  /**
   * The window's own daily average, projected over thirty days.
   *
   * The legacy multiplies **yesterday alone** by 30 (`admin.php:252`), so a
   * quiet Friday reports a month a third of the truth and one good day reports
   * a record. Averaging the selected window keeps that behaviour exactly where
   * the legacy had it — «دیروز» is one day, so one day × 30 — and stops the
   * noise everywhere else.
   */
  projectedMonthlyIrr: number;
  /** How many days the projection divided by, so the screen can show its work. */
  projectionDays: number;

  /* ---- stocks: always now, never ranged ---- */
  customersTotal: number;
  activeSubscriptions: number;
  activeSubscriptionsIrr: number;
  walletHeldIrr: number;
  walletOwedToShopIrr: number;
  walletDebtors: number;
  resellers: number;
  panels: number;
  claimsWaiting: number;

  /* ---- per payment method, over the range ---- */
  gateways: GatewayTotal[];
}

/**
 * `WHERE` fragment for a range over one timestamp column, plus its binds.
 *
 * Written rather than interpolated: `packages/db` rejects a statement that
 * mixes `?` and `?N` styles instead of guessing, so the positions are counted
 * here once and every caller below stays consistent with them.
 */
function rangeClause(
  column: string,
  bounds: { start: number | null; end: number | null },
  firstIndex: number,
): { sql: string; binds: number[] } {
  if (bounds.start === null || bounds.end === null) return { sql: '', binds: [] };
  return {
    sql: ` AND ${column} >= to_timestamp(?${firstIndex} / 1000.0)
           AND ${column} <  to_timestamp(?${firstIndex + 1} / 1000.0)`,
    binds: [bounds.start, bounds.end],
  };
}

const pct = (part: number, whole: number): number =>
  whole > 0 ? Math.round((part / whole) * 10000) / 100 : 0;

export async function shopReport(
  db: Db,
  range: StatsRange,
  nowMs = Date.now(),
  day?: string | null,
  to?: string | null,
): Promise<ShopReport> {
  const bounds = statsRangeBounds(range, nowMs, day, to);

  const orders = rangeClause('o.completed_at', bounds, 1);
  const joins = rangeClause('registered_at', bounds, 1);
  // `payments` has no `paid_at`. `updated_at` is when the row last changed for
  // any reason, so a rejection re-reviewed months later would move the payment
  // into the wrong window; `created_at` is when the customer raised it and never
  // moves again. For a PAID row the two are minutes apart.
  const pays = rangeClause('created_at', bounds, 1);

  const [stats, flows, people, gateways, subs] = await Promise.all([
    // Every «now» figure, from the one place that already defines them.
    shopStats(db),

    /**
     * Sales, renewals and top-ups in one pass over `orders`.
     *
     * `COMPLETED` only, and counted from `orders` rather than `payments`: a
     * purchase paid from the wallet has no payment row of its own and would
     * disappear from the count — the same reasoning the nightly report gives.
     *
     * `buyers` counts `NEW_PURCHASE` only, and that is not an oversight about
     * renewals — it is what keeps `avgPerBuyerIrr` an average of something.
     *
     * The browser found this: a day whose only completed order was a renewal
     * showed «کاربران دارای خرید ۱» beside «میانگین خرید هر مشتری ۰ تومان»,
     * because the numerator excluded renewal money while the denominator
     * counted the person who paid it. The legacy screen is coherent here for a
     * structural reason rather than a careful one — its buyers come from
     * `invoice` and its total comes from `invoice`, while renewals live in
     * `service_other` and are in neither.
     *
     * So both figures describe the same population. Renewal money is not lost:
     * it has its own count and its own total, and `renewalSharePercent`
     * relates the two.
     */
    db
      .prepare(
        `SELECT
           count(*) FILTER (WHERE o.kind = 'NEW_PURCHASE')::int               AS sales_count,
           COALESCE(sum(o.total_irr) FILTER (WHERE o.kind = 'NEW_PURCHASE'), 0) AS sales_irr,
           count(*) FILTER (WHERE o.kind = 'RENEWAL')::int                    AS renewals_count,
           COALESCE(sum(o.total_irr) FILTER (WHERE o.kind = 'RENEWAL'), 0)      AS renewals_irr,
           COALESCE(sum(o.total_irr) FILTER (WHERE o.kind = 'WALLET_TOPUP'), 0) AS topups_irr,
           count(DISTINCT o.user_id) FILTER (
             WHERE o.kind = 'NEW_PURCHASE'
           )::int                                                             AS buyers,
           -- Cast, because EXTRACT yields numeric with a fractional part and
           -- the adapter refuses to hand a lossy numeric to a JS number.
           (EXTRACT(EPOCH FROM min(o.completed_at)) * 1000)::bigint            AS first_ms
         FROM orders o
        WHERE o.status = 'COMPLETED'${orders.sql}`,
      )
      .bind(...orders.binds)
      .first<{
        sales_count: number;
        sales_irr: string | number;
        renewals_count: number;
        renewals_irr: string | number;
        topups_irr: string | number;
        buyers: number;
        first_ms: string | number | null;
      }>(),

    db
      .prepare(
        `SELECT count(*)::int AS joined FROM users WHERE true${joins.sql}`,
      )
      .bind(...joins.binds)
      .first<{ joined: number }>(),

    /**
     * Money in, by method.
     *
     * `ADMIN_CREDIT` and `ADMIN_DEBIT` are excluded because they are not
     * payments — they are an operator moving a balance, and the legacy drops
     * its own two equivalents (`add balance by admin`, `low balance by admin`)
     * for the same reason. Including them would report the shop paying itself.
     */
    db
      .prepare(
        `SELECT method, count(*)::int AS n, COALESCE(sum(amount_irr), 0) AS irr
           FROM payments
          WHERE status = 'PAID'
            AND method NOT IN ('ADMIN_CREDIT','ADMIN_DEBIT')${pays.sql}
          GROUP BY method
          ORDER BY sum(amount_irr) DESC`,
      )
      .bind(...pays.binds)
      .all<{ method: string; n: number; irr: string | number }>(),

    // Two stocks `shopStats` does not carry, and the value of what is live.
    db
      .prepare(
        `SELECT
           (SELECT count(*) FROM users WHERE is_reseller)::int                AS resellers,
           (SELECT count(*) FROM provisioning_providers)::int                 AS panels,
           (SELECT COALESCE(sum(price_irr), 0) FROM subscriptions
             WHERE status = 'ACTIVE')                                         AS active_irr`,
      )
      .first<{ resellers: number; panels: number; active_irr: string | number }>(),
  ]);

  const salesIrr = Number(flows?.sales_irr ?? 0);
  const renewalsIrr = Number(flows?.renewals_irr ?? 0);
  const buyers = flows?.buyers ?? 0;
  const newCustomers = people?.joined ?? 0;

  /**
   * How many days the projection divides by.
   *
   * For a bounded range it is the range. For «آمار کل» there is no upper edge
   * to subtract, so the shop's own first completed sale is the lower one —
   * which is the only honest span available and is what «since we opened»
   * means. A shop with no sales yet projects nothing rather than dividing by
   * zero.
   */
  const spanStart = bounds.start ?? (flows?.first_ms != null ? Number(flows.first_ms) : null);
  const spanEnd = bounds.end ?? nowMs;
  const projectionDays =
    spanStart === null ? 0 : Math.max(1, Math.round((spanEnd - spanStart) / DAY_MS));

  return {
    range,
    startMs: bounds.start,
    endMs: bounds.end,

    newCustomers,
    buyers,
    salesCount: flows?.sales_count ?? 0,
    salesIrr,
    renewalsCount: flows?.renewals_count ?? 0,
    renewalsIrr,
    topupsIrr: Number(flows?.topups_irr ?? 0),

    conversionPercent: pct(buyers, newCustomers),
    avgPerBuyerIrr: buyers > 0 ? Math.round(salesIrr / buyers) : 0,
    // Capped at 100 like the legacy does: renewals of services sold before the
    // window can otherwise exceed the window's own sales and read as >100%.
    renewalSharePercent: Math.min(100, pct(renewalsIrr, salesIrr)),
    projectedMonthlyIrr:
      projectionDays > 0 ? Math.round((salesIrr / projectionDays) * 30) : 0,
    projectionDays,

    customersTotal: stats.customers,
    activeSubscriptions: stats.activeSubscriptions,
    activeSubscriptionsIrr: Number(subs?.active_irr ?? 0),
    walletHeldIrr: stats.walletHeldIrr,
    walletOwedToShopIrr: stats.walletOwedToShopIrr,
    walletDebtors: stats.walletDebtors,
    resellers: subs?.resellers ?? 0,
    panels: subs?.panels ?? 0,
    claimsWaiting: stats.claimsWaiting,

    gateways: (gateways.results ?? []).map((g) => ({
      method: g.method,
      count: g.n,
      irr: Number(g.irr),
    })),
  };
}
