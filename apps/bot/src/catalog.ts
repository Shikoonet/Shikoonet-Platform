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
  /*
   * «محدودیت ساخت اکانت» — legacy 'limit_panel', migrated into
   * provisioning_providers.capacity, where it sat unread. The dashboard has
   * written it and drawn it beside the live count since the screen was built,
   * so an operator setting it had every reason to believe it did something;
   * nothing in the bot ever asked. NULL is unlimited, which is what the legacy
   * 'unlimited' string became.
   *
   * Counted the way the PHP counted it (index.php:3600) — live subscriptions on
   * the panel, not accounts on the panel itself, because the panel may carry
   * accounts this shop never sold.
   */
  AND (
        pr.capacity IS NULL
     OR pr.capacity > (
          SELECT COUNT(*) FROM subscriptions cap
           WHERE cap.provider_id = pr.id
             AND cap.status IN ('ACTIVE', 'ON_HOLD')
        )
      )
`;

/**
 * One sellable service on a panel — «پلاتینیوم», «طلایی», «معمولی».
 *
 * This level did not exist in the shop until now, and its absence is what made
 * a panel able to sell exactly one tier. The plan list was drawn straight off
 * the panel and every button on it was labelled with its PRODUCT's name, so
 * three plans of one product read as the same button three times, and three
 * products of one panel read as a flat list with no grouping at all.
 */
export interface CatalogProduct {
  productId: number;
  name: string;
  /**
   * The panel it is delivered from.
   *
   * Not drawn on the button unless it has to be. The shop no longer asks the
   * customer to pick a location first — they pick a SERVICE — so the panel is
   * only ever needed to tell two services of the same name apart, which is what
   * a second panel selling its own «پلاتینیوم» would produce.
   */
  providerName: string;
}

/**
 * The services this customer can buy.
 *
 * Across every panel, because the shop's first question is «which level», not
 * «which location». The panel is still what delivers, and the plan page still
 * names it, but it is no longer a step the customer walks through: the legacy
 * shop asked location-first because a legacy panel WAS a tier — five
 * `marzban_panel` rows on one PasarGuard differing only in `inbounds` — and
 * once a service carries its own groups that reason is gone.
 *
 * `providerId` narrows it to one panel. Nothing in the shop passes it any more;
 * the `panel:` callback does, so a button in a message sent before this change
 * still opens something sensible instead of silently doing nothing.
 */
export async function productsForUser(
  db: Db,
  userId: number,
  providerId?: number,
): Promise<CatalogProduct[]> {
  const rows = await db
    .prepare(
      // No price and no plan count in the SELECT: this screen picks a LEVEL,
      // and a level does not have one price. The JOIN and the GROUP BY stay —
      // they are what keeps a service with nothing sellable inside it off the
      // list, which is a rule about visibility rather than about money.
      `SELECT p.id                AS product_id,
              p.name              AS name,
              pr.name             AS provider_name
         FROM products p
         JOIN product_plans pl          ON pl.product_id = p.id
         JOIN provisioning_providers pr ON pr.id = p.provider_id
         JOIN users u                   ON u.id = ?1
        WHERE (?2::bigint IS NULL OR pr.id = ?2) AND ${PURCHASABLE}
        GROUP BY p.id, p.name, p.sort_order, pr.name, pr.sort_order, pr.id
        -- The panel's order first, then the product's. Same reason the panel
        -- list used it: every migrated row carries sort_order 0, so a tiebreak
        -- on name would rearrange a shop customers already know.
        ORDER BY pr.sort_order, pr.id, p.sort_order, p.id`,
    )
    .bind(userId, providerId ?? null)
    .all<{ product_id: number; name: string; provider_name: string }>();
  return rows.results.map((r) => ({
    productId: r.product_id,
    name: r.name,
    providerName: r.provider_name,
  }));
}

/**
 * One button on the shop's first screen.
 *
 * A category is the level the customer now picks first, and it replaced the
 * service list for one reason: a service is a TIER and a tier has no price, so
 * that screen could only ever show names — the customer chose blind and met the
 * numbers one screen later. A category groups priced rows, so the very next
 * screen is payable amounts.
 */
export interface CatalogCategory {
  categoryId: number;
  name: string;
  /**
   * Drawn on the button before the name, when the admin gave it one — «🆕»,
   * «🔴 آف», «ویژه». Was `emoji` until 0033; it was never only an emoji.
   */
  badge: string | null;
  /** Where the admin broke the row, or null for «never arranged». */
  rowIndex: number | null;
}

/**
 * The categories holding something this customer can actually buy.
 *
 * The JOIN down to `product_plans` and the `PURCHASABLE` predicate are what
 * make this list honest: a category whose every product is HIDDEN, or is
 * resellers-only for a customer who is not one, draws no button at all rather
 * than a button onto an empty screen. That is the same rule `productsForUser`
 * already applies one level down, and it is the reason this cannot be a plain
 * `SELECT * FROM product_categories`.
 *
 * `active` is the admin's own switch and is checked here rather than in the
 * screen: a category taken off sale must be off sale everywhere, including the
 * `cat:<id>` a customer still has sitting in an old message.
 */
export async function categoriesForUser(db: Db, userId: number): Promise<CatalogCategory[]> {
  const rows = await db
    .prepare(
      `SELECT cat.id AS category_id, cat.name AS name, cat.badge AS badge,
              cat.row_index AS row_index
         FROM product_categories cat
         JOIN products p                ON p.category_id = cat.id
         JOIN product_plans pl          ON pl.product_id = p.id
         JOIN provisioning_providers pr ON pr.id = p.provider_id
         JOIN users u                   ON u.id = ?1
        WHERE cat.active AND ${PURCHASABLE}
        GROUP BY cat.id, cat.name, cat.badge, cat.row_index, cat.sort_order
        ORDER BY cat.sort_order, cat.id`,
    )
    .bind(userId)
    .all<{ category_id: number; name: string; badge: string | null; row_index: number | null }>();
  return rows.results.map((r) => ({
    categoryId: r.category_id,
    name: r.name,
    badge: r.badge,
    rowIndex: r.row_index,
  }));
}

export interface CatalogPlan {
  planId: number;
  /** The product the plan belongs to. A discount code can be scoped to one. */
  productId: number;
  productName: string;
  planName: string;
  /** Drawn before the label on the plan's button. Same field as a category's. */
  badge: string | null;
  priceIrr: number;
  durationDays: number | null;
  volumeGb: number | null;
  userLimit: number | null;
  providerId: number;
  providerName: string;
  /** The category it is sold under. Decides where «بازگشت» lands. */
  categoryId: number;
  /**
   * Where the admin broke the row, or null for «this screen was never
   * arranged». Read by `groupIntoRows`; see `packages/contracts/src/catalogLayout.ts`.
   */
  rowIndex: number | null;
  /**
   * How many plans sit in the same CATEGORY, this one included. Decides where
   * «بازگشت» goes: to the category's list when there is one to go back to, and
   * to the shop's first screen when this plan never drew one — a category
   * holding a single plan is opened straight from `buy`.
   *
   * It counts ACTIVE plans rather than PURCHASABLE ones, and that is a
   * deliberate approximation: the exact number costs the whole predicate a
   * second time per row, and being wrong only ever sends «بازگشت» to a list of
   * one instead of to the shop.
   */
  siblings: number;
}

interface PlanRow {
  plan_id: number;
  product_id: number;
  product_name: string;
  plan_name: string;
  badge: string | null;
  price_irr: number;
  duration_days: number | null;
  volume_gb: number | null;
  user_limit: number | null;
  provider_id: number;
  provider_name: string;
  category_id: number;
  row_index: number | null;
  siblings: number;
}

const PLAN_COLUMNS = `
  pl.id           AS plan_id,
  p.id            AS product_id,
  p.name          AS product_name,
  pl.name         AS plan_name,
  pl.badge        AS badge,
  pl.price_irr    AS price_irr,
  pl.duration_days AS duration_days,
  pl.volume_gb    AS volume_gb,
  pl.user_limit   AS user_limit,
  pr.id           AS provider_id,
  pr.name         AS provider_name,
  p.category_id   AS category_id,
  pl.row_index    AS row_index,
  (SELECT COUNT(*)::int
     FROM product_plans sib
     JOIN products sp ON sp.id = sib.product_id
    WHERE sp.category_id = p.category_id AND sib.status = 'ACTIVE') AS siblings
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
    badge: row.badge,
    priceIrr: row.price_irr,
    durationDays: row.duration_days,
    volumeGb: row.volume_gb,
    userLimit: row.user_limit,
    providerId: row.provider_id,
    providerName: row.provider_name,
    categoryId: row.category_id,
    rowIndex: row.row_index,
    siblings: row.siblings,
  };
}

/**
 * Every priced row inside one category. Empty if it is not this customer's to open.
 *
 * The ORDER BY here IS the layout's column order — `groupIntoRows` reads this
 * list as given — so changing it silently rearranges every arranged screen.
 *
 * `pl.sort_order` comes first because that is what the arrangement writes, and
 * once a screen has been arranged it is a total order and nothing after it ever
 * matters. Everything after it is the DEFAULT for a screen nobody has touched,
 * where every `sort_order` is still 0: group a service's rows together, in the
 * admin's own service order, cheapest first inside each. Sorting the whole
 * category by price instead would interleave three services' sizes into one
 * ladder, which is the shape the service level was introduced to remove.
 *
 * `${PURCHASABLE}` is here for the same reason it is in `purchasablePlan`:
 * `cat:<id>` is unsigned callback data and anyone can post one for a category
 * they were never offered. An empty list is the whole of the answer.
 */
export async function plansInCategory(
  db: Db,
  userId: number,
  categoryId: number,
): Promise<CatalogPlan[]> {
  const rows = await db
    .prepare(
      `SELECT ${PLAN_COLUMNS} ${PLAN_FROM}
        JOIN product_categories cat ON cat.id = p.category_id
        WHERE p.category_id = ?2 AND cat.active AND ${PURCHASABLE}
        ORDER BY pl.sort_order, p.sort_order, p.id, pl.price_irr, pl.id`,
    )
    .bind(userId, categoryId)
    .all<PlanRow>();
  return rows.results.map(toPlan);
}

/**
 * Every plan on one panel, flat.
 *
 * The SHOP no longer draws this — it goes through services now — but a RENEWAL
 * does, and the difference is real rather than an oversight. A renewal is not
 * choosing a tier: it is extending an account that already exists, and the plan
 * it was sold under is gone for roughly half the migrated services. So it is
 * offered everything the panel sells, labelled by product because on this list
 * the product is what tells two rows apart.
 */
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
 * The plans inside one service. Empty if it is not this customer's to open.
 *
 * Ordered by price rather than by `sort_order` first: inside a single service
 * the plans differ only in how much you get, so cheapest-first is the order the
 * customer is reading them in. Between services that is not true, which is why
 * the list above it keeps the admin's arrangement.
 */
export async function plansInProduct(
  db: Db,
  userId: number,
  productId: number,
): Promise<CatalogPlan[]> {
  const rows = await db
    .prepare(
      `SELECT ${PLAN_COLUMNS} ${PLAN_FROM}
        WHERE p.id = ?2 AND ${PURCHASABLE}
        ORDER BY pl.sort_order, pl.price_irr, pl.id`,
    )
    .bind(userId, productId)
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
