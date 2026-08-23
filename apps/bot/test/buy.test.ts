import { beforeAll, describe, expect, it } from 'vitest';
import { handleUpdate } from '../src/handle.js';
import * as menu from '../src/menu.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db } from './helpers/env.js';
import {
  ensureCatalog,
  makeCustomer,
  planId,
  planIdIn,
  productId,
  providerId,
} from './helpers/shop.js';

/**
 * The buy flow end to end, through the real handler and the real database:
 * /start, the shop, one panel, one plan, one order.
 */

let nextId = 1;
function ids(): { updateId: number; telegramId: number } {
  const n = nextId++ * 10;
  return { updateId: 950_000 + n, telegramId: 820_000 + n };
}

function press(updateId: number, telegramId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `buyer${telegramId}` },
      message: { message_id: 4242, chat: { id: telegramId } },
      data,
    },
  };
}

function startUpdate(updateId: number, telegramId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: telegramId, username: `buyer${telegramId}` },
      chat: { id: telegramId },
      text: '/start',
    },
  };
}

async function orderRows(userId: number) {
  const rows = await db
    .prepare(
      `SELECT public_id, kind, plan_id, quantity, unit_price_irr, discount_irr, total_irr, status
         FROM orders WHERE user_id = ?1 ORDER BY id`,
    )
    .bind(userId)
    .all<{
      public_id: string;
      kind: string;
      plan_id: number;
      quantity: number;
      unit_price_irr: number;
      discount_irr: number;
      total_irr: number;
      status: string;
    }>();
  return rows.results;
}

beforeAll(async () => {
  await ensureCatalog();
});

describe('walking from /start to an order', () => {
  it('greets with the menu, lists panels, lists plans, and books the order', async () => {
    const { updateId, telegramId } = ids();
    const vip = await providerId('sim-vip');
    const plan = await planId('sim-vip-1m-50');

    const start = await handleUpdate(db, startUpdate(updateId, telegramId));
    expect(start.status).toBe('processed');
    const menuButtons = start.replies[0]?.keyboard?.flat().map((b) => b.callback_data) ?? [];
    expect(menuButtons).toContain('buy');
    // A greeting is a new message, not an edit of one.
    expect(start.replies[0]?.editMessageId).toBeUndefined();

    const product = await productId('sim-vip-1m-50');
    const shop = await handleUpdate(db, press(updateId + 1, telegramId, 'buy'));
    // Services, not locations. «خرید اشتراک» opens the levels directly — a
    // customer's first question is which one they want, and the panel that
    // delivers it is named on the plan's own page.
    expect(shop.replies[0]?.text).toBe(menu.CHOOSE_PRODUCT);
    // The menu is replaced in place, so the chat does not fill with dead screens.
    expect(shop.replies[0]?.editMessageId).toBe(4242);
    const offered = shop.replies[0]?.keyboard?.flat().map((b) => b.callback_data) ?? [];
    expect(offered).toContain(`prd:${product}`);
    expect(offered.some((d) => d?.startsWith('panel:'))).toBe(false);

    // Still reachable by a button in a message sent before the change.
    const panel = await handleUpdate(db, press(updateId + 2, telegramId, `panel:${vip}`));
    expect(panel.replies[0]?.text).toBe(menu.CHOOSE_PRODUCT);
    expect(panel.replies[0]?.keyboard?.flat().map((b) => b.callback_data)).toContain(
      `prd:${product}`,
    );

    // A service holding one plan is not a choice, so it opens that plan.
    const only = await handleUpdate(db, press(updateId + 3, telegramId, `prd:${product}`));
    expect(only.replies[0]?.keyboard?.flat().map((b) => b.callback_data)).toContain(
      `order:${plan}`,
    );

    const detail = await handleUpdate(db, press(updateId + 4, telegramId, `plan:${plan}`));
    expect(detail.replies[0]?.text).toContain('195,000 تومان');
    expect(detail.replies[0]?.keyboard?.flat().map((b) => b.callback_data)).toContain(
      `order:${plan}`,
    );

    const placed = await handleUpdate(db, press(updateId + 5, telegramId, `order:${plan}`));
    expect(placed.status).toBe('processed');
    expect(placed.replies[0]?.text).toContain('سفارش شما ثبت شد');

    const user = await userIdOf(telegramId);
    const orders = await orderRows(user);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      kind: 'NEW_PURCHASE',
      plan_id: plan,
      quantity: 1,
      unit_price_irr: 1_950_000,
      discount_irr: 0,
      total_irr: 1_950_000,
      status: 'AWAITING_PAYMENT',
    });
    // The order number the customer was told is the one on the row.
    expect(placed.replies[0]?.text).toContain(orders[0]!.public_id);
  });

  it('charges a discounted customer the discounted price', async () => {
    const { updateId, telegramId } = ids();
    const user = await makeCustomer(telegramId, { discountPercent: 15 });
    const plan = await planId('sim-vip-1m-50');

    const detail = await handleUpdate(db, press(updateId, telegramId, `plan:${plan}`));
    expect(detail.replies[0]?.text).toContain('165,750 تومان');

    await handleUpdate(db, press(updateId + 1, telegramId, `order:${plan}`));

    const orders = await orderRows(user);
    expect(orders).toHaveLength(1);
    // The list price stays on the row: a discounted sale has to remain auditable.
    expect(orders[0]).toMatchObject({
      unit_price_irr: 1_950_000,
      discount_irr: 292_500,
      total_irr: 1_657_500,
    });
  });

  it('gives a second tap the order the customer already has', async () => {
    const { updateId, telegramId } = ids();
    const user = await makeCustomer(telegramId);
    const plan = await planId('sim-gold-10');

    const first = await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));
    const second = await handleUpdate(db, press(updateId + 1, telegramId, `order:${plan}`));

    const orders = await orderRows(user);
    expect(orders).toHaveLength(1);
    expect(second.replies[0]?.text).toContain(orders[0]!.public_id);
    expect(first.replies[0]?.text).toContain(orders[0]!.public_id);
  });

  it('writes a fresh order once the price has moved', async () => {
    const { updateId, telegramId } = ids();
    const user = await makeCustomer(telegramId);
    const plan = await planId('sim-shop-spotify');

    await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));
    await db.prepare(`UPDATE product_plans SET price_irr = 2600000 WHERE id = ?1`).bind(plan).run();
    try {
      await handleUpdate(db, press(updateId + 1, telegramId, `order:${plan}`));
      const orders = await orderRows(user);
      // Quietly charging yesterday's price is worse than a second row.
      expect(orders).toHaveLength(2);
      expect(orders.map((o) => o.total_irr)).toEqual([2_500_000, 2_600_000]);
    } finally {
      await db
        .prepare(`UPDATE product_plans SET price_irr = 2500000 WHERE id = ?1`)
        .bind(plan)
        .run();
    }
  });

  it('refuses a plan that costs nothing instead of writing an unpayable order', async () => {
    // This asserted the opposite until 2026-08-14, and the order it allowed was
    // the one that took the bot down: total 0 renders «pay from wallet»,
    // the overdraft guard passes on `0 < 0`, and the `-0` ledger row breaks
    // `CHECK (amount_irr <> 0)` inside the transaction that also holds the
    // once-only `telegram_updates` row.
    //
    // A free plan is a fixture invention, not a shop: the dump has 21 products
    // and none priced at or below zero — the cheapest is 100,000 IRR. Free
    // trials in the legacy bot are their own feature (`limit_usertest`), gated
    // by `OFFTestAccount`, and are not a plan you buy for nothing.
    const { updateId, telegramId } = ids();
    const user = await makeCustomer(telegramId);
    const plan = await planId('sim-vip-trial');

    const out = await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));

    expect(await orderRows(user)).toHaveLength(0);
    expect(out.replies[0]?.text ?? '').not.toBe('');
  });
});

describe('screens with nothing on them', () => {
  it('says so instead of showing an empty list', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    const empty = await providerId('sim-empty');

    const outcome = await handleUpdate(db, press(updateId, telegramId, `panel:${empty}`));

    expect(outcome.replies[0]?.text).toBe(menu.PANEL_EMPTY);
    // «بازگشت به منو» alone: this screen is only reachable from a button in an
    // old message now, and the shop's first screen is one tap from the menu.
    expect(outcome.replies[0]?.keyboard?.flat().map((b) => b.callback_data)).toEqual(['menu']);
  });

  it('sends a stranger to /start rather than a menu', async () => {
    const { updateId, telegramId } = ids();
    const outcome = await handleUpdate(db, press(updateId, telegramId, 'buy'));
    expect(outcome.status).toBe('ignored');
    expect(outcome.replies[0]?.text).toBe(menu.NOT_REGISTERED);
  });

  it('ignores a callback it does not recognise, silently', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    const outcome = await handleUpdate(db, press(updateId, telegramId, 'deleteEverything:1'));
    expect(outcome.status).toBe('ignored');
    expect(outcome.replies).toEqual([]);
  });

  it('answers a callback that arrived without its message', async () => {
    // Telegram drops the message from the update once it is old enough. There is
    // nothing to edit then, but the private chat id is the user id.
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    const update = press(updateId, telegramId, 'menu');
    delete update.callback_query!.message;

    const outcome = await handleUpdate(db, update);

    expect(outcome.replies[0]?.chatId).toBe(telegramId);
    expect(outcome.replies[0]?.editMessageId).toBeUndefined();
  });

  it('says a section is coming rather than doing nothing', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    const outcome = await handleUpdate(db, press(updateId, telegramId, 'soon'));
    expect(outcome.replies[0]?.text).toBe(menu.SOON);
  });
});

describe('a button press is still exactly once', () => {
  it('books one order for a redelivered press', async () => {
    const { updateId, telegramId } = ids();
    const user = await makeCustomer(telegramId);
    const plan = await planId('sim-shop-ai');

    await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));
    const again = await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));

    expect(again.status).toBe('duplicate');
    expect(again.replies).toEqual([]);
    expect(await orderRows(user)).toHaveLength(1);
  });

  it('records a blocked customer as seen but answers nothing', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    await db
      .prepare(`UPDATE users SET status = 'BLOCKED' WHERE telegram_id = ?1`)
      .bind(telegramId)
      .run();

    const outcome = await handleUpdate(db, press(updateId, telegramId, 'buy'));

    expect(outcome.status).toBe('ignored');
    expect(outcome.replies).toEqual([]);
  });
});

async function userIdOf(telegramId: number): Promise<number> {
  const row = await db
    .prepare(`SELECT id FROM users WHERE telegram_id = ?1`)
    .bind(telegramId)
    .first<{ id: number }>();
  if (!row) throw new Error(`no user for telegram_id ${telegramId}`);
  return row.id;
}

describe('a panel that sells more than one level', () => {
  /**
   * The whole point of the service level, walked the way a customer walks it.
   *
   * Before it, the shop drew plans straight off a panel and labelled each
   * button with its PRODUCT's name — so «پلاتینیوم ۳۰ گیگ» and «پلاتینیوم ۵۰
   * گیگ» came out as two buttons reading «پلاتینیوم», told apart only by a
   * price, and where a migrated name already quotes its price they came out
   * identical. A panel could sell exactly one tier however many groups it had,
   * because `group_ids` lived only on the panel row.
   */
  it('lists services, then the sizes inside the one that was picked', async () => {
    const { updateId, telegramId } = ids();
    const platinum = await productId('sim-vip-platinum');
    const fifty = await planIdIn('sim-vip-platinum', '۵۰ گیگ - یک‌ماهه');

    await handleUpdate(db, startUpdate(updateId, telegramId));

    const shop = await handleUpdate(db, press(updateId + 1, telegramId, 'buy'));
    const services = shop.replies[0]?.keyboard?.flat() ?? [];
    const row = services.find((b) => b.callback_data === `prd:${platinum}`);
    expect(row, 'the service is on the panel screen').toBeDefined();
    // «از», because three sizes have no single price. A bare number here is one
    // the customer then cannot find on the next screen.
    expect(row?.text).toContain('از');
    expect(row?.text).toContain('پلاتینیوم');

    const inside = await handleUpdate(db, press(updateId + 2, telegramId, `prd:${platinum}`));
    expect(inside.replies[0]?.text).toContain('پلاتینیوم');
    const plans = inside.replies[0]?.keyboard?.flat() ?? [];
    // Named by PLAN, and every one of them distinct — this is the assertion the
    // old shape could not have passed.
    const labels = plans.filter((b) => b.callback_data?.startsWith('plan:')).map((b) => b.text);
    expect(labels).toHaveLength(3);
    expect(new Set(labels).size).toBe(3);
    for (const label of labels) expect(label).not.toContain('پلاتینیوم');

    // Cheapest first, and the prices are the plans' own.
    expect(labels[0]).toContain('150,000');
    expect(labels[2]).toContain('540,000');

    const detail = await handleUpdate(db, press(updateId + 3, telegramId, `plan:${fifty}`));
    expect(detail.replies[0]?.text).toContain('220,000 تومان');
    const back = (detail.replies[0]?.keyboard?.flat() ?? []).map((b) => b.callback_data);
    expect(back).toContain(`order:${fifty}`);
    // Back goes to the plan list it came from, not two levels up to the panel.
    expect(back).toContain(`prd:${platinum}`);
    expect(back.some((d) => d?.startsWith('panel:'))).toBe(false);
  });
});
