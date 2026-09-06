/**
 * Discount codes, from the button to the row.
 *
 * The conditions under test are the PHP's (`index.php:4218`), and three of them
 * were unreachable until 2026-08-14 because the importer never carried the
 * columns they read: an expired code, a code for another panel, and a code for
 * renewals only. `packages/migrate/test/discounts.mysql.test.ts` measures the
 * import against the real dump; this file measures what the bot does with the
 * result.
 *
 * The money assertions read the ORDER row, not the screen. A screen that says
 * "20% off" over an order charging full price is the failure this is for.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_CODE_LENGTH, normalizeCode } from '../src/discount.js';
import { handleUpdate } from '../src/handle.js';
import * as menu from '../src/menu.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer, planId, providerId } from './helpers/shop.js';

const NOW_MS = Date.UTC(2026, 7, 14, 9, 0, 0);
const DAY = 86_400_000;

let nextId = 1;
function ids(): { updateId: number; telegramId: number } {
  const n = nextId++ * 10;
  return { updateId: 900_000 + n, telegramId: 920_000 + n };
}

function press(updateId: number, telegramId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `dsc${telegramId}` },
      message: { message_id: 7, chat: { id: telegramId } },
      data,
    },
  };
}

function types(updateId: number, telegramId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: telegramId },
      from: { id: telegramId, username: `dsc${telegramId}` },
      text,
    },
  };
}

interface CodeOptions {
  kind?: 'PERCENT_OFF' | 'AMOUNT_OFF' | 'GIFT_BALANCE';
  percent?: number;
  amountIrr?: number;
  expiresInDays?: number | null;
  maxUses?: number | null;
  firstPurchaseOnly?: boolean;
  resellersOnly?: boolean;
  productId?: number | null;
  providerId?: number | null;
  appliesTo?: 'ALL' | 'BUY' | 'RENEW';
  usesPerUser?: number;
  status?: 'ACTIVE' | 'DISABLED';
  targetUserId?: number | null;
}

async function makeCode(code: string, options: CodeOptions = {}): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO discount_codes
         (code, kind, percent, amount_irr, expires_at, max_uses, first_purchase_only,
          resellers_only, product_id, provider_id, applies_to,
          uses_per_user, status, target_user_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
       -- Every column, not just the one it conflicted on. This used to set the
       -- code to itself, which is a no-op upsert: a code left in the table by
       -- an earlier run kept its OLD kind, so a test asking for a gift code
       -- could be handed a percentage one and fail somewhere else entirely.
       -- Which test broke depended on the order they ran in.
       ON CONFLICT (code) DO UPDATE SET
         kind = EXCLUDED.kind, percent = EXCLUDED.percent,
         amount_irr = EXCLUDED.amount_irr, expires_at = EXCLUDED.expires_at,
         max_uses = EXCLUDED.max_uses,
         first_purchase_only = EXCLUDED.first_purchase_only,
         resellers_only = EXCLUDED.resellers_only,
         product_id = EXCLUDED.product_id, provider_id = EXCLUDED.provider_id,
         applies_to = EXCLUDED.applies_to,
         uses_per_user = EXCLUDED.uses_per_user, status = EXCLUDED.status,
         target_user_id = EXCLUDED.target_user_id
       RETURNING id`,
    )
    .bind(
      code,
      options.kind ?? 'PERCENT_OFF',
      options.percent ?? (options.kind === 'PERCENT_OFF' || !options.kind ? 20 : null),
      options.amountIrr ?? null,
      options.expiresInDays === undefined || options.expiresInDays === null
        ? null
        : new Date(NOW_MS + options.expiresInDays * DAY).toISOString(),
      options.maxUses ?? null,
      options.firstPurchaseOnly ?? false,
      options.resellersOnly ?? false,
      options.productId ?? null,
      options.providerId ?? null,
      options.appliesTo ?? 'ALL',
      options.usesPerUser ?? 1,
      options.status ?? 'ACTIVE',
      options.targetUserId ?? null,
    )
    .first<{ id: number }>();
  if (!row) throw new Error(`code fixture ${code} failed`);
  return row.id;
}

async function lastOrder(userId: number) {
  return db
    .prepare(
      `SELECT id, unit_price_irr, discount_irr, total_irr, status
         FROM orders WHERE user_id = ?1 ORDER BY id DESC LIMIT 1`,
    )
    .bind(userId)
    .first<{
      id: number;
      unit_price_irr: number;
      discount_irr: number;
      total_irr: number;
      status: string;
    }>();
}

async function orderCount(userId: number): Promise<number> {
  const row = await db
    .prepare(`SELECT count(*)::int AS n FROM orders WHERE user_id = ?1`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Types a code against a plan: press the button, then send the code. */
async function useCode(
  updateId: number,
  telegramId: number,
  plan: number,
  code: string,
): Promise<string> {
  await handleUpdate(db, press(updateId, telegramId, `dsc:${plan}`));
  const out = await handleUpdate(db, types(updateId + 1, telegramId, code));
  return out.replies[0]?.text ?? '';
}

let VIP_PLAN = 0;
let VIP_PROVIDER = 0;
let GOLD_PROVIDER = 0;
/** The fixture plan's list price, read rather than assumed. */
let VIP_PRICE = 0;

beforeAll(async () => {
  await ensureCatalog();
  VIP_PLAN = await planId('sim-vip-1m-50');
  VIP_PROVIDER = await providerId('sim-vip');
  GOLD_PROVIDER = await providerId('sim-gold');
  const row = await db
    .prepare(`SELECT price_irr FROM product_plans WHERE id = ?1`)
    .bind(VIP_PLAN)
    .first<{ price_irr: number }>();
  VIP_PRICE = row!.price_irr;
});

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('what counts as a code at all', () => {
  it('bounds what a customer can type before it reaches the lookup', () => {
    // Telegram will carry 4,096 characters and the longest code that has ever
    // existed here is 14. Everything past the cap is lowercased and matched
    // against an index for nothing, once per message, for free.
    const essay = 'x'.repeat(4_096);
    expect(normalizeCode(essay)).toHaveLength(MAX_CODE_LENGTH);
    // The cap is applied before the lowering, so it cannot be walked past by
    // a string whose case-folded form is longer than its input.
    expect(normalizeCode(essay)).toBe('x'.repeat(MAX_CODE_LENGTH));
  });

  it('leaves a real code exactly as the shop stored it', () => {
    // The cap must not become a truncation bug: every code in production fits.
    expect(normalizeCode('  OFF15  ')).toBe('off15');
    expect(normalizeCode('sale-1404-nowruz')).toBe('sale-1404-nowruz');
  });
});

describe('a code that works', () => {
  it('takes its percentage off the order, not off the screen', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await makeCode('save20');

    const said = await useCode(updateId, telegramId, VIP_PLAN, 'save20');
    expect(said).toContain('save20');
    await handleUpdate(db, press(updateId + 2, telegramId, `order:${VIP_PLAN}`));

    const order = await lastOrder(userId);
    expect(order).toMatchObject({
      unit_price_irr: VIP_PRICE,
      discount_irr: Math.round(VIP_PRICE * 0.2),
      total_irr: VIP_PRICE - Math.round(VIP_PRICE * 0.2),
    });
  });

  it('is written down as redeemed, against the order it paid for', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const codeId = await makeCode('mark1');

    await useCode(updateId, telegramId, VIP_PLAN, 'mark1');
    await handleUpdate(db, press(updateId + 2, telegramId, `order:${VIP_PLAN}`));

    const order = await lastOrder(userId);
    const redemption = await db
      .prepare(
        `SELECT order_id, amount_irr FROM discount_redemptions
          WHERE code_id = ?1 AND user_id = ?2`,
      )
      .bind(codeId, userId)
      .first<{ order_id: number; amount_irr: number }>();
    expect(redemption).toMatchObject({
      order_id: order!.id,
      amount_irr: Math.round(VIP_PRICE * 0.2),
    });
  });

  it('is typed the way a customer types it', async () => {
    // Production holds `off15`; a phone capitalises and people add spaces.
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await makeCode('mixed9', { percent: 10 });

    await useCode(updateId, telegramId, VIP_PLAN, '  MiXeD9 ');
    await handleUpdate(db, press(updateId + 2, telegramId, `order:${VIP_PLAN}`));

    expect((await lastOrder(userId))?.discount_irr).toBe(Math.round(VIP_PRICE * 0.1));
  });

  it('stacks with a standing discount, and refuses the order the stack empties', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId, { discountPercent: 60 });
    await makeCode('half50', { percent: 100 });

    await useCode(updateId, telegramId, VIP_PLAN, 'half50');
    await handleUpdate(db, press(updateId + 2, telegramId, `order:${VIP_PLAN}`));

    // 60% standing + 100% code is 160% of the price, so the arithmetic floors
    // at free rather than going negative — that part was always right.
    //
    // What this used to assert was `total_irr: 0`, and it stopped exactly there.
    // One press further was the outage: see `zero-total.test.ts`. No row now.
    expect(await lastOrder(userId)).toBeNull();
  });

  it('leaves a code unspent when the order it would have paid for is refused', async () => {
    // The redemption is written after the order, so a refusal must not burn a
    // single-use code on a purchase that never happened.
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId, { discountPercent: 60 });
    const codeId = await makeCode('unspent1', { percent: 100 });

    await useCode(updateId, telegramId, VIP_PLAN, 'unspent1');
    await handleUpdate(db, press(updateId + 2, telegramId, `order:${VIP_PLAN}`));

    const spent = await db
      .prepare(
        `SELECT count(*)::int AS n FROM discount_redemptions WHERE code_id = ?1 AND user_id = ?2`,
      )
      .bind(codeId, userId)
      .first<{ n: number }>();
    expect(spent?.n).toBe(0);
  });
});

describe('a code that does not', () => {
  it('refuses one whose date has passed', async () => {
    // 31 of the 33 production codes are in this state.
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await makeCode('gone1', { expiresInDays: -1 });

    expect(await useCode(updateId, telegramId, VIP_PLAN, 'gone1')).toBe(
      menu.DISCOUNT_REFUSED['EXPIRED'],
    );
    await handleUpdate(db, press(updateId + 2, telegramId, `order:${VIP_PLAN}`));
    expect((await lastOrder(userId))?.discount_irr).toBe(0);
  });

  it('refuses one belonging to another panel, and allows the one for this panel', async () => {
    // Both halves, because a scope check that refuses everything passes the
    // first half on its own. 23 production codes are tied to a panel.
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    await makeCode('gold1', { providerId: GOLD_PROVIDER });
    await makeCode('vip1', { providerId: VIP_PROVIDER, percent: 5 });

    expect(await useCode(updateId, telegramId, VIP_PLAN, 'gold1')).toBe(
      menu.DISCOUNT_REFUSED['NOT_FOR_THIS'],
    );
    expect(await useCode(updateId + 2, telegramId, VIP_PLAN, 'vip1')).toContain('vip1');
  });

  it('refuses a renewal code on a purchase', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    await makeCode('ext1', { appliesTo: 'RENEW' });

    expect(await useCode(updateId, telegramId, VIP_PLAN, 'ext1')).toBe(
      menu.DISCOUNT_REFUSED['NOT_FOR_THIS'],
    );
  });

  it('refuses a first-purchase code to somebody who already bought', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await makeCode('first1', { firstPurchaseOnly: true });
    await db
      .prepare(
        `INSERT INTO subscriptions (public_id, user_id, plan_name_at_sale, price_irr,
                                    status, purchased_at)
         VALUES (?1, ?2, 'already owned', 1000000, 'ACTIVE', now())`,
      )
      .bind(`own-${telegramId}`, userId)
      .run();

    expect(await useCode(updateId, telegramId, VIP_PLAN, 'first1')).toBe(
      menu.DISCOUNT_REFUSED['FIRST_PURCHASE_ONLY'],
    );
  });

  it('refuses a reseller code to an ordinary customer', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    await makeCode('agent1', { resellersOnly: true });

    expect(await useCode(updateId, telegramId, VIP_PLAN, 'agent1')).toBe(
      menu.DISCOUNT_REFUSED['NOT_FOR_YOU'],
    );
  });

  it('refuses one whose uses are gone', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    const codeId = await makeCode('full1', { maxUses: 1 });
    const other = await makeCustomer(ids().telegramId);
    await db
      .prepare(`INSERT INTO discount_redemptions (code_id, user_id) VALUES (?1, ?2)`)
      .bind(codeId, other)
      .run();

    expect(await useCode(updateId, telegramId, VIP_PLAN, 'full1')).toBe(
      menu.DISCOUNT_REFUSED['USED_UP'],
    );
  });

  it('refuses a code nobody issued, and says so', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    expect(await useCode(updateId, telegramId, VIP_PLAN, 'nosuchcode')).toBe(
      menu.DISCOUNT_REFUSED['UNKNOWN_CODE'],
    );
  });

  it('will not spend a gift code on a purchase', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    await makeCode('gift9', { kind: 'GIFT_BALANCE', amountIrr: 500_000 });

    expect(await useCode(updateId, telegramId, VIP_PLAN, 'gift9')).toBe(
      menu.DISCOUNT_REFUSED['NOT_FOR_THIS'],
    );
  });
});

describe('using one twice', () => {
  it('does not let the same customer use it on a second purchase', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await makeCode('once1', { percent: 25 });

    await useCode(updateId, telegramId, VIP_PLAN, 'once1');
    await handleUpdate(db, press(updateId + 2, telegramId, `order:${VIP_PLAN}`));
    // That order is paid for and gone; the code should not come back.
    await db.prepare(`UPDATE orders SET status = 'PAID' WHERE user_id = ?1`).bind(userId).run();

    expect(await useCode(updateId + 3, telegramId, VIP_PLAN, 'once1')).toBe(
      menu.DISCOUNT_REFUSED['ALREADY_USED'],
    );
  });

  it('answers a second tap on «ثبت سفارش» with the order they already have', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await makeCode('twice1', { percent: 30 });
    const before = await orderCount(userId);

    await useCode(updateId, telegramId, VIP_PLAN, 'twice1');
    await handleUpdate(db, press(updateId + 2, telegramId, `order:${VIP_PLAN}`));
    await handleUpdate(db, press(updateId + 3, telegramId, `order:${VIP_PLAN}`));

    // Without the open-order check the second tap loses the discount, prices
    // the plan at full, and writes a second order for the same purchase.
    expect(await orderCount(userId)).toBe(before + 1);
    expect((await lastOrder(userId))?.discount_irr).toBe(Math.round(VIP_PRICE * 0.3));
  });
});

describe('renewing with a code', () => {
  /** A service on the VIP panel that can be renewed. */
  async function makeRenewable(userId: number, publicId: string): Promise<number> {
    const row = await db
      .prepare(
        `INSERT INTO subscriptions
           (public_id, user_id, provider_id, plan_name_at_sale, price_irr,
            remote_username, volume_gb, duration_days, status, purchased_at, expires_at)
         VALUES (?1, ?2, ?3, 'کهنه - ۲۰ گیگ', 1000000, ?4, 20, 30, 'ACTIVE', now(),
                 now() + interval '3 days')
         RETURNING id`,
      )
      .bind(publicId, userId, VIP_PROVIDER, `u_${publicId}`)
      .first<{ id: number }>();
    if (!row) throw new Error('renewable fixture failed');
    return row.id;
  }

  it('applies a renewal code to the renewal order', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const service = await makeRenewable(userId, `rn${telegramId}`);
    await makeCode('ext20', { appliesTo: 'RENEW', percent: 20 });

    await handleUpdate(db, press(updateId, telegramId, `dsr:${service}`));
    const said = await handleUpdate(db, types(updateId + 1, telegramId, 'ext20'));
    expect(said.replies[0]?.text).toContain('ext20');
    await handleUpdate(db, press(updateId + 2, telegramId, `rord:${service}:${VIP_PLAN}`));

    const order = await lastOrder(userId);
    expect(order).toMatchObject({
      discount_irr: Math.round(VIP_PRICE * 0.2),
      total_irr: VIP_PRICE - Math.round(VIP_PRICE * 0.2),
    });
  });

  it('refuses a buy-only code on a renewal', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const service = await makeRenewable(userId, `rb${telegramId}`);
    await makeCode('buyonly', { appliesTo: 'BUY' });

    await handleUpdate(db, press(updateId, telegramId, `dsr:${service}`));
    const out = await handleUpdate(db, types(updateId + 1, telegramId, 'buyonly'));

    expect(out.replies[0]?.text).toBe(menu.DISCOUNT_REFUSED['NOT_FOR_THIS']);
  });

  it('accepts a product-scoped code but does not apply it to another product', async () => {
    // The one check the renewal entry cannot make: the plan is chosen after the
    // code. It has to be made again at the order, and this is that.
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const service = await makeRenewable(userId, `rp${telegramId}`);
    const otherProduct = await db
      .prepare(
        `SELECT p.id FROM products p JOIN product_plans pl ON pl.product_id = p.id
                 WHERE pl.id <> ?1 AND p.provider_id = ?2 LIMIT 1`,
      )
      .bind(VIP_PLAN, VIP_PROVIDER)
      .first<{ id: number }>();
    await makeCode('otherp', { appliesTo: 'RENEW', productId: otherProduct!.id });

    await handleUpdate(db, press(updateId, telegramId, `dsr:${service}`));
    // Accepted here, because no plan has been chosen yet.
    const said = await handleUpdate(db, types(updateId + 1, telegramId, 'otherp'));
    expect(said.replies[0]?.text).toContain('otherp');

    await handleUpdate(db, press(updateId + 2, telegramId, `rord:${service}:${VIP_PLAN}`));

    // And not applied, because the plan chosen is not the product it is for.
    expect((await lastOrder(userId))?.discount_irr).toBe(0);
  });

  it('does not let a renewal code be spent twice', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const service = await makeRenewable(userId, `rt${telegramId}`);
    await makeCode('extonce', { appliesTo: 'RENEW', percent: 15 });
    const before = await orderCount(userId);

    await handleUpdate(db, press(updateId, telegramId, `dsr:${service}`));
    await handleUpdate(db, types(updateId + 1, telegramId, 'extonce'));
    await handleUpdate(db, press(updateId + 2, telegramId, `rord:${service}:${VIP_PLAN}`));
    await handleUpdate(db, press(updateId + 3, telegramId, `rord:${service}:${VIP_PLAN}`));

    expect(await orderCount(userId)).toBe(before + 1);
    expect((await lastOrder(userId))?.discount_irr).toBe(Math.round(VIP_PRICE * 0.15));
  });

  it('will not hold a code against somebody else’s service', async () => {
    const owner = await makeCustomer(ids().telegramId);
    const service = await makeRenewable(owner, `rx${owner}`);
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);

    const out = await handleUpdate(db, press(updateId, telegramId, `dsr:${service}`));

    expect(out.replies[0]?.text).toBe(menu.RENEWAL_GONE);
  });
});

describe('a gift code', () => {
  it('credits the wallet once, whatever the customer types after', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await makeCode('cash1', { kind: 'GIFT_BALANCE', amountIrr: 750_000 });

    await handleUpdate(db, press(updateId, telegramId, 'gft'));
    const first = await handleUpdate(db, types(updateId + 1, telegramId, 'cash1'));
    expect(first.replies[0]?.text).toContain('75,000 تومان');

    // Ask again and type the same code: the wallet must not move twice.
    await handleUpdate(db, press(updateId + 2, telegramId, 'gft'));
    const second = await handleUpdate(db, types(updateId + 3, telegramId, 'cash1'));
    expect(second.replies[0]?.text).toBe(menu.DISCOUNT_REFUSED['ALREADY_USED']);

    const wallet = await db
      .prepare(
        `SELECT count(*)::int AS n, coalesce(sum(amount_irr), 0)::bigint AS total
           FROM wallet_entries WHERE user_id = ?1 AND kind = 'GIFT_CODE'`,
      )
      .bind(userId)
      .first<{ n: number; total: number }>();
    expect(wallet).toMatchObject({ n: 1, total: 750_000 });
    // And it reads as Persian on the wallet screen. Found on the browser: a new
    // wallet kind with no label falls through to the raw `GIFT_CODE`.
    const screen = menu.walletHome(750_000, [{ amount_irr: 750_000, kind: 'GIFT_CODE' }]);
    expect(screen).toContain('کد هدیه');
    expect(screen).not.toContain('GIFT_CODE');
  });

  it('refuses the production gift code that credits nothing', async () => {
    // `15off` in the dump has a NULL price. The migration reproduced it rather
    // than repairing it, so the bot must not hand a customer a gift of zero.
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    await makeCode('empty1', { kind: 'GIFT_BALANCE', amountIrr: 0 });

    await handleUpdate(db, press(updateId, telegramId, 'gft'));
    const out = await handleUpdate(db, types(updateId + 1, telegramId, 'empty1'));
    expect(out.replies[0]?.text).toBe(menu.DISCOUNT_REFUSED['UNKNOWN_CODE']);
  });

  /**
   * The ceiling, under the only condition that can break it.
   *
   * `max_uses` is checked by counting `discount_redemptions` and then acting on
   * the count. Two DIFFERENT customers on a code with `max_uses = 1` both count
   * zero, both insert, and a shop that authorised one gift gives two — unless
   * the `FOR UPDATE` on the code's row serialises them, which is what this
   * proves.
   *
   * The comment here used to add that «the unique index `(code_id, user_id)`
   * makes that safe for ONE customer pressing twice». That index is gone —
   * migration 0059 replaced it with a per-order one and a counted per-user
   * ceiling — so the sentence is corrected rather than left to be believed.
   * The same lock is what holds BOTH ceilings now, and there is a sibling test
   * of this shape below for the per-user one.
   *
   * Sequential calls cannot show this; the second one sees the first's row.
   * Both redemptions have to be in flight at once, which is why this is
   * `Promise.all` over two sessions rather than two awaits.
   */
  it('honours the use ceiling when two customers arrive together', async () => {
    const a = ids();
    const b = ids();
    await makeCustomer(a.telegramId);
    await makeCustomer(b.telegramId);
    // A name of its own. `makeCode` upserts `ON CONFLICT (code)` without
    // touching `kind`, so reusing a code another test already made as
    // PERCENT_OFF would silently hand this one the wrong kind — and which test
    // won would depend on the order they ran in.
    await makeCode('ceil1', { kind: 'GIFT_BALANCE', amountIrr: 500_000, maxUses: 1 });

    await handleUpdate(db, press(a.updateId, a.telegramId, 'gft'));
    await handleUpdate(db, press(b.updateId, b.telegramId, 'gft'));

    // Together, not one after the other.
    const [first, second] = await Promise.all([
      handleUpdate(db, types(a.updateId + 1, a.telegramId, 'ceil1')),
      handleUpdate(db, types(b.updateId + 1, b.telegramId, 'ceil1')),
    ]);

    const credited = await db
      .prepare(
        `SELECT count(*)::int AS n FROM wallet_entries
          WHERE kind = 'GIFT_CODE' AND note = 'gift code ceil1'`,
      )
      .first<{ n: number }>();
    const redeemed = await db
      .prepare(
        `SELECT count(*)::int AS n FROM discount_redemptions r
           JOIN discount_codes c ON c.id = r.code_id WHERE c.code = 'ceil1'`,
      )
      .first<{ n: number }>();

    // One gift, one redemption row, and the loser told why — read from the
    // database rather than from the two replies, because the replies are
    // written by the same code that did the crediting.
    expect(redeemed?.n).toBe(1);
    expect(credited?.n).toBe(1);
    const texts = [first.replies[0]?.text, second.replies[0]?.text];
    expect(texts.filter((t) => t === menu.DISCOUNT_REFUSED['USED_UP'])).toHaveLength(1);
  });

  it('will not credit a purchase code into the wallet', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await makeCode('percent1', { percent: 50 });

    await handleUpdate(db, press(updateId, telegramId, 'gft'));
    const out = await handleUpdate(db, types(updateId + 1, telegramId, 'percent1'));

    expect(out.replies[0]?.text).toBe(menu.DISCOUNT_REFUSED['NOT_FOR_THIS']);
    const wallet = await db
      .prepare(`SELECT count(*)::int AS n FROM wallet_entries WHERE user_id = ?1`)
      .bind(userId)
      .first<{ n: number }>();
    expect(wallet?.n).toBe(0);
  });
});

describe('a code nobody asked for', () => {
  it('is ignored when typed out of the blue', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    const out = await handleUpdate(db, types(updateId, telegramId, 'save20'));
    expect(out.status).toBe('ignored');
  });
});

describe('how many times one customer may use a code', () => {
  /**
   * Until migration 0059 the answer was «once», and it was not a rule anybody
   * chose — it was a UNIQUE index on `(code_id, user_id)`. The legacy is
   * looser: 23 of its 33 codes allow 2 or 5 uses per person, and not one of
   * them was ever used twice — 93 redemptions, 92 distinct customers, zero
   * duplicate pairs on the 08-11 dump.
   *
   * So these tests are not restoring lost behaviour. They hold a guarantee
   * that used to be structural and is now a count, which is the only thing
   * worth testing about this change.
   */
  it('still refuses a second use when the code allows one', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    await makeCode('peruser1', { kind: 'GIFT_BALANCE', amountIrr: 100_000 });

    await handleUpdate(db, press(updateId, telegramId, 'gft'));
    await handleUpdate(db, types(updateId + 1, telegramId, 'peruser1'));
    await handleUpdate(db, press(updateId + 2, telegramId, 'gft'));
    const again = await handleUpdate(db, types(updateId + 3, telegramId, 'peruser1'));

    expect(again.replies[0]?.text).toBe(menu.DISCOUNT_REFUSED['ALREADY_USED']);
    const redeemed = await db
      .prepare(
        `SELECT count(*)::int AS n FROM discount_redemptions r
           JOIN discount_codes c ON c.id = r.code_id WHERE c.code = 'peruser1'`,
      )
      .first<{ n: number }>();
    expect(redeemed?.n).toBe(1);
  });

  it('allows a second use when the code allows two, and refuses the third', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await makeCode('peruser2', { kind: 'GIFT_BALANCE', amountIrr: 100_000, usesPerUser: 2 });

    for (const step of [0, 2]) {
      await handleUpdate(db, press(updateId + step, telegramId, 'gft'));
      await handleUpdate(db, types(updateId + step + 1, telegramId, 'peruser2'));
    }
    await handleUpdate(db, press(updateId + 4, telegramId, 'gft'));
    const third = await handleUpdate(db, types(updateId + 5, telegramId, 'peruser2'));

    expect(third.replies[0]?.text).toBe(menu.DISCOUNT_REFUSED['ALREADY_USED']);
    // Two redemptions and two credits, read from the database rather than from
    // the replies — the replies are written by the code that did the crediting.
    const redeemed = await db
      .prepare(
        `SELECT count(*)::int AS n FROM discount_redemptions r
           JOIN discount_codes c ON c.id = r.code_id WHERE c.code = 'peruser2'`,
      )
      .first<{ n: number }>();
    const credited = await db
      .prepare(
        `SELECT count(*)::int AS n FROM wallet_entries
          WHERE user_id = ?1 AND kind = 'GIFT_CODE' AND note = 'gift code peruser2'`,
      )
      .bind(userId)
      .first<{ n: number }>();
    expect(redeemed?.n).toBe(2);
    expect(credited?.n).toBe(2);
  });

  /**
   * The ceiling that used to be an index, under the only condition that can
   * break it.
   *
   * `uses_per_user` is now a count, and a count read outside a lock is a race:
   * two taps arriving together both see one redemption, both pass a ceiling of
   * two, and the customer takes a third gift. Sequential calls cannot show it —
   * the second sees the first's row — so both have to be in flight at once.
   *
   * This is the same shape as «honours the use ceiling when two customers
   * arrive together» above, and it rests on the same `FOR UPDATE` in `redeem`.
   */
  it('honours the per-user ceiling when the same customer taps twice at once', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await makeCode('peruserrace', { kind: 'GIFT_BALANCE', amountIrr: 100_000, usesPerUser: 2 });

    // One use already spent, so the ceiling is one away and two concurrent
    // taps are exactly the pair that must not both pass.
    await handleUpdate(db, press(updateId, telegramId, 'gft'));
    await handleUpdate(db, types(updateId + 1, telegramId, 'peruserrace'));

    await handleUpdate(db, press(updateId + 2, telegramId, 'gft'));
    await handleUpdate(db, press(updateId + 4, telegramId, 'gft'));
    await Promise.all([
      handleUpdate(db, types(updateId + 3, telegramId, 'peruserrace')),
      handleUpdate(db, types(updateId + 5, telegramId, 'peruserrace')),
    ]);

    const redeemed = await db
      .prepare(
        `SELECT count(*)::int AS n FROM discount_redemptions r
           JOIN discount_codes c ON c.id = r.code_id WHERE c.code = 'peruserrace'`,
      )
      .first<{ n: number }>();
    const credited = await db
      .prepare(
        `SELECT count(*)::int AS n FROM wallet_entries
          WHERE user_id = ?1 AND kind = 'GIFT_CODE' AND note = 'gift code peruserrace'`,
      )
      .bind(userId)
      .first<{ n: number }>();
    expect(redeemed?.n).toBe(2);
    expect(credited?.n).toBe(2);
  });
});

describe('a code an admin has switched off', () => {
  it('is refused, and says paused rather than expired', async () => {
    // The two words are not interchangeable to a customer: «مهلتش تمام شده» is
    // final and «فعلاً غیرفعال است» is worth waiting for. A shop that pauses a
    // code for an hour must not send everyone who tries it to support.
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    await makeCode('paused1', { kind: 'GIFT_BALANCE', amountIrr: 100_000, status: 'DISABLED' });

    await handleUpdate(db, press(updateId, telegramId, 'gft'));
    const out = await handleUpdate(db, types(updateId + 1, telegramId, 'paused1'));

    expect(out.replies[0]?.text).toBe(menu.DISCOUNT_REFUSED['DISABLED']);
  });

  it('works again once it is switched back on', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await makeCode('paused2', { kind: 'GIFT_BALANCE', amountIrr: 100_000, status: 'DISABLED' });

    await handleUpdate(db, press(updateId, telegramId, 'gft'));
    await handleUpdate(db, types(updateId + 1, telegramId, 'paused2'));

    await db.prepare(`UPDATE discount_codes SET status = 'ACTIVE' WHERE code = 'paused2'`).run();

    await handleUpdate(db, press(updateId + 2, telegramId, 'gft'));
    await handleUpdate(db, types(updateId + 3, telegramId, 'paused2'));

    // The refused attempt left nothing behind — that is what «pause» has to
    // mean. A refusal that had spent the code would make the switch one-way.
    const credited = await db
      .prepare(
        `SELECT count(*)::int AS n FROM wallet_entries
          WHERE user_id = ?1 AND kind = 'GIFT_CODE' AND note = 'gift code paused2'`,
      )
      .bind(userId)
      .first<{ n: number }>();
    expect(credited?.n).toBe(1);
  });
});

describe('a code aimed at one customer', () => {
  it('works for the customer it names', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await makeCode('mine1', {
      kind: 'GIFT_BALANCE',
      amountIrr: 100_000,
      targetUserId: userId,
    });

    await handleUpdate(db, press(updateId, telegramId, 'gft'));
    await handleUpdate(db, types(updateId + 1, telegramId, 'mine1'));

    const credited = await db
      .prepare(
        `SELECT count(*)::int AS n FROM wallet_entries
          WHERE user_id = ?1 AND kind = 'GIFT_CODE' AND note = 'gift code mine1'`,
      )
      .bind(userId)
      .first<{ n: number }>();
    expect(credited?.n).toBe(1);
  });

  it('refuses everybody else, and says whose it is rather than that it exists', async () => {
    const owner = ids();
    const other = ids();
    const ownerId = await makeCustomer(owner.telegramId);
    const otherId = await makeCustomer(other.telegramId);
    await makeCode('mine2', {
      kind: 'GIFT_BALANCE',
      amountIrr: 100_000,
      targetUserId: ownerId,
    });

    await handleUpdate(db, press(other.updateId, other.telegramId, 'gft'));
    const out = await handleUpdate(db, types(other.updateId + 1, other.telegramId, 'mine2'));

    // NOT_FOR_YOU rather than UNKNOWN_CODE: the customer typed something real,
    // and «چنین کدی وجود ندارد» would send them to support to ask why their
    // friend's code does not work.
    expect(out.replies[0]?.text).toBe(menu.DISCOUNT_REFUSED['NOT_FOR_YOU']);
    const credited = await db
      .prepare(`SELECT count(*)::int AS n FROM wallet_entries WHERE user_id = ?1`)
      .bind(otherId)
      .first<{ n: number }>();
    expect(credited?.n).toBe(0);
  });
});

describe('the switch and the target, on the purchase path', () => {
  /**
   * The gift path and the purchase path read the same row through DIFFERENT
   * functions — `redeemGift` and `checkCode` — and neither calls the other.
   *
   * The first version of these tests covered only the gift side, and a
   * guard-removal run showed it: deleting the status check from `checkCode`
   * turned nothing red. Two doors onto one rule need a test at each of them.
   */
  it('refuses a switched-off code on a purchase', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await makeCode('offbuy1', { percent: 25, status: 'DISABLED' });

    expect(await useCode(updateId, telegramId, VIP_PLAN, 'offbuy1')).toBe(
      menu.DISCOUNT_REFUSED['DISABLED'],
    );
    // And the order is placed at full price rather than not at all — a refused
    // code must not cost the customer their purchase.
    await handleUpdate(db, press(updateId + 2, telegramId, `order:${VIP_PLAN}`));
    expect((await lastOrder(userId))?.discount_irr).toBe(0);
  });

  it('takes it again once it is switched back on', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    await makeCode('offbuy2', { percent: 25, status: 'DISABLED' });

    expect(await useCode(updateId, telegramId, VIP_PLAN, 'offbuy2')).toBe(
      menu.DISCOUNT_REFUSED['DISABLED'],
    );
    await db.prepare(`UPDATE discount_codes SET status = 'ACTIVE' WHERE code = 'offbuy2'`).run();

    const said = await useCode(updateId + 3, telegramId, VIP_PLAN, 'offbuy2');
    expect(said).not.toBe(menu.DISCOUNT_REFUSED['DISABLED']);
  });

  it('refuses a targeted code on a purchase by anybody else', async () => {
    const owner = ids();
    const other = ids();
    const ownerId = await makeCustomer(owner.telegramId);
    const otherUserId = await makeCustomer(other.telegramId);
    await makeCode('minebuy1', { percent: 25, targetUserId: ownerId });

    expect(await useCode(other.updateId, other.telegramId, VIP_PLAN, 'minebuy1')).toBe(
      menu.DISCOUNT_REFUSED['NOT_FOR_YOU'],
    );
    await handleUpdate(db, press(other.updateId + 2, other.telegramId, `order:${VIP_PLAN}`));
    expect((await lastOrder(otherUserId))?.discount_irr).toBe(0);
  });

  it('applies it for the customer it names', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await makeCode('minebuy2', { percent: 25, targetUserId: userId });

    const said = await useCode(updateId, telegramId, VIP_PLAN, 'minebuy2');
    expect(said).not.toBe(menu.DISCOUNT_REFUSED['NOT_FOR_YOU']);

    await handleUpdate(db, press(updateId + 2, telegramId, `order:${VIP_PLAN}`));
    // Both halves, because a target check that refuses everybody would pass the
    // test above on its own.
    expect((await lastOrder(userId))?.discount_irr).toBeGreaterThan(0);
  });

  it('lets one customer buy twice with a code that allows two', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await makeCode('buytwice', { percent: 25, usesPerUser: 2 });

    await useCode(updateId, telegramId, VIP_PLAN, 'buytwice');
    await handleUpdate(db, press(updateId + 2, telegramId, `order:${VIP_PLAN}`));
    const first = await lastOrder(userId);
    expect(first?.discount_irr).toBeGreaterThan(0);

    // A genuinely new order — the first is paid off, so `place()` does not
    // reuse it — and the second use is spent on that rather than on the
    // invoice the customer was already looking at.
    await db
      .prepare(`UPDATE orders SET status = 'COMPLETED' WHERE id = ?1`)
      .bind(first!.id)
      .run();

    await useCode(updateId + 4, telegramId, VIP_PLAN, 'buytwice');
    await handleUpdate(db, press(updateId + 6, telegramId, `order:${VIP_PLAN}`));
    const second = await lastOrder(userId);
    expect(second?.id).not.toBe(first?.id);
    expect(second?.discount_irr).toBeGreaterThan(0);
  });

  it('does not spend a second use on the invoice the customer already has', async () => {
    /**
     * The hazard migration 0059 introduces, and the reason the uniqueness
     * moved to `(code_id, order_id)`.
     *
     * `handleOrder` calls `redeem` on EVERY tap of «سفارش», including the taps
     * `place()` answers with the order the customer already has. While the
     * unique index was `(code_id, user_id)` those extra calls were absorbed by
     * the conflict clause. With a per-user ceiling of two and no order-scoped
     * index, the second tap would silently spend the customer's second use on
     * an invoice they were already looking at.
     */
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await makeCode('taptwice', { percent: 25, usesPerUser: 2 });

    await useCode(updateId, telegramId, VIP_PLAN, 'taptwice');
    await handleUpdate(db, press(updateId + 2, telegramId, `order:${VIP_PLAN}`));
    await handleUpdate(db, press(updateId + 3, telegramId, `order:${VIP_PLAN}`));
    await handleUpdate(db, press(updateId + 4, telegramId, `order:${VIP_PLAN}`));

    const redeemed = await db
      .prepare(
        `SELECT count(*)::int AS n FROM discount_redemptions r
           JOIN discount_codes c ON c.id = r.code_id
          WHERE c.code = 'taptwice' AND r.user_id = ?1`,
      )
      .bind(userId)
      .first<{ n: number }>();
    // Three taps, one order, one use spent.
    expect(redeemed?.n).toBe(1);
  });
});
