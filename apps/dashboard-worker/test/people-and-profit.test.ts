/**
 * «اشخاص» and «سود و زیان» — Sam, 2026-09-22.
 *
 * Every figure below is checked against arithmetic written beside the fixture,
 * never against a second call to the code under test. The fixture sits on a
 * Tehran day of its own (`DAY`), far behind anything `seed:sim` writes, so the
 * report over that one day is this file's rows and nothing else.
 *
 * ```
 * catalogue   cat-v2 ─┬─ diamond (panel-a)       cat-ovpn ── ovpn (panel-b)
 *                     └─ titan   (panel-a)       cat-empty (no service)
 *
 * sales       diamond 3,000,000 · titan 1,000,000 · ovpn 2,000,000
 *             an imported order naming no service 500,000
 *             an imported order whose subscription is on panel-b 200,000
 *                                          → ovpn, the one service on it,
 *                                            though since renewed onto titan
 *             an imported order whose subscription is on panel-a 100,000
 *                                          → nobody: two services share it
 *             a wallet top-up 999,000                       ← not a sale
 *
 * ledger      diamond        400,000 + fee 10,000 = 410,000
 *             cat-v2       1,000,001   → by sales 3:1 → diamond 750,001 · titan 250,000
 *             panel-a         90,000   → by sales 3:1 → diamond  67,500 · titan  22,500
 *             panel-b        300,000   → ovpn only
 *             cat-empty       70,000   → nobody under it: «unallocated»
 *             the shop       500,000   → shared, never split
 *             REVENUE_FIX   −100,000 · MANUAL_INCOME +200,000
 *             PARTNER_DRAW  1,000,000 to «hesam»                 ← below the profit
 *             an expense the next day, and a voided one          ← not in the window
 *
 * gifts       referral commission 60,000 on the diamond order · gift code 40,000
 *
 * expenses    410,000 + 1,000,001 + 90,000 + 300,000 + 70,000 + 500,000 = 2,370,001
 * sales       3,000,000 + 1,000,000 + 2,200,000 + 600,000                 = 6,800,000
 * revenue     6,800,000 − 100,000 + 200,000                               = 6,900,000
 * profit      6,900,000 − 100,000 gifts − 2,370,001                       = 4,429,999
 * retained    4,429,999 − 1,000,000                                       = 3,429,999
 * ```
 *
 * The 1,000,001 is odd on purpose: 3:1 of it is 750,000.75 / 250,000.25, and
 * the one Rial left over has to land somewhere and be counted exactly once.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-people@example.com';
const READER = 'readonly-people@example.com';
const P = 'zz-pp-';
const DAY = '2026-05-10';
/** Tehran noon on `DAY`. */
const AT = Date.UTC(2026, 4, 10, 8, 30, 0);
const db = baseEnv.DB;

const envAs = (email: string) => ({ ...baseEnv, TEST_ACCESS_USER: email });
const call = (method: string, path: string, body?: unknown, email = ADMIN) =>
  app.request(
    path,
    body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    envAs(email),
  );
const BASE = '/api/v1/admin/revenue-adjustments';

interface Profit {
  salesIrr: number;
  revenueFixIrr: number;
  manualIncomeIrr: number;
  revenueIrr: number;
  giftsIrr: number;
  sharedGiftsIrr: number;
  expensesIrr: number;
  serviceExpensesIrr: number;
  sharedExpensesIrr: number;
  profitIrr: number;
  drawsIrr: number;
  retainedIrr: number;
  services: Array<{ productId: number | null; name: string; revenueIrr: number; expensesIrr: number; giftsIrr: number; profitIrr: number; marginPercent: number | null }>;
  unallocated: Array<{ name: string; irr: number }>;
  partners: Array<{ partyId: number; name: string; sharePercent: number | null; shareIrr: number; drawnIrr: number; balanceIrr: number }>;
}

const profit = async (): Promise<Profit> => {
  const res = await call('GET', `${BASE}/profit?range=day&day=${DAY}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Profit;
};

let ids: Record<string, number> = {};

async function one<T>(sql: string, ...binds: unknown[]): Promise<T> {
  const row = await db.prepare(sql).bind(...binds).first<T>();
  if (!row) throw new Error(`no row: ${sql}`);
  return row;
}

async function purge(): Promise<void> {
  // The wallet ledger is append-only by trigger; TRUNCATE is the one door, the
  // same one `customers.test.ts` uses. Then orders, which the gifts pointed at.
  await db.prepare(`TRUNCATE wallet_entries, wallets RESTART IDENTITY CASCADE`).run();
  await db.prepare(`DELETE FROM revenue_adjustments WHERE note LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM expense_recurrences WHERE label LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM subscriptions WHERE public_id LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM orders WHERE public_id LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM product_plans WHERE name LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM products WHERE code LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM product_categories WHERE name LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM provisioning_providers WHERE code LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM parties WHERE name LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM users WHERE username LIKE ?1`).bind(`${P}%`).run();
}

async function service(tag: string, categoryId: number, providerId: number) {
  const product = await one<{ id: number }>(
    `INSERT INTO products (code, name, kind, category_id, provider_id, status)
     VALUES (?1, ?1, 'vpn', ?2, ?3, 'ACTIVE') RETURNING id`,
    `${P}${tag}`, categoryId, providerId,
  );
  const plan = await one<{ id: number }>(
    `INSERT INTO product_plans (product_id, name, price_irr, duration_days, status)
     VALUES (?1, ?2, 1, 30, 'ACTIVE') RETURNING id`,
    product.id, `${P}${tag}-30`,
  );
  return { productId: Number(product.id), planId: Number(plan.id) };
}

async function order(userId: number, tag: string, kind: string, totalIrr: number, planId: number | null, planName: string | null = null) {
  const row = await one<{ id: number }>(
    `INSERT INTO orders (public_id, user_id, kind, quantity, unit_price_irr, discount_irr, total_irr,
                         status, created_at, completed_at, plan_id, plan_name_at_sale)
     VALUES (?1, ?2, ?3, 1, ?4, 0, ?4, 'COMPLETED', to_timestamp(?5 / 1000.0), to_timestamp(?5 / 1000.0), ?6, ?7)
     RETURNING id`,
    `${P}${tag}`, userId, kind, totalIrr, AT, planId, planName,
  );
  return Number(row.id);
}

/** A ledger row written straight to the table, so the fixture does not depend on the routes it tests. */
async function ledger(kind: string, amountIrr: number, extra: Record<string, unknown> = {}, day = DAY) {
  const cols = Object.keys(extra);
  await db
    .prepare(
      `INSERT INTO revenue_adjustments (amount_irr, note, created_by, created_at, kind, spent_on${cols.map((c) => `, ${c}`).join('')})
       VALUES (?1, ?2, 'test', now(), ?3, ?4::date${cols.map((_, i) => `, ?${i + 5}`).join('')})`,
    )
    .bind(amountIrr, `${P}${kind}-${amountIrr}`, kind, day, ...Object.values(extra))
    .run();
}

beforeAll(async () => {
  await applySchema();
  await purge();
  const now = Date.now();
  for (const [email, role] of [[ADMIN, 'ADMIN'], [READER, 'READ_ONLY']] as const) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
         VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
      )
      .bind(crypto.randomUUID(), email, role, now)
      .run();
  }

  const catV2 = Number((await one<{ id: number }>(`INSERT INTO product_categories (name) VALUES (?1) RETURNING id`, `${P}cat-v2`)).id);
  const catOvpn = Number((await one<{ id: number }>(`INSERT INTO product_categories (name) VALUES (?1) RETURNING id`, `${P}cat-ovpn`)).id);
  const catEmpty = Number((await one<{ id: number }>(`INSERT INTO product_categories (name) VALUES (?1) RETURNING id`, `${P}cat-empty`)).id);
  const panel = async (code: string) =>
    Number((await one<{ id: number }>(
      `INSERT INTO provisioning_providers (code, name, kind, status) VALUES (?1, ?1, 'manual', 'ACTIVE') RETURNING id`,
      `${P}${code}`,
    )).id);
  const panelA = await panel('panel-a');
  const panelB = await panel('panel-b');

  const diamond = await service('diamond', catV2, panelA);
  const titan = await service('titan', catV2, panelA);
  const ovpn = await service('ovpn', catOvpn, panelB);

  const buyer = Number((await one<{ id: number }>(
    `INSERT INTO users (telegram_id, username, registered_at) VALUES (9123456789012, ?1, now()) RETURNING id`,
    `${P}buyer`,
  )).id);
  const diamondOrder = await order(buyer, 'o1', 'NEW_PURCHASE', 3_000_000, diamond.planId);
  await order(buyer, 'o2', 'NEW_PURCHASE', 1_000_000, titan.planId);
  await order(buyer, 'o3', 'NEW_PURCHASE', 2_000_000, ovpn.planId);
  await order(buyer, 'o4', 'NEW_PURCHASE', 500_000, null, 'الماس ۳۰ روزه — قدیمی');
  await order(buyer, 'o5', 'WALLET_TOPUP', 999_000, null);
  // Imported: no plan, only the panel the subscription they created is on.
  // o6's subscription was since renewed onto titan's plan — a tier change
  // (#271) rewrites `subscriptions.plan_id` — and the sale is still ovpn's.
  // Production, 2026-09-23: an August Titanium sale showed under «وایرگارد ترید».
  for (const [tag, total, providerId, planId] of [
    ['o6', 200_000, panelB, titan.planId],
    ['o7', 100_000, panelA, null],
  ] as const) {
    const id = await order(buyer, tag, 'NEW_PURCHASE', total, null, '1ماهه-50گیگ-249.000ت🚀');
    await db
      .prepare(
        `INSERT INTO subscriptions (public_id, user_id, order_id, provider_id, plan_id, plan_name_at_sale, price_irr, status, purchased_at)
         VALUES (?1, ?2, ?3, ?4, ?5, '1ماهه-50گیگ', ?6, 'ACTIVE', to_timestamp(?7 / 1000.0))`,
      )
      .bind(`${P}sub-${tag}`, buyer, id, providerId, planId, total, AT)
      .run();
  }

  await db
    .prepare(
      `INSERT INTO wallet_entries (user_id, amount_irr, kind, order_id, created_at)
       VALUES (?1, 60000, 'REFERRAL_BONUS', ?2, to_timestamp(?3 / 1000.0)),
              (?1, 40000, 'GIFT_CODE', NULL, to_timestamp(?3 / 1000.0))`,
    )
    .bind(buyer, diamondOrder, AT)
    .run();

  const hesam = Number((await one<{ id: number }>(
    `INSERT INTO parties (name, roles, share_percent) VALUES (?1, '{PARTNER}', 60) RETURNING id`, `${P}hesam`)).id);
  const pouyan = Number((await one<{ id: number }>(
    `INSERT INTO parties (name, roles, share_percent) VALUES (?1, '{PARTNER}', 40) RETURNING id`, `${P}pouyan`)).id);
  const host = Number((await one<{ id: number }>(
    `INSERT INTO parties (name, roles) VALUES (?1, '{SUPPLIER}') RETURNING id`, `${P}host`)).id);

  await ledger('EXPENSE', -400_000, { product_id: diamond.productId, fee_irr: 10_000, party_id: host });
  await ledger('EXPENSE', -1_000_001, { product_category_id: catV2 });
  await ledger('EXPENSE', -90_000, { provider_id: panelA, party_id: host });
  await ledger('EXPENSE', -300_000, { provider_id: panelB });
  await ledger('EXPENSE', -70_000, { product_category_id: catEmpty });
  await ledger('EXPENSE', -500_000);
  await ledger('REVENUE_FIX', -100_000);
  await ledger('MANUAL_INCOME', 200_000);
  await ledger('PARTNER_DRAW', -1_000_000, { party_id: hesam });
  await ledger('EXPENSE', -777_000, { product_id: diamond.productId }, '2026-05-11');
  await ledger('EXPENSE', -123_000, { product_id: diamond.productId, voided_at: new Date().toISOString(), voided_by: 'test' });

  ids = { catV2, catOvpn, catEmpty, panelA, panelB, hesam, pouyan, host, ...{ diamond: diamond.productId, titan: titan.productId, ovpn: ovpn.productId } };
});

afterAll(purge);

describe('«سود و زیان» over one day', () => {
  it('adds up the statement top to bottom', async () => {
    const r = await profit();
    expect({
      sales: r.salesIrr,
      fix: r.revenueFixIrr,
      manual: r.manualIncomeIrr,
      revenue: r.revenueIrr,
      gifts: r.giftsIrr,
      sharedGifts: r.sharedGiftsIrr,
      expenses: r.expensesIrr,
      service: r.serviceExpensesIrr,
      shared: r.sharedExpensesIrr,
      profit: r.profitIrr,
      draws: r.drawsIrr,
      retained: r.retainedIrr,
    }).toEqual({
      sales: 6_800_000,
      fix: -100_000,
      manual: 200_000,
      revenue: 6_900_000,
      gifts: 100_000,
      // The gift code names no order, so it is nobody's service.
      sharedGifts: 40_000,
      expenses: 2_370_001,
      service: 1_870_001,
      shared: 500_000,
      profit: 4_429_999,
      draws: 1_000_000,
      retained: 3_429_999,
    });
  });

  it('spreads a category and a panel over their services by sales, to the Rial', async () => {
    const r = await profit();
    const row = (name: string) => r.services.find((s) => s.name === `${P}${name}`);
    expect(r.services.map((s) => [s.name, s.revenueIrr, s.expensesIrr, s.giftsIrr, s.profitIrr])).toEqual([
      [`${P}diamond`, 3_000_000, 410_000 + 750_001 + 67_500, 60_000, 3_000_000 - 1_227_501 - 60_000],
      // 2,000,000 bought through its plan + 200,000 imported onto its panel.
      [`${P}ovpn`, 2_200_000, 300_000, 0, 1_900_000],
      [`${P}titan`, 1_000_000, 250_000 + 22_500, 0, 727_500],
      // 500,000 naming nothing + 100,000 on a panel two services share.
      ['سفارش‌های قدیمی', 600_000, 0, 0, 600_000],
    ]);
    expect(row('titan')!.marginPercent).toBe(72.75);
    expect(r.unallocated).toEqual([{ name: `${P}cat-empty`, irr: 70_000 }]);
    // Every Rial of named spending is somewhere exactly once.
    const placed = r.services.reduce((a, s) => a + s.expensesIrr, 0) + r.unallocated.reduce((a, u) => a + u.irr, 0);
    expect(placed).toBe(r.serviceExpensesIrr);
  });

  it('gives each partner his percent of the profit, less what he drew', async () => {
    const r = await profit();
    const mine = r.partners.filter((p) => p.name.startsWith(P));
    expect(mine.map((p) => [p.name, p.sharePercent, p.shareIrr, p.drawnIrr, p.balanceIrr])).toEqual([
      // 60% of 4,429,999 = 2,657,999.4 → 2,657,999
      [`${P}hesam`, 60, 2_657_999, 1_000_000, 1_657_999],
      // 40% of 4,429,999 = 1,771,999.6 → 1,772,000
      [`${P}pouyan`, 40, 1_772_000, 0, 1_772_000],
    ]);
    expect(r.partners.some((p) => p.name === `${P}host`)).toBe(false);
  });

  it('gives an archived partner his draws and no share, so the percents never pass 100', async () => {
    // Review of #426: archiving kept his 60%, and a new partner could then
    // take 60% more — the screen would have divided 160% of the profit.
    await db.prepare(`UPDATE parties SET active = false WHERE id = ?1`).bind(ids.hesam).run();
    try {
      const hesam = (await profit()).partners.find((p) => p.partyId === ids.hesam)!;
      expect([hesam.sharePercent, hesam.shareIrr, hesam.drawnIrr, hesam.balanceIrr]).toEqual([null, 0, 1_000_000, -1_000_000]);
    } finally {
      await db.prepare(`UPDATE parties SET active = true WHERE id = ?1`).bind(ids.hesam).run();
    }
  });

  it('is withheld from a READ_ONLY operator', async () => {
    expect((await call('GET', `${BASE}/profit?range=day&day=${DAY}`, undefined, READER)).status).toBe(403);
    expect((await call('GET', `${BASE}/parties`, undefined, READER)).status).toBe(403);
  });
});

describe('«اشخاص»', () => {
  it('lists what each person drew, was paid, and brought in', async () => {
    const res = await call('GET', `${BASE}/parties`);
    const items = ((await res.json()) as { items: Array<{ name: string; drawnIrr: number; paidIrr: number; rowCount: number; roles: string[] }> }).items;
    const by = (n: string) => items.find((i) => i.name === `${P}${n}`)!;
    expect([by('hesam').drawnIrr, by('hesam').paidIrr]).toEqual([1_000_000, 0]);
    // 400,000 + its 10,000 fee on diamond, and 90,000 on panel-a.
    expect([by('host').drawnIrr, by('host').paidIrr, by('host').rowCount]).toEqual([0, 500_000, 2]);
    expect(by('host').roles).toEqual(['SUPPLIER']);
  });

  it('adds a person, refuses his name twice, and keeps shares under 100', async () => {
    const add = await call('POST', `${BASE}/parties`, { name: `${P}sam`, roles: ['PARTNER'] });
    expect(add.status).toBe(200);
    expect((await call('POST', `${BASE}/parties`, { name: `${P}sam` })).status).toBe(409);
    // 60 + 40 are already taken.
    const over = await call('POST', `${BASE}/parties`, { name: `${P}fourth`, roles: ['PARTNER'], sharePercent: 1 });
    expect(over.status).toBe(400);
    expect(((await over.json()) as { error: string }).error).toBe('shares_over_100');
    // A share on someone who is not a partner is dropped, not stored.
    const supplier = (await (await call('POST', `${BASE}/parties`, { name: `${P}cdn`, roles: ['SUPPLIER'], sharePercent: 5 })).json()) as { id: number };
    expect((await one<{ s: number | null }>(`SELECT share_percent AS s FROM parties WHERE id = ?1`, supplier.id)).s).toBeNull();
    expect((await call('POST', `${BASE}/parties`, { name: `${P}x` }, READER)).status).toBe(403);
  });

  it('will not take the partner role from someone who drew', async () => {
    const res = await call('PATCH', `${BASE}/parties/${ids.hesam}`, { roles: ['CONTRACTOR'] });
    expect(res.status).toBe(409);
  });
});

describe('the ledger learns who, and what for', () => {
  const add = (body: Record<string, unknown>) =>
    call('POST', BASE, { amountToman: 1000, note: `${P}route`, ...body });

  it('refuses a draw with nobody, or with someone who is not a partner', async () => {
    const none = await add({ kind: 'PARTNER_DRAW' });
    expect(((await none.json()) as { error: string }).error).toBe('draw_needs_a_partner');
    const supplier = await add({ kind: 'PARTNER_DRAW', partyId: ids.host });
    expect(((await supplier.json()) as { error: string }).error).toBe('draw_needs_a_partner');
    const missing = await add({ kind: 'EXPENSE', partyId: 999_999_999 });
    expect(((await missing.json()) as { error: string }).error).toBe('party_not_found');
  });

  it('stores a draw negative, outside «هزینه», and names it in the list', async () => {
    const res = await add({ kind: 'PARTNER_DRAW', partyId: ids.pouyan, note: `${P}draw-route` });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { amountIrr: number }).amountIrr).toBe(-10_000);
    const list = (await (await call('GET', `${BASE}?q=${P}draw-route`)).json()) as {
      items: Array<{ kind: string; partyName: string }>;
      totals: { expensesIrr: number; partnerDrawsIrr: number; partnerDrawsCount: number };
    };
    expect(list.items[0]).toMatchObject({ kind: 'PARTNER_DRAW', partyName: `${P}pouyan` });
    expect([list.totals.expensesIrr, list.totals.partnerDrawsIrr, list.totals.partnerDrawsCount]).toEqual([0, -10_000, 1]);
  });

  it('keeps a scope on spending only, and refuses one that does not exist', async () => {
    const ok = (await (await add({ kind: 'EXPENSE', scope: { level: 'CATEGORY', id: ids.catOvpn }, note: `${P}scoped` })).json()) as { id: number };
    const row = await one<{ c: number | null; p: number | null }>(
      `SELECT product_category_id AS c, product_id AS p FROM revenue_adjustments WHERE id = ?1`, ok.id);
    expect([Number(row.c), row.p]).toEqual([ids.catOvpn, null]);

    const income = (await (await add({ kind: 'MANUAL_INCOME', scope: { level: 'PRODUCT', id: ids.diamond }, note: `${P}income` })).json()) as { id: number };
    expect((await one<{ p: number | null }>(`SELECT product_id AS p FROM revenue_adjustments WHERE id = ?1`, income.id)).p).toBeNull();

    const bad = await add({ kind: 'EXPENSE', scope: { level: 'PROVIDER', id: 999_999_999 } });
    expect(((await bad.json()) as { error: string }).error).toBe('scope_not_found');
    expect((await add({ kind: 'EXPENSE', scope: { level: 'SHOP', id: 1 } })).status).toBe(400);
  });

  it('turns an expense into a draw by edit: the category goes, the person stays, the history says so', async () => {
    const created = (await (await add({ kind: 'EXPENSE', partyId: ids.hesam, note: `${P}was-expense` })).json()) as { id: number };
    const res = await call('PATCH', `${BASE}/${created.id}`, { kind: 'PARTNER_DRAW', reason: 'برداشت سود بود' });
    expect(res.status).toBe(200);
    const row = await one<{ kind: string; amount_irr: number; party_id: number; category_id: number | null }>(
      `SELECT kind, amount_irr, party_id, category_id FROM revenue_adjustments WHERE id = ?1`, created.id);
    expect([row.kind, Number(row.amount_irr), Number(row.party_id), row.category_id]).toEqual(['PARTNER_DRAW', -10_000, ids.hesam, null]);
    const history = (await (await call('GET', `${BASE}/${created.id}/history`)).json()) as { items: Array<{ after: Record<string, unknown> | null }> };
    expect(history.items.at(-1)!.after).toMatchObject({ kind: 'PARTNER_DRAW' });
  });

  it('filters the list to one person', async () => {
    const list = (await (await call('GET', `${BASE}?partyId=${ids.host}&q=${P}`)).json()) as { total: number };
    expect(list.total).toBe(2);
  });

  it('a recurring cost remembers its panel and posts to it', async () => {
    const tpl = (await (await call('POST', `${BASE}/recurrences`, {
      label: `${P}server`,
      amountToman: 5000,
      nextDueOn: '2026-05-01',
      scope: { level: 'PROVIDER', id: ids.panelB },
      partyId: ids.host,
    })).json()) as { id: number };
    const posted = (await (await call('POST', `${BASE}/recurrences/${tpl.id}/post`, { note: `${P}server-may` })).json()) as { id: number };
    const row = await one<{ provider_id: number; party_id: number }>(
      `SELECT provider_id, party_id FROM revenue_adjustments WHERE id = ?1`, posted.id);
    expect([Number(row.provider_id), Number(row.party_id)]).toEqual([ids.panelB, ids.host]);
  });
});
