/**
 * Settlement: what a verified claim does to the sale.
 *
 * Every case here drives the claim to VERIFIED the way the hub does — by status
 * on the row — and then checks the rows the customer's order actually lives on.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/handle.js';
import { settleVerifiedPayments } from '../src/settle.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db, pendingNotifications } from './helpers/env.js';
import { invalidateShopSettings } from '../src/settings.js';
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

    // And it is written down somewhere that outlives a log rotation. This used
    // to be a `console.error` and nothing else: the one record in this system
    // that ages out, holding a customer's money with nobody assigned to it.
    const incident = await db
      .prepare(
        `SELECT actor_role, action, entity_id, after_json, reason FROM audit_logs
          WHERE action = 'PAYMENT_NEEDS_REFUND' AND entity_id = ?1`,
      )
      .bind(sale.paymentPublicId)
      .first<{ actor_role: string; action: string; entity_id: string; after_json: string; reason: string }>();

    expect(incident).not.toBeNull();
    expect(incident?.actor_role).toBe('SYSTEM');
    // The state the order was in when it happened, so whoever picks this up
    // does not have to guess why the money could not be applied.
    const detail = JSON.parse(incident!.after_json) as { orderStatus: string; orderId: number };
    expect(detail.orderStatus).toBe('CANCELLED');
    expect(detail.orderId).toBe(sale.orderId);
  });

  it('records nothing when the settlement rolls back', async () => {
    // The incident row is inside the settling transaction on purpose. A record
    // of money needing a refund, for a payment that was never settled at all,
    // sends somebody looking for a problem that does not exist — and the
    // reverse, settling without recording, is the bug this closes.
    const sale = await buyAndClaim('sim-shop-ai');
    await db
      .prepare(`UPDATE orders SET status = 'CANCELLED' WHERE id = ?1`)
      .bind(sale.orderId)
      .run();
    await hubVerifies(sale.paymentPublicId);

    // The message the settlement owes cannot be written, so the whole
    // transaction rolls back — the same lever `refuses to settle at all if the
    // message cannot be recorded` pulls.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await db.prepare(`ALTER TABLE bot_notifications RENAME TO notifications_hidden`).run();
    try {
      await settleVerifiedPayments(db).catch(() => undefined);
    } finally {
      await db.prepare(`ALTER TABLE notifications_hidden RENAME TO bot_notifications`).run();
      errors.mockRestore();
    }

    const incident = await db
      .prepare(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'PAYMENT_NEEDS_REFUND' AND entity_id = ?1`)
      .bind(sale.paymentPublicId)
      .first<{ n: number }>();
    expect(incident?.n).toBe(0);
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

/**
 * Money that is not paid from a shipped constant.
 *
 * Referral commission comes out of the shop's wallet and cannot be taken back.
 * `settleVerifiedPayments` read the rate through `loadShopSettings`, which used
 * to answer a failed read with `DEFAULT_SHOP_SETTINGS` — ten per cent — while
 * the admin's own five sat unread. The comment above that line argued paying
 * something beats paying nothing, and never considered the third option:
 * paying in a minute, when the database answers.
 */
describe('settlement when the shop rules have never been read', () => {
  it('waits instead of paying commission at the shipped rate', async () => {
    const sale = await buyAndClaim('sim-vip-1m-50');
    await hubVerifies(sale.paymentPublicId);

    // The real failure, not a stub: the table is taken away AND the loader has
    // nothing cached, which together is the only state where `fromDatabase` is
    // false. Anything less and it would serve the last good read.
    invalidateShopSettings();
    await db.prepare(`ALTER TABLE settings RENAME TO settings_hidden`).run();
    let settled: number;
    try {
      settled = await settleVerifiedPayments(db);
    } finally {
      await db.prepare(`ALTER TABLE settings_hidden RENAME TO settings`).run();
      invalidateShopSettings();
    }

    expect(settled).toBe(0);
    // Untouched, so the next sweep does the whole thing properly.
    expect(await statuses(sale.orderId, sale.paymentPublicId)).toEqual({
      order: 'AWAITING_PAYMENT',
      payment: 'AWAITING_REVIEW',
    });

    // And it really does settle once the rules can be read again.
    expect(await settleVerifiedPayments(db)).toBe(1);
    expect(await statuses(sale.orderId, sale.paymentPublicId)).toEqual({
      order: 'PAID',
      payment: 'PAID',
    });
  });
});
