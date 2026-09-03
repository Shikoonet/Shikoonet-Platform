/**
 * What a reseller pays, and where that number comes from.
 *
 * Until 0046 a discount was one column on one customer, so «everybody at level
 * one gets 20» meant typing 20 into twenty rows. The level now carries the
 * percentage and the customer's own `discount_percent` is left alone — which is
 * the part these tests are really about, because the alternative design (copy
 * the level's number onto the row) passes every price assertion here and fails
 * the last two.
 *
 * The prices are computed in the test from the plan's own list price, not by
 * calling `priceForUser` — a test that asked the code under test what the
 * answer should be would agree with any mistake it made.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/handle.js';
import * as menu from '../src/menu.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer, planId, setTierDiscount } from './helpers/shop.js';

const NOW_MS = Date.UTC(2026, 8, 3, 9, 0, 0);
/** `sim-vip-1m-50`, in IRR. Read once in `beforeAll` rather than hardcoded. */
let VIP_PRICE = 0;
let VIP_PLAN = 0;

let nextId = 1;
function ids(): { updateId: number; telegramId: number } {
  const n = nextId++ * 10;
  return { updateId: 930_000 + n, telegramId: 840_000 + n };
}

function press(updateId: number, telegramId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `tier${telegramId}` },
      message: { message_id: 11, chat: { id: telegramId }, type: 'private' },
      data,
    },
  };
}

function types(updateId: number, telegramId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: telegramId, type: 'private' },
      from: { id: telegramId, username: `tier${telegramId}` },
      text,
    },
  };
}

async function lastOrder(userId: number) {
  return db
    .prepare(
      `SELECT unit_price_irr, discount_irr, total_irr FROM orders
        WHERE user_id = ?1 ORDER BY id DESC LIMIT 1`,
    )
    .bind(userId)
    .first<{ unit_price_irr: number; discount_irr: number; total_irr: number }>();
}

async function makeCode(code: string, percent: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO discount_codes (code, kind, percent, applies_to)
       VALUES (?1, 'PERCENT_OFF', ?2, 'ALL')
       ON CONFLICT (code) DO UPDATE SET kind = 'PERCENT_OFF', percent = EXCLUDED.percent`,
    )
    .bind(code, percent)
    .run();
}

beforeAll(async () => {
  await ensureCatalog();
  VIP_PLAN = await planId('sim-vip-1m-50');
  const row = await db
    .prepare(`SELECT price_irr FROM product_plans WHERE id = ?1`)
    .bind(VIP_PLAN)
    .first<{ price_irr: number }>();
  VIP_PRICE = Number(row?.price_irr);
});

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  // The two rows are shared state seeded at 0. Every test sets what it needs.
  await setTierDiscount('n', 0);
  await setTierDiscount('n2', 0);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await setTierDiscount('n', 0);
  await setTierDiscount('n2', 0);
});

describe('the level decides the price', () => {
  it('charges a reseller their level’s percentage, not their own', async () => {
    const { updateId, telegramId } = ids();
    // 25 on the row, 40 on the level. The level is what the customer pays.
    const userId = await makeCustomer(telegramId, {
      reseller: true,
      tier: 'n',
      discountPercent: 25,
    });
    await setTierDiscount('n', 40);

    await handleUpdate(db, press(updateId, telegramId, `order:${VIP_PLAN}`));

    expect(await lastOrder(userId)).toMatchObject({
      unit_price_irr: VIP_PRICE,
      discount_irr: Math.round(VIP_PRICE * 0.4),
      total_irr: VIP_PRICE - Math.round(VIP_PRICE * 0.4),
    });
  });

  it('prices the two levels apart', async () => {
    const one = ids();
    const two = ids();
    const levelOne = await makeCustomer(one.telegramId, { reseller: true, tier: 'n' });
    const levelTwo = await makeCustomer(two.telegramId, { reseller: true, tier: 'n2' });
    await setTierDiscount('n', 10);
    await setTierDiscount('n2', 30);

    await handleUpdate(db, press(one.updateId, one.telegramId, `order:${VIP_PLAN}`));
    await handleUpdate(db, press(two.updateId, two.telegramId, `order:${VIP_PLAN}`));

    expect((await lastOrder(levelOne))?.discount_irr).toBe(Math.round(VIP_PRICE * 0.1));
    expect((await lastOrder(levelTwo))?.discount_irr).toBe(Math.round(VIP_PRICE * 0.3));
  });

  /**
   * A reseller whose level was never set is level one — the rule `tierFor` and
   * `DISCOUNT_PERCENT` both spell out. It matters because `is_reseller` is
   * written by the request-approval route, the importer and the seed, and a row
   * from any of them that arrived without a level must not quietly fall back to
   * ordinary prices.
   */
  it('treats a reseller with no level as level one', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId, { reseller: true, tier: null });
    await setTierDiscount('n', 20);

    await handleUpdate(db, press(updateId, telegramId, `order:${VIP_PLAN}`));

    expect((await lastOrder(userId))?.discount_irr).toBe(Math.round(VIP_PRICE * 0.2));
  });

  it('leaves an ordinary customer on their own discount', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId, { discountPercent: 15 });
    await setTierDiscount('n', 40);

    await handleUpdate(db, press(updateId, telegramId, `order:${VIP_PLAN}`));

    expect((await lastOrder(userId))?.discount_irr).toBe(Math.round(VIP_PRICE * 0.15));
  });
});

describe('what the level does NOT do', () => {
  /**
   * The assertion the copy-onto-the-row design fails.
   *
   * If joining a level wrote its percentage into `users.discount_percent`, the
   * customer's own 25 would be gone and this would read 40 — or 0, if the
   * copy cleared it. Reading through the level leaves the row untouched, so the
   * moment they stop being a reseller their own number is still there.
   */
  it('gives a customer their own discount back when they stop being a reseller', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId, {
      reseller: true,
      tier: 'n',
      discountPercent: 25,
    });
    await setTierDiscount('n', 40);
    await handleUpdate(db, press(updateId, telegramId, `order:${VIP_PLAN}`));
    expect((await lastOrder(userId))?.discount_irr).toBe(Math.round(VIP_PRICE * 0.4));

    await db
      .prepare(`UPDATE users SET is_reseller = false, reseller_tier = NULL WHERE id = ?1`)
      .bind(userId)
      .run();

    // A different plan, so `place()` writes a new order instead of reusing the one above.
    const other = await planId('sim-gold-10');
    await handleUpdate(db, press(updateId + 1, telegramId, `order:${other}`));

    const row = await db
      .prepare(`SELECT discount_percent FROM users WHERE id = ?1`)
      .bind(userId)
      .first<{ discount_percent: number }>();
    expect(Number(row?.discount_percent)).toBe(25);
    const priced = await lastOrder(userId);
    expect(priced?.discount_irr).toBe(Math.round(priced!.unit_price_irr * 0.25));
  });

  it('cannot mint a free order at a hundred percent', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId, { reseller: true, tier: 'n' });
    await setTierDiscount('n', 100);

    const out = await handleUpdate(db, press(updateId, telegramId, `order:${VIP_PLAN}`));

    // `place()` refuses a total of zero, so there is no row and no invoice —
    // the outage `zero-total.test.ts` describes, reached through the level.
    expect(await lastOrder(userId)).toBeNull();
    expect(out.replies[0]?.text).toBe(menu.ORDER_NOT_PAYABLE);
  });
});

describe('a typed discount code on top of a level', () => {
  /**
   * Stacking, and the order the two are taken in.
   *
   * This does NOT exercise the `handleTypedAnswer` load, and it was written
   * believing it did: typing a code only validates and holds it, and the price
   * is computed one press later in `handleCallback`. Removing the shared
   * expression from that SELECT leaves this test green, which is how the
   * mistake was found. The load that actually spends it is an add-on quantity —
   * see «applies the level's discount to an add-on» in `addon.test.ts`.
   */
  it('takes the code off the level’s price, not the list price', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId, { reseller: true, tier: 'n' });
    await setTierDiscount('n', 20);
    await makeCode('tier10', 10);

    await handleUpdate(db, press(updateId, telegramId, `dsc:${VIP_PLAN}`));
    await handleUpdate(db, types(updateId + 1, telegramId, 'tier10'));
    await handleUpdate(db, press(updateId + 2, telegramId, `order:${VIP_PLAN}`));

    // 20% of list from the level, plus 10% of what is left from the code.
    const levelOff = Math.round(VIP_PRICE * 0.2);
    const codeOff = Math.round((VIP_PRICE - levelOff) * 0.1);
    expect(await lastOrder(userId)).toMatchObject({
      discount_irr: levelOff + codeOff,
      total_irr: VIP_PRICE - levelOff - codeOff,
    });
  });
});
