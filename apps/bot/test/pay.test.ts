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
import type { TelegramUpdate } from '../src/telegram.js';
import { balanceFor } from '../src/wallet.js';
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

  it('does not fulfil on «پرداخت کردم», even while Continuity is on', async () => {
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
        status: 'PENDING',
        fulfilment_mode: null,
        fulfilled_by: null,
        fulfilment_reason: null,
      });
      expect(claims[0]?.fulfilled_at).toBeNull();
      expect((await paymentsOf(user))[0]?.status).toBe('AWAITING_REVIEW');
      const moved = await db
        .prepare(`SELECT status FROM orders WHERE id = ?1`)
        .bind(order)
        .first<{ status: string }>();
      expect(moved?.status).toBe('AWAITING_PAYMENT');

      const audit = await db
        .prepare(
          `SELECT COUNT(*)::int AS n
             FROM audit_logs
            WHERE entity_id = (SELECT id FROM payment_claims WHERE external_order_id = ?1)
              AND action = 'claim.continuity_fulfilled'`,
        )
        .bind(claims[0]!.external_order_id)
        .first<{ n: number }>();
      expect(audit?.n).toBe(0);
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

/**
 * «پرداختی نکردم» — issue #199.
 *
 * One mis-tap on «پرداخت کردم» used to freeze the order for good: the expiry
 * sweep skips an order under review, the wallet refuses one somebody says they
 * paid by card, and re-entering the plan hands the same order back. The only
 * exit was an operator rejecting a claim with nothing on it.
 *
 * Asserted against the rows, as the rest of this file is: a claim that reads
 * REJECTED is what takes the row off the review screen and out of the matcher.
 */
describe('"I did not pay"', () => {
  function sendsPhoto(updateId: number, telegramId: number, fileId: string): TelegramUpdate {
    return {
      update_id: updateId,
      message: {
        message_id: updateId,
        chat: { id: telegramId },
        from: { id: telegramId, username: `unpd${telegramId}` },
        photo: [{ file_id: fileId }],
      },
    };
  }

  async function orderStatus(orderId: number): Promise<string> {
    const row = await db
      .prepare(`SELECT status FROM orders WHERE id = ?1`)
      .bind(orderId)
      .first<{ status: string }>();
    return row!.status;
  }

  const buttons = (out: Awaited<ReturnType<typeof handleUpdate>>): string[] =>
    out.replies[0]?.keyboard?.flat().map((b) => b.callback_data ?? '') ?? [];

  async function credit(userId: number, amountIrr: number, key: string): Promise<void> {
    await db
      .prepare(
        `INSERT INTO wallet_entries (user_id, amount_irr, kind, idempotency_key)
         VALUES (?1, ?2, 'TOPUP', ?3) ON CONFLICT (idempotency_key) DO NOTHING`,
      )
      .bind(userId, amountIrr, key)
      .run();
  }

  /** Order placed, «پرداخت کردم» pressed: the state the button exists for. */
  async function claimed(planCode = 'sim-vip-1m-50') {
    const { updateId, telegramId } = ids();
    const user = await makeCustomer(telegramId);
    const plan = await planId(planCode);
    await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));
    const order = await orderIdOf(user);
    const paid = await handleUpdate(db, press(updateId + 1, telegramId, `paid:${order}`));
    return { updateId, telegramId, user, plan, order, paid };
  }

  it('asks first, and «no» lands back on the screen it came from', async () => {
    const { updateId, telegramId, user, order, paid } = await claimed();
    // The way out is on the screen that opened the claim, and names the order.
    expect(buttons(paid)).toContain(`unpd:${order}`);

    const asked = await handleUpdate(db, press(updateId + 2, telegramId, `unpd:${order}`));
    expect(asked.replies[0]?.text).toBe(menu.WITHDRAW_CONFIRM);
    expect(buttons(asked)).toEqual([`unpd2:${order}`, `paid:${order}`]);
    // Asking changed nothing.
    expect((await claimsOf(user)).map((c) => c.status)).toEqual(['PENDING']);

    const no = await handleUpdate(db, press(updateId + 3, telegramId, `paid:${order}`));
    expect(no.replies[0]?.text).toContain('قبلاً ثبت شده');
    expect(buttons(no)).toContain(`unpd:${order}`);
    expect((await claimsOf(user)).map((c) => c.status)).toEqual(['PENDING']);
  });

  it('closes an empty claim and puts the same invoice back, same card', async () => {
    const { updateId, telegramId, user, plan, order } = await claimed();
    const card = (await paymentsOf(user))[0]!.assigned_card_number!;

    const withdrawn = await handleUpdate(db, press(updateId + 2, telegramId, `unpd2:${order}`));
    expect(withdrawn.replies[0]?.text).toContain('پس گرفته شد');
    // The invoice, as it was: the same card, and the buttons an invoice has.
    expect(withdrawn.replies[0]?.text).toContain(menu.formatCard(card));
    expect(buttons(withdrawn)).toContain(`paid:${order}`);
    expect(buttons(withdrawn)).not.toContain(`unpd:${order}`);

    // The claim leaves the review screen; the payment beneath it closes with
    // the enum's word for it; a fresh PENDING row on the same card takes its
    // place; the order itself is untouched.
    expect((await claimsOf(user)).map((c) => c.status)).toEqual(['REJECTED']);
    const payments = await paymentsOf(user);
    expect(payments.map((p) => p.status)).toEqual(['REJECTED', 'PENDING']);
    expect(payments[1]?.assigned_card_number).toBe(card);
    const rejected = await db
      .prepare(`SELECT reject_reason FROM payments WHERE public_id = ?1`)
      .bind(payments[0]!.public_id)
      .first<{ reject_reason: string }>();
    expect(rejected?.reject_reason).toBe('CUSTOMER_WITHDREW');
    expect(await orderStatus(order)).toBe('AWAITING_PAYMENT');
    const audit = await db
      .prepare(
        `SELECT after_json FROM audit_logs
          WHERE action = 'claim.rejected'
            AND entity_id = (SELECT id FROM payment_claims WHERE external_order_id = ?1)`,
      )
      .bind((await claimsOf(user))[0]!.external_order_id)
      .first<{ after_json: string }>();
    expect(JSON.parse(audit!.after_json)).toMatchObject({ reason: 'CUSTOMER_WITHDREW' });

    // Re-entering the plan is the same order and the same card — nothing
    // rotated under the customer — and a second «پرداخت کردم» opens a second
    // claim rather than answering «قبلاً».
    const again = await handleUpdate(db, press(updateId + 3, telegramId, `order:${plan}`));
    expect(again.replies[0]?.text).toContain(menu.formatCard(card));
    expect(await orderIdOf(user)).toBe(order);
    await handleUpdate(db, press(updateId + 4, telegramId, `paid:${order}`));
    expect((await claimsOf(user)).map((c) => c.status)).toEqual(['REJECTED', 'PENDING']);
    expect((await paymentsOf(user)).map((p) => p.status)).toEqual(['REJECTED', 'AWAITING_REVIEW']);
  });

  it('a second «yes» — a double tap, a redelivery — redraws the invoice rather than «سفارش پیدا نشد»', async () => {
    const { updateId, telegramId, user, order } = await claimed();
    await handleUpdate(db, press(updateId + 2, telegramId, `unpd2:${order}`));

    const twice = await handleUpdate(db, press(updateId + 3, telegramId, `unpd2:${order}`));
    expect(twice.replies[0]?.text).not.toBe(menu.ORDER_GONE);
    expect(buttons(twice)).toContain(`paid:${order}`);
    // And wrote nothing more.
    expect((await claimsOf(user)).map((c) => c.status)).toEqual(['REJECTED']);
    expect((await paymentsOf(user)).map((p) => p.status)).toEqual(['REJECTED', 'PENDING']);
  });

  it('the wallet refusal carries the way out, and after it the wallet goes through', async () => {
    const { updateId, telegramId, user, order } = await claimed();
    await credit(user, 5_000_000, `unpd-fund:${user}`);

    // #187's guard: the customer said they sent bank money, so the balance is
    // refused — and this is exactly where the mis-tapped customer lands.
    const refused = await handleUpdate(db, press(updateId + 2, telegramId, `wpay:${order}`));
    expect(refused.replies[0]?.text).toContain('قبلاً ثبت شده');
    expect(buttons(refused)).toContain(`unpd:${order}`);

    const back = await handleUpdate(db, press(updateId + 3, telegramId, `unpd2:${order}`));
    expect(buttons(back)).toContain(`wpay:${order}`);
    await handleUpdate(db, press(updateId + 4, telegramId, `wpay:${order}`));
    expect(await orderStatus(order)).toBe('PAID');
    expect(await balanceFor(db, user)).toBe(5_000_000 - 1_950_000);
  });

  it('refuses once a receipt is on the claim — that decision is a person’s', async () => {
    const { updateId, telegramId, user, order } = await claimed();
    await handleUpdate(db, sendsPhoto(updateId + 2, telegramId, 'AgACAgQAAxkBAAIBunpd0001'));

    const refused = await handleUpdate(db, press(updateId + 3, telegramId, `unpd2:${order}`));
    expect(refused.replies[0]?.text).toContain('نمی‌شود پسش گرفت');
    expect((await claimsOf(user)).map((c) => c.status)).toEqual(['PENDING']);
    expect((await paymentsOf(user)).map((p) => p.status)).toEqual(['AWAITING_REVIEW']);
  });

  it('refuses once the matcher has seen a deposit it could not settle', async () => {
    // For this bot's claims a found-but-unsettled deposit is a suspect reason
    // on a claim that is still PENDING — `recordMirzabotSuspect` never moves
    // the status. «No transaction» is the one reason that is NOT evidence.
    for (const [reason, expected] of [
      ['AMBIGUOUS_CLAIMS', 'evidence'],
      ['AMOUNT_MISMATCH', 'evidence'],
      ['OUTSIDE_AUTO_MATCH_WINDOW', 'evidence'],
      ['NO_TRANSACTION', 'withdrawn'],
    ] as const) {
      const { updateId, telegramId, user, order } = await claimed();
      await db
        .prepare(
          `UPDATE payment_claims SET suspect_reason = ?2
            WHERE external_order_id = 'shikoo:' || ?1`,
        )
        .bind((await paymentsOf(user))[0]!.public_id, reason)
        .run();

      const out = await handleUpdate(db, press(updateId + 2, telegramId, `unpd2:${order}`));
      const claimStatus = (await claimsOf(user)).map((c) => c.status);
      if (expected === 'evidence') {
        expect(out.replies[0]?.text, reason).toContain('نمی‌شود پسش گرفت');
        expect(claimStatus, reason).toEqual(['PENDING']);
      } else {
        expect(out.replies[0]?.text, reason).toContain('پس گرفته شد');
        expect(claimStatus, reason).toEqual(['REJECTED']);
      }
    }
  });

  it('will not let one customer withdraw another customer’s claim', async () => {
    const { telegramId, user: victim, order: victimOrder } = await claimed();

    const attacker = ids();
    await makeCustomer(attacker.telegramId);
    for (const step of ['unpd', 'unpd2'] as const) {
      const outcome = await handleUpdate(
        db,
        press(attacker.updateId + (step === 'unpd' ? 0 : 1), attacker.telegramId, `${step}:${victimOrder}`),
      );
      expect(outcome.replies[0]?.text, step).toBe(menu.ORDER_GONE);
    }
    expect((await claimsOf(victim)).map((c) => c.status)).toEqual(['PENDING']);
    expect(telegramId).toBeGreaterThan(0);
  });
});
