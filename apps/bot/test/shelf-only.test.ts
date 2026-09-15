/**
 * A panel with no third party behind it sells ONLY what is on its shelf.
 *
 * Sam, 2026-09-15: «فقط باید از روی قفسه انبار اکانت رو تحویل بده، اگر هم
 * اکانتی موجود نبود در قفسه انبار، بیاد و به مشتری بگه اکانتی فعلا موجود
 * نیست و همچنین ازش پول نگیره». And on renewal: «اکانتها یک بار مصرف هستن و
 * قابلیت تمدید ندارن».
 *
 * Before this the shop took the money, found the shelf empty, marked the order
 * COMPLETED through the manual adapter and told the customer a person was
 * finishing it — a queue no screen showed. The rule now has four halves and
 * each is pinned here: the button says «ناموجود», the tap writes no invoice,
 * an invoice HOLDS its row for its whole life (0063), and delivery hands over
 * exactly the held row.
 */

import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/handle.js';
import { expireUnpaidOrders } from '../src/expire.js';
import { provisionPaidOrders } from '../src/provision.js';
import * as menu from '../src/menu.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db, assertSchema } from './helpers/env.js';
import { ensureCatalog, makeCustomer, planId, providerId, categoryIdOfProduct } from './helpers/shop.js';

const NOW_MS = 1_800_000_000_000;
let nextId = 1;
function ids(): { updateId: number; telegramId: number } {
  const n = nextId++ * 10;
  return { updateId: 761_000 + n, telegramId: 761_000 + n };
}

function press(updateId: number, telegramId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `shelf${telegramId}` },
      message: { message_id: 55, chat: { id: telegramId } },
      data,
    },
  };
}

const deadPanel = (async () =>
  Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof globalThis.fetch;

/** One account on the sim-shop shelf, for the AI plan. */
async function shelve(plan: number, username: string): Promise<number> {
  const provider = await providerId('sim-shop');
  const row = await db
    .prepare(
      `INSERT INTO provisioning_stock
         (plan_id, provider_id, remote_username, remote_ref, subscription_url, secret)
       VALUES (?1, ?2, ?3, '{"kind":"stock"}'::jsonb, NULL, 'pw-1')
       RETURNING id`,
    )
    .bind(plan, provider, username)
    .first<{ id: number }>();
  return row!.id;
}

async function stockRow(id: number) {
  return db
    .prepare(`SELECT status, order_id FROM provisioning_stock WHERE id = ?1`)
    .bind(id)
    .first<{ status: string; order_id: number | null }>();
}

async function ordersOf(telegramId: number) {
  const { results } = await db
    .prepare(
      `SELECT o.id, o.status FROM orders o JOIN users u ON u.id = o.user_id
        WHERE u.telegram_id = ?1 ORDER BY o.id`,
    )
    .bind(telegramId)
    .all<{ id: number; status: string }>();
  return results;
}

const buttons = (out: Awaited<ReturnType<typeof handleUpdate>>) =>
  out.replies[0]?.keyboard?.flat() ?? [];

beforeAll(async () => {
  await assertSchema();
  await ensureCatalog();
});
beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  // The seed stocks the AI shelf so other suites can buy from it; this suite
  // is about the shelf itself and starts from nothing on it. USED rows stay —
  // they belong to orders.
  const plan = await planId('sim-shop-ai');
  await db
    .prepare(
      `DELETE FROM provisioning_stock
        WHERE (plan_id = ?1 AND status <> 'USED') OR remote_username LIKE 'shelf-only-%'`,
    )
    .bind(plan)
    .run();
});
afterEach(() => vi.restoreAllMocks());

describe('what the customer sees', () => {
  it('draws an empty shelf as «ناموجود», and the tap writes no invoice', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    const plan = await planId('sim-shop-ai');
    const cat = await categoryIdOfProduct('sim-shop-ai');

    // The category holds two one-config services, so the list is the tier
    // list; the AI one is a service of one config and its button IS the plan.
    const list = await handleUpdate(db, press(updateId, telegramId, `cat:${cat}`));
    const product = await productOf(plan);
    const shown = buttons(list).find(
      (b) => b.callback_data === `plan:${plan}` || b.callback_data === `prd:${product}`,
    );
    expect(shown?.text).toContain('ناموجود');

    const tap = await handleUpdate(db, press(updateId + 1, telegramId, `plan:${plan}`));
    expect(tap.replies[0]?.text).toBe(menu.PLAN_OUT_OF_STOCK);
    expect(buttons(tap).some((b) => b.callback_data?.startsWith('order:'))).toBe(false);

    // The button in a month-old message: still no invoice.
    const forced = await handleUpdate(db, press(updateId + 2, telegramId, `order:${plan}`));
    expect(forced.replies[0]?.text).toBe(menu.PLAN_OUT_OF_STOCK);
    expect(await ordersOf(telegramId)).toEqual([]);
  });

  it('sells the shelf while there is something on it — and holds the row for the invoice', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    const plan = await planId('sim-shop-ai');
    const stock = await shelve(plan, 'shelf-only-a@mail.test');

    const tap = await handleUpdate(db, press(updateId, telegramId, `plan:${plan}`));
    expect(buttons(tap).some((b) => b.callback_data === `order:${plan}`)).toBe(true);
    expect(tap.replies[0]?.text).not.toContain('ناموجود');

    const invoice = await handleUpdate(db, press(updateId + 1, telegramId, `order:${plan}`));
    const [order] = await ordersOf(telegramId);
    expect(order?.status).toBe('AWAITING_PAYMENT');
    expect(invoice.replies[0]?.text).toContain('تومان');
    // The row is this invoice's now, and nobody else's.
    expect(await stockRow(stock)).toEqual({ status: 'RESERVED', order_id: order!.id });

    // A second tap on the same plan reuses the open invoice — and its hold.
    await handleUpdate(db, press(updateId + 2, telegramId, `order:${plan}`));
    expect(await ordersOf(telegramId)).toHaveLength(1);
    expect(await stockRow(stock)).toEqual({ status: 'RESERVED', order_id: order!.id });
  });

  it('gives the last account to one invoice, and tells the second customer it is gone', async () => {
    const a = ids();
    const b = ids();
    await makeCustomer(a.telegramId);
    await makeCustomer(b.telegramId);
    const plan = await planId('sim-shop-ai');
    await shelve(plan, 'shelf-only-last@mail.test');

    await handleUpdate(db, press(a.updateId, a.telegramId, `order:${plan}`));
    expect(await ordersOf(a.telegramId)).toHaveLength(1);

    // The 24-hour window: A has not paid, B arrives. A check at the button
    // would let B in; the hold does not.
    const second = await handleUpdate(db, press(b.updateId, b.telegramId, `order:${plan}`));
    expect(second.replies[0]?.text).toBe(menu.PLAN_OUT_OF_STOCK);
    expect(await ordersOf(b.telegramId)).toEqual([]);
  });
});

describe('what the invoice does with its row', () => {
  it('puts the row back on the shelf when the invoice dies unpaid', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    const plan = await planId('sim-shop-ai');
    const stock = await shelve(plan, 'shelf-only-expire@mail.test');
    await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));
    const [order] = await ordersOf(telegramId);
    expect(await stockRow(stock)).toEqual({ status: 'RESERVED', order_id: order!.id });

    await db
      .prepare(`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = ?1`)
      .bind(order!.id)
      .run();
    expect(await expireUnpaidOrders(db, Date.now())).toBeGreaterThanOrEqual(1);

    expect(await stockRow(stock)).toEqual({ status: 'AVAILABLE', order_id: null });
    expect((await ordersOf(telegramId))[0]?.status).toBe('EXPIRED');
  });

  it('delivers the held row and not the next one when the invoice is paid', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    const plan = await planId('sim-shop-ai');
    const first = await shelve(plan, 'shelf-only-held@mail.test');
    const other = await shelve(plan, 'shelf-only-other@mail.test');
    await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));
    const [order] = await ordersOf(telegramId);
    expect(await stockRow(first)).toEqual({ status: 'RESERVED', order_id: order!.id });

    // Paid, the way the settle sweep marks it.
    await db.prepare(`UPDATE orders SET status = 'PAID' WHERE id = ?1`).bind(order!.id).run();
    await provisionPaidOrders(db, deadPanel, Date.now());

    expect((await ordersOf(telegramId))[0]?.status).toBe('COMPLETED');
    expect(await stockRow(first)).toEqual({ status: 'USED', order_id: order!.id });
    expect(await stockRow(other)).toEqual({ status: 'AVAILABLE', order_id: null });
    const sub = await db
      .prepare(`SELECT remote_username FROM subscriptions WHERE order_id = ?1`)
      .bind(order!.id)
      .first<{ remote_username: string }>();
    expect(sub?.remote_username).toBe('shelf-only-held@mail.test');
  });

  it('fails a paid order that reaches an empty shelf, instead of queueing it for a person', async () => {
    // An order from before 0063, or a shelf somebody emptied by hand: the
    // honest answer is the one a refusing panel gets, not COMPLETED.
    const { telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const plan = await planId('sim-shop-ai');
    const row = await db
      .prepare(
        `INSERT INTO orders (public_id, user_id, kind, plan_id, quantity, unit_price_irr, total_irr, status)
         VALUES (?1, ?2, 'NEW_PURCHASE', ?3, 1, 9000000, 9000000, 'PAID') RETURNING id`,
      )
      .bind(`shlf${String(telegramId).slice(-6)}`, userId, plan)
      .first<{ id: number }>();

    await provisionPaidOrders(db, deadPanel, Date.now());

    const status = await db.prepare(`SELECT status FROM orders WHERE id = ?1`).bind(row!.id).first<{ status: string }>();
    expect(status?.status).toBe('FAILED');
    const subs = await db.prepare(`SELECT id FROM subscriptions WHERE order_id = ?1`).bind(row!.id).all();
    expect(subs.results).toEqual([]);
  });
});

describe('renewing', () => {
  it('does not offer to renew an account from the shelf — it is bought once', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const shelfPanel = await providerId('sim-shop');
    const vpnPanel = await providerId('sim-vip');
    for (const [publicId, provider] of [
      [`shelf-only-${telegramId}-a`, shelfPanel],
      [`shelf-only-${telegramId}-v`, vpnPanel],
    ] as const) {
      await db
        .prepare(
          `INSERT INTO subscriptions (public_id, user_id, provider_id, plan_name_at_sale, remote_username,
                                      price_irr, status, purchased_at, expires_at)
           VALUES (?1, ?2, ?3, 'x', ?1, 1000, 'ACTIVE', now(), now() + interval '5 days')`,
        )
        .bind(publicId, userId, provider)
        .run();
    }
    const out = await handleUpdate(db, press(updateId, telegramId, 'renew'));
    const offered = buttons(out).map((b) => b.callback_data ?? '');
    const subs = await db
      .prepare(`SELECT id, provider_id FROM subscriptions WHERE user_id = ?1`)
      .bind(userId)
      .all<{ id: number; provider_id: number }>();
    const onShelf = subs.results.find((s) => s.provider_id === shelfPanel)!;
    const onVpn = subs.results.find((s) => s.provider_id === vpnPanel)!;
    expect(offered).toContain(`rnw:${onVpn.id}`);
    expect(offered).not.toContain(`rnw:${onShelf.id}`);
    // And the button in an old message.
    const forced = await handleUpdate(db, press(updateId + 1, telegramId, `rnw:${onShelf.id}`));
    expect(forced.replies[0]?.text).toBe(menu.RENEWAL_GONE);
  });
});

async function productOf(plan: number): Promise<number> {
  const row = await db.prepare(`SELECT product_id FROM product_plans WHERE id = ?1`).bind(plan).first<{ product_id: number }>();
  return row!.product_id;
}
