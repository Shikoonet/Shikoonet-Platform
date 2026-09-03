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
  planIdsIn,
  categoryIdOfProduct,
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

/** A typed answer, for the flows that ask a question mid-purchase. */
function typed(updateId: number, telegramId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: telegramId, username: `buyer${telegramId}` },
      chat: { id: telegramId },
      text,
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
  it('greets, lists categories, then tiers, then prices, and books the order', async () => {
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
    const category = await categoryIdOfProduct('sim-vip-1m-50');
    const shop = await handleUpdate(db, press(updateId + 1, telegramId, 'buy'));
    // Categories, not locations and not services. «خرید اشتراک» opens the
    // KINDS, and the panel that delivers is named on the plan's own page. A
    // service list sat here until 2026-08-26 and its trouble was that a service
    // is a tier with no single price, so the screen could only show names.
    expect(shop.replies[0]?.text).toBe(menu.CHOOSE_CATEGORY);
    // The menu is replaced in place, so the chat does not fill with dead screens.
    expect(shop.replies[0]?.editMessageId).toBe(4242);
    const offered = shop.replies[0]?.keyboard?.flat().map((b) => b.callback_data) ?? [];
    expect(offered).toContain(`cat:${category}`);
    expect(offered.some((d) => d?.startsWith('panel:'))).toBe(false);
    expect(offered.some((d) => d?.startsWith('prd:'))).toBe(false);

    // The category's SERVICE list — the tiers, which carry no price because a
    // tier does not have one. Connected on 2026-08-27; before that this screen
    // drew every size of every tier in one ladder.
    const tiers = await handleUpdate(db, press(updateId + 2, telegramId, `cat:${category}`));
    const tierButtons = tiers.replies[0]?.keyboard?.flat().map((b) => b.callback_data) ?? [];
    expect(tierButtons).toContain(`prd:${product}`);
    expect(tierButtons.some((d) => d?.startsWith('plan:'))).toBe(false);
    // And a way back up to the categories, not only to the menu.
    expect(tierButtons).toContain('buy');

    // `sim-vip-1m-50` holds exactly one size, so pressing its tier does NOT
    // draw a price list — it opens that price. Asserting a `plan:` button here
    // would be asserting a screen the collapse rule says must not exist.
    // Both still reachable by buttons in messages sent before the change.
    // Telegram keeps a button pressable forever; an old one answering nothing
    // reads as a broken bot rather than an old screen.
    const panel = await handleUpdate(db, press(updateId + 4, telegramId, `panel:${vip}`));
    expect(panel.replies[0]?.text).toBe(menu.CHOOSE_PRODUCT);
    expect(panel.replies[0]?.keyboard?.flat().map((b) => b.callback_data)).toContain(
      `prd:${product}`,
    );

    const only = await handleUpdate(db, press(updateId + 5, telegramId, `prd:${product}`));
    expect(only.replies[0]?.keyboard?.flat().map((b) => b.callback_data)).toContain(
      `order:${plan}`,
    );

    const detail = await handleUpdate(db, press(updateId + 6, telegramId, `plan:${plan}`));
    expect(detail.replies[0]?.text).toContain('195,000 تومان');
    expect(detail.replies[0]?.keyboard?.flat().map((b) => b.callback_data)).toContain(
      `order:${plan}`,
    );

    const placed = await handleUpdate(db, press(updateId + 7, telegramId, `order:${plan}`));
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
    // Two buttons since 2026-08-27. This screen is the SERVICE list again — the
    // shop opens it from a category — so «بازگشت به دسته‌بندی‌ها» has somewhere
    // to go. It had «منو» alone while the only way here was an expired button.
    expect(outcome.replies[0]?.keyboard?.flat().map((b) => b.callback_data)).toEqual([
      'buy',
      'menu',
    ]);
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
  it('lists one tier’s prices, with each size its own distinct button', async () => {
    const { updateId, telegramId } = ids();
    const platinum = await productId('sim-vip-platinum');
    const category = await categoryIdOfProduct('sim-vip-platinum');
    const fifty = await planIdIn('sim-vip-platinum', '۵۰ گیگ - یک‌ماهه');
    const ids3 = await planIdsIn('sim-vip-platinum');

    await handleUpdate(db, startUpdate(updateId, telegramId));

    const shop = await handleUpdate(db, press(updateId + 1, telegramId, 'buy'));
    const first = shop.replies[0]?.keyboard?.flat() ?? [];
    expect(
      first.find((b) => b.callback_data === `cat:${category}`),
      'the category is on the shop screen',
    ).toBeDefined();

    // The tier list, then this tier. Two screens where there used to be one,
    // and the reason is the whole point of the level: «۳۰ گیگ — ۱۵۰٬۰۰۰» on a
    // flat category screen does not say whether it is پلاتینیوم or معمولی.
    const tiers = await handleUpdate(db, press(updateId + 2, telegramId, `cat:${category}`));
    expect(
      (tiers.replies[0]?.keyboard?.flat() ?? []).find((b) => b.callback_data === `prd:${platinum}`),
      'the tier is on the category screen',
    ).toBeDefined();

    const inside = await handleUpdate(db, press(updateId + 3, telegramId, `prd:${platinum}`));
    const buttons = inside.replies[0]?.keyboard?.flat() ?? [];
    const mine = buttons.filter((b) =>
      ids3.some((id) => b.callback_data === `plan:${id}`),
    );
    // Named by PLAN, and every one of them distinct — this is the assertion the
    // old shape could not have passed. The shop used to draw plans straight off
    // a panel labelled with their PRODUCT's name, so «پلاتینیوم ۳۰ گیگ» and
    // «پلاتینیوم ۵۰ گیگ» came out as two buttons both reading «پلاتینیوم».
    expect(mine).toHaveLength(3);
    expect(new Set(mine.map((b) => b.text)).size).toBe(3);
    for (const b of mine) expect(b.text).not.toContain('پلاتینیوم');

    // Cheapest first, which is the default this screen falls back to while
    // nobody has arranged it: `sort_order` is 0 on every row, so price decides.
    expect(mine[0]?.text).toContain('150,000');
    expect(mine[2]?.text).toContain('540,000');

    const detail = await handleUpdate(db, press(updateId + 4, telegramId, `plan:${fifty}`));
    expect(detail.replies[0]?.text).toContain('220,000 تومان');
    const back = (detail.replies[0]?.keyboard?.flat() ?? []).map((b) => b.callback_data);
    expect(back).toContain(`order:${fifty}`);
    // Back goes to the list it came from — this tier's three sizes — not up to
    // the category, and not two levels up to the panel.
    expect(back).toContain(`prd:${platinum}`);
    expect(back).not.toContain(`cat:${category}`);
    expect(back.some((d) => d?.startsWith('panel:'))).toBe(false);
  });
});

/**
 * «نام کاربری دلخواه مشتری» — the panel that asks before it sells.
 *
 * The assertion that justifies this file existing is the last one: tapping
 * «خرید» twice must leave ONE order. `place()` reuses an open order on
 * (user, plan, price, kind, target, quantity), and the chosen name is
 * deliberately not part of that tuple — if it were, a customer changing their
 * mind would get a second AWAITING_PAYMENT row for the same plan.
 */
describe('a panel that asks the customer to name their account', () => {
  const PANEL = 'sim-vip';
  let plan = 0;

  async function setMode(mode: string | null): Promise<void> {
    await db
      .prepare(
        mode === null
          ? `UPDATE provisioning_providers SET config = config - 'username_mode' WHERE code = ?1`
          : `UPDATE provisioning_providers
                SET config = config || jsonb_build_object('username_mode', ?2::text)
              WHERE code = ?1`,
      )
      .bind(...(mode === null ? [PANEL] : [PANEL, mode]))
      .run();
  }

  async function orderCount(userId: number): Promise<number> {
    const row = await db
      .prepare(`SELECT COUNT(*)::int AS n FROM orders WHERE user_id = ?1`)
      .bind(userId)
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  async function nameOn(userId: number): Promise<string | null> {
    const row = await db
      .prepare(`SELECT username_text FROM orders WHERE user_id = ?1 ORDER BY id DESC LIMIT 1`)
      .bind(userId)
      .first<{ username_text: string | null }>();
    return row?.username_text ?? null;
  }

  beforeAll(async () => {
    await ensureCatalog();
    plan = await planId('sim-vip-1m-50');
  });

  it('asks before it writes anything, and takes the name on the second message', async () => {
    const { updateId, telegramId } = ids();
    const user = await makeCustomer(telegramId);
    await setMode('CUSTOMER_TEXT');

    try {
      const asked = await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));

      expect(asked.replies[0]?.text).toBe(menu.ASK_ACCOUNT_NAME);
      // Nothing written. A prompt that had already placed the order would be a
      // customer holding an invoice for an account they had not named.
      expect(await orderCount(user)).toBe(0);

      const placed = await handleUpdate(db, typed(updateId + 1, telegramId, 'RezaVPN'));

      // Sanitised on the way in, so the column holds what the panel will get.
      expect(await nameOn(user)).toBe('rezavpn');
      expect(await orderCount(user)).toBe(1);
      // And it went straight to the invoice rather than back to the plan.
      expect(placed.replies[0]?.text).toContain('تومان');
    } finally {
      await setMode(null);
    }
  });

  it('asks again for a name the panel would refuse, and still writes nothing', async () => {
    const { updateId, telegramId } = ids();
    const user = await makeCustomer(telegramId);
    await setMode('CUSTOMER_TEXT');

    try {
      await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));

      // Persian sanitises to the empty string — the common case for this shop.
      const persian = await handleUpdate(db, typed(updateId + 1, telegramId, 'رضا'));
      expect(persian.replies[0]?.text).toBe(menu.ACCOUNT_NAME_REFUSED);
      expect(await orderCount(user)).toBe(0);

      // Too short is the other half of the same rule.
      const short = await handleUpdate(db, typed(updateId + 2, telegramId, 'ab'));
      expect(short.replies[0]?.text).toBe(menu.ACCOUNT_NAME_REFUSED);
      expect(await orderCount(user)).toBe(0);

      // The question stayed open the whole time.
      const ok = await handleUpdate(db, typed(updateId + 3, telegramId, 'reza'));
      expect(ok.replies[0]?.text).toContain('تومان');
      expect(await orderCount(user)).toBe(1);
    } finally {
      await setMode(null);
    }
  });

  it('gives a second tap the order that already exists, not a second one', async () => {
    const { updateId, telegramId } = ids();
    const user = await makeCustomer(telegramId);
    await setMode('CUSTOMER_TEXT');

    try {
      await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));
      await handleUpdate(db, typed(updateId + 1, telegramId, 'reza'));
      expect(await orderCount(user)).toBe(1);

      // Tapping «خرید» again: the held name means no second prompt, and
      // `place()` reuses the open order.
      await handleUpdate(db, press(updateId + 2, telegramId, `order:${plan}`));

      expect(await orderCount(user)).toBe(1);
    } finally {
      await setMode(null);
    }
  });

  it('rewrites the name on the open order when the customer changes their mind', async () => {
    const { updateId, telegramId } = ids();
    const user = await makeCustomer(telegramId);
    await setMode('CUSTOMER_TEXT');

    try {
      await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));
      await handleUpdate(db, typed(updateId + 1, telegramId, 'firstname'));
      expect(await nameOn(user)).toBe('firstname');

      // A fresh prompt, a different answer. Still one order — the name is not
      // part of what makes an order the same order.
      await db.prepare(`DELETE FROM bot_sessions WHERE user_id = ?1`).bind(user).run();
      await handleUpdate(db, press(updateId + 2, telegramId, `order:${plan}`));
      await handleUpdate(db, typed(updateId + 3, telegramId, 'secondname'));

      expect(await orderCount(user)).toBe(1);
      expect(await nameOn(user)).toBe('secondname');
    } finally {
      await setMode(null);
    }
  });

  it('asks nothing on a panel that builds the name itself', async () => {
    const { updateId, telegramId } = ids();
    const user = await makeCustomer(telegramId);
    await setMode('ORDER_ID');

    try {
      const out = await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));

      expect(out.replies[0]?.text).not.toBe(menu.ASK_ACCOUNT_NAME);
      expect(await orderCount(user)).toBe(1);
      expect(await nameOn(user)).toBeNull();
    } finally {
      await setMode(null);
    }
  });
});
