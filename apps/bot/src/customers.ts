/**
 * Finding a customer, and everything the admin's phone shows about one.
 *
 * Reads only. The two things an admin can *change* — the wallet and the block —
 * are `adjustWallet` and `setCustomerStatus` in `@shikoo/domain`, shared with
 * the panel so there is one way to move a customer's money.
 *
 * ## Why the search is narrower than the panel's
 *
 * The panel's customer list is a filtered, paginated table; this is a text box
 * on a phone, and the admin using it is mid-conversation with somebody. So it
 * takes the three things that identify a person in that moment — the Telegram
 * id they can read off their own profile, the @username, and the order number
 * on the invoice the bot sent them — and returns a handful.
 *
 * The order number is the one the panel does not have, and it is the one the
 * customer actually quotes: «سفارش SHK-… پرداخت کردم ولی سرویس نیامد».
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';

type Db = D1Database | D1DatabaseSession;

/** Enough rows to choose from, few enough to read on a phone. */
export const SEARCH_LIMIT = 8;

export interface CustomerHit {
  id: number;
  telegram_id: number;
  username: string | null;
  status: string;
  balance_irr: number | null;
}

export interface CustomerDetail extends CustomerHit {
  phone: string | null;
  phone_verified: boolean;
  blocked_reason: string | null;
  is_reseller: boolean;
  discount_percent: number;
  registered_at: string;
  last_seen_at: string | null;
  order_count: number;
  completed_irr: number;
  active_services: number;
}

/**
 * Whoever the typed text could mean.
 *
 * Persian digits are what a Persian keyboard produces, so a Telegram id typed
 * on one is normalised rather than read as "not a number" — the same treatment
 * the add-on amounts get.
 */
export function normalizeQuery(text: string): string {
  return text
    .trim()
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/^@/, '');
}

export async function findCustomers(db: Db, rawQuery: string): Promise<CustomerHit[]> {
  const q = normalizeQuery(rawQuery);
  if (q === '') return [];

  // A Telegram id is exact. A username is a substring, case-insensitively,
  // because an admin remembers part of a handle far more often than all of it.
  // An order id is exact and upper-cased, since that is how it was printed.
  const asId = /^[0-9]{1,19}$/.test(q) ? q : null;
  const { results } = await db
    .prepare(
      `SELECT DISTINCT u.id, u.telegram_id, u.username, u.status, w.balance_irr
         FROM users u
         LEFT JOIN wallets w ON w.user_id = u.id
        WHERE u.username ILIKE ?1
           OR (?2::bigint IS NOT NULL AND u.telegram_id = ?2::bigint)
           OR EXISTS (SELECT 1 FROM orders o
                       WHERE o.user_id = u.id AND upper(o.public_id) = ?3)
        ORDER BY u.id DESC
        LIMIT ?4`,
    )
    .bind(`%${q}%`, asId, q.toUpperCase(), SEARCH_LIMIT)
    .all<CustomerHit>();
  return results ?? [];
}

export async function customerDetail(db: Db, userId: number): Promise<CustomerDetail | null> {
  return db
    .prepare(
      `SELECT u.id, u.telegram_id, u.username, u.status, u.phone, u.phone_verified,
              u.blocked_reason, u.is_reseller, u.discount_percent,
              u.registered_at, u.last_seen_at,
              COALESCE(w.balance_irr, 0) AS balance_irr,
              (SELECT count(*)::int FROM orders o WHERE o.user_id = u.id) AS order_count,
              (SELECT COALESCE(SUM(o.total_irr), 0)::bigint FROM orders o
                WHERE o.user_id = u.id AND o.status = 'COMPLETED') AS completed_irr,
              (SELECT count(*)::int FROM subscriptions s
                WHERE s.user_id = u.id AND s.status = 'ACTIVE') AS active_services
         FROM users u
         LEFT JOIN wallets w ON w.user_id = u.id
        WHERE u.id = ?1`,
    )
    .bind(userId)
    .first<CustomerDetail>();
}
