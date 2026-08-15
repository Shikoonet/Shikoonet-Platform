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
  /** What the shop owes its customers right now. */
  walletHeldIrr: number;
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
      .prepare(`SELECT COALESCE(SUM(balance_irr), 0)::bigint AS irr FROM wallets`)
      .first<{ irr: number }>(),
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
    walletHeldIrr: Number(wallet?.irr ?? 0),
    claimsWaiting: claims?.n ?? 0,
  };
}
