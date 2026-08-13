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
  public_id: string;
  status: string;
  plan_name_at_sale: string;
  provider_name_at_sale: string | null;
  remote_username: string | null;
  subscription_url: string | null;
  /** `numeric` and `int8` both come back as numbers — packages/db sets the
   *  type parsers, and refuses any value a JS number would round. */
  volume_gb: number | null;
  used_bytes: number | null;
  duration_days: number | null;
  expires_at: string | null;
  last_synced_at: string | null;
  purchased_at: string;
}

const SUBSCRIPTION_COLUMNS = `
  id, public_id, status, plan_name_at_sale, provider_name_at_sale,
  remote_username, subscription_url, volume_gb, used_bytes,
  duration_days, expires_at, last_synced_at, purchased_at
`;

/**
 * Everything this customer owns, newest first, with the live ones on top.
 *
 * `PENDING_PAYMENT` rows are excluded. They are the shell of a purchase that
 * was never completed — there is nothing to show and nothing to tap, and
 * listing them next to real services is how a customer comes to support asking
 * why a service they never paid for does not work.
 *
 * Paged rather than capped. Four customers in production have more than ten
 * services and one has forty-five, and they are the resellers — showing them
 * the first eight and silently dropping the rest would hit exactly the people
 * who use this screen most.
 */
export async function subscriptionsForUser(
  db: Db,
  userId: number,
  limit: number,
  offset = 0,
): Promise<OwnedSubscription[]> {
  const rows = await db
    .prepare(
      `SELECT ${SUBSCRIPTION_COLUMNS}
         FROM subscriptions
        WHERE user_id = ?1 AND status <> 'PENDING_PAYMENT'
        ORDER BY (status = 'ACTIVE') DESC, purchased_at DESC, id DESC
        LIMIT ?2 OFFSET ?3`,
    )
    .bind(userId, limit, offset)
    .all<OwnedSubscription>();
  return rows.results;
}

/** How many rows the list above can page through. */
export async function countSubscriptionsForUser(db: Db, userId: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*)::int AS n FROM subscriptions
        WHERE user_id = ?1 AND status <> 'PENDING_PAYMENT'`,
    )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * A service that can be extended, together with the panel it lives on.
 *
 * `provider_config` comes along because two of the admin's own settings live
 * in it — whether this panel may be renewed at all, and whether a renewal adds
 * to what is there or resets it. Both were set in the old bot and both are
 * honoured (`renewAllowed`, `renewModeFor`).
 */
export interface RenewableSubscription {
  id: number;
  public_id: string;
  status: string;
  plan_name_at_sale: string;
  remote_username: string;
  expires_at: string | null;
  volume_gb: number | null;
  used_bytes: number | null;
  provider_id: number;
  provider_name: string;
  provider_kind: string;
  provider_config: Record<string, unknown> | null;
}

/**
 * Which of this customer's services can be extended.
 *
 * The plan they originally bought is deliberately not part of the condition.
 * Half the live services were sold under a product that no longer exists —
 * 1,687 of 3,139 match a current product by name, and `subscriptions.plan_id`
 * is NULL for every migrated row — so requiring the original plan would tell
 * most customers their service cannot be renewed. What is required is an
 * account on a panel that is still there; the plan is chosen at the next step.
 *
 * `status = 'ACTIVE'` includes services whose date has passed. Those are the
 * ones most in need of renewal, and the row's status does not move on its own
 * (see `menu.serviceState`).
 */
const RENEWABLE = `
  s.status = 'ACTIVE'
  AND s.remote_username IS NOT NULL
  AND pv.status = 'ACTIVE'
`;

const RENEWABLE_COLUMNS = `
  s.id, s.public_id, s.status, s.plan_name_at_sale, s.remote_username, s.expires_at,
  s.volume_gb, s.used_bytes,
  pv.id AS provider_id, pv.name AS provider_name, pv.kind AS provider_kind,
  pv.config AS provider_config
`;

export async function renewableForUser(
  db: Db,
  userId: number,
  limit: number,
  offset = 0,
): Promise<RenewableSubscription[]> {
  const rows = await db
    .prepare(
      `SELECT ${RENEWABLE_COLUMNS}
         FROM subscriptions s
         JOIN provisioning_providers pv ON pv.id = s.provider_id
        WHERE s.user_id = ?1 AND ${RENEWABLE}
        ORDER BY s.expires_at NULLS LAST, s.id
        LIMIT ?2 OFFSET ?3`,
    )
    .bind(userId, limit, offset)
    .all<RenewableSubscription>();
  return rows.results;
}

export async function countRenewableForUser(db: Db, userId: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*)::int AS n
         FROM subscriptions s
         JOIN provisioning_providers pv ON pv.id = s.provider_id
        WHERE s.user_id = ?1 AND ${RENEWABLE}`,
    )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** One renewable service, and only if it is this customer's. */
export async function renewableForUserById(
  db: Db,
  userId: number,
  subscriptionId: number,
): Promise<RenewableSubscription | null> {
  return db
    .prepare(
      `SELECT ${RENEWABLE_COLUMNS}
         FROM subscriptions s
         JOIN provisioning_providers pv ON pv.id = s.provider_id
        WHERE s.id = ?1 AND s.user_id = ?2 AND ${RENEWABLE}`,
    )
    .bind(subscriptionId, userId)
    .first<RenewableSubscription>();
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
      `SELECT ${SUBSCRIPTION_COLUMNS}
         FROM subscriptions
        WHERE id = ?1 AND user_id = ?2 AND status <> 'PENDING_PAYMENT'`,
    )
    .bind(subscriptionId, userId)
    .first<OwnedSubscription>();
}
