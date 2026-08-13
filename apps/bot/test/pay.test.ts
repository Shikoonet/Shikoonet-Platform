/**
 * Checkout: the card the customer is shown, and what "I have paid" writes.
 *
 * These assertions are deliberately against the rows rather than against the
 * screens. The review dashboard and the auto-verification engine read
 * `payment_claims`, and a screen that says the right thing over a row that says
 * the wrong one is the failure that costs money.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { MIRZABOT_SOURCE } from '@shikoo/contracts';
import { handleUpdate } from '../src/handle.js';
import * as menu from '../src/menu.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer, planId } from './helpers/shop.js';

/** Checked against `payment_cards` itself, not against a constant this file owns. */
async function activeCard(digits: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT status FROM payment_cards WHERE card_digits = ?1`)
    .bind(digits)
    .first<{ status: string }>();
  return row?.status === 'ACTIVE';
}

let nextId = 1;
function ids(): { updateId: number; telegramId: number } {
  const n = nextId++ * 10;
  return { updateId: 970_000 + n, telegramId: 840_000 + n };
}

function press(updateId: number, telegramId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `payer${telegramId}` },
      message: { message_id: 4242, chat: { id: telegramId } },
      data,
    },
  };
}

async function orderIdOf(userId: number): Promise<number> {
  const row = await db
    .prepare(`SELECT id FROM orders WHERE user_id = ?1 ORDER BY id DESC LIMIT 1`)
    .bind(userId)
    .first<{ id: number }>();
  if (!row) throw new Error(`no order for user ${userId}`);
  return row.id;
}

async function paymentsOf(userId: number) {
  const rows = await db
    .prepare(
      `SELECT public_id, amount_irr, method, status, assigned_card_number
         FROM payments WHERE user_id = ?1 ORDER BY id`,
    )
    .bind(userId)
    .all<{
      public_id: string;
      amount_irr: number;
      method: string;
      status: string;
      assigned_card_number: string | null;
    }>();
  return rows.results;
}

async function claimsOf(userId: number) {
  const rows = await db
    .prepare(
      `SELECT c.external_order_id, c.expected_amount_irr, c.source_system, c.status,
              c.card_digits, c.target_financial_account_id, c.paid_clicked_at, c.customer_reference
         FROM payment_claims c
         JOIN payments p ON ('shikoo:' || p.public_id) = c.external_order_id
        WHERE p.user_id = ?1
        ORDER BY c.created_at`,
    )
    .bind(userId)
    .all<{
      external_order_id: string;
      expected_amount_irr: number;
      source_system: string;
      status: string;
      card_digits: string | null;
      target_financial_account_id: string | null;
      paid_clicked_at: number | null;
      customer_reference: string | null;
    }>();
  return rows.results;
}

beforeAll(async () => {
  await ensureCatalog();
});

describe('the checkout screen', () => {
  it('shows the exact amount and a card, and opens a pending payment', async () => {
    const { updateId, telegramId } = ids();
    const user = await makeCustomer(telegramId);
    const plan = await planId('sim-vip-1m-50');

    const placed = await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));

    const payments = await paymentsOf(user);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      amount_irr: 1_950_000,
      method: 'CARD_TO_CARD',
      status: 'PENDING',
    });

    const text = placed.replies[0]?.text ?? '';
    expect(text).toContain('195,000 تومان');
    // Which card is not this test's business — rotation hands out the
    // least-recently-used one of however many the database holds. What must
    // hold is that the number on the screen is the number on the row, and that
    // the row names a card that really is active.
    const card = payments[0]!.assigned_card_number!;
    expect(text).toContain(menu.formatCard(card));
    expect(await activeCard(card)).toBe(true);
    // Nothing to review until the customer says they paid.
    expect(await claimsOf(user)).toHaveLength(0);
  });

  it('keeps showing the same card when the customer taps back and forth', async () => {
    const { updateId, telegramId } = ids();
    const user = await makeCustomer(telegramId);
    const plan = await planId('sim-gold-10');

    await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));
    await handleUpdate(db, press(updateId + 1, telegramId, `order:${plan}`));

    // Two cards would mean the money lands on one and we look for it on another.
    const payments = await paymentsOf(user);
    expect(payments).toHaveLength(1);
  });

  it('says so rather than drawing a checkout with nowhere to pay', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    const plan = await planId('sim-shop-ai');

    await db.prepare(`UPDATE payment_cards SET status = 'DISABLED'`).run();
    try {
      const outcome = await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));
      expect(outcome.replies[0]?.text).toBe(menu.NO_CARD_AVAILABLE);
    } finally {
      await db.prepare(`UPDATE payment_cards SET status = 'ACTIVE'`).run();
    }
  });
});

describe('"I have paid"', () => {
  it('opens one claim the review screen can see', async () => {
    const { updateId, telegramId } = ids();
    const user = await makeCustomer(telegramId);
    const plan = await planId('sim-vip-1m-50');

    await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));
    const order = await orderIdOf(user);
    const before = Date.now();
    const paid = await handleUpdate(db, press(updateId + 1, telegramId, `paid:${order}`));

    expect(paid.status).toBe('processed');
    expect(paid.replies[0]?.text).toContain('در حال بررسی');

    const claims = await claimsOf(user);
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;
    expect(claim).toMatchObject({
      expected_amount_irr: 1_950_000,
      // Names the card-to-card protocol, which is what every review query and
      // the auto-verification engine filter on.
      source_system: MIRZABOT_SOURCE,
      status: 'PENDING',
      customer_reference: String(telegramId),
    });
    // The claim must carry the card the customer was actually shown, or the
    // matcher looks for the money on the wrong account.
    const payments = await paymentsOf(user);
    expect(claim.card_digits).toBe(payments[0]?.assigned_card_number);
    // The card resolved to an account, so the engine can compare a bank SMS
    // against it instead of reporting UNMAPPED_CARD.
    expect(claim.target_financial_account_id).not.toBeNull();
    // Which bot opened it is readable from the id, not from source_system.
    expect(claim.external_order_id).toMatch(/^shikoo:[0-9a-f]{10}$/);
    // Anchors the ±5 minute window the matcher compares against.
    expect(claim.paid_clicked_at).toBeGreaterThanOrEqual(before);

    expect(payments[0]?.status).toBe('AWAITING_REVIEW');
  });

  it('does not open a second claim when the button is pressed twice', async () => {
    const { updateId, telegramId } = ids();
    const user = await makeCustomer(telegramId);
    const plan = await planId('sim-gold-10');

    await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));
    const order = await orderIdOf(user);
    await handleUpdate(db, press(updateId + 1, telegramId, `paid:${order}`));
    const again = await handleUpdate(db, press(updateId + 2, telegramId, `paid:${order}`));

    expect(again.replies[0]?.text).toContain('قبلاً ثبت شده');
    expect(await claimsOf(user)).toHaveLength(1);
  });

  it('will not let one customer claim another customer’s order', async () => {
    const { updateId, telegramId } = ids();
    const victim = await makeCustomer(telegramId);
    const plan = await planId('sim-shop-spotify');
    await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));
    const victimOrder = await orderIdOf(victim);

    const attacker = ids();
    await makeCustomer(attacker.telegramId);
    const outcome = await handleUpdate(
      db,
      press(attacker.updateId, attacker.telegramId, `paid:${victimOrder}`),
    );

    // The order simply does not exist for anyone but its owner.
    expect(outcome.replies[0]?.text).toBe(menu.ORDER_GONE);
    expect(await claimsOf(victim)).toHaveLength(0);
    const payments = await paymentsOf(victim);
    expect(payments[0]?.status).toBe('PENDING');
  });

  it('answers an order that never reached checkout without writing anything', async () => {
    const { updateId, telegramId } = ids();
    const user = await makeCustomer(telegramId);
    const row = await db
      .prepare(
        `INSERT INTO orders (public_id, user_id, kind, quantity, unit_price_irr, total_irr, status)
         VALUES ('nocheckout1', ?1, 'NEW_PURCHASE', 1, 1000, 1000, 'AWAITING_PAYMENT')
         RETURNING id`,
      )
      .bind(user)
      .first<{ id: number }>();

    const outcome = await handleUpdate(db, press(updateId, telegramId, `paid:${row!.id}`));

    expect(outcome.replies[0]?.text).toBe(menu.ORDER_GONE);
    expect(await claimsOf(user)).toHaveLength(0);
  });
});
