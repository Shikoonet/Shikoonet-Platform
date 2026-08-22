/**
 * The shop's headline numbers, defined once.
 *
 * Two surfaces ask for these — the admin panel's home screen over HTTP, and the
 * bot's own «آمار» screen, which an admin reads on a phone. They must agree.
 * An admin who sees 41 orders in one place and 43 in the other does not
 * conclude that "today" is defined differently; they conclude one of the two is
 * lying, and after that neither number is used.
 *
 * So the definitions live here rather than in either caller:
 *
 *   * **today** is Tehran's day, asked of Postgres. Not UTC's day and not the
 *     browser's — the customer was told a Tehran time by the bot, and the
 *     database is the only participant that agrees with it.
 *   * **revenue** is `COMPLETED` orders only. An order that is merely `PAID`
 *     has money against it and nothing delivered; counting it is how a later
 *     refund makes the headline retroactively wrong.
 *   * **wallet** is summed as it stands, negative balances included. Netting
 *     them out would hide exactly the accounts worth looking at.
 *
 * Nothing is filtered away silently. Where a filter exists it is in the SQL
 * above and named in the label each surface draws, because a headline an admin
 * cannot reproduce is one they will eventually stop trusting.
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';

type Db = D1Database | D1DatabaseSession;

export interface ShopStats {
  customers: number;
  customersToday: number;
  activeSubscriptions: number;
  /** Lifetime, `COMPLETED` orders. */
  revenueIrr: number;
  /** The same measure, over Tehran's today. */
  revenueTodayIrr: number;
  ordersToday: number;
  /**
   * What the shop owes its customers right now — the credit balances only.
   *
   * Not `SUM(balance_irr)`. A wallet may legitimately be negative:
   * `users.reseller_max_debt` is a ceiling a reseller is *allowed* to trade
   * under, so a debtor is a designed state and not a broken row. Summing
   * everything nets a receivable against a payable and reports neither. The
   * sim's own fixture shows the size of it — 12,500,000 owed to customers and
   * one reseller 10,970,000 under, which the plain sum reported as 1,530,000,
   * a figure eight times smaller than the liability it claimed to be.
   */
  walletHeldIrr: number;
  /**
   * The other side: what customers owe the shop, as a positive number.
   *
   * Kept rather than dropped, because a reseller deep under their ceiling is
   * the thing an admin most wants to see on this screen, and netting it into
   * the figure above was how it stayed invisible.
   */
  walletOwedToShopIrr: number;
  /** How many wallets are under zero. */
  walletDebtors: number;
  /** Payments waiting for a person to decide. */
  claimsWaiting: number;
}

/** Tehran's midnight, as a timestamp Postgres compares against directly. */
const SINCE_TODAY = `date_trunc('day', now() AT TIME ZONE 'Asia/Tehran') AT TIME ZONE 'Asia/Tehran'`;

export async function shopStats(db: Db): Promise<ShopStats> {
  const [customers, subs, revenue, orders, wallet, claims] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE registered_at >= ${SINCE_TODAY})::int AS today
           FROM users`,
      )
      .first<{ total: number; today: number }>(),
    db
      .prepare(`SELECT COUNT(*)::int AS n FROM subscriptions WHERE status = 'ACTIVE'`)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT COALESCE(SUM(total_irr), 0)::bigint AS irr,
                COALESCE(SUM(total_irr) FILTER (WHERE created_at >= ${SINCE_TODAY}), 0)::bigint
                  AS irr_today
           FROM orders WHERE status = 'COMPLETED'`,
      )
      .first<{ irr: number; irr_today: number }>(),
    db
      .prepare(`SELECT COUNT(*)::int AS n FROM orders WHERE created_at >= ${SINCE_TODAY}`)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT COALESCE(SUM(balance_irr) FILTER (WHERE balance_irr > 0), 0)::bigint AS held,
                COALESCE(-SUM(balance_irr) FILTER (WHERE balance_irr < 0), 0)::bigint AS owed,
                COUNT(*) FILTER (WHERE balance_irr < 0)::int AS debtors
           FROM wallets`,
      )
      .first<{ held: number; owed: number; debtors: number }>(),
    db
      .prepare(
        `SELECT COUNT(*)::int AS n FROM payment_claims
          WHERE status IN ('PENDING', 'MATCH_SUGGESTED')`,
      )
      .first<{ n: number }>(),
  ]);

  return {
    customers: customers?.total ?? 0,
    customersToday: customers?.today ?? 0,
    activeSubscriptions: subs?.n ?? 0,
    revenueIrr: Number(revenue?.irr ?? 0),
    revenueTodayIrr: Number(revenue?.irr_today ?? 0),
    ordersToday: orders?.n ?? 0,
    walletHeldIrr: Number(wallet?.held ?? 0),
    walletOwedToShopIrr: Number(wallet?.owed ?? 0),
    walletDebtors: Number(wallet?.debtors ?? 0),
    claimsWaiting: claims?.n ?? 0,
  };
}
