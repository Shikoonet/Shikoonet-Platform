/**
 * Reading the shop.
 *
 * These rows belong to nobody — every customer may see the same catalog — so
 * they are deliberately NOT in owned.ts. Scoping a product by user_id would be
 * cargo-culting that rule rather than applying it.
 *
 * What IS enforced here is visibility, and it is enforced in exactly one place.
 * `PURCHASABLE` below is the entire answer to "may this customer buy this?",
 * and all three queries in this file are built from it — including the one the
 * order handler uses.
 *
 * That last part is the point. A button having been shown proves nothing:
 * `callback_data` is unsigned, and anyone can post `order:<id>` for an id they
 * were never offered. So the order path re-runs the same predicate instead of
 * trusting that the customer got there by pressing something. Split the check
 * — list with one rule, sell with another — and the two drift apart, which is
 * how Mirzabot ended up checking ownership on `config_` and not on
 * `subscriptionurl_`.
 *
 * The rule itself is a direct translation of the PHP:
 *
 *   panel active        marzban_panel.status = 'active'      (keyboard.php:608)
 *   product visible     product row exists for that panel    (index.php:3534)
 *   reseller gate       product.agent = user.agent           (index.php:3534)
 *   first purchase      one_buy_status=1 AND no paid invoice (keyboard.php:1409)
 *
 * with two deliberate departures, both approved:
 *
 *   - Legacy shows a reseller ONLY products flagged for resellers, and there
 *     are zero such rows in production — so a reseller sees an empty shop.
 *     Here a reseller sees everything a customer sees, plus the reseller rows.
 *   - Legacy lists a panel even when it has nothing to sell, which is a button
 *     that leads to an empty list. Here a panel with no purchasable plan is not
 *     offered at all.
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';

type Db = D1Database | D1DatabaseSession;

/**
 * Joined against `users u` on the caller. Every query below must therefore
 * bring `u` into scope, which is the point: there is no way to ask this
 * question without saying who is asking.
 *
 * `subscriptions.status <> 'PENDING_PAYMENT'` is the migration of legacy
 * `invoice WHERE Status != 'Unpaid'` — "has this customer ever actually
 * received anything", which is what makes a first-purchase offer first.
 */
const PURCHASABLE = `
      pr.status = 'ACTIVE'
  AND p.status  = 'ACTIVE'
  AND pl.status = 'ACTIVE'
  AND (p.resellers_only = false OR u.is_reseller)
  AND (
        p.once_per_user = false
     OR NOT EXISTS (
          SELECT 1 FROM subscriptions s
           WHERE s.user_id = u.id AND s.status <> 'PENDING_PAYMENT'
        )
      )
`;

export interface Panel {
  id: number;
  name: string;
  /** How many plans this customer can buy here. Never zero: empty panels are
   *  not returned at all. */
  plans: number;
}

/** The panels worth showing this customer, in the order the admin set. */
export async function panelsForUser(db: Db, userId: number): Promise<Panel[]> {
  const rows = await db
    .prepare(
      `SELECT pr.id, pr.name, COUNT(pl.id)::int AS plans
         FROM provisioning_providers pr
         JOIN products p        ON p.provider_id = pr.id
         JOIN product_plans pl  ON pl.product_id = p.id
         JOIN users u           ON u.id = ?1
        WHERE ${PURCHASABLE}
        GROUP BY pr.id, pr.name, pr.sort_order
        -- id, not name. Every migrated panel carries sort_order 0, so a
        -- tiebreak on name reorders the shop alphabetically and customers lose
        -- the arrangement they know. Compared against the live bot on
        -- 2026-08-12: it lists مولتی لوکیشن, طلایی, خرید اولی‌ها — which is
        -- marzban_panel.id order, and our ids follow legacy_id.
        ORDER BY pr.sort_order, pr.id`,
    )
    .bind(userId)
    .all<Panel>();
  return rows.results;
}

export interface CatalogPlan {
  planId: number;
  /** The product the plan belongs to. A discount code can be scoped to one. */
  productId: number;
  productName: string;
  planName: string;
  priceIrr: number;
  durationDays: number | null;
  volumeGb: number | null;
  userLimit: number | null;
  providerId: number;
  providerName: string;
}

interface PlanRow {
  plan_id: number;
  product_id: number;
  product_name: string;
  plan_name: string;
  price_irr: number;
  duration_days: number | null;
  volume_gb: number | null;
  user_limit: number | null;
  provider_id: number;
  provider_name: string;
}

const PLAN_COLUMNS = `
  pl.id           AS plan_id,
  p.id            AS product_id,
  p.name          AS product_name,
  pl.name         AS plan_name,
  pl.price_irr    AS price_irr,
  pl.duration_days AS duration_days,
  pl.volume_gb    AS volume_gb,
  pl.user_limit   AS user_limit,
  pr.id           AS provider_id,
  pr.name         AS provider_name
`;

const PLAN_FROM = `
  FROM product_plans pl
  JOIN products p                ON p.id = pl.product_id
  JOIN provisioning_providers pr ON pr.id = p.provider_id
  JOIN users u                   ON u.id = ?1
`;

function toPlan(row: PlanRow): CatalogPlan {
  return {
    planId: row.plan_id,
    productId: row.product_id,
    productName: row.product_name,
    planName: row.plan_name,
    priceIrr: row.price_irr,
    durationDays: row.duration_days,
    volumeGb: row.volume_gb,
    userLimit: row.user_limit,
    providerId: row.provider_id,
    providerName: row.provider_name,
  };
}

/** What this customer can buy on one panel. Empty if the panel is not theirs to see. */
export async function plansOnPanel(
  db: Db,
  userId: number,
  providerId: number,
): Promise<CatalogPlan[]> {
  const rows = await db
    .prepare(
      `SELECT ${PLAN_COLUMNS} ${PLAN_FROM}
        WHERE pr.id = ?2 AND ${PURCHASABLE}
        ORDER BY p.sort_order, pl.sort_order, pl.price_irr`,
    )
    .bind(userId, providerId)
    .all<PlanRow>();
  return rows.results.map(toPlan);
}

/**
 * One plan, and only if this customer may actually buy it right now.
 *
 * Null covers every reason at once — no such plan, hidden product, disabled
 * panel, resellers only, already had their first purchase — because the caller
 * has no business acting differently on any of them, and telling them apart
 * would hand out a map of the hidden catalog.
 */
export async function purchasablePlan(
  db: Db,
  userId: number,
  planId: number,
): Promise<CatalogPlan | null> {
  const row = await db
    .prepare(
      `SELECT ${PLAN_COLUMNS} ${PLAN_FROM}
        WHERE pl.id = ?2 AND ${PURCHASABLE}`,
    )
    .bind(userId, planId)
    .first<PlanRow>();
  return row ? toPlan(row) : null;
}
