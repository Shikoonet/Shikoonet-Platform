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
import { trialFor } from '@shikoo/domain';

import type { ButtonStyle } from './telegram.js';

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
  /*
   * «مخفی کردن پنل برای یک کاربر» - legacy marzban_panel.hide_user, now
   * provider_hidden_users. A deny list: empty means everybody sees it.
   *
   * It belongs HERE rather than in the listing queries because three of the
   * five callers of this predicate are not listings at all - they are the
   * ones that answer «may this customer buy plan 41», asked with a number
   * that arrived in a callback. Legacy puts the check in the keyboard
   * builders instead (keyboard.php:616 and six more continues) and its
   * single-panel shortcuts skip it entirely, answering «موقعیتی یافت نشد»
   * from a separate branch. One clause cannot be forgotten in one place.
   */
  AND NOT EXISTS (
        SELECT 1 FROM provider_hidden_users h
         WHERE h.provider_id = pr.id AND h.user_id = u.id
      )
  AND (
        p.once_per_user = false
     OR NOT EXISTS (
          SELECT 1 FROM subscriptions s
           WHERE s.user_id = u.id AND s.status <> 'PENDING_PAYMENT'
        )
      )
  /*
   * «فقط برای کسانی که هنوز خرید نکرده‌اند» — Sam, 2026-09-03. A starter panel
   * that disappears the moment the customer owns anything.
   *
   * The same question as once_per_user directly above, asked of the PANEL
   * rather than of the product, and answered with the identical sub-select on
   * purpose: «has this person bought» means services OWNED, not orders placed
   * — legacy index.php:4249, and the reason discount.ts:203 says so too. An
   * order that was never paid for has bought nothing.
   *
   * Here rather than in the listing queries for the reason the deny list above
   * gives, and with one consequence the panel screen has to state out loud:
   * plansOnPanel uses this predicate for the RENEWAL list, so a customer who
   * bought here once cannot renew here. That is what «only for people who have
   * never bought» means, and it is not a bug — but it is a sentence somebody
   * must read before ticking the box.
   */
  AND (
        (pr.config->>'newcomers_only') IS DISTINCT FROM 'true'
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
  /**
   * The badge of this service's ONE config, or null when it has several.
   *
   * `products` has no badge column and does not need one. A service holding a
   * single purchasable config IS that config — `handleCategory` collapses right
   * past the price screen for it and opens the plan directly — so this button
   * is that plan's button, and it wears that plan's badge. A service holding
   * three has three answers and therefore none: its badges appear one screen
   * down, on the buttons they belong to.
   *
   * Without this the tier screen was the one catalogue screen that drew neither
   * badge nor colour, and on a migrated shop it is the screen an operator
   * actually looks at: every legacy row imported as one service with one config
   * under it, so a badge typed on «محصولات» had no button to land on and the
   * panel said nothing about why.
   */
  badge: string | null;
  /** The same rule, for the colour. See `badge` above. */
  buttonStyle: ButtonStyle | null;
  /**
   * Which row of the tier screen this button sits on, or null for its own.
   *
   * `products.row_index`, added in 0037. Until then this was the one catalogue
   * keyboard that could not be arranged, so four tiers came out as four rows of
   * one while the screens either side of it put two buttons on a line.
   */
  rowIndex: number | null;
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
 *
 * `categoryId` narrows it to one category, and THAT is what the shop asks for:
 * a category screen lists the levels inside it. Both filters are optional and
 * independent — a call with neither is «everything this customer may buy»,
 * which is what `SHOP_EMPTY` is decided on.
 */
export async function productsForUser(
  db: Db,
  userId: number,
  providerId?: number,
  categoryId?: number,
): Promise<CatalogProduct[]> {
  const rows = await db
    .prepare(
      // No price and no plan count in the SELECT: this screen picks a LEVEL,
      // and a level does not have one price. The JOIN and the GROUP BY stay —
      // they are what keeps a service with nothing sellable inside it off the
      // list, which is a rule about visibility rather than about money.
      //
      // `cat.active` is joined for the same reason `plansInCategory` checks it:
      // `cat:<id>` is unsigned callback data, and a switched-off category must
      // not become reachable by posting its number.
      `SELECT p.id                AS product_id,
              p.name              AS name,
              pr.name             AS provider_name,
              p.row_index         AS row_index,
              -- The one config's badge and colour, and only when there is one.
              --
              -- COUNT(*) is the number of PURCHASABLE configs here, counted
              -- under the same predicate and the same joins as
              -- plansInProduct -- so this test is the very condition
              -- handleCategory collapses on, not an approximation of it. In
              -- that branch the group holds a single row, so MIN() is that
              -- row's value; with more than one it is NULL and the button
              -- draws exactly as it did before.
              CASE WHEN COUNT(*) = 1 THEN MIN(pl.badge) END        AS badge,
              CASE WHEN COUNT(*) = 1 THEN MIN(pl.button_style) END AS button_style
         FROM products p
         JOIN product_plans pl          ON pl.product_id = p.id
         JOIN provisioning_providers pr ON pr.id = p.provider_id
         JOIN product_categories cat    ON cat.id = p.category_id
         JOIN users u                   ON u.id = ?1
        WHERE (?2::bigint IS NULL OR pr.id = ?2)
          AND (?3::bigint IS NULL OR (p.category_id = ?3 AND cat.active))
          AND ${PURCHASABLE}
        GROUP BY p.id, p.name, p.sort_order, p.row_index, pr.name
        -- The product's own order, and nothing before it.
        --
        -- This used to lead with the panel's sort_order and id — correct when
        -- the query fed the old «pick a panel» screen, and wrong the moment the
        -- screen became arrangeable. catalog-layout writes sort_order in the
        -- order the operator dragged, and a panel ordering in front of it
        -- silently overrules that. Worse quietly: groupIntoRows joins
        -- CONSECUTIVE equal row_index, so a category spanning two panels would
        -- interleave them and split a row the operator had put together.
        -- Every other arrangeable screen here already leads with its own
        -- sort_order; this is that, not a new idea.
        --
        -- p.id is the tiebreak because every migrated row carries sort_order 0,
        -- and insertion order is at least the order somebody built them in.
        ORDER BY p.sort_order, p.id`,
    )
    .bind(userId, providerId ?? null, categoryId ?? null)
    .all<{
      product_id: number;
      name: string;
      provider_name: string;
      row_index: number | null;
      badge: string | null;
      button_style: ButtonStyle | null;
    }>();
  return rows.results.map((r) => ({
    productId: r.product_id,
    name: r.name,
    providerName: r.provider_name,
    badge: r.badge,
    buttonStyle: r.button_style,
    rowIndex: r.row_index,
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
  /**
   * The whole button's colour, or null for the client's own default. A badge
   * and a colour are two different things on one button: «🔥 آف» in red is
   * both, and either alone is a button an operator asked for.
   */
  buttonStyle: ButtonStyle | null;
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
              cat.button_style AS button_style, cat.row_index AS row_index
         FROM product_categories cat
         JOIN products p                ON p.category_id = cat.id
         JOIN product_plans pl          ON pl.product_id = p.id
         JOIN provisioning_providers pr ON pr.id = p.provider_id
         JOIN users u                   ON u.id = ?1
        WHERE cat.active AND ${PURCHASABLE}
        GROUP BY cat.id, cat.name, cat.badge, cat.button_style, cat.row_index, cat.sort_order
        ORDER BY cat.sort_order, cat.id`,
    )
    .bind(userId)
    .all<{
      category_id: number;
      name: string;
      badge: string | null;
      button_style: ButtonStyle | null;
      row_index: number | null;
    }>();
  return rows.results.map((r) => ({
    categoryId: r.category_id,
    name: r.name,
    badge: r.badge,
    buttonStyle: r.button_style,
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
  /** The whole button's colour. Same field as a category's, same three names. */
  buttonStyle: ButtonStyle | null;
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
   * How many plans sit in the same SERVICE, this one included.
   *
   * With `tiers` it decides where «بازگشت» goes, and the two of them mirror the
   * two «a list of one is not a choice» collapses exactly: a customer who was
   * never shown a screen must not be sent «back» to it.
   *
   *   siblings > 1  →  this service's price list   (`prd:`)
   *   tiers > 1     →  the category's tier list    (`cat:`)
   *   otherwise     →  the shop's first screen     (`buy`)
   *
   * It counted plans in the CATEGORY until 2026-08-27, which was right while a
   * category screen WAS the price list. It is not one any more.
   *
   * Both count ACTIVE rows rather than PURCHASABLE ones, and that is a
   * deliberate approximation: the exact number costs the whole predicate a
   * second time per row, and being wrong only ever sends «بازگشت» one screen
   * further out than it had to.
   */
  siblings: number;
  /** How many services in this category have something ACTIVE in them. */
  tiers: number;
}

interface PlanRow {
  plan_id: number;
  product_id: number;
  product_name: string;
  plan_name: string;
  badge: string | null;
  button_style: ButtonStyle | null;
  price_irr: number;
  duration_days: number | null;
  volume_gb: number | null;
  user_limit: number | null;
  provider_id: number;
  provider_name: string;
  category_id: number;
  row_index: number | null;
  siblings: number;
  tiers: number;
}

const PLAN_COLUMNS = `
  pl.id           AS plan_id,
  p.id            AS product_id,
  p.name          AS product_name,
  pl.name         AS plan_name,
  pl.badge        AS badge,
  pl.button_style AS button_style,
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
    WHERE sib.product_id = p.id AND sib.status = 'ACTIVE') AS siblings,
  (SELECT COUNT(DISTINCT sp.id)::int
     FROM products sp
     JOIN product_plans sib ON sib.product_id = sp.id
    WHERE sp.category_id = p.category_id
      AND sp.status = 'ACTIVE' AND sib.status = 'ACTIVE') AS tiers
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
    buttonStyle: row.button_style,
    priceIrr: row.price_irr,
    durationDays: row.duration_days,
    volumeGb: row.volume_gb,
    userLimit: row.user_limit,
    providerId: row.provider_id,
    providerName: row.provider_name,
    categoryId: row.category_id,
    rowIndex: row.row_index,
    siblings: row.siblings,
    tiers: row.tiers,
  };
}

/**
 * `plansInCategory` was here, and it is gone on purpose (2026-08-27).
 *
 * It returned every priced row in a category, flattened across the services
 * inside it, and `categoryScreen` drew that as the second screen of the shop.
 * Its own comment said what was wrong with it: sorting a whole category
 * «would interleave three services' sizes into one ladder, which is the shape
 * the service level was introduced to remove» — and then it interleaved them
 * anyway, because the level it described was never actually drawn.
 *
 * The shop now goes category → service (`productsForUser` with a categoryId)
 * → plans (`plansInProduct`). Nothing needs the flat list, and leaving it
 * exported would leave a second, subtly different definition of «what is in
 * this category» for the next screen to pick up by accident.
 */

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

/**
 * A panel that will hand this customer a free account, and what it hands out.
 *
 * Legacy asks the same question with
 * `SELECT * FROM marzban_panel WHERE TestAccount = 'ONTestAccount'`
 * (`keyboard.php:734`) and then filters the hidden ones out in PHP. Here the
 * hidden ones never arrive, because the same `NOT EXISTS` that keeps a hidden
 * panel out of the shop keeps it out of this list — a panel a customer may not
 * buy from is not one they may take a free account on either.
 *
 * The trial settings themselves are read in TypeScript rather than in SQL,
 * because `trialFor` is where the legacy fallbacks and the megabytes live and
 * a second reading of them in a WHERE clause is exactly the pair that drifts.
 * Five panels; the filter costs nothing.
 */
export interface TrialPanel {
  providerId: number;
  name: string;
  volumeGb: number;
  durationHours: number;
}

export async function trialPanelsForUser(db: Db, userId: number): Promise<TrialPanel[]> {
  const rows = await db
    .prepare(
      // A panel with no address or no credential cannot create an account, and
      // a trial that fails is worse than a button that was never drawn — the
      // customer has spent their one free account on nothing. Both spellings of
      // «has a credential» count, for the same reason panelRoutes counts both:
      // panels wired before provider_secrets resolve through the environment.
      `SELECT pr.id AS provider_id, pr.name AS name, pr.config AS config
         FROM provisioning_providers pr
         JOIN users u ON u.id = ?1
        WHERE pr.status = 'ACTIVE'
          AND pr.base_url IS NOT NULL
          AND (
                pr.secret_ref IS NOT NULL
             OR EXISTS (SELECT 1 FROM provider_secrets ps WHERE ps.provider_id = pr.id)
              )
          AND NOT EXISTS (
                SELECT 1 FROM provider_hidden_users h
                 WHERE h.provider_id = pr.id AND h.user_id = u.id
              )
        ORDER BY pr.sort_order, pr.id`,
    )
    .bind(userId)
    .all<{ provider_id: number; name: string; config: Record<string, unknown> | null }>();

  const out: TrialPanel[] = [];
  for (const row of rows.results ?? []) {
    const trial = trialFor(row.config ?? {});
    if (!trial.enabled) continue;
    out.push({
      providerId: row.provider_id,
      name: row.name,
      // `enabled` is only true when both are usable, which is what makes these
      // two assertions true rather than hopeful.
      volumeGb: trial.volumeGb!,
      durationHours: trial.durationHours!,
    });
  }
  return out;
}
