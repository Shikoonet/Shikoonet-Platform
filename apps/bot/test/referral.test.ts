/**
 * Which orders pay the referrer, and how much — against the real database.
 *
 * Sam, 2026-09-22: the referred customer's FIRST purchase pays one rate
 * (`bot/affiliatespercentage`, 30), every one of their renewals pays another
 * (`bot/affiliatespercentage_renewal`, 10), and nothing else pays at all — not
 * a second new purchase, not an add-on, not a top-up. Delivery is where it is
 * called (`provision.test.ts` › «the referrer is paid on delivery»); this file
 * is the rule itself, one order kind at a time.
 */

import { describe, expect, it } from 'vitest';
import type { D1DatabaseSession } from '@shikoo/database';
import { payReferralCommission } from '../src/referral.js';
import { db } from './helpers/env.js';
import { makeCustomer } from './helpers/shop.js';

const RATES = { first: 30, renewal: 10 };

let seq = 0;

/** A referrer and the customer they brought, both fresh. */
async function pair(): Promise<{ referrer: number; customer: number }> {
  seq += 1;
  const referrer = await makeCustomer(880_000 + seq * 2);
  const customer = await makeCustomer(880_001 + seq * 2);
  await db
    .prepare(`UPDATE users SET referred_by = ?2 WHERE id = ?1`)
    .bind(customer, referrer)
    .run();
  return { referrer, customer };
}

let orderSeq = 0;

/** A delivered order of `kind` for `userId`, the state `complete()` pays from. */
async function delivered(userId: number, kind: string, totalIrr: number): Promise<number> {
  orderSeq += 1;
  const row = await db
    .prepare(
      `INSERT INTO orders (public_id, user_id, kind, quantity, unit_price_irr, total_irr, status)
       VALUES (?1, ?2, ?3, 1, ?4, ?4, 'COMPLETED') RETURNING id`,
    )
    .bind(`${String(orderSeq).padStart(4, '0')}refr`, userId, kind, totalIrr)
    .first<{ id: number }>();
  return row!.id;
}

async function pay(orderId: number, rates = RATES): Promise<number | null> {
  return db.withSession((tx) => payReferralCommission(tx as D1DatabaseSession, orderId, rates));
}

async function earned(referrer: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(sum(amount_irr), 0)::bigint AS irr FROM wallet_entries
        WHERE user_id = ?1 AND kind = 'REFERRAL_BONUS'`,
    )
    .bind(referrer)
    .first<{ irr: number }>();
  return Number(row!.irr);
}

describe('referral commission', () => {
  it('pays the first-purchase rate on the first purchase, and nothing on a second', async () => {
    const { referrer, customer } = await pair();
    expect(await pay(await delivered(customer, 'NEW_PURCHASE', 2_000_000))).toBe(600_000);
    expect(await pay(await delivered(customer, 'NEW_PURCHASE', 2_000_000))).toBeNull();
    expect(await earned(referrer)).toBe(600_000);
  });

  it('pays the renewal rate on every renewal, as often as they renew', async () => {
    const { referrer, customer } = await pair();
    await pay(await delivered(customer, 'NEW_PURCHASE', 1_000_000));
    expect(await pay(await delivered(customer, 'RENEWAL', 1_500_000))).toBe(150_000);
    expect(await pay(await delivered(customer, 'RENEWAL', 1_500_000))).toBe(150_000);
    expect(await earned(referrer)).toBe(300_000 + 150_000 + 150_000);
  });

  it('pays the first-purchase rate even after a top-up and a renewal came first', async () => {
    // A renewal before any new purchase is an imported customer renewing a
    // PHP-era service; it must not make their first new purchase a «second».
    const { customer } = await pair();
    await delivered(customer, 'WALLET_TOPUP', 5_000_000);
    await pay(await delivered(customer, 'RENEWAL', 1_000_000));
    expect(await pay(await delivered(customer, 'NEW_PURCHASE', 1_000_000))).toBe(300_000);
  });

  it('pays nothing on an add-on, a top-up or a transfer', async () => {
    const { referrer, customer } = await pair();
    for (const kind of ['ADD_VOLUME', 'ADD_TIME', 'WALLET_TOPUP', 'TRANSFER']) {
      expect(await pay(await delivered(customer, kind, 1_000_000)), kind).toBeNull();
    }
    expect(await earned(referrer)).toBe(0);
  });

  it('pays nothing at a rate of zero — that is how the dashboard switches one off', async () => {
    const { customer } = await pair();
    const off = { first: 30, renewal: 0 };
    expect(await pay(await delivered(customer, 'RENEWAL', 1_000_000), off)).toBeNull();
  });

  it('pays once per order however many times it is called', async () => {
    const { referrer, customer } = await pair();
    const renewal = await delivered(customer, 'RENEWAL', 1_000_000);
    expect(await pay(renewal)).toBe(100_000);
    expect(await pay(renewal)).toBeNull();
    expect(await earned(referrer)).toBe(100_000);
  });

  it('pays nobody for a customer nobody referred', async () => {
    const lone = await makeCustomer(889_999);
    expect(await pay(await delivered(lone, 'RENEWAL', 1_000_000))).toBeNull();
  });
});
