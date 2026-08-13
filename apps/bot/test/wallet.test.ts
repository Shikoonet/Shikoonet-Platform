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
import { newPublicId, placeTopupOrder } from '../src/order.js';
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
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer } from './helpers/shop.js';

beforeEach(async () => {
  await ensureCatalog();
});

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

describe('spending the balance', () => {
  it('pays an order and leaves the balance exactly short of it', async () => {
    const userId = await makeCustomer(920_100_001);
    await credit(userId, 3_000_000, `t:${userId}:a`);

    const order = await db.withSession(async (tx) => placeTopupOrder(tx, userId, 1_000_000));
    const result = await db.withSession(async (tx) =>
      spendOnOrder(tx, userId, order.id, 1_200_000),
    );

    expect(result).toBe('PAID');
    expect(await balanceFor(db, userId)).toBe(1_800_000);
  });

  it('refuses to go negative rather than lending', async () => {
    const userId = await makeCustomer(920_100_002);
    await credit(userId, 1_000_000, `t:${userId}:a`);
    const order = await db.withSession(async (tx) => placeTopupOrder(tx, userId, 1_000_000));

    const result = await db.withSession(async (tx) =>
      spendOnOrder(tx, userId, order.id, 1_000_001),
    );

    expect(result).toBe('INSUFFICIENT');
    expect(await balanceFor(db, userId)).toBe(1_000_000);
  });

  it('charges once for one order, however many times the button is pressed', async () => {
    const userId = await makeCustomer(920_100_003);
    await credit(userId, 5_000_000, `t:${userId}:a`);
    const order = await db.withSession(async (tx) => placeTopupOrder(tx, userId, 1_000_000));

    const first = await db.withSession(async (tx) => spendOnOrder(tx, userId, order.id, 2_000_000));
    const second = await db.withSession(async (tx) =>
      spendOnOrder(tx, userId, order.id, 2_000_000),
    );

    expect(first).toBe('PAID');
    expect(second).toBe('ALREADY_PAID');
    // The guarantee is the UNIQUE idempotency_key, not the code above it.
    expect(await balanceFor(db, userId)).toBe(3_000_000);
  });

  it('lets a customer with no wallet row spend nothing', async () => {
    const userId = await makeCustomer(920_100_004);
    const order = await db.withSession(async (tx) => placeTopupOrder(tx, userId, 1_000_000));

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
    const order = await db.withSession(async (tx) => placeTopupOrder(tx, userId, 1_000_000));

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
    const order = await db.withSession(async (tx) => placeTopupOrder(tx, userId, amountIrr));
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

    const notes = await settleVerifiedPayments(db);

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
    const order = await db.withSession(async (tx) => placeTopupOrder(tx, userId, 1_000_000));
    await db.prepare(`UPDATE orders SET status = 'PAID' WHERE id = ?1`).bind(order.id).run();

    await provisionPaidOrders(db, (async () =>
      Promise.reject(new Error('no panel should be called'))) as unknown as typeof fetch);

    const row = await db
      .prepare(`SELECT status, failure_reason FROM orders WHERE id = ?1`)
      .bind(order.id)
      .first<{ status: string; failure_reason: string | null }>();
    expect(row).toMatchObject({ status: 'PAID', failure_reason: null });
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
    const order = await db.withSession(async (tx) => placeTopupOrder(tx, userId, 1_000_000));
    await db.withSession(async (tx) => spendOnOrder(tx, userId, order.id, 2_000_000));

    const summed = await db
      .prepare(`SELECT COALESCE(SUM(amount_irr), 0) AS total FROM wallet_entries WHERE user_id = ?1`)
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
      db.prepare(`UPDATE wallet_entries SET amount_irr = 999 WHERE user_id = ?1`).bind(userId).run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.prepare(`DELETE FROM wallet_entries WHERE user_id = ?1`).bind(userId).run(),
    ).rejects.toThrow(/append-only/);
  });
});
