/**
 * Settlement: what a verified claim does to the sale.
 *
 * Every case here drives the claim to VERIFIED the way the hub does — by status
 * on the row — and then checks the rows the customer's order actually lives on.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { handleUpdate } from '../src/handle.js';
import { settleVerifiedPayments } from '../src/settle.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db, pendingNotifications } from './helpers/env.js';
import { ensureCatalog, makeCustomer, planId } from './helpers/shop.js';

let nextId = 1;
function ids(): { updateId: number; telegramId: number } {
  const n = nextId++ * 10;
  return { updateId: 985_000 + n, telegramId: 860_000 + n };
}

function press(updateId: number, telegramId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `settler${telegramId}` },
      message: { message_id: 4242, chat: { id: telegramId } },
      data,
    },
  };
}

/** Walks a customer to a claim awaiting the bank. Returns the ids it created. */
async function buyAndClaim(
  productCode: string,
): Promise<{ userId: number; telegramId: number; orderId: number; paymentPublicId: string }> {
  const { updateId, telegramId } = ids();
  const userId = await makeCustomer(telegramId);
  const plan = await planId(productCode);

  await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));
  const order = await db
    .prepare(`SELECT id FROM orders WHERE user_id = ?1 ORDER BY id DESC LIMIT 1`)
    .bind(userId)
    .first<{ id: number }>();
  await handleUpdate(db, press(updateId + 1, telegramId, `paid:${order!.id}`));

  const payment = await db
    .prepare(`SELECT public_id FROM payments WHERE user_id = ?1 ORDER BY id DESC LIMIT 1`)
    .bind(userId)
    .first<{ public_id: string }>();

  return {
    userId,
    telegramId,
    orderId: order!.id,
    paymentPublicId: payment!.public_id,
  };
}

/** What the hub does when a bank credit matches, reduced to its one effect. */
async function hubVerifies(paymentPublicId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE payment_claims SET status = 'VERIFIED', updated_at = ?2
        WHERE external_order_id = ?1`,
    )
    .bind(`shikoo:${paymentPublicId}`, Date.now())
    .run();
}

async function statuses(orderId: number, paymentPublicId: string) {
  const order = await db
    .prepare(`SELECT status FROM orders WHERE id = ?1`)
    .bind(orderId)
    .first<{ status: string }>();
  const payment = await db
    .prepare(`SELECT status FROM payments WHERE public_id = ?1`)
    .bind(paymentPublicId)
    .first<{ status: string }>();
  return { order: order?.status, payment: payment?.status };
}

beforeAll(async () => {
  await ensureCatalog();
});

describe('settling a verified payment', () => {
  it('moves the payment and the order, and owes the customer a message', async () => {
    const sale = await buyAndClaim('sim-vip-1m-50');

    // Nothing to settle while the bank has not confirmed anything.
    expect(await settleVerifiedPayments(db)).toBe(0);
    expect(await pendingNotifications()).toEqual([]);
    expect(await statuses(sale.orderId, sale.paymentPublicId)).toEqual({
      order: 'AWAITING_PAYMENT',
      payment: 'AWAITING_REVIEW',
    });

    await hubVerifies(sale.paymentPublicId);
    await settleVerifiedPayments(db);
    // Read from the outbox, not from a return value: what matters is that the
    // message committed with the settlement, not that a string was built.
    const notifications = await pendingNotifications();

    expect(await statuses(sale.orderId, sale.paymentPublicId)).toEqual({
      order: 'PAID',
      payment: 'PAID',
    });
    const mine = notifications.filter((n) => n.chatId === sale.telegramId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.text).toContain('پرداخت شما تایید شد');
    expect(mine[0]?.text).toContain(sale.paymentPublicId);
  });

  it('refuses to settle at all if the message cannot be recorded', async () => {
    // The one assertion that separates "enqueued inside the transaction" from
    // "enqueued right after it". Every other test in this file passes either
    // way — checked on 2026-08-18 by moving the enqueue out, and all eighteen
    // stayed green, which is why this exists.
    //
    // Outside the transaction, a failure here leaves the payment PAID and the
    // order PAID with nobody owed anything, and no later sweep looks at a
    // settled payment again — the customer has paid and will never be told.
    // Inside it, the whole settlement rolls back and the next sweep retries.
    const sale = await buyAndClaim('sim-vip-1m-50');
    await hubVerifies(sale.paymentPublicId);

    await db
      .prepare(
        `ALTER TABLE bot_notifications
           ADD CONSTRAINT tmp_reject_settle CHECK (dedupe_key <> ?1::text)`.replace(
          '?1::text',
          `'settle:${sale.paymentPublicId}'`,
        ),
      )
      .run();
    try {
      await expect(settleVerifiedPayments(db)).rejects.toThrow();

      expect(await statuses(sale.orderId, sale.paymentPublicId)).toEqual({
        order: 'AWAITING_PAYMENT',
        payment: 'AWAITING_REVIEW',
      });
      // Scoped to this sale: the suite shares a database and earlier tests have
      // left their own settled payments behind.
      const mine = (await pendingNotifications()).filter(
        (n) => n.dedupeKey === `settle:${sale.paymentPublicId}`,
      );
      expect(mine).toEqual([]);
    } finally {
      await db
        .prepare(`ALTER TABLE bot_notifications DROP CONSTRAINT tmp_reject_settle`)
        .run();
    }

    // And once the obstacle is gone the next sweep settles it normally, which
    // is what makes the rollback recoverable rather than merely safe.
    expect(await settleVerifiedPayments(db)).toBeGreaterThanOrEqual(1);
    expect(await statuses(sale.orderId, sale.paymentPublicId)).toEqual({
      order: 'PAID',
      payment: 'PAID',
    });
  });

  it('settles once, however many times the sweep runs', async () => {
    const sale = await buyAndClaim('sim-gold-10');
    await hubVerifies(sale.paymentPublicId);

    expect(await settleVerifiedPayments(db)).toBe(1);
    const afterFirst = await pendingNotifications();
    // A second sweep must not tell the customer again, and must not re-settle.
    expect(await settleVerifiedPayments(db)).toBe(0);
    const afterSecond = await pendingNotifications();

    expect(afterFirst.filter((n) => n.chatId === sale.telegramId)).toHaveLength(1);
    expect(afterSecond.filter((n) => n.chatId === sale.telegramId)).toHaveLength(1);
    expect(await statuses(sale.orderId, sale.paymentPublicId)).toEqual({
      order: 'PAID',
      payment: 'PAID',
    });
  });

  it('keeps the money on the books when the order is no longer open', async () => {
    const sale = await buyAndClaim('sim-shop-ai');
    await db
      .prepare(`UPDATE orders SET status = 'CANCELLED' WHERE id = ?1`)
      .bind(sale.orderId)
      .run();
    await hubVerifies(sale.paymentPublicId);

    await settleVerifiedPayments(db);

    // The money arrived, so the payment is paid and stays visible. Forcing the
    // cancelled order to PAID would hide a refund somebody has to make.
    expect(await statuses(sale.orderId, sale.paymentPublicId)).toEqual({
      order: 'CANCELLED',
      payment: 'PAID',
    });
  });

  it('leaves a claim the hub has not verified completely alone', async () => {
    const sale = await buyAndClaim('sim-shop-spotify');

    await settleVerifiedPayments(db);

    expect(await statuses(sale.orderId, sale.paymentPublicId)).toEqual({
      order: 'AWAITING_PAYMENT',
      payment: 'AWAITING_REVIEW',
    });
  });
});
