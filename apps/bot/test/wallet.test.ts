/**
 * The wallet, against the real database.
 *
 * This is the highest-risk thing the new bot touches: 387 production customers
 * hold 13,390,450 Toman between them, and Mirzabot's version of this is a
 * mutable integer with no history that has already produced one account at
 * -5,940,000 with nothing to explain it.
 *
 * So the tests here are about the ways money goes wrong rather than the happy
 * path: paying twice, depositing twice, spending what is not there, and a
 * balance that stops agreeing with the entries that produced it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { newPublicId, placeTopupOrder, type PlacedOrder } from '../src/order.js';
import { provisionPaidOrders } from '../src/provision.js';
import { settleVerifiedPayments } from '../src/settle.js';
import {
  balanceFor,
  spendOnOrder,
  topupAmount,
  topupNeededIrr,
  TOPUP_AMOUNTS_IRR,
  TOPUP_MIN_IRR,
} from '../src/wallet.js';
import { handleUpdate } from '../src/handle.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db, pendingNotifications } from './helpers/env.js';
import { ensureCatalog, makeCustomer, planId } from './helpers/shop.js';

/** Payment rows a "I have paid" press could still claim against. */
async function openPayments(orderId: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT count(*)::int AS n FROM payments
        WHERE order_id = ?1 AND status IN ('PENDING', 'AWAITING_REVIEW')`,
    )
    .bind(orderId)
    .first<{ n: number }>();
  return row!.n;
}

/** One button press, the way `poll.ts` hands it over. */
function press(updateId: number, telegramId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `w${telegramId}` },
      message: { message_id: 42, chat: { id: telegramId } },
      data,
    },
  };
}

beforeEach(async () => {
  await ensureCatalog();
});

/**
 * A deposit order, insisting it exists.
 *
 * `placeTopupOrder` can now refuse — an order that comes to nothing is not
 * written — and every deposit here is for a positive amount, so a null is a
 * broken fixture rather than a case to handle. Failing loudly beats eleven
 * non-null assertions that would each go stale on their own.
 */
async function topupOrder(userId: number, amountIrr: number): Promise<PlacedOrder> {
  const placed = await db.withSession(async (tx) => placeTopupOrder(tx, userId, amountIrr));
  if (!placed) throw new Error(`fixture deposit of ${amountIrr} was refused`);
  return placed;
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

describe('what a customer may deposit', () => {
  it('offers nothing below the shop own floor or above its ceiling', () => {
    // Both numbers come from the production PaySetting rows, not from taste:
    // minbalancecart 80,000 Toman and the ordinary tier max of 400,000.
    for (const amount of TOPUP_AMOUNTS_IRR) {
      expect(amount).toBeGreaterThanOrEqual(800_000);
      expect(amount).toBeLessThanOrEqual(4_000_000);
    }
  });

  it('reads a choice, never an amount', () => {
    expect(topupAmount(1)).toBe(TOPUP_AMOUNTS_IRR[0]);
    expect(topupAmount(TOPUP_AMOUNTS_IRR.length)).toBe(
      TOPUP_AMOUNTS_IRR[TOPUP_AMOUNTS_IRR.length - 1],
    );
    // A forged callback naming a choice we never offered buys nothing.
    expect(topupAmount(0)).toBeNull();
    expect(topupAmount(99)).toBeNull();
    expect(topupAmount(-1)).toBeNull();
  });

  it('never asks for a deposit the shop would refuse', () => {
    // 30,000 Toman short, but the shop does not accept a transfer under 80,000.
    expect(topupNeededIrr(1_000_000, 700_000)).toBe(TOPUP_MIN_IRR);
    // Comfortably short: ask for the difference itself.
    expect(topupNeededIrr(5_000_000, 1_000_000)).toBe(4_000_000);
    // Already affordable.
    expect(topupNeededIrr(1_000_000, 1_000_000)).toBeNull();
    expect(topupNeededIrr(1_000_000, 2_000_000)).toBeNull();
  });
});

describe('one order is paid once, and the database is what says so', () => {
  // The application used to carry this on its own, with an
  // `ON CONFLICT (public_id) DO NOTHING` whose conflict could never fire —
  // `public_id` is minted fresh on every insert. It was safe only because the
  // poll loop is serial, which is a fact about today's caller rather than about
  // the data. Migration 0016 moved it into a partial unique index.
  //
  // Asked of Postgres directly rather than through the bot: the guard has to
  // hold for a webhook, a second process or an admin route that does not exist
  // yet, and none of those would go through `handleUpdate`.

  it('refuses a second PAID payment for the same order', async () => {
    const userId = await makeCustomer(920_100_050);
    const order = await topupOrder(userId, 1_000_000);
    // `place` hands back the open order this customer already had, so on a
    // second run of the suite the PAID row written below is still attached to
    // it and the first insert — the one that is meant to succeed — would be the
    // one that conflicts. Clearing makes the test say what it means.
    await db.prepare(`DELETE FROM payments WHERE order_id = ?1`).bind(order.id).run();

    await db
      .prepare(
        `INSERT INTO payments (public_id, user_id, order_id, amount_irr, method, status, created_at)
         VALUES (?1, ?2, ?3, 1000000, 'WALLET', 'PAID', now())`,
      )
      .bind(newPublicId(), userId, order.id)
      .run();

    await expect(
      db
        .prepare(
          `INSERT INTO payments (public_id, user_id, order_id, amount_irr, method, status, created_at)
           VALUES (?1, ?2, ?3, 1000000, 'WALLET', 'PAID', now())`,
        )
        .bind(newPublicId(), userId, order.id)
        .run(),
    ).rejects.toThrow();
  });

  it('still allows the card row beside the wallet row', async () => {
    // A customer shown a card and then paying from their balance leaves two
    // payment rows for one order. Only one of them may be PAID, which is why
    // the index is scoped to that status rather than to `order_id` alone.
    const userId = await makeCustomer(920_100_051);
    const order = await topupOrder(userId, 1_000_000);
    await db.prepare(`DELETE FROM payments WHERE order_id = ?1`).bind(order.id).run();

    await db
      .prepare(
        `INSERT INTO payments (public_id, user_id, order_id, amount_irr, method, status, created_at)
         VALUES (?1, ?2, ?3, 1000000, 'CARD_TO_CARD', 'PENDING', now())`,
      )
      .bind(newPublicId(), userId, order.id)
      .run();
    await db
      .prepare(
        `INSERT INTO payments (public_id, user_id, order_id, amount_irr, method, status, created_at)
         VALUES (?1, ?2, ?3, 1000000, 'WALLET', 'PAID', now())`,
      )
      .bind(newPublicId(), userId, order.id)
      .run();

    const rows = await db
      .prepare(`SELECT count(*)::int AS n FROM payments WHERE order_id = ?1`)
      .bind(order.id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(2);
  });
});

describe('spending the balance', () => {
  it('pays an order and leaves the balance exactly short of it', async () => {
    const userId = await makeCustomer(920_100_001);
    await credit(userId, 3_000_000, `t:${userId}:a`);

    const order = await topupOrder(userId, 1_000_000);
    const result = await db.withSession(async (tx) =>
      spendOnOrder(tx, userId, order.id, 1_200_000),
    );

    expect(result).toBe('PAID');
    expect(await balanceFor(db, userId)).toBe(1_800_000);
  });

  it('refuses to go negative rather than lending', async () => {
    const userId = await makeCustomer(920_100_002);
    await credit(userId, 1_000_000, `t:${userId}:a`);
    const order = await topupOrder(userId, 1_000_000);

    const result = await db.withSession(async (tx) =>
      spendOnOrder(tx, userId, order.id, 1_000_001),
    );

    expect(result).toBe('INSUFFICIENT');
    expect(await balanceFor(db, userId)).toBe(1_000_000);
  });

  it('charges once for one order, however many times the button is pressed', async () => {
    const userId = await makeCustomer(920_100_003);
    await credit(userId, 5_000_000, `t:${userId}:a`);
    const order = await topupOrder(userId, 1_000_000);

    const first = await db.withSession(async (tx) => spendOnOrder(tx, userId, order.id, 2_000_000));
    const second = await db.withSession(async (tx) =>
      spendOnOrder(tx, userId, order.id, 2_000_000),
    );

    expect(first).toBe('PAID');
    expect(second).toBe('ALREADY_PAID');
    // The guarantee is the UNIQUE idempotency_key, not the code above it.
    expect(await balanceFor(db, userId)).toBe(3_000_000);
  });

  it('has nothing to charge for an order priced at zero, and does not crash trying', async () => {
    // C1's remaining half. `place()` refuses to write a zero-total order now,
    // but this function took the amount on trust — and a zero entry violates
    // `CHECK (amount_irr <> 0)`, whose exception rolls back the whole update
    // including the `telegram_updates` row that makes handling exactly-once.
    // That rollback is the entire C1 freeze, reached from the one direction the
    // floor in `place()` does not cover: a row that was already there.
    //
    // 'PAID' rather than a refusal, because it is true: nothing is owed, so
    // nothing is charged. What must not happen is a ledger row for no money.
    const userId = await makeCustomer(920_100_006);
    await credit(userId, 1_000_000, `t:${userId}:a`);
    const order = await topupOrder(userId, 1_000_000);

    expect(await db.withSession(async (tx) => spendOnOrder(tx, userId, order.id, 0))).toBe('PAID');
    expect(await balanceFor(db, userId)).toBe(1_000_000);
  });

  it('refuses a negative price instead of paying the customer for buying', async () => {
    // Worth its own test because the failure is not a crash. `-amountIrr` on a
    // negative amount is a positive one, so a purchase became a deposit and the
    // balance went UP — a sale that pays the buyer.
    const userId = await makeCustomer(920_100_007);
    await credit(userId, 1_000_000, `t:${userId}:a`);
    const order = await topupOrder(userId, 1_000_000);

    expect(await db.withSession(async (tx) => spendOnOrder(tx, userId, order.id, -500_000))).toBe(
      'INSUFFICIENT',
    );
    expect(await balanceFor(db, userId)).toBe(1_000_000);
  });

  it('lets a customer with no wallet row spend nothing', async () => {
    const userId = await makeCustomer(920_100_004);
    const order = await topupOrder(userId, 1_000_000);

    expect(await balanceFor(db, userId)).toBe(0);
    expect(await db.withSession(async (tx) => spendOnOrder(tx, userId, order.id, 10))).toBe(
      'INSUFFICIENT',
    );
  });

  it('will not let a customer carrying a debt spend their way further down', async () => {
    // Production holds an account at -5,940,000 Toman. The schema stores that
    // faithfully; the refusal belongs here, at the point of spend.
    const userId = await makeCustomer(920_100_005);
    await db
      .prepare(
        `INSERT INTO wallet_entries (user_id, amount_irr, kind, idempotency_key)
         VALUES (?1, -59400000, 'ADMIN_ADJUST', ?2)`,
      )
      .bind(userId, `debt:${userId}`)
      .run();
    const order = await topupOrder(userId, 1_000_000);

    expect(await balanceFor(db, userId)).toBe(-59_400_000);
    expect(await db.withSession(async (tx) => spendOnOrder(tx, userId, order.id, 1))).toBe(
      'INSUFFICIENT',
    );
  });
});

describe('a deposit that is paid for', () => {
  /** Drives a top-up order all the way through the hub, as the sweeps do. */
  async function payTopup(telegramId: number, amountIrr: number) {
    const userId = await makeCustomer(telegramId);
    const order = await topupOrder(userId, amountIrr);
    const payment = await db
      .prepare(
        `INSERT INTO payments
           (public_id, user_id, order_id, amount_irr, method, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'CARD_TO_CARD', 'AWAITING_REVIEW', now(), now())
         RETURNING id, public_id`,
      )
      // A fresh id per run. `payment_claims` has no foreign key to `users`, so
      // the suite's `TRUNCATE users CASCADE` does not reach it — a deterministic
      // id here survives the reset and collides on the next run.
      .bind(newPublicId(), userId, order.id, amountIrr)
      .first<{ id: number; public_id: string }>();
    await db
      .prepare(
        `INSERT INTO payment_claims
           (id, external_order_id, customer_reference, expected_amount_irr, card_digits,
            submitted_at, paid_clicked_at, source_system, metadata_json, status,
            created_at, updated_at)
         VALUES (?1, ?2, 'x', ?3, '6037000000000095', 0, 0, 'MIRZABOT', '{}', 'VERIFIED', 0, 0)`,
      )
      .bind(`c-${payment!.public_id}`, `shikoo:${payment!.public_id}`, amountIrr)
      .run();
    return { userId, order };
  }

  it('lands in the balance and tells the customer so', async () => {
    const { userId } = await payTopup(920_100_010, 2_000_000);

    await settleVerifiedPayments(db);
    const notes = await pendingNotifications();

    expect(await balanceFor(db, userId)).toBe(2_000_000);
    expect(notes.some((n) => n.text.includes('کیف پول شما شارژ شد'))).toBe(true);
  });

  it('completes the order instead of leaving it for the provisioning sweep', async () => {
    // A deposit has no plan. Left at PAID it would be picked up by
    // `provisionPaidOrders` and failed as "the plan no longer exists" — the
    // customer would be told their service needs help after topping up.
    const { order } = await payTopup(920_100_011, 1_000_000);

    await settleVerifiedPayments(db);
    await provisionPaidOrders(db, (async () =>
      Promise.reject(new Error('no panel should be called'))) as unknown as typeof fetch);

    const row = await db
      .prepare(`SELECT status, failure_reason FROM orders WHERE id = ?1`)
      .bind(order.id)
      .first<{ status: string; failure_reason: string | null }>();
    expect(row).toMatchObject({ status: 'COMPLETED', failure_reason: null });
  });

  it('is left alone by the provisioning sweep even if it somehow reaches PAID', async () => {
    // `settleVerifiedPayments` completes a deposit itself, so this state should
    // not occur. The fence in `provisionPaidOrders` exists for the day it does —
    // a hand-fixed row, an admin tool, a future second settle path — and a
    // guard with no test is a guard that quietly stops working.
    const userId = await makeCustomer(920_100_013);
    const order = await topupOrder(userId, 1_000_000);
    await db.prepare(`UPDATE orders SET status = 'PAID' WHERE id = ?1`).bind(order.id).run();

    await provisionPaidOrders(db, (async () =>
      Promise.reject(new Error('no panel should be called'))) as unknown as typeof fetch);

    const row = await db
      .prepare(`SELECT status, failure_reason FROM orders WHERE id = ?1`)
      .bind(order.id)
      .first<{ status: string; failure_reason: string | null }>();
    expect(row).toMatchObject({ status: 'PAID', failure_reason: null });
  });

  it('says how much is missing when the balance will not cover the order', async () => {
    /*
     * «موجودی کافی نیست» used to be the whole message.
     *
     * The total is on the checkout screen and the balance is on the wallet
     * screen, so the customer was left to do the subtraction between two places
     * before they could choose a deposit. The number is the one thing they need
     * in order to act.
     *
     * Reachable without forging anything: «پرداخت از کیف پول» is drawn only
     * when the balance covers the order, but Telegram keeps a button pressable
     * for ever — so opening two checkouts and paying one from the balance
     * leaves the other one live and now unaffordable.
     */
    const telegramId = 920_100_016;
    const userId = await makeCustomer(telegramId);
    const plan = await planId('sim-gold-10');
    await handleUpdate(db, press(920_100_917, telegramId, `order:${plan}`));
    const order = await db
      .prepare(
        `SELECT id, total_irr FROM orders
          WHERE user_id = ?1 AND kind = 'NEW_PURCHASE' ORDER BY id DESC LIMIT 1`,
      )
      .bind(userId)
      .first<{ id: number; total_irr: number }>();
    // Enough to be a real balance, not enough to buy.
    await credit(userId, order!.total_irr - 250_000, `t:${userId}:short`);

    const out = await handleUpdate(db, press(920_100_918, telegramId, `wpay:${order!.id}`));

    // The shortfall, in the Toman the customer transfers.
    expect(out.replies[0]!.text).toContain('25,000');
    expect(await balanceFor(db, userId)).toBe(order!.total_irr - 250_000);
  });

  it('refuses the balance once the customer has said they sent bank money', async () => {
    /*
     * The reverse order of the test below, and it is the one that was open.
     *
     * No forging is needed. `screen()` edits only the message its press came
     * from, and Telegram keeps every other one pressable — so opening the same
     * plan twice leaves two live invoices for ONE order, because `place()`
     * reuses the order and `checkoutFor` reuses the payment.
     *
     * Press «پرداخت کردم» on one and «پرداخت از کیف پول» on the other: the
     * order is still AWAITING_PAYMENT, the lock passes, and the balance goes.
     * The supersede cleanup cannot help — by then the card row is
     * AWAITING_REVIEW and that statement closes PENDING only, deliberately,
     * because closing a claim against money already sent is worse.
     *
     * What follows is worse than a double charge: the transfer lands, the
     * matcher verifies the claim, and `settle.ts` tries to mark that payment
     * PAID against an index the WALLET row already holds. 23505 every cycle,
     * for ever, with no audit row.
     */
    const telegramId = 920_100_017;
    const userId = await makeCustomer(telegramId);
    await credit(userId, 9_000_000, `t:${userId}:a`);
    const plan = await planId('sim-gold-10');

    await handleUpdate(db, press(920_100_919, telegramId, `order:${plan}`));
    const order = await db
      .prepare(
        `SELECT id, total_irr FROM orders
          WHERE user_id = ?1 AND kind = 'NEW_PURCHASE' ORDER BY id DESC LIMIT 1`,
      )
      .bind(userId)
      .first<{ id: number; total_irr: number }>();

    // «پرداخت کردم» first: the card row becomes a claim.
    await handleUpdate(db, press(920_100_920, telegramId, `paid:${order!.id}`));
    const claimed = await db
      .prepare(
        `SELECT count(*)::int AS n FROM payments
          WHERE order_id = ?1 AND status = 'AWAITING_REVIEW'`,
      )
      .bind(order!.id)
      .first<{ n: number }>();
    expect(claimed?.n).toBe(1);

    // Then the other, still-live invoice.
    const out = await handleUpdate(db, press(920_100_921, telegramId, `wpay:${order!.id}`));

    // Not charged twice.
    expect(await balanceFor(db, userId)).toBe(9_000_000);
    // And no WALLET row to collide with the claim when it settles.
    const wallet = await db
      .prepare(
        `SELECT count(*)::int AS n FROM payments WHERE order_id = ?1 AND method = 'WALLET'`,
      )
      .bind(order!.id)
      .first<{ n: number }>();
    expect(wallet?.n).toBe(0);
    // Told what is actually true: we are waiting on the transfer they sent.
    expect(out.replies[0]!.text).toContain('پرداخت');
  });

  it('closes the card checkout it supersedes, so the order cannot be paid twice', async () => {
    /*
     * Paying from the balance left the card row PENDING on a PAID order.
     *
     * The two payment indexes are deliberately disjoint — one open row per
     * order, one PAID row per order — so the pair is legal, and nothing closed
     * the card half: `expireUnpaidOrders` only touches payments whose ORDER
     * expired, and a paid order never does.
     *
     * What that left reachable: press «پرداخت کردم» on the stale checkout,
     * the card row flips to AWAITING_REVIEW and opens a claim, the customer
     * transfers a second time, and settling that claim collides with the PAID
     * row on the unique index. `settle.ts` no longer stalls on the collision,
     * but the state should not exist at all.
     */
    const telegramId = 920_100_015;
    const userId = await makeCustomer(telegramId);
    await credit(userId, 5_000_000, `t:${userId}:a`);
    const plan = await planId('sim-gold-10');

    // A real checkout, so there is a real CARD_TO_CARD row to supersede.
    await handleUpdate(db, press(920_100_915, telegramId, `order:${plan}`));
    const order = await db
      .prepare(
        `SELECT id, total_irr FROM orders
          WHERE user_id = ?1 AND kind = 'NEW_PURCHASE' ORDER BY id DESC LIMIT 1`,
      )
      .bind(userId)
      .first<{ id: number; total_irr: number }>();
    expect(await openPayments(order!.id)).toBe(1);

    await handleUpdate(db, press(920_100_916, telegramId, `wpay:${order!.id}`));

    // The wallet paid it, and the card row is no longer open for anybody to
    // claim against.
    expect(await balanceFor(db, userId)).toBe(5_000_000 - order!.total_irr);
    expect(await openPayments(order!.id)).toBe(0);
  });

  it('cannot be paid out of the balance it exists to fill', async () => {
    /*
     * `wpay` on a deposit order used to take the money and give nothing back.
     *
     * The button is never drawn for a deposit — `checkoutMenu` omits the wallet
     * row because `topup()` passes it no balance — but `callback_data` is
     * unsigned, so the press arrives anyway. What followed: the balance was
     * debited, the order moved to PAID, `creditTopup` was never called (only
     * the card settlement calls it), and the provisioning sweep skips
     * `WALLET_TOPUP` by name, so nothing ever failed the order into a refund.
     * The money left the wallet and no row said where it went.
     *
     * Asserted on the BALANCE rather than on the screen: what makes this a bug
     * is the money, and the screen is only how the customer finds out.
     */
    const telegramId = 920_100_014;
    const userId = await makeCustomer(telegramId);
    await credit(userId, 3_000_000, `t:${userId}:a`);
    const order = await topupOrder(userId, 1_000_000);

    await handleUpdate(db, press(920_100_914, telegramId, `wpay:${order.id}`));

    expect(await balanceFor(db, userId)).toBe(3_000_000);
    const row = await db
      .prepare(`SELECT status FROM orders WHERE id = ?1`)
      .bind(order.id)
      .first<{ status: string }>();
    expect(row).toMatchObject({ status: 'AWAITING_PAYMENT' });
  });

  it('credits once even when the sweep runs again', async () => {
    const { userId } = await payTopup(920_100_012, 1_000_000);

    await settleVerifiedPayments(db);
    await settleVerifiedPayments(db);

    expect(await balanceFor(db, userId)).toBe(1_000_000);
  });
});

describe('the balance and its history', () => {
  it('always equals the sum of the entries that produced it', async () => {
    const userId = await makeCustomer(920_100_020);
    await credit(userId, 3_000_000, `t:${userId}:a`);
    await credit(userId, 1_500_000, `t:${userId}:b`);
    const order = await topupOrder(userId, 1_000_000);
    await db.withSession(async (tx) => spendOnOrder(tx, userId, order.id, 2_000_000));

    const summed = await db
      .prepare(
        `SELECT COALESCE(SUM(amount_irr), 0) AS total FROM wallet_entries WHERE user_id = ?1`,
      )
      .bind(userId)
      .first<{ total: number }>();

    // Not a tautology: the balance is maintained by a trigger and this reads
    // the entries independently. If the trigger ever stops firing, this is what
    // says so.
    expect(await balanceFor(db, userId)).toBe(Number(summed!.total));
    expect(await balanceFor(db, userId)).toBe(2_500_000);
  });

  it('refuses to let history be rewritten', async () => {
    const userId = await makeCustomer(920_100_021);
    await credit(userId, 1_000_000, `t:${userId}:a`);

    await expect(
      db
        .prepare(`UPDATE wallet_entries SET amount_irr = 999 WHERE user_id = ?1`)
        .bind(userId)
        .run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.prepare(`DELETE FROM wallet_entries WHERE user_id = ?1`).bind(userId).run(),
    ).rejects.toThrow(/append-only/);
  });
});

describe('an order paid from the wallet that cannot be delivered', () => {
  it('gives the credit back and says so, instead of calling it safe', async () => {
    // Walked on the test bot on 2026-08-13: the customer paid from the balance
    // for a panel with no address, the order failed, and the message told them
    // their payment was "safe" while the credit stayed spent.
    const userId = await makeCustomer(920_100_030);
    await credit(userId, 3_000_000, `t:${userId}:a`);
    const plan = await planId('sim-vip-1m-20');
    const order = await db
      .prepare(
        `INSERT INTO orders (public_id, user_id, kind, plan_id, quantity,
                             unit_price_irr, discount_irr, total_irr, status)
         VALUES (?1, ?2, 'NEW_PURCHASE', ?3, 1, 1000000, 0, 1000000, 'AWAITING_PAYMENT')
         RETURNING id`,
      )
      .bind(newPublicId(), userId, plan)
      .first<{ id: number }>();
    await db.withSession(async (tx) => spendOnOrder(tx, userId, order!.id, 1_000_000));
    await db
      .prepare(
        `INSERT INTO payments (public_id, user_id, order_id, amount_irr, method, status,
                               created_at, updated_at)
         VALUES (?1, ?2, ?3, 1000000, 'WALLET', 'PAID', now(), now())`,
      )
      .bind(newPublicId(), userId, order!.id)
      .run();
    await db.prepare(`UPDATE orders SET status = 'PAID' WHERE id = ?1`).bind(order!.id).run();
    expect(await balanceFor(db, userId)).toBe(2_000_000);

    // No base_url on the fixture provider, which is the real failure seen.
    await provisionPaidOrders(db, (async () =>
      Promise.reject(new Error('panel unreachable'))) as unknown as typeof fetch);
    const notes = await pendingNotifications();

    expect(await balanceFor(db, userId)).toBe(3_000_000);
    expect(notes.some((n) => n.text.includes('به کیف پول شما برگشت'))).toBe(true);
  });

  it('refunds once, however many sweeps see it', async () => {
    const userId = await makeCustomer(920_100_031);
    await credit(userId, 2_000_000, `t:${userId}:a`);
    const plan = await planId('sim-vip-1m-20');
    const order = await db
      .prepare(
        `INSERT INTO orders (public_id, user_id, kind, plan_id, quantity,
                             unit_price_irr, discount_irr, total_irr, status)
         VALUES (?1, ?2, 'NEW_PURCHASE', ?3, 1, 1000000, 0, 1000000, 'PAID')
         RETURNING id`,
      )
      .bind(newPublicId(), userId, plan)
      .first<{ id: number }>();
    await db
      .prepare(
        `INSERT INTO payments (public_id, user_id, order_id, amount_irr, method, status,
                               created_at, updated_at)
         VALUES (?1, ?2, ?3, 1000000, 'WALLET', 'PAID', now(), now())`,
      )
      .bind(newPublicId(), userId, order!.id)
      .run();

    await provisionPaidOrders(db);
    const after = await balanceFor(db, userId);
    await db
      .prepare(`UPDATE orders SET status = 'PROVISIONING' WHERE id = ?1`)
      .bind(order!.id)
      .run();
    await provisionPaidOrders(db);

    expect(await balanceFor(db, userId)).toBe(after);
  });

  it('leaves a card payment alone — that money is in a bank, not in the ledger', async () => {
    const userId = await makeCustomer(920_100_032);
    await credit(userId, 1_000_000, `t:${userId}:a`);
    const plan = await planId('sim-vip-1m-20');
    const order = await db
      .prepare(
        `INSERT INTO orders (public_id, user_id, kind, plan_id, quantity,
                             unit_price_irr, discount_irr, total_irr, status)
         VALUES (?1, ?2, 'NEW_PURCHASE', ?3, 1, 1000000, 0, 1000000, 'PAID')
         RETURNING id`,
      )
      .bind(newPublicId(), userId, plan)
      .first<{ id: number }>();
    await db
      .prepare(
        `INSERT INTO payments (public_id, user_id, order_id, amount_irr, method, status,
                               created_at, updated_at)
         VALUES (?1, ?2, ?3, 1000000, 'CARD_TO_CARD', 'PAID', now(), now())`,
      )
      .bind(newPublicId(), userId, order!.id)
      .run();

    await provisionPaidOrders(db);
    const notes = await pendingNotifications();

    expect(await balanceFor(db, userId)).toBe(1_000_000);
    expect(notes.some((n) => n.text.includes('محفوظ است'))).toBe(true);
  });
});
