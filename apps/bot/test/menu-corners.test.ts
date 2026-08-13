/**
 * The three corners of the menu that used to answer "coming soon": support,
 * education, and referrals.
 *
 * Two of them are read-only screens and the interesting part is what they do
 * when the admin has set nothing up. The third moves money — ten percent of a
 * referred customer's first purchase — and that is where the assertions are.
 *
 * The rules are production's, read off the 2026-08-11 dump rather than chosen:
 * `statussupportpv = onpvsupport`, `affiliatespercentage = 10`,
 * `porsant_one_buy = on_buy_porsant` (first purchase only), and the joining
 * gift `Discount = offDiscountaffiliates`, which is why no gift is paid here.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/handle.js';
import * as menu from '../src/menu.js';
import { COMMISSION_PERCENT, payReferralCommission, referrerFromPayload } from '../src/referral.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer, planId } from './helpers/shop.js';

const NOW_MS = Date.UTC(2026, 7, 14, 9, 0, 0);

let nextId = 1;
function ids(): { updateId: number; telegramId: number } {
  const n = nextId++ * 10;
  return { updateId: 640_000 + n, telegramId: 660_000 + n };
}

function press(updateId: number, telegramId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `crn${telegramId}` },
      message: { message_id: 5, chat: { id: telegramId } },
      data,
    },
  };
}

function starts(updateId: number, telegramId: number, text = '/start'): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: telegramId },
      from: { id: telegramId, username: `crn${telegramId}` },
      text,
    },
  };
}

async function setSetting(key: string, value: string | null): Promise<void> {
  if (value === null) {
    await db.prepare(`DELETE FROM settings WHERE scope = 'bot' AND key = ?1`).bind(key).run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO settings (scope, key, value, updated_at)
       VALUES ('bot', ?1, to_jsonb(?2::text), now())
       ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value`,
    )
    .bind(key, value)
    .run();
}

let VIP_PLAN = 0;
let VIP_PRICE = 0;

beforeAll(async () => {
  await ensureCatalog();
  VIP_PLAN = await planId('sim-vip-1m-50');
  const row = await db
    .prepare(`SELECT price_irr FROM product_plans WHERE id = ?1`)
    .bind(VIP_PLAN)
    .first<{ price_irr: number }>();
  VIP_PRICE = row!.price_irr;
});

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  await setSetting('statussupportpv', 'onpvsupport');
  await setSetting('id_support', 'shikoo_sim_support');
  await setSetting('username', 'Test_Shikoo_bot');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('support', () => {
  it('sends the customer to the handle the admin set', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);

    const out = await handleUpdate(db, press(updateId, telegramId, 'sup'));

    expect(out.replies[0]?.text).toContain('@shikoo_sim_support');
  });

  it('says so instead of inventing a handle when none is set', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    await setSetting('id_support', null);

    const out = await handleUpdate(db, press(updateId, telegramId, 'sup'));

    expect(out.replies[0]?.text).toBe(menu.SUPPORT_UNAVAILABLE);
    expect(out.replies[0]?.text).not.toContain('@');
  });

  it('respects the switch, not just the handle', async () => {
    // The admin can turn direct support off while leaving the handle in place.
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    await setSetting('statussupportpv', 'offpvsupport');

    const out = await handleUpdate(db, press(updateId, telegramId, 'sup'));

    expect(out.replies[0]?.text).toBe(menu.SUPPORT_UNAVAILABLE);
  });
});

describe('education', () => {
  it('lists the articles and opens one', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);

    const list = await handleUpdate(db, press(updateId, telegramId, 'hlp'));
    expect(list.replies[0]?.text).toBe(menu.CHOOSE_HELP);
    const first = list.replies[0]?.keyboard?.[0]?.[0];
    expect(first?.callback_data).toMatch(/^hlp:\d+$/);

    const article = await handleUpdate(db, press(updateId + 1, telegramId, first!.callback_data));
    expect(article.replies[0]?.text).toContain('اتصال در اندروید');
  });

  it('does not open an article that has been switched off', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    const row = await db
      .prepare(`SELECT id FROM help_articles WHERE active ORDER BY id LIMIT 1`)
      .first<{ id: number }>();
    await db.prepare(`UPDATE help_articles SET active = false WHERE id = ?1`).bind(row!.id).run();

    const out = await handleUpdate(db, press(updateId, telegramId, `hlp:${row!.id}`));

    expect(out.replies[0]?.text).toBe(menu.HELP_EMPTY);
    await db.prepare(`UPDATE help_articles SET active = true WHERE id = ?1`).bind(row!.id).run();
  });

  it('lists the apps with their links', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);

    const out = await handleUpdate(db, press(updateId, telegramId, 'app'));

    expect(out.replies[0]?.text).toContain('v2rayNG');
    expect(out.replies[0]?.text).toContain('https://');
  });
});

describe('referrals', () => {
  it('records who brought a new customer, and only the first link', async () => {
    const first = await makeCustomer(ids().telegramId);
    const second = await makeCustomer(ids().telegramId);
    const { updateId, telegramId } = ids();

    await handleUpdate(db, starts(updateId, telegramId, `/start ${first}`));
    // A second link, later, must not move the attribution.
    await handleUpdate(db, starts(updateId + 1, telegramId, `/start ${second}`));

    const row = await db
      .prepare(`SELECT referred_by FROM users WHERE telegram_id = ?1`)
      .bind(telegramId)
      .first<{ referred_by: number | null }>();
    expect(row?.referred_by).toBe(first);
  });

  it('refuses a payload that is not a customer', async () => {
    const { updateId, telegramId } = ids();

    await handleUpdate(db, starts(updateId, telegramId, '/start 999999999'));
    await handleUpdate(db, starts(updateId + 1, telegramId, '/start ../../etc'));

    const row = await db
      .prepare(`SELECT referred_by FROM users WHERE telegram_id = ?1`)
      .bind(telegramId)
      .first<{ referred_by: number | null }>();
    expect(row?.referred_by).toBeNull();
  });

  it('refuses a payload that is the customer themselves', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);

    await handleUpdate(db, starts(updateId, telegramId, `/start ${userId}`));

    const row = await db
      .prepare(`SELECT referred_by FROM users WHERE id = ?1`)
      .bind(userId)
      .first<{ referred_by: number | null }>();
    expect(row?.referred_by).toBeNull();
  });

  it('reads only a plain number as a referrer', () => {
    expect(referrerFromPayload('42')).toBe(42);
    expect(referrerFromPayload('0')).toBeNull();
    expect(referrerFromPayload('-1')).toBeNull();
    expect(referrerFromPayload('4 2')).toBeNull();
    expect(referrerFromPayload(undefined)).toBeNull();
  });

  it('shows the link, the count and what it has earned', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const invited = await makeCustomer(ids().telegramId);
    await db
      .prepare(`UPDATE users SET referred_by = ?1 WHERE id = ?2`)
      .bind(userId, invited)
      .run();

    const out = await handleUpdate(db, press(updateId, telegramId, 'ref'));

    expect(out.replies[0]?.text).toContain(`https://t.me/Test_Shikoo_bot?start=${userId}`);
    expect(out.replies[0]?.text).toContain(`${COMMISSION_PERCENT}٪`);
  });

  it('pays ten percent of a first purchase, once', async () => {
    const referrer = await makeCustomer(ids().telegramId);
    const buyerTelegram = ids().telegramId;
    const buyer = await makeCustomer(buyerTelegram);
    await db
      .prepare(`UPDATE users SET referred_by = ?1 WHERE id = ?2`)
      .bind(referrer, buyer)
      .run();
    const order = await db
      .prepare(
        `INSERT INTO orders (public_id, user_id, kind, plan_id, quantity,
                             unit_price_irr, discount_irr, total_irr, status)
         VALUES (?1, ?2, 'NEW_PURCHASE', ?3, 1, ?4, 0, ?4, 'PAID')
         RETURNING id`,
      )
      .bind(`ref-${buyerTelegram}`, buyer, VIP_PLAN, VIP_PRICE)
      .first<{ id: number }>();

    const paid = await payReferralCommission(db as never, order!.id);
    const again = await payReferralCommission(db as never, order!.id);

    expect(paid).toBe(Math.floor((VIP_PRICE * COMMISSION_PERCENT) / 100));
    // The second call is the sweep running twice. The unique key answers.
    expect(again).toBeNull();
    const wallet = await db
      .prepare(
        `SELECT count(*)::int AS n, coalesce(sum(amount_irr), 0)::bigint AS total
           FROM wallet_entries WHERE user_id = ?1 AND kind = 'REFERRAL_BONUS'`,
      )
      .bind(referrer)
      .first<{ n: number; total: number }>();
    expect(wallet).toMatchObject({ n: 1, total: Math.floor((VIP_PRICE * COMMISSION_PERCENT) / 100) });
  });

  it('pays nothing on a second purchase', async () => {
    const referrer = await makeCustomer(ids().telegramId);
    const buyerTelegram = ids().telegramId;
    const buyer = await makeCustomer(buyerTelegram);
    await db
      .prepare(`UPDATE users SET referred_by = ?1 WHERE id = ?2`)
      .bind(referrer, buyer)
      .run();
    for (const n of [1, 2]) {
      await db
        .prepare(
          `INSERT INTO orders (public_id, user_id, kind, plan_id, quantity,
                               unit_price_irr, discount_irr, total_irr, status)
           VALUES (?1, ?2, 'NEW_PURCHASE', ?3, 1, ?4, 0, ?4, 'PAID')`,
        )
        .bind(`ref2-${buyerTelegram}-${n}`, buyer, VIP_PLAN, VIP_PRICE)
        .run();
    }
    const second = await db
      .prepare(`SELECT id FROM orders WHERE public_id = ?1`)
      .bind(`ref2-${buyerTelegram}-2`)
      .first<{ id: number }>();

    expect(await payReferralCommission(db as never, second!.id)).toBeNull();
  });

  it('pays nothing on a wallet top-up', async () => {
    // Otherwise the commission is paid twice: once on the money going in, and
    // once on whatever that money then buys.
    const referrer = await makeCustomer(ids().telegramId);
    const buyerTelegram = ids().telegramId;
    const buyer = await makeCustomer(buyerTelegram);
    await db
      .prepare(`UPDATE users SET referred_by = ?1 WHERE id = ?2`)
      .bind(referrer, buyer)
      .run();
    const order = await db
      .prepare(
        `INSERT INTO orders (public_id, user_id, kind, quantity,
                             unit_price_irr, discount_irr, total_irr, status)
         VALUES (?1, ?2, 'WALLET_TOPUP', 1, 1000000, 0, 1000000, 'COMPLETED')
         RETURNING id`,
      )
      .bind(`reftop-${buyerTelegram}`, buyer)
      .first<{ id: number }>();

    expect(await payReferralCommission(db as never, order!.id)).toBeNull();
  });

  it('pays nothing when nobody referred the buyer', async () => {
    const buyerTelegram = ids().telegramId;
    const buyer = await makeCustomer(buyerTelegram);
    const order = await db
      .prepare(
        `INSERT INTO orders (public_id, user_id, kind, plan_id, quantity,
                             unit_price_irr, discount_irr, total_irr, status)
         VALUES (?1, ?2, 'NEW_PURCHASE', ?3, 1, ?4, 0, ?4, 'PAID')
         RETURNING id`,
      )
      .bind(`refnone-${buyerTelegram}`, buyer, VIP_PLAN, VIP_PRICE)
      .first<{ id: number }>();

    expect(await payReferralCommission(db as never, order!.id)).toBeNull();
  });
});
