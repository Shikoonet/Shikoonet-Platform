/**
 * Closing an invoice nobody paid — and never closing one somebody did.
 *
 * `orders.expires_at` and the partial index over it have been in the schema
 * since `0003_sales.sql` and nothing wrote either. Four sweeps ran every poll
 * cycle and none of them expired anything, so a card-to-card invoice — with a
 * specific card number printed on it — stayed open in a customer's chat for
 * ever, long after that card had been rotated out.
 *
 * The dangerous half is the other direction. An order expired while a claim is
 * live is money that arrives, verifies, and settles onto an order `settle.ts`
 * will not advance, because it guards on AWAITING_PAYMENT. The customer has
 * paid, the admin has approved, and nothing happens. The last test here is that
 * one, driven as an actual race rather than as a sequence.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONTENT, invalidateBotContent } from '../src/botContent.js';
import { expireUnpaidOrders, ORDER_TTL_MS } from '../src/expire.js';
import { handleUpdate } from '../src/handle.js';
import * as menu from '../src/menu.js';
import { run } from '../src/poll.js';
import type { TelegramApi, TelegramUpdate } from '../src/telegram.js';
import { balanceFor } from '../src/wallet.js';
import { db, pendingNotifications } from './helpers/env.js';
import { ensureCatalog, makeCustomer, planId } from './helpers/shop.js';

let nextId = 1;
function ids(): { updateId: number; telegramId: number } {
  const n = nextId++ * 10;
  return { updateId: 730_000 + n, telegramId: 731_000 + n };
}

function press(updateId: number, telegramId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `exp${telegramId}` },
      message: { message_id: 55, chat: { id: telegramId } },
      data,
    },
  };
}

/** Buys something and stops at the invoice, without pressing «پرداخت کردم». */
async function buy(productCode: string) {
  const { updateId, telegramId } = ids();
  const userId = await makeCustomer(telegramId);
  const plan = await planId(productCode);
  await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));
  const order = await db
    .prepare(
      `SELECT id, public_id, expires_at FROM orders
        WHERE user_id = ?1 ORDER BY id DESC LIMIT 1`,
    )
    .bind(userId)
    .first<{ id: number; public_id: string; expires_at: string | null }>();
  return { updateId, telegramId, userId, order: order! };
}

/**
 * Ages an invoice past its deadline without waiting a day for it.
 *
 * Refuses an order that has no deadline instead of inventing one. Otherwise
 * every test below would keep passing with the deadline taken back out of
 * `place()` — the fixture would be supplying the very thing under test.
 */
async function age(orderId: number): Promise<void> {
  const aged = await db
    .prepare(
      `UPDATE orders SET expires_at = now() - interval '1 minute'
        WHERE id = ?1 AND expires_at IS NOT NULL
      RETURNING id`,
    )
    .bind(orderId)
    .first();
  if (!aged) throw new Error(`order ${orderId} was written with no deadline to age`);
}

/** Puts money in the way the settle sweep does, without the sweep. */
async function credit(userId: number, amountIrr: number, key: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO wallet_entries (user_id, amount_irr, kind, idempotency_key)
       VALUES (?1, ?2, 'TOPUP', ?3) ON CONFLICT (idempotency_key) DO NOTHING`,
    )
    .bind(userId, amountIrr, key)
    .run();
}

/**
 * Holds the lock the sweep takes, runs `press`, then expires the order under it.
 *
 * The 200ms is not a guess at how long the handler takes — it is long enough for
 * the press to have reached the lock and stopped there, which is the only state
 * this can be in once it has stopped making progress.
 */
async function raceAgainstExpiry(
  orderId: number,
  press: () => Promise<{ replies: { text: string }[] }>,
) {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const sweeping = db.withSession(async (tx) => {
    await tx.prepare(`SELECT id FROM orders WHERE id = ?1 FOR UPDATE`).bind(orderId).first();
    await held;
    await tx.prepare(`UPDATE orders SET status = 'EXPIRED' WHERE id = ?1`).bind(orderId).run();
  });

  const pressing = press();
  await new Promise((r) => setTimeout(r, 200));
  release();

  await sweeping;
  return pressing;
}

async function statuses(orderId: number) {
  const order = await db
    .prepare(`SELECT status FROM orders WHERE id = ?1`)
    .bind(orderId)
    .first<{ status: string }>();
  const payment = await db
    .prepare(`SELECT status FROM payments WHERE order_id = ?1 ORDER BY id DESC LIMIT 1`)
    .bind(orderId)
    .first<{ status: string }>();
  return { order: order?.status, payment: payment?.status };
}

beforeAll(async () => {
  await ensureCatalog();
});

describe('an invoice with a deadline', () => {
  it('gets one, a day out, the moment the order is written', async () => {
    // Measured against the wall clock the database keeps, not against our own
    // constant echoed back: the column has to hold a real timestamp a day away,
    // which is what the sweep and the index both read.
    const { order } = await buy('sim-vip-1m-50');
    expect(order.expires_at).not.toBeNull();

    const gap = new Date(order.expires_at!).getTime() - Date.now();
    expect(gap).toBeGreaterThan(ORDER_TTL_MS - 60_000);
    expect(gap).toBeLessThanOrEqual(ORDER_TTL_MS + 60_000);
  });

  it('is left alone until the deadline passes', async () => {
    const sale = await buy('sim-gold-10');
    await expireUnpaidOrders(db);
    const notes = await pendingNotifications();
    expect(notes.filter((n) => n.chatId === sale.telegramId)).toEqual([]);
    expect((await statuses(sale.order.id)).order).toBe('AWAITING_PAYMENT');
  });

  it('is closed once it does, and the customer is warned off the stale card', async () => {
    const sale = await buy('sim-vip-1m-20');
    await age(sale.order.id);

    await expireUnpaidOrders(db);

    const notes = await pendingNotifications();
    expect(await statuses(sale.order.id)).toEqual({ order: 'EXPIRED', payment: 'EXPIRED' });
    const mine = notes.filter((n) => n.chatId === sale.telegramId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.text).toContain(sale.order.public_id);
    // The invoice with the card on it is still sitting in their chat. Telling
    // them the order expired without telling them not to pay it is half a
    // message.
    expect(mine[0]?.text).toContain('واریز نکنید');
  });

  it('says so, rather than opening a claim, when the button is pressed too late', async () => {
    const sale = await buy('sim-vip-1m-50');
    await age(sale.order.id);
    await expireUnpaidOrders(db);

    const out = await handleUpdate(
      db,
      press(sale.updateId + 1, sale.telegramId, `paid:${sale.order.id}`),
    );

    expect(out.replies[0]?.text).toBe(menu.ORDER_EXPIRED);
    const claims = await db
      .prepare(
        `SELECT count(*)::int AS n
           FROM payment_claims c JOIN payments p ON c.external_order_id = 'shikoo:' || p.public_id
          WHERE p.order_id = ?1`,
      )
      .bind(sale.order.id)
      .first<{ n: number }>();
    expect(claims?.n).toBe(0);
  });

  it('tells each customer about their own order and nobody else’s', async () => {
    const a = await buy('sim-vip-1m-50');
    const b = await buy('sim-gold-10');
    await age(a.order.id);
    await age(b.order.id);

    await expireUnpaidOrders(db);

    const notes = await pendingNotifications();
    const to = (id: number) => notes.filter((n) => n.chatId === id);

    expect(to(a.telegramId)).toHaveLength(1);
    expect(to(a.telegramId)[0]?.text).toContain(a.order.public_id);
    expect(to(a.telegramId)[0]?.text).not.toContain(b.order.public_id);
    expect(to(b.telegramId)).toHaveLength(1);
  });

  it('is not closed once somebody has said they paid it', async () => {
    const sale = await buy('sim-vip-1m-20');
    await handleUpdate(db, press(sale.updateId + 1, sale.telegramId, `paid:${sale.order.id}`));
    await age(sale.order.id);

    await expireUnpaidOrders(db);

    const notes = await pendingNotifications();
    expect(notes.filter((n) => n.chatId === sale.telegramId)).toEqual([]);
    expect(await statuses(sale.order.id)).toEqual({
      order: 'AWAITING_PAYMENT',
      payment: 'AWAITING_REVIEW',
    });
  });

  it('is closed once the operator refuses the payment', async () => {
    /*
     * The other half of the test above, and the half that was missing.
     *
     * The guard is right to hold while a payment is under review: expiring an
     * order somebody has claimed to have paid is how a verified payment settles
     * onto an order nothing will advance. But it protects the order for exactly
     * as long as the payment row is live — and until 2026-08-24 the dashboard's
     * «رد» wrote only `payment_claims`, so the payment stayed AWAITING_REVIEW
     * after being refused and the guard went on protecting an order whose
     * payment had been rejected. Not for a day. For good.
     *
     * `REJECTED` here is the state the reject route now writes; the panel's own
     * `receipt.test.ts` sibling asserts it produces exactly this. The two meet
     * at a value, not at a comment.
     */
    const sale = await buy('sim-vip-1m-20');
    await handleUpdate(db, press(sale.updateId + 1, sale.telegramId, `paid:${sale.order.id}`));
    await age(sale.order.id);

    await db
      .prepare(`UPDATE payments SET status = 'REJECTED' WHERE order_id = ?1`)
      .bind(sale.order.id)
      .run();

    await expireUnpaidOrders(db);

    expect(await statuses(sale.order.id)).toEqual({
      order: 'EXPIRED',
      payment: 'REJECTED',
    });
  });

  it('expires once, however many times the sweep runs', async () => {
    const sale = await buy('sim-gold-10');
    await age(sale.order.id);

    await expireUnpaidOrders(db);

    const first = await pendingNotifications();
    await expireUnpaidOrders(db);
    const second = await pendingNotifications();
    // One message, and it is still there after the second sweep rather than
    // gone: the outbox holds it until it is actually delivered.
    expect(first.filter((n) => n.chatId === sale.telegramId)).toHaveLength(1);
    expect(second.filter((n) => n.chatId === sale.telegramId)).toHaveLength(1);
  });
});

describe('a sweep that runs on a bot nobody is talking to', () => {
  it('still speaks the shop own words, not the ones the code ships', async () => {
    // A restart at night. The sweeps run, no update ever arrives, and only
    // `handleUpdate` refreshed the module bindings these messages are built
    // from — so a customer was told about their own money in the wording the
    // code ships rather than the sentence the shop wrote, and the shop's words
    // appeared only once some unrelated customer happened to say hello.
    // Exactly the bug 6ac5f1b closed on the update path, left open on this one.
    //
    // Driven through `run` rather than by calling the sweep directly, because
    // the sweep was never wrong: the wiring around it was.
    const sale = await buy('sim-gold-10');
    await age(sale.order.id);
    await db
      .prepare(
        `INSERT INTO bot_texts (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .bind('ORDER_EXPIRED_TITLE', 'سفارش شما بسته شد چون پرداخت نشد')
      .run();

    // The state a process is in before its first update: bindings at defaults.
    invalidateBotContent();
    menu.applyContent(DEFAULT_CONTENT);

    const sent: { chatId: number; text: string }[] = [];
    const controller = new AbortController();
    const api: TelegramApi = {
      getMe: async () => ({ username: null }),
      // One cycle, and never a single update — which is the whole point.
      getUpdates: async () => {
        controller.abort();
        return [];
      },
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
      deleteMessage: async () => undefined,
      sendPhoto: async () => undefined,
      sendPhotoBytes: async () => undefined,
      sendDocument: async () => undefined,
      getChatMember: async () => 'member',
      editMessageText: async () => undefined,
      answerCallbackQuery: async () => undefined,
    };

    await run(db, api, { signal: controller.signal, timeoutSec: 1 });

    const mine = sent.filter((m) => m.chatId === sale.telegramId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.text).toContain('سفارش شما بسته شد چون پرداخت نشد');

    await db.prepare(`DELETE FROM bot_texts WHERE key = 'ORDER_EXPIRED_TITLE'`).run();
    invalidateBotContent();
    menu.applyContent(DEFAULT_CONTENT);
  });
});

describe('a press that arrives while the sweep is running', () => {
  it('never leaves a live claim against an expired order', async () => {
    // The race, driven rather than described. A transaction holds the lock the
    // sweep takes on its candidates; the press starts, blocks on that lock, and
    // only continues once the order has been expired underneath it.
    //
    // Remove the `SELECT … FOR UPDATE` from `recordPaidClick` and this goes red:
    // the press reads an order that is still AWAITING_PAYMENT in its own
    // snapshot and opens a claim for money that will verify onto an order
    // `settle.ts` will never advance.
    const sale = await buy('sim-vip-1m-50');
    await age(sale.order.id);

    const out = await raceAgainstExpiry(sale.order.id, () =>
      handleUpdate(db, press(sale.updateId + 1, sale.telegramId, `paid:${sale.order.id}`)),
    );

    expect(out.replies[0]?.text).toBe(menu.ORDER_EXPIRED);
    const claims = await db
      .prepare(
        `SELECT count(*)::int AS n
           FROM payment_claims c JOIN payments p ON c.external_order_id = 'shikoo:' || p.public_id
          WHERE p.order_id = ?1`,
      )
      .bind(sale.order.id)
      .first<{ n: number }>();
    expect(claims?.n).toBe(0);
  });

  it('never takes the balance for an order it then refuses to deliver', async () => {
    // The same race as above, down the other payment path — and until
    // 2026-08-15 this one was open, because `wpay` read the order with a plain
    // SELECT and judged its status in application code while the card path
    // three files away held a lock.
    //
    // What the customer got was the worst shape a money bug has: the balance
    // debited, a PAID payment row written, «پرداخت شد» on screen, an order left
    // EXPIRED that `provisionPaidOrders` only ever skips, and no refund —
    // because `refundOrder` runs when provisioning fails, and provisioning
    // never started.
    const sale = await buy('sim-vip-1m-50');
    await credit(sale.userId, 9_000_000, `exp:${sale.userId}:a`);
    const before = await balanceFor(db, sale.userId);
    await age(sale.order.id);

    const out = await raceAgainstExpiry(sale.order.id, () =>
      handleUpdate(db, press(sale.updateId + 1, sale.telegramId, `wpay:${sale.order.id}`)),
    );

    expect(out.replies[0]?.text).toBe(menu.ORDER_GONE);
    // The assertion that matters: their money is still theirs.
    expect(await balanceFor(db, sale.userId)).toBe(before);
    const paid = await db
      .prepare(`SELECT count(*)::int AS n FROM payments WHERE order_id = ?1 AND status = 'PAID'`)
      .bind(sale.order.id)
      .first<{ n: number }>();
    expect(paid?.n).toBe(0);
  });
});
