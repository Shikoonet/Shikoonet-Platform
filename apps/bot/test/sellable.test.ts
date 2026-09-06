/**
 * `whyNotSellable` against the only thing that can contradict it: the bot.
 *
 * WHY THIS FILE IS THE POINT OF THAT MODULE. `packages/contracts/src/sellable.ts`
 * restates in TypeScript a predicate that lives in SQL — `PURCHASABLE` in
 * `apps/bot/src/catalog.ts`. Two definitions of one rule drift, quietly, and the
 * drift is invisible precisely where it matters: the dashboard keeps saying «در
 * فروشگاه» about a row the shop stopped offering. That is the failure this whole
 * change exists to fix, so shipping a second unchecked opinion of it would be
 * the same bug wearing the fix's clothes.
 *
 * So nothing here asserts what `whyNotSellable` returns against a hand-written
 * expectation. Every case seeds a real row in a real database, asks
 * `whyNotSellable` whether a customer could buy it, then drives a real «خرید
 * اشتراک» through `handleUpdate` and reads the keyboard the customer was sent.
 * The assertion is that the two agree — and the fixture is arranged so that the
 * bot's answer would change if either side moved.
 *
 * The one condition NOT covered here is `resellers_only` / `once_per_user`.
 * `whyNotSellable` deliberately does not answer for those: they depend on who is
 * asking, and an admin screen has no customer in hand. `buy.test.ts` already
 * covers them from the bot's side.
 */

import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { whyNotSellable, isSellable, type SellableFacts } from '@shikoo/contracts';
import { assertSchema, db } from './helpers/env.js';
import { handleUpdate } from '../src/handle.js';

const PREFIX = 'zz-sellable-';

let nextId = 0;
function ids(): { updateId: number; telegramId: number } {
  const n = ++nextId * 10;
  return { updateId: 851_000 + n, telegramId: 851_000 + n };
}

/**
 * A whole shop of one: one panel, one service, one config, one category.
 *
 * Its own everything, because the assertion below is «this is the only thing on
 * offer» and a fixture sharing a category with another test's row cannot make
 * that claim.
 */
interface Shop {
  categoryId: number;
  providerId: number;
  productId: number;
  planId: number;
  panelName: string;
}

async function makeShop(
  label: string,
  opts: {
    panelStatus?: string;
    productStatus?: string;
    planStatus?: string;
    capacity?: number | null;
    liveSubscriptions?: number;
    withPanel?: boolean;
    categoryActive?: boolean;
  } = {},
): Promise<Shop> {
  const withPanel = opts.withPanel ?? true;
  const panelName = `پنل ${label}`;

  let providerId = 0;
  if (withPanel) {
    const provider = await db
      .prepare(
        `INSERT INTO provisioning_providers (code, name, kind, status, capacity)
         VALUES (?1, ?2, 'marzban', ?3, ?4) RETURNING id`,
      )
      .bind(`${PREFIX}${label}`, panelName, opts.panelStatus ?? 'ACTIVE', opts.capacity ?? null)
      .first<{ id: number }>();
    providerId = Number(provider!.id);

    // The ceiling is spent by LIVE subscriptions, and only ACTIVE and ON_HOLD
    // count — the same two `PURCHASABLE` counts and `SELECT_PANEL` counts.
    if ((opts.liveSubscriptions ?? 0) > 0) {
      const owner = await db
        .prepare(
          `INSERT INTO users (telegram_id, username, registered_at) VALUES (?1, ?2, now())
           ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username RETURNING id`,
        )
        .bind(852_000 + providerId, `sl851-owner-${label}`)
        .first<{ id: number }>();
      for (let n = 0; n < (opts.liveSubscriptions ?? 0); n += 1) {
        await db
          .prepare(
            `INSERT INTO subscriptions (public_id, user_id, provider_id, plan_name_at_sale,
                                        price_irr, status, purchased_at)
             VALUES (?1, ?2, ?3, 'ceiling fixture', 1000, 'ACTIVE', now())`,
          )
          .bind(`${PREFIX}${label}-${n}`, owner!.id, providerId)
          .run();
      }
    }
  }

  const category = await db
    .prepare(
      `INSERT INTO product_categories (name, sort_order, active) VALUES (?1, 0, ?2) RETURNING id`,
    )
    .bind(`${PREFIX}${label}`, opts.categoryActive ?? true)
    .first<{ id: number }>();
  const categoryId = Number(category!.id);

  const product = await db
    .prepare(
      `INSERT INTO products (code, name, kind, provider_id, category_id, status)
       VALUES (?1, ?2, 'vpn', ?3, ?4, ?5) RETURNING id`,
    )
    .bind(
      `${PREFIX}${label}`,
      `سرویس ${label}`,
      withPanel ? providerId : null,
      categoryId,
      opts.productStatus ?? 'ACTIVE',
    )
    .first<{ id: number }>();
  const productId = Number(product!.id);

  const plan = await db
    .prepare(
      `INSERT INTO product_plans (product_id, name, price_irr, duration_days, volume_gb, status)
       VALUES (?1, ?2, 500000, 30, 10, ?3) RETURNING id`,
    )
    .bind(productId, `کانفیگ ${label}`, opts.planStatus ?? 'ACTIVE')
    .first<{ id: number }>();

  return { categoryId, providerId, productId, planId: Number(plan!.id), panelName };
}

/** The facts as a dashboard row carries them, read back out of Postgres. */
async function factsOf(shop: Shop): Promise<SellableFacts> {
  const row = await db
    .prepare(
      `SELECT pl.status AS plan_status, p.status AS product_status,
              cat.name AS category_name, cat.active AS category_active,
              pr.name AS panel_name, pr.status AS panel_status, pr.capacity,
              (SELECT COUNT(*)::int FROM subscriptions s
                WHERE s.provider_id = pr.id AND s.status IN ('ACTIVE','ON_HOLD')) AS live
         FROM product_plans pl
         JOIN products p ON p.id = pl.product_id
         LEFT JOIN product_categories cat ON cat.id = p.category_id
         LEFT JOIN provisioning_providers pr ON pr.id = p.provider_id
        WHERE pl.id = ?1`,
    )
    .bind(shop.planId)
    .first<{
      plan_status: string;
      product_status: string;
      category_name: string | null;
      category_active: boolean | null;
      panel_name: string | null;
      panel_status: string | null;
      capacity: number | null;
      live: number | null;
    }>();
  return {
    planStatus: row!.plan_status,
    productStatus: row!.product_status,
    category:
      row!.category_active === null
        ? null
        : { name: row!.category_name!, active: row!.category_active },
    panel:
      row!.panel_status === null
        ? null
        : {
            name: row!.panel_name!,
            status: row!.panel_status,
            capacity: row!.capacity === null ? null : Number(row!.capacity),
            liveSubscriptions: Number(row!.live ?? 0),
          },
  };
}

/** Does this customer's shop offer this exact category? */
async function botOffers(categoryId: number): Promise<boolean> {
  const { updateId, telegramId } = ids();
  await handleUpdate(db, {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: telegramId, username: `sl${telegramId}` },
      chat: { id: telegramId },
      text: '/start',
    },
  });
  const shown = await handleUpdate(db, {
    update_id: updateId + 1,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `sl${telegramId}` },
      message: { message_id: updateId, chat: { id: telegramId } },
      data: `cat:${categoryId}`,
    },
  });
  // `plansInCategory` re-applies `PURCHASABLE`, so an unsellable category
  // answers with a screen carrying nothing to buy. Asking through `cat:` rather
  // than `buy` keeps this test about ONE category — `buy` shows every category
  // in the database, including the other cases in this file.
  //
  // TWO callbacks count as an offer, and the second one is not padding: a
  // category holding exactly one purchasable config is collapsed straight to
  // that config's own page (`handle.ts:1094`, «a list of one is not a choice»),
  // which carries `order:` instead of `plan:`. Every fixture here is a shop of
  // one, so looking only for `plan:` would call a perfectly sellable row
  // unsellable — which cost a red run to find.
  const keyboard = shown.replies[0]?.keyboard ?? [];
  return keyboard
    .flat()
    .some((b) => /^(plan|order):/.test(b.callback_data ?? ''));
}

/**
 * What happens when a customer presses a `plan:` button they already have.
 *
 * `botOffers` above asks the LIST, and a list that hides a row is not the same
 * guarantee as a gate that refuses one. Every message this bot has ever sent
 * stays in the customer's chat, so «switched the category off» has to mean the
 * button in a month-old message stops working too — otherwise the operator
 * turned off a shelf and kept selling from it, which is the whole bug.
 *
 * Returns whether the bot answered with something to buy. `purchasablePlan`
 * re-applies `PURCHASABLE`, so a refusal draws no order screen at all.
 */
async function botSellsPlanDirectly(planId: number): Promise<boolean> {
  const { updateId, telegramId } = ids();
  await handleUpdate(db, {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: telegramId, username: `sl${telegramId}` },
      chat: { id: telegramId },
      text: '/start',
    },
  });
  const shown = await handleUpdate(db, {
    update_id: updateId + 1,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `sl${telegramId}` },
      message: { message_id: updateId, chat: { id: telegramId } },
      data: `plan:${planId}`,
    },
  });
  return (shown.replies[0]?.keyboard ?? [])
    .flat()
    .some((b) => /^order:/.test(b.callback_data ?? ''));
}

/**
 * The whole assertion, in one place: what the dashboard would say, and what the
 * customer actually got.
 */
async function agree(shop: Shop): Promise<{ dashboard: boolean; bot: boolean }> {
  return { dashboard: isSellable(await factsOf(shop)), bot: await botOffers(shop.categoryId) };
}

async function purge(): Promise<void> {
  await db
    .prepare(
      `DELETE FROM product_plans WHERE product_id IN (SELECT id FROM products WHERE code LIKE ?1)`,
    )
    .bind(`${PREFIX}%`)
    .run();
  await db.prepare(`DELETE FROM products WHERE code LIKE ?1`).bind(`${PREFIX}%`).run();
  await db.prepare(`DELETE FROM product_categories WHERE name LIKE ?1`).bind(`${PREFIX}%`).run();
  await db.prepare(`DELETE FROM subscriptions WHERE public_id LIKE ?1`).bind(`${PREFIX}%`).run();
  await db.prepare(`DELETE FROM provisioning_providers WHERE code LIKE ?1`).bind(`${PREFIX}%`).run();
  await db.prepare(`DELETE FROM users WHERE username LIKE 'sl851%'`).run();
}

beforeAll(assertSchema);
beforeEach(purge);
afterAll(purge);

describe('what the dashboard says is on sale, and what the bot sells', () => {
  it('agrees that a healthy row is on sale — so the refusals below mean something', async () => {
    const shop = await makeShop('ok');
    expect(await agree(shop)).toEqual({ dashboard: true, bot: true });
    expect(whyNotSellable(await factsOf(shop))).toEqual([]);
  });

  it('agrees a switched-off category takes everything under it off sale', async () => {
    // The gap this case closes was the other way round from the panel one: the
    // BOT was the screen that lied. `PURCHASABLE` did not read `cat.active`, so
    // the order gate kept selling a category the operator had switched off —
    // and `whyNotSellable`, which is supposed to restate `PURCHASABLE`, had no
    // opinion about categories at all. Both sides moved for this test.
    const shop = await makeShop('cat-off', { categoryActive: false });
    expect(await agree(shop)).toEqual({ dashboard: false, bot: false });
    expect(whyNotSellable(await factsOf(shop))).toEqual([
      { kind: 'CATEGORY_OFF', category: `${PREFIX}cat-off` },
    ]);
  });

  it('refuses the button a customer is already holding, not just the list', async () => {
    /**
     * The path the list test cannot reach. `cat:` proves the shelf is hidden;
     * this presses `plan:<id>` the way a customer scrolling back through their
     * own chat does, and that is the request that takes money.
     *
     * Both halves are asserted on purpose. A gate that refuses everything would
     * pass the first line and be a shop that sells nothing, so the same plan is
     * bought again with the category switched back on — which is also the exact
     * thing an operator does when they realise they turned off the wrong one.
     */
    const off = await makeShop('stale-off', { categoryActive: false });
    expect(await botSellsPlanDirectly(off.planId)).toBe(false);

    await db
      .prepare(`UPDATE product_categories SET active = TRUE WHERE id = ?1`)
      .bind(off.categoryId)
      .run();
    expect(await botSellsPlanDirectly(off.planId)).toBe(true);
  });

  it('agrees a switched-off panel takes its catalogue with it', async () => {
    // The case that started all of this: five of seven panels off, thirteen
    // products the dashboard drew a green badge on, three the bot would sell.
    const shop = await makeShop('panel-off', { panelStatus: 'DISABLED' });
    expect(await agree(shop)).toEqual({ dashboard: false, bot: false });
    expect(whyNotSellable(await factsOf(shop))).toEqual([
      { kind: 'PANEL_OFF', panel: shop.panelName },
    ]);
  });

  it('agrees a panel at its ceiling sells nothing more', async () => {
    // `pr.capacity > live` — strictly greater, so capacity 2 with 2 live is
    // full. Off by one here and a shop stops selling a day early, or oversells.
    const shop = await makeShop('full', { capacity: 2, liveSubscriptions: 2 });
    expect(await agree(shop)).toEqual({ dashboard: false, bot: false });
    expect(whyNotSellable(await factsOf(shop))).toEqual([
      { kind: 'PANEL_FULL', panel: shop.panelName, capacity: 2, live: 2 },
    ]);
  });

  it('agrees a panel one short of its ceiling still sells', async () => {
    const shop = await makeShop('nearly-full', { capacity: 2, liveSubscriptions: 1 });
    expect(await agree(shop)).toEqual({ dashboard: true, bot: true });
  });

  it('agrees no capacity means unlimited, not zero', async () => {
    // NULL is the migration of the legacy 'unlimited' string. Read as a number
    // it would be a ceiling of zero, which closes every panel that never set one.
    const shop = await makeShop('unlimited', { capacity: null, liveSubscriptions: 5 });
    expect(await agree(shop)).toEqual({ dashboard: true, bot: true });
  });

  it('agrees a hidden service is not on sale', async () => {
    const shop = await makeShop('service-hidden', { productStatus: 'HIDDEN' });
    expect(await agree(shop)).toEqual({ dashboard: false, bot: false });
    expect(whyNotSellable(await factsOf(shop))).toEqual([
      { kind: 'PRODUCT_OFF', status: 'HIDDEN' },
    ]);
  });

  it('agrees a disabled config is not on sale', async () => {
    const shop = await makeShop('config-off', { planStatus: 'DISABLED' });
    expect(await agree(shop)).toEqual({ dashboard: false, bot: false });
    expect(whyNotSellable(await factsOf(shop))).toEqual([{ kind: 'PLAN_OFF', status: 'DISABLED' }]);
  });

  it('agrees a service with no panel at all is not on sale', async () => {
    // SQL cannot see this one: `PURCHASABLE` reads `pr.status` through a join
    // that a null `provider_id` never satisfies, so the row vanishes for a
    // reason no column states. The dashboard has to name it, because the
    // operator's fix is «یک پنل انتخاب کن» and nothing else says so.
    const shop = await makeShop('no-panel', { withPanel: false });
    expect(await agree(shop)).toEqual({ dashboard: false, bot: false });
    expect(whyNotSellable(await factsOf(shop))).toEqual([{ kind: 'NO_PANEL' }]);
  });

  it('names every reason at once, outermost first', async () => {
    // A config that is off AND sits on a dead panel needs both fixing. Reporting
    // only the first one is how the second is discovered in production — and the
    // panel comes first because switching the config back on changes nothing
    // while its panel is off.
    const shop = await makeShop('both', { panelStatus: 'DISABLED', planStatus: 'HIDDEN' });
    expect(whyNotSellable(await factsOf(shop))).toEqual([
      { kind: 'PANEL_OFF', panel: shop.panelName },
      { kind: 'PLAN_OFF', status: 'HIDDEN' },
    ]);
    expect(await agree(shop)).toEqual({ dashboard: false, bot: false });
  });
});
