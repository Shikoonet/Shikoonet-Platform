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
import { activateContinuityMode, deactivateContinuityMode } from '@shikoo/domain';
import { handleUpdate } from '../src/handle.js';
import * as menu from '../src/menu.js';
import { checkoutFor } from '../src/payment.js';
import { settleVerifiedPayments } from '../src/settle.js';
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
              c.card_digits, c.target_financial_account_id, c.paid_clicked_at, c.customer_reference,
              c.fulfilment_mode, c.fulfilled_at, c.fulfilled_by, c.fulfilment_reason
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
      fulfilment_mode: string | null;
      fulfilled_at: number | null;
      fulfilled_by: string | null;
      fulfilment_reason: string | null;
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

  it('will not open a checkout for an order with nothing to pay', async () => {
    // The other half of C1. A claim opened at `expected_amount_irr = 0` can
    // never be settled — auto-verification matches the amount exactly, with no
    // tolerance — so the order would sit in AWAITING_PAYMENT for good while the
    // customer looks at a card and a total of nothing.
    //
    // Asked of the function rather than through the bot on purpose: `place()`
    // refuses to write a zero-total order, so the only way to reach this is the
    // way production would — a row that was already there.
    const { updateId, telegramId } = ids();
    const user = await makeCustomer(telegramId);
    const plan = await planId('sim-vip-1m-50');
    await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));
    const order = await db
      .prepare(`SELECT id FROM orders WHERE user_id = ?1 ORDER BY id DESC LIMIT 1`)
      .bind(user)
      .first<{ id: number }>();

    const checkout = await db.withSession(async (tx) =>
      checkoutFor(tx, user, order!.id, 0, 'zero-total-fixture'),
    );

    expect(checkout).toBeNull();
    const claims = await db
      .prepare(`SELECT count(*)::int AS n FROM payments WHERE order_id = ?1 AND amount_irr = 0`)
      .bind(order!.id)
      .first<{ n: number }>();
    expect(claims?.n).toBe(0);
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

  it('keeps showing the same card when two checkouts race', async () => {
    // The tap-back-and-forth test above is a sequence, and a sequence cannot see
    // this: `checkoutFor` reads the open payment, finds none, rotates a card and
    // inserts. Two callers arriving together both read nothing and both insert.
    //
    // What that costs is not a duplicate row. It is two DIFFERENT card numbers
    // on one order — the customer pays into whichever screen was drawn first,
    // `recordPaidClick` opens the claim against the newest, and
    // auto-verification refuses the pair because the account does not match
    // (condition 5). Real money, correct receipt, stuck in manual review.
    //
    // Two sessions, so these are two transactions and not one; `Promise.all`, so
    // they overlap. `idx_payments_one_open_per_order` (0022) is what decides it.
    const { updateId, telegramId } = ids();
    const user = await makeCustomer(telegramId);
    const plan = await planId('sim-gold-10');
    await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));
    const order = await orderIdOf(user);
    // Start from no open payment, so both racers take the insert path.
    await db.prepare(`DELETE FROM payments WHERE order_id = ?1`).bind(order).run();

    // A second ACTIVE card, and it is what makes this test deterministic rather
    // than lucky. `rotateCard` takes its row `FOR UPDATE SKIP LOCKED`, so with
    // the fixture's single card the second caller is handed nothing and returns
    // before it ever reaches the insert — the race would resolve on the card
    // lock and the index would never be asked. With two, both callers get a
    // card, both reach the insert, and the conflict is the real one.
    await db
      .prepare(
        `INSERT INTO payment_cards (id, financial_account_id, card_digits, holder_name,
                                    status, created_at)
         SELECT '__race-card', financial_account_id, '6219861999999999', 'Race Fixture',
                'ACTIVE', ?1
           FROM payment_cards LIMIT 1`,
      )
      .bind(Date.now())
      .run();

    try {
      const both = await Promise.all([
        db.withSession((tx) => checkoutFor(tx, user, order, 1_000_000, `race-a-${order}`)),
        db.withSession((tx) => checkoutFor(tx, user, order, 1_000_000, `race-b-${order}`)),
      ]);

      const open = await db
        .prepare(
          `SELECT count(*)::int AS n FROM payments
            WHERE order_id = ?1 AND status IN ('PENDING', 'AWAITING_REVIEW')`,
        )
        .bind(order)
        .first<{ n: number }>();
      expect(open?.n).toBe(1);

      // And both callers were told about the SAME one. A surviving single row
      // with one caller shown a card that no row records is the same failure
      // wearing a different shape — they would still pay into a card nothing
      // is expecting money on.
      expect(both[0]).not.toBeNull();
      expect(both[1]).not.toBeNull();
      expect(both[0]?.publicId).toBe(both[1]?.publicId);
      expect(both[0]?.cardDigits).toBe(both[1]?.cardDigits);
      expect(await activeCard(both[0]!.cardDigits)).toBe(true);
    } finally {
      await db.prepare(`DELETE FROM payment_cards WHERE id = '__race-card'`).run();
    }
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

  it('fulfils a current-bot claim opened while Continuity is on', async () => {
    const actor = 'continuity-admin@example.com';
    const reason = 'bank SMS relay is unavailable';
    const activated = await activateContinuityMode(db, {
      actorEmail: actor,
      reason,
      durationMs: 30 * 60 * 1000,
      confirmed: true,
    });
    expect(activated.ok).toBe(true);

    try {
      const { updateId, telegramId } = ids();
      const user = await makeCustomer(telegramId);
      const plan = await planId('sim-vip-1m-50');

      await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));
      const order = await orderIdOf(user);
      await handleUpdate(db, press(updateId + 1, telegramId, `paid:${order}`));

      const claims = await claimsOf(user);
      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatchObject({
        status: 'FULFILLED_UNRECONCILED',
        fulfilment_mode: 'CONTINUITY',
        fulfilled_by: actor,
        fulfilment_reason: reason,
      });
      expect(claims[0]?.fulfilled_at).not.toBeNull();

      // This is the delivery boundary for the current bot. Before the fix the
      // claim stayed PENDING, so the ordinary bot sweep found zero work even
      // though the panel's switch visibly said Continuity was active.
      expect(await settleVerifiedPayments(db)).toBe(1);
      expect((await paymentsOf(user))[0]?.status).toBe('PAID');
      const moved = await db
        .prepare(`SELECT status FROM orders WHERE id = ?1`)
        .bind(order)
        .first<{ status: string }>();
      expect(moved?.status).toBe('PAID');

      const audit = await db
        .prepare(
          `SELECT actor_email, actor_role, reason
             FROM audit_logs
            WHERE entity_id = (SELECT id FROM payment_claims WHERE external_order_id = ?1)
              AND action = 'claim.continuity_fulfilled'`,
        )
        .bind(claims[0]!.external_order_id)
        .first<{ actor_email: string; actor_role: string; reason: string }>();
      expect(audit).toEqual({ actor_email: actor, actor_role: 'SYSTEM', reason });
    } finally {
      await deactivateContinuityMode(db, { actorEmail: actor });
    }
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
