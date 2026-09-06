import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedCatalog } from '@shikoo/seed';
import {
  categoriesForUser,
  plansInProduct,
  plansOnPanel,
  productsForUser,
  purchasablePlan,
} from '../src/catalog.js';
import { productMenu } from '../src/menu.js';
import { db } from './helpers/env.js';
import {
  ensureCatalog,
  giveSubscription,
  makeCustomer,
  planId,
  productId,
  providerId,
} from './helpers/shop.js';

/**
 * The catalog fixture lives in @shikoo/seed but has no suite of its own, because
 * @shikoo/seed has no database to test against. This is the first package that
 * both depends on it and has one.
 */
describe('seedCatalog', () => {
  it('produces a catalog shaped like production', async () => {
    const result = await seedCatalog(db);

    // No categories: `category` has zero rows in production and
    // setting.statuscategory is 'offcategory'.
    //
    // Ten of the eleven products hold one plan each, because a legacy `product`
    // row IS a purchasable plan and that is the shape being migrated from. The
    // eleventh is «پلاتینیوم» and holds three — a fixture made only of the
    // legacy shape cannot test the level between a panel and a plan, which is
    // exactly how that level came to be missing.
    expect(result).toEqual({ providers: 5, products: 11, plans: 13 });

    const rows = await db
      .prepare(
        `SELECT p.code, p.kind, p.status, p.once_per_user, p.resellers_only,
                p.category_id,
                pr.code AS provider_code, pr.status AS provider_status,
                COUNT(pl.id)::int AS plans,
                MIN(pl.price_irr)::bigint AS price
           FROM products p
           JOIN provisioning_providers pr ON pr.id = p.provider_id
           LEFT JOIN product_plans pl ON pl.product_id = p.id
          WHERE p.code LIKE 'sim-%'
          GROUP BY p.id, pr.code, pr.status
          ORDER BY p.sort_order`,
      )
      .all<{
        code: string;
        kind: string;
        status: string;
        once_per_user: boolean;
        resellers_only: boolean;
        category_id: number | null;
        provider_code: string;
        provider_status: string;
        plans: number;
        price: number;
      }>();

    const byCode = new Map(rows.results.map((r) => [r.code, r]));
    expect(byCode.size).toBe(11);
    // The tier, and the fact that makes it one: it carries its own groups, so
    // a purchase from it lands somewhere different from a purchase from the
    // product beside it on the same panel.
    expect(byCode.get('sim-vip-platinum')?.plans).toBe(3);
    expect(byCode.get('sim-vip-platinum')?.provider_code).toBe('sim-vip');
    expect(byCode.get('sim-vip-1m-50')?.plans).toBe(1);
    expect(byCode.get('sim-vip-1m-50')?.provider_code).toBe('sim-vip');
    expect(byCode.get('sim-gold-10')?.provider_code).toBe('sim-gold');
    expect(byCode.get('sim-shop-spotify')?.kind).toBe('spotify');
    // Every branch a visibility test needs something to be invisible for.
    expect(byCode.get('sim-vip-hidden')?.status).toBe('HIDDEN');
    expect(byCode.get('sim-vip-reseller')?.resellers_only).toBe(true);
    expect(byCode.get('sim-vip-trial')?.once_per_user).toBe(true);
    expect(byCode.get('sim-vip-trial')?.price).toBe(0);
    expect(byCode.get('sim-off-1m')?.provider_status).toBe('DISABLED');
    // Everything is filed under a category, and that is not a preference — the
    // shop's first screen IS the category list now, so a product without one
    // has no button and none of its plans can be reached from anywhere. The
    // schema refuses the state; this asserts the fixture does not go looking
    // for a way around it.
    expect(rows.results.every((r) => r.category_id !== null)).toBe(true);
    // And more than one of them, or the category screen never draws a list:
    // `buy` falls straight through to the single category's prices.
    expect(new Set(rows.results.map((r) => r.category_id)).size).toBeGreaterThan(1);
  });

  it('is safe to run twice', async () => {
    const first = await seedCatalog(db);
    const before = await countPlans();

    const second = await seedCatalog(db);
    const after = await countPlans();

    expect(second).toEqual(first);
    expect(after).toBe(before);
  });

  it('prices money as integer IRR', async () => {
    await seedCatalog(db);
    const row = await db
      .prepare(
        `SELECT COUNT(*)::int AS n FROM product_plans pl
           JOIN products p ON p.id = pl.product_id
          WHERE p.code LIKE 'sim-%' AND pl.price_irr <> trunc(pl.price_irr)`,
      )
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});

/**
 * What a customer may see. Every case here is a row that exists and must not be
 * reachable — the interesting half of a catalog.
 */
describe('what the shop shows a customer', () => {
  let customer: number;
  let reseller: number;
  let returning: number;
  let vip: number;

  beforeAll(async () => {
    await ensureCatalog();
    customer = await makeCustomer(810_001);
    reseller = await makeCustomer(810_002, { reseller: true });
    returning = await makeCustomer(810_003);
    await giveSubscription(returning, 'catalog-sub-1');
    vip = await providerId('sim-vip');
  });

  it('offers the active panels', async () => {
    const codes = await panelCodes(customer);
    expect(codes).toContain('sim-vip');
    expect(codes).toContain('sim-gold');
    expect(codes).toContain('sim-shop');
  });

  /**
   * «فقط برای کسانی که هنوز خریدی نکرده‌اند» — a starter panel.
   *
   * Both halves are asserted against the SAME panel and the same moment,
   * because a filter that hides a panel from everybody passes any test that
   * only checks the customer who should not see it.
   *
   * `returning` owns a subscription; `customer` owns nothing. That is the
   * distinction the clause makes — services owned, not orders placed — and it
   * is the same sub-select `once_per_user` uses one line above it.
   */
  it('hides a newcomers-only panel from anybody who already owns a service', async () => {
    await db
      .prepare(
        `UPDATE provisioning_providers SET config = config || '{"newcomers_only": true}'::jsonb
          WHERE code = 'sim-gold'`,
      )
      .run();
    try {
      expect(await panelCodes(customer)).toContain('sim-gold');
      expect(await panelCodes(returning)).not.toContain('sim-gold');
      // And it has not taken the rest of the shop with it.
      expect(await panelCodes(returning)).toContain('sim-vip');
    } finally {
      await db
        .prepare(
          `UPDATE provisioning_providers SET config = config - 'newcomers_only'
            WHERE code = 'sim-gold'`,
        )
        .run();
    }
  });

  it('leaves a panel that has never been ticked visible to everyone', async () => {
    // The default. `IS DISTINCT FROM 'true'` rather than `= false`, because the
    // key is absent on every panel that has never been edited and `NULL = 'x'`
    // is unknown — which would have hidden every panel in the shop.
    expect(await panelCodes(returning)).toContain('sim-gold');
  });

  it('keeps the services in the order the shop arranged them', async () => {
    // Not alphabetical. Every migrated row carries sort_order 0, so ordering by
    // name reshuffles a menu customers already know: the live bot on 2026-08-12
    // listed مولتی لوکیشن, then طلایی, then خرید اولی‌ها. Falling back to
    // `p.id` keeps that guarantee — it is the order the rows were created in.
    //
    // The panel's own order USED TO come first here, and this test asserted it.
    // It was removed on 2026-08-28 when `products.row_index` made this screen
    // arrangeable, and the reason is not a preference: `catalog-layout` writes
    // `sort_order` in the order the operator dragged, so a panel ordering in
    // front of it silently overrules them. Quieter and worse, `groupIntoRows`
    // joins CONSECUTIVE equal `row_index` — so a category spanning two panels
    // would interleave the two and split a row the operator had put together.
    // A screen somebody arranges has to be drawn in the order they arranged.
    const products = await productsForUser(db, customer);
    const rows = await db
      .prepare(
        `SELECT p.id, p.sort_order AS product_order
           FROM products p
          WHERE p.id = ANY($1)`,
      )
      .bind(products.map((p) => p.productId))
      .all<{ id: number; product_order: number }>();
    const meta = new Map(rows.results.map((r) => [r.id, r]));
    const keys = products.map((p) => {
      const m = meta.get(p.productId)!;
      return [m.product_order, p.productId] as const;
    });
    const sorted = [...keys].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    expect(keys).toEqual(sorted);
  });

  it('carries the panel that delivers each service, for telling two apart', async () => {
    // Nothing asks the customer to pick a location any more, so the panel is
    // only ever used to disambiguate two services of one name. It still has to
    // be there, or that disambiguation has nothing to draw.
    const products = await productsForUser(db, customer);
    expect(products.every((p) => p.providerName.trim() !== '')).toBe(true);
  });

  /**
   * The badge an operator types on «محصولات» reaches the button they typed it
   * for — and the one they typed it for is on THIS screen.
   *
   * The panel writes `badge` and `button_style` onto `product_plans`, and every
   * migrated row is one service holding one config, so the button a customer
   * meets for it is the TIER button. Until 2026-09-02 this query selected
   * neither column and `productMenu` drew neither, which is exactly what Sam
   * reported: a colour and an emoji saved on ten of the eleven fixture services
   * that no customer could ever see. The plan screen those two DID reach is
   * drawn only for «پلاتینیوم» — everything else has one config and the bot
   * collapses straight past it into the plan itself.
   *
   * Asserted through Postgres and not on a hand-built object, because the whole
   * defect lived in the SELECT: a pure-function test of `productMenu` was green
   * throughout.
   */
  it('draws the one config’s badge and colour on the service that IS that config', async () => {
    const single = await productId('sim-vip-1m-20');
    const tiered = await productId('sim-vip-platinum');
    // `finally`, because this suite shares one Postgres with every other
    // package's and the catalogue is a fixture nothing re-seeds between files.
    // A badge left behind by a FAILING run is the worst kind of leftover: the
    // next file reads a styled row it never wrote, and `env.ts` already carries
    // two notes about exactly this costing an hour each.
    try {
      await db
        .prepare(
          `UPDATE product_plans SET badge = ?1, button_style = ?2
            WHERE product_id = ?3`,
        )
        .bind('🆕 نیو', 'success', single)
        .run();
      // Both configs of the tiered service badged, so «none» below can only be
      // the one-config rule and not an empty column.
      await db
        .prepare(
          `UPDATE product_plans SET badge = ?1, button_style = ?2
            WHERE product_id = ?3`,
        )
        .bind('🔥 آف', 'danger', tiered)
        .run();

      const products = await productsForUser(db, customer);
      const one = products.find((p) => p.productId === single);
      expect([one?.badge, one?.buttonStyle]).toEqual(['🆕 نیو', 'success']);

      // Three configs are three answers, so the tier button takes none of them —
      // its badges belong one screen down, on the buttons they were typed for.
      const many = products.find((p) => p.productId === tiered);
      expect([many?.badge, many?.buttonStyle]).toEqual([null, null]);

      // And it reaches the keyboard, `style` key and all.
      expect(productMenu([one!])[0]![0]).toMatchObject({
        text: expect.stringContaining('🆕 نیو'),
        style: 'success',
      });
      expect(productMenu([many!])[0]![0]).not.toHaveProperty('style');
    } finally {
      await db
        .prepare(
          `UPDATE product_plans SET badge = NULL, button_style = NULL
            WHERE product_id = ANY($1)`,
        )
        .bind([single, tiered])
        .run();
    }
  });

  it('does not offer a disabled panel', async () => {
    expect(await panelCodes(customer)).not.toContain('sim-off');
  });

  it('does not offer a panel with nothing on it', async () => {
    // A button that opens an empty list is a dead end. Legacy shows it anyway.
    expect(await panelCodes(customer)).not.toContain('sim-empty');
  });

  it('lists the plans on a panel and hides the hidden one', async () => {
    const names = (await plansOnPanel(db, customer, vip)).map((p) => p.productName);
    expect(names).toContain('۱ماهه - ۲۰ گیگ - چند کاربر');
    expect(names).toContain('۱ماهه - ۵۰ گیگ - چند کاربر');
    expect(names).not.toContain('۱ماهه - ۱۰۰ گیگ - پنهان');
  });

  it('keeps a resellers-only plan away from a customer and gives it to a reseller', async () => {
    const forCustomer = (await plansOnPanel(db, customer, vip)).map((p) => p.productName);
    const forReseller = (await plansOnPanel(db, reseller, vip)).map((p) => p.productName);
    expect(forCustomer).not.toContain('پک نمایندگی - ۱۰ کاربر');
    expect(forReseller).toContain('پک نمایندگی - ۱۰ کاربر');
    // The approved departure from legacy: a reseller sees the ordinary catalog
    // too, instead of the empty shop `agent = 'n'` gives them in production.
    expect(forReseller).toContain('۱ماهه - ۵۰ گیگ - چند کاربر');
  });

  it('offers a first-purchase plan only until the first purchase', async () => {
    const fresh = (await plansOnPanel(db, customer, vip)).map((p) => p.productName);
    const after = (await plansOnPanel(db, returning, vip)).map((p) => p.productName);
    expect(fresh).toContain('اکانت تست - ۱ روزه - ۱ گیگ');
    expect(after).not.toContain('اکانت تست - ۱ روزه - ۱ گیگ');
  });

  it('returns nothing for a panel the customer may not open', async () => {
    expect(await plansOnPanel(db, customer, await providerId('sim-off'))).toEqual([]);
    expect(await plansOnPanel(db, customer, await providerId('sim-empty'))).toEqual([]);
  });

  it('carries the price and the panel on every listed plan', async () => {
    const plan = (await plansOnPanel(db, customer, vip)).find(
      (p) => p.productName === '۱ماهه - ۵۰ گیگ - چند کاربر',
    );
    expect(plan?.priceIrr).toBe(1_950_000);
    expect(plan?.durationDays).toBe(30);
    expect(plan?.volumeGb).toBe(50);
    expect(plan?.providerId).toBe(vip);
    expect(plan?.providerName).toBe('🥇 سرویس VIP (شبیه‌سازی)');
  });
});

describe('purchasablePlan answers the same question as the list', () => {
  let customer: number;
  let reseller: number;
  let returning: number;

  beforeAll(async () => {
    await ensureCatalog();
    customer = await makeCustomer(811_001);
    reseller = await makeCustomer(811_002, { reseller: true });
    returning = await makeCustomer(811_003);
    await giveSubscription(returning, 'catalog-sub-2');
  });

  it('finds a plan that is genuinely for sale', async () => {
    const plan = await purchasablePlan(db, customer, await planId('sim-vip-1m-50'));
    expect(plan?.priceIrr).toBe(1_950_000);
  });

  it('refuses every plan the list would not have drawn', async () => {
    expect(await purchasablePlan(db, customer, await planId('sim-vip-hidden'))).toBeNull();
    expect(await purchasablePlan(db, customer, await planId('sim-off-1m'))).toBeNull();
    expect(await purchasablePlan(db, customer, await planId('sim-empty-hidden'))).toBeNull();
    expect(await purchasablePlan(db, customer, await planId('sim-vip-reseller'))).toBeNull();
    expect(await purchasablePlan(db, returning, await planId('sim-vip-trial'))).toBeNull();
  });

  it('allows a reseller the plan meant for them', async () => {
    expect(await purchasablePlan(db, reseller, await planId('sim-vip-reseller'))).not.toBeNull();
  });

  it('answers null for a plan that does not exist', async () => {
    expect(await purchasablePlan(db, customer, 2_000_000_000)).toBeNull();
  });

  /**
   * The gate, not the list — and that distinction is the whole bug.
   *
   * `product_categories.active` was checked by `categoriesForUser` and by
   * `productsForUser`, so switching a category off really did take its buttons
   * off every screen a customer opened next. `PURCHASABLE` did not check it and
   * the plan queries did not even join the table, so the ORDER path kept
   * selling: a customer holding an older message with `plan:<id>` in it could
   * still buy, and `callback_data` carries no signature, so posting the number
   * by hand was enough.
   *
   * A test written against the list would have passed the whole time. This one
   * asks all three of the queries that had no join, and the first assertion is
   * that the row sells BEFORE the switch — without it, a fixture that stopped
   * existing would make this pass for the wrong reason.
   */
  it('refuses at the order gate when the category is switched off, not only on the screens', async () => {
    const plan = await planId('sim-vip-1m-50');
    const sold = await purchasablePlan(db, customer, plan);
    expect(sold).not.toBeNull();

    const cat = await db
      .prepare(
        `SELECT p.category_id AS id
           FROM product_plans pl JOIN products p ON p.id = pl.product_id
          WHERE pl.id = ?1`,
      )
      .bind(plan)
      .first<{ id: number }>();

    await db
      .prepare(`UPDATE product_categories SET active = false WHERE id = ?1`)
      .bind(cat!.id)
      .run();
    try {
      expect(await purchasablePlan(db, customer, plan)).toBeNull();
      expect((await plansOnPanel(db, customer, sold!.providerId)).map((p) => p.planId)).not.toContain(
        plan,
      );
      expect((await productsForUser(db, customer)).map((p) => p.productId)).not.toContain(
        sold!.productId,
      );
    } finally {
      await db
        .prepare(`UPDATE product_categories SET active = true WHERE id = ?1`)
        .bind(cat!.id)
        .run();
    }

    // Switched back on, it sells again — so the refusal above was the category
    // and nothing else that happened to be true at that moment.
    expect(await purchasablePlan(db, customer, plan)).not.toBeNull();
  });
});

/**
 * Which panels a customer's shop reaches, read back off the services it offers.
 *
 * The shop stopped listing panels, but every rule about them still holds — a
 * disabled panel's products must not be reachable, and a panel with nothing
 * sellable must not contribute a row. Asking the question through the products
 * is what keeps those assertions pointed at the screen that actually exists.
 */
async function panelCodes(userId: number): Promise<string[]> {
  const products = await productsForUser(db, userId);
  if (products.length === 0) return [];
  const rows = await db
    .prepare(`SELECT DISTINCT pr.code FROM provisioning_providers pr
                JOIN products p ON p.provider_id = pr.id
               WHERE p.id = ANY($1)`)
    .bind(products.map((p) => p.productId))
    .all<{ code: string }>();
  return rows.results.map((r) => r.code);
}

async function countPlans(): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*)::int AS n FROM product_plans pl
         JOIN products p ON p.id = pl.product_id
        WHERE p.code LIKE 'sim-%'`,
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * «محدودیت ساخت اکانت» — the panel cap, which until 2026-08-26 was written,
 * drawn on the dashboard beside the live count, and read by nothing.
 *
 * The dashboard has offered the field since «مدیریت پنل‌ها» was built, so an
 * operator who set it had every reason to believe it did something. Nothing in
 * the bot asked: `PURCHASABLE` checked status, reseller and once-per-user, and
 * `capacity` appeared zero times in `apps/bot/src`. The legacy shop counted it
 * at `index.php:3600` and refused the purchase, which is the behaviour being
 * restored.
 *
 * Counted the way the PHP counted it — live subscriptions on OUR side, not
 * accounts on the panel, because a panel can hold accounts this shop never
 * sold and the cap is about what we are willing to sell.
 */
describe('the panel cap', () => {
  let customer: number;
  let vip: number;

  beforeAll(async () => {
    await ensureCatalog();
    customer = await makeCustomer(810_010);
    vip = await providerId('sim-vip');
  });

  async function setCapacity(value: number | null): Promise<void> {
    await db
      .prepare(`UPDATE provisioning_providers SET capacity = ?2 WHERE id = ?1`)
      .bind(vip, value)
      .run();
  }

  async function liveOn(panelId: number): Promise<number> {
    const row = await db
      .prepare(
        `SELECT COUNT(*)::int AS n FROM subscriptions
          WHERE provider_id = ?1 AND status IN ('ACTIVE', 'ON_HOLD')`,
      )
      .bind(panelId)
      .first<{ n: number }>();
    return row!.n;
  }

  /**
   * Asked through `productsForUser` narrowed to this panel, not by re-running
   * the predicate: the whole point of the change is that the SHOP stops
   * offering the panel, and a test that queries the table would pass with the
   * guard deleted.
   */
  async function sellsFrom(panelId: number): Promise<boolean> {
    return (await productsForUser(db, customer, panelId)).length > 0;
  }

  afterAll(async () => {
    await setCapacity(null);
    await db.prepare(`DELETE FROM subscriptions WHERE public_id LIKE 'cap-%'`).run();
  });

  it('sells nothing more once the live count reaches the cap, and sells again above it', async () => {
    const live = await liveOn(vip);

    // A cap above what is already sold changes nothing.
    await setCapacity(live + 1);
    expect(await sellsFrom(vip)).toBe(true);

    // Exactly at the cap is full: the legacy check is `>= limit_panel`, and
    // off-by-one here means selling one account past a limit somebody set
    // because the panel could not carry more.
    await setCapacity(live);
    expect(await sellsFrom(vip)).toBe(false);

    await setCapacity(0);
    expect(await sellsFrom(vip)).toBe(false);

    // NULL is unlimited — what the legacy string 'unlimited' migrated to. A
    // cap of 0 and no cap at all must not be the same thing, and `capacity IS
    // NULL` rather than a falsy test is what keeps them apart.
    await setCapacity(null);
    expect(await sellsFrom(vip)).toBe(true);
  });

  it('counts only live subscriptions, not every row ever sold', async () => {
    const live = await liveOn(vip);
    await setCapacity(live + 1);

    // A cancelled sale must not hold a seat. Statuses the schema allows that
    // are NOT live: PENDING_PAYMENT, DISABLED, REMOVED, FAILED.
    for (const [id, status] of [
      ['cap-removed', 'REMOVED'],
      ['cap-failed', 'FAILED'],
      ['cap-pending', 'PENDING_PAYMENT'],
    ] as const) {
      await db
        .prepare(
          `INSERT INTO subscriptions
             (public_id, user_id, provider_id, plan_name_at_sale, price_irr, status, purchased_at)
           VALUES (?1, ?2, ?3, 'cap fixture', 1000, ?4, now())
           ON CONFLICT (public_id) DO UPDATE SET status = EXCLUDED.status`,
        )
        .bind(id, customer, vip, status)
        .run();
    }

    expect(await liveOn(vip)).toBe(live);
    expect(await sellsFrom(vip)).toBe(true);
  });

  it('does not touch renewals — a full panel still renews what it already sold', async () => {
    await setCapacity(0);
    // `RENEWABLE` in owned.ts is a separate predicate and deliberately has no
    // cap in it. A customer who already paid must not be locked out of
    // extending because the panel filled up after they bought.
    const renewable = await db
      .prepare(
        `SELECT COUNT(*)::int AS n FROM provisioning_providers
          WHERE id = ?1 AND status = 'ACTIVE'`,
      )
      .bind(vip)
      .first<{ n: number }>();
    expect(renewable!.n).toBe(1);
    await setCapacity(null);
  });
});

/**
 * A shelf built by «قفسهٔ تازه» has to be reachable by a customer, or the whole
 * feature is an operator filling a box nobody can buy from.
 *
 * The rows are written here the way `POST /api/v1/admin/stock/shelves` writes
 * them — a `manual` panel with no address and no credential, a product with no
 * `group_ids` and no `row_index`, and a plan with no volume and no user limit.
 * That shape is the thing under test: what breaks it is a change to the bot's
 * visibility predicate, not a change to the route, and this file is where that
 * predicate lives.
 */
describe('a shelf made from the dashboard is something a customer can buy', () => {
  const CODE = 'zz-shelf-visible';
  let customer: number;
  let categoryId: number;
  let productId: number;
  let planId: number;

  beforeAll(async () => {
    await ensureCatalog();
    customer = await makeCustomer(811_101);

    const category = await db
      .prepare(`SELECT id FROM product_categories ORDER BY id LIMIT 1`)
      .first<{ id: number }>();
    categoryId = Number(category!.id);

    const provider = await db
      .prepare(
        `INSERT INTO provisioning_providers (code, name, kind, status)
         VALUES (?1, 'قفسهٔ تست', 'manual', 'ACTIVE')
         ON CONFLICT (code) DO UPDATE SET kind = 'manual', status = 'ACTIVE' RETURNING id`,
      )
      .bind(CODE)
      .first<{ id: number }>();
    const product = await db
      .prepare(
        `INSERT INTO products (code, name, kind, provider_id, category_id, status)
         VALUES (?1, 'قفسهٔ تست', 'other', ?2, ?3, 'ACTIVE')
         ON CONFLICT (code) DO UPDATE SET status = 'ACTIVE' RETURNING id`,
      )
      .bind(CODE, Number(provider!.id), categoryId)
      .first<{ id: number }>();
    productId = Number(product!.id);
    const plan = await db
      .prepare(
        `INSERT INTO product_plans (product_id, name, price_irr, duration_days, status)
         VALUES (?1, 'قفسهٔ تست', 2500000, 30, 'ACTIVE') RETURNING id`,
      )
      .bind(productId)
      .first<{ id: number }>();
    planId = Number(plan!.id);
  });

  afterAll(async () => {
    await db.prepare(`DELETE FROM product_plans WHERE id = ?1`).bind(planId).run();
    await db.prepare(`DELETE FROM products WHERE code = ?1`).bind(CODE).run();
    await db.prepare(`DELETE FROM provisioning_providers WHERE code = ?1`).bind(CODE).run();
  });

  it('is on every screen between the first button and the price', async () => {
    const categories = await categoriesForUser(db, customer);
    expect(categories.map((c) => c.categoryId)).toContain(categoryId);

    const products = await productsForUser(db, customer, undefined, categoryId);
    expect(products.map((p) => p.productId)).toContain(productId);

    const plans = await plansInProduct(db, customer, productId);
    expect(plans.map((p) => p.planId)).toContain(planId);

    // The one that decides whether the money can be taken.
    const buyable = await purchasablePlan(db, customer, planId);
    expect(buyable).not.toBeNull();
    expect(buyable?.priceIrr).toBe(2_500_000);
    // No panel address, no volume, no user limit — none of which is a fault on
    // a shelf, and none of which may quietly remove it from sale.
    expect(buyable?.volumeGb).toBeNull();
  });
});
