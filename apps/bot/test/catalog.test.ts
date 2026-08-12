import { beforeAll, describe, expect, it } from 'vitest';
import { seedCatalog } from '@shikoo/seed';
import { panelsForUser, plansOnPanel, purchasablePlan } from '../src/catalog.js';
import { db } from './helpers/env.js';
import {
  ensureCatalog,
  giveSubscription,
  makeCustomer,
  planId,
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
    // setting.statuscategory is 'offcategory'. One plan per product, because a
    // legacy `product` row IS a purchasable plan.
    expect(result).toEqual({ providers: 5, products: 10, plans: 10 });
    expect(result.plans).toBe(result.products);

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
    expect(byCode.size).toBe(10);
    expect(byCode.get('sim-vip-1m-50')?.provider_code).toBe('sim-vip');
    expect(byCode.get('sim-gold-10')?.provider_code).toBe('sim-gold');
    expect(byCode.get('sim-shop-spotify')?.kind).toBe('spotify');
    // Every branch a visibility test needs something to be invisible for.
    expect(byCode.get('sim-vip-hidden')?.status).toBe('HIDDEN');
    expect(byCode.get('sim-vip-reseller')?.resellers_only).toBe(true);
    expect(byCode.get('sim-vip-trial')?.once_per_user).toBe(true);
    expect(byCode.get('sim-vip-trial')?.price).toBe(0);
    expect(byCode.get('sim-off-1m')?.provider_status).toBe('DISABLED');
    // Nothing is filed under a category, because production files nothing.
    expect(rows.results.every((r) => r.category_id === null)).toBe(true);
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

  it('keeps the panels in the order the shop arranged them', async () => {
    // Not alphabetical. Every migrated panel carries sort_order 0, so ordering
    // by name reshuffles a menu customers already know: the live bot on
    // 2026-08-12 listed مولتی لوکیشن, then طلایی, then خرید اولی‌ها.
    const panels = await panelsForUser(db, customer);
    const rows = await db
      .prepare(`SELECT id, sort_order FROM provisioning_providers WHERE id = ANY($1)`)
      .bind(panels.map((p) => p.id))
      .all<{ id: number; sort_order: number }>();
    const meta = new Map(rows.results.map((r) => [r.id, r.sort_order]));
    const keys = panels.map((p) => [meta.get(p.id) ?? 0, p.id] as const);
    const sorted = [...keys].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    expect(keys).toEqual(sorted);
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
});

async function panelCodes(userId: number): Promise<string[]> {
  const panels = await panelsForUser(db, userId);
  if (panels.length === 0) return [];
  const rows = await db
    .prepare(`SELECT code FROM provisioning_providers WHERE id = ANY($1)`)
    .bind(panels.map((p) => p.id))
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
