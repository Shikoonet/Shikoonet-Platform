/**
 * Every read of a row that belongs to one customer.
 *
 * This file exists so that "did we check the owner?" has one answer instead of
 * one per handler. Each query below carries `AND user_id = $caller`, and the
 * signatures make the caller impossible to omit — it is the first argument, not
 * an option. A handler cannot reach an order except through here.
 *
 * Mirzabot's shape is the counter-example: `config_` checks the owner,
 * `extend_`, `changestatus_` and the `subscriptionurl_` button path do not. The
 * check was a habit applied by hand at each call site, and four call sites
 * later somebody's attention ran out. BUGS-FOR-ADMIN.md item 8.
 *
 * Catalog rows — panels, products, plans — are NOT here. They belong to nobody
 * and every customer may read them, so scoping them by user would be
 * cargo-culting the rule rather than applying it. What a customer may not do is
 * read another customer's ORDER, which is what this file guards.
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';

type Db = D1Database | D1DatabaseSession;

export interface OwnedOrder {
  id: number;
  public_id: string;
  status: string;
  total_irr: number;
  plan_id: number | null;
}

/**
 * Loads one order, and only if it belongs to `userId`.
 *
 * Returns null both when the order does not exist and when it belongs to
 * somebody else. The caller cannot tell those apart, which is deliberate: a
 * different answer for "not yours" turns this into an enumeration oracle.
 */
export async function orderForUser(
  db: Db,
  userId: number,
  orderId: number,
): Promise<OwnedOrder | null> {
  return db
    .prepare(
      `SELECT id, public_id, status, total_irr, plan_id
         FROM orders
        WHERE id = ?1 AND user_id = ?2`,
    )
    .bind(orderId, userId)
    .first<OwnedOrder>();
}

export interface OwnedSubscription {
  id: number;
  status: string;
  expires_at: string | null;
}

/**
 * The lookup Mirzabot gets wrong. `subscriptionurl_<id>` there loads by id
 * alone and returns the subscription URL to whoever asked; here the row simply
 * does not exist for anyone but its owner.
 */
export async function subscriptionForUser(
  db: Db,
  userId: number,
  subscriptionId: number,
): Promise<OwnedSubscription | null> {
  return db
    .prepare(
      `SELECT id, status, expires_at
         FROM subscriptions
        WHERE id = ?1 AND user_id = ?2`,
    )
    .bind(subscriptionId, userId)
    .first<OwnedSubscription>();
}
