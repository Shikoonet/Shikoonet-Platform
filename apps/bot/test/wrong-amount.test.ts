/**
 * A transfer that is not the invoice's amount goes to the customer's wallet
 * (`wrongAmount.ts`, Sam 2026-09-23).
 *
 * Every row here is built by hand on an account and card of this file's own,
 * so no other test's claims sit near these clicks and no checkout elsewhere
 * is handed this card (it is DISABLED; the sweep reads the mapping, not the
 * rotation).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { creditWrongAmounts } from '../src/wrongAmount.js';
import { db, pendingNotifications } from './helpers/env.js';
import { makeCustomer } from './helpers/shop.js';

const ACCOUNT = 'wa-account';
const CARD = '5022290000001111';
const DEVICE = 'wa-device';
const RUN = Date.now().toString(36);
const MINUTE = 60_000;

let seq = 0;

async function cleanUp(): Promise<void> {
  await db.prepare(`DELETE FROM payment_claims WHERE target_financial_account_id = ?1`).bind(ACCOUNT).run();
  await db.prepare(`DELETE FROM transaction_candidates WHERE financial_account_id = ?1`).bind(ACCOUNT).run();
  await db.prepare(`DELETE FROM raw_sms_events WHERE device_id = ?1`).bind(DEVICE).run();
  await db.prepare(`DELETE FROM payments WHERE assigned_card_number = ?1`).bind(CARD).run();
}

beforeAll(async () => {
  await db
    .prepare(
      `INSERT INTO financial_accounts
         (id, bank_name, display_name, account_type, active, customer_visible,
          parser_configuration, created_at, updated_at)
       VALUES (?1, 'Melli', 'حساب تست مبلغ اشتباه', 'CARD', 1, 1, '{}', 0, 0)
       ON CONFLICT (id) DO NOTHING`,
    )
    .bind(ACCOUNT)
    .run();
  await db
    .prepare(
      `INSERT INTO payment_cards (id, financial_account_id, card_digits, holder_name, status, created_at)
       VALUES ('wa-card', ?1, ?2, 'تست', 'DISABLED', 0)
       ON CONFLICT (card_digits) DO NOTHING`,
    )
    .bind(ACCOUNT, CARD)
    .run();
  await db
    .prepare(
      `INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at)
       VALUES (?1, ?1, 'wrong-amount fixture', 1, 0, 0)
       ON CONFLICT (id) DO NOTHING`,
    )
    .bind(DEVICE)
    .run();
});

beforeEach(cleanUp);

afterAll(async () => {
  await cleanUp();
  await db.prepare(`DELETE FROM payment_cards WHERE card_digits = ?1`).bind(CARD).run();
  await db.prepare(`DELETE FROM financial_accounts WHERE id = ?1`).bind(ACCOUNT).run();
  await db.prepare(`DELETE FROM devices WHERE id = ?1`).bind(DEVICE).run();
});

/**
 * An invoice whose customer pressed «پرداخت کردم» `ago` ms before now, and
 * whose claim the matcher has given up on (no deposit of its amount).
 */
async function claimedInvoice(o: {
  cardIrr: number;
  totalIrr?: number;
  ago?: number;
  suspect?: string | null;
}) {
  const n = ++seq;
  const telegramId = 793_000 + n;
  const userId = await makeCustomer(telegramId);
  const publicId = `wa${RUN}${n}`;
  const clickedAt = Date.now() - (o.ago ?? 11 * MINUTE);
  const order = await db
    .prepare(
      `INSERT INTO orders (public_id, user_id, kind, quantity, unit_price_irr, total_irr, status)
       VALUES (?1, ?2, 'NEW_PURCHASE', 1, ?3, ?3, 'AWAITING_PAYMENT') RETURNING id`,
    )
    .bind(`o${publicId}`, userId, o.totalIrr ?? o.cardIrr)
    .first<{ id: number }>();
  await db
    .prepare(
      `INSERT INTO payments
         (public_id, user_id, order_id, amount_irr, method, status, assigned_card_number,
          created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'CARD_TO_CARD', 'AWAITING_REVIEW', ?5,
               to_timestamp(?6 / 1000.0), now())`,
    )
    .bind(publicId, userId, order!.id, o.cardIrr, CARD, clickedAt - MINUTE)
    .run();
  const claimId = randomUUID();
  await db
    .prepare(
      `INSERT INTO payment_claims
         (id, external_order_id, customer_reference, expected_amount_irr,
          target_financial_account_id, card_digits, submitted_at, paid_clicked_at,
          source_system, metadata_json, status, suspect_reason, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, 'MIRZABOT', '{}', 'MATCH_SUGGESTED', ?8, ?7, ?7)`,
    )
    .bind(
      claimId,
      `shikoo:${publicId}`,
      String(telegramId),
      o.cardIrr,
      ACCOUNT,
      CARD,
      clickedAt,
      o.suspect === undefined ? 'NO_TRANSACTION_AFTER_10M' : o.suspect,
    )
    .run();
  return { userId, telegramId, orderId: order!.id, publicId, claimId, clickedAt };
}

/** A bank credit on this file's account, stamped `at`. */
async function deposit(amountIrr: number, at: number): Promise<string> {
  const id = `wa-tx-${RUN}-${++seq}`;
  await db
    .prepare(
      `INSERT INTO raw_sms_events
         (id, device_id, sender, normalized_body, body_sha256, app_checksum,
          sms_timestamp, received_at, classification, parser_status, created_at)
       VALUES (?1, ?2, 'BANK', 'x', ?1, 'c', ?3, ?3, 'BANK_TRANSACTION', 'OK', ?3)`,
    )
    .bind(id, DEVICE, at)
    .run();
  await db
    .prepare(
      `INSERT INTO transaction_candidates
         (id, raw_sms_event_id, financial_account_id, direction, amount_irr, status,
          processing_disposition, bank_timestamp, confidence, parser_id, parser_version,
          parser_evidence_json, created_at, updated_at)
       VALUES (?1, ?1, ?2, 'CREDIT', ?3, 'PARSED', 'ACTIONABLE', ?4, 1.0, 'test', 'v1', '{}', ?4, ?4)`,
    )
    .bind(id, ACCOUNT, amountIrr, at)
    .run();
  return id;
}

async function balanceOf(userId: number): Promise<number> {
  const row = await db
    .prepare(`SELECT balance_irr FROM wallets WHERE user_id = ?1`)
    .bind(userId)
    .first<{ balance_irr: number | string }>();
  return Number(row?.balance_irr ?? 0);
}

async function statuses(inv: { claimId: string; orderId: number; publicId: string }) {
  const row = await db
    .prepare(
      `SELECT c.status AS claim, o.status AS "order", p.status AS payment
         FROM payment_claims c, orders o, payments p
        WHERE c.id = ?1 AND o.id = ?2 AND p.public_id = ?3`,
    )
    .bind(inv.claimId, inv.orderId, inv.publicId)
    .first<{ claim: string; order: string; payment: string }>();
  return row;
}

async function messageTo(telegramId: number): Promise<string | undefined> {
  return (await pendingNotifications()).find((n) => n.chatId === telegramId)?.text;
}

/** An operator's credit on the customer's page, stamped `at` (1 Mehr 1405: 41 minutes after the deposit). */
async function creditByHand(userId: number, at: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO wallet_entries (user_id, amount_irr, kind, actor, note, idempotency_key, created_at)
       VALUES (?1, 1000000, 'ADMIN_ADJUST', 'sam@example.com', 'اشتباه واریزی', ?2, to_timestamp(?3 / 1000.0))`,
    )
    .bind(userId, `admin-adjust:${userId}:${RUN}:${++seq}`, at)
    .run();
}

/** A report group for the body of `fn`, only if this database has none; left as found. */
async function withReportGroup(fn: () => Promise<void>): Promise<void> {
  const ours = await db
    .prepare(
      `INSERT INTO settings (scope, key, value) VALUES ('bot', 'Channel_Report', '-100777'::jsonb)
       ON CONFLICT (scope, key) DO NOTHING RETURNING key`,
    )
    .first<{ key: string }>();
  try {
    await fn();
  } finally {
    await db.prepare(`DELETE FROM bot_notifications WHERE dedupe_key LIKE 'report:paymentreport:hand-credited:wa-tx-%'`).run();
    if (ours) await db.prepare(`DELETE FROM settings WHERE scope = 'bot' AND key = 'Channel_Report'`).run();
  }
}

describe('a transfer that is not the invoice amount', () => {
  it('goes to the wallet, closes the invoice, and tells the customer both amounts in bold', async () => {
    // 199,000 Toman asked; the customer typed 199,000 into a Rial field.
    const inv = await claimedInvoice({ cardIrr: 1_990_000 });
    const tx = await deposit(199_000, inv.clickedAt + 30_000);

    expect(await creditWrongAmounts(db)).toBe(1);

    expect(await balanceOf(inv.userId)).toBe(199_000);
    expect(await statuses(inv)).toEqual({ claim: 'EXPIRED', order: 'EXPIRED', payment: 'EXPIRED' });
    const key = await db
      .prepare(`SELECT kind, amount_irr FROM wallet_entries WHERE idempotency_key = ?1`)
      .bind(`deposit:${tx}:wallet`)
      .first<{ kind: string; amount_irr: number | string }>();
    expect(key).toEqual({ kind: 'TOPUP', amount_irr: expect.anything() });
    expect(Number(key!.amount_irr)).toBe(199_000);

    const text = await messageTo(inv.telegramId);
    expect(text).toContain(
      '<blockquote><b>قرار بود 199,000 تومان واریز کنید، ولی 19,900 تومان واریز کرده‌اید.</b></blockquote>',
    );
    expect(text).toContain('موجودی فعلی: 19,900 تومان');
    expect(text).toContain('مابه‌التفاوت (179,100 تومان)');
    expect(text).toContain('«پرداخت از کیف پول»');
  });

  it('says the balance is enough when the customer sent more than the invoice', async () => {
    const inv = await claimedInvoice({ cardIrr: 1_000_000 });
    await deposit(1_500_000, inv.clickedAt - 60_000);

    expect(await creditWrongAmounts(db)).toBe(1);
    expect(await balanceOf(inv.userId)).toBe(1_500_000);
    const text = await messageTo(inv.telegramId);
    expect(text).toContain('موجودی کیف پول شما برای همین خرید کافی است');
    expect(text).not.toContain('مابه‌التفاوت');
  });

  it('gives back what the invoice took from the balance too, and counts it in the difference', async () => {
    // A 2,000,000 order: 500,000 came off the balance at checkout (#317), the
    // card was asked for 1,500,000, and 150,000 arrived.
    const inv = await claimedInvoice({ cardIrr: 1_500_000, totalIrr: 2_000_000 });
    await db
      .prepare(
        `INSERT INTO wallet_entries (user_id, amount_irr, kind, order_id, note, idempotency_key)
         VALUES (?1, 500000, 'TOPUP', NULL, 'earlier', ?2),
                (?1, -500000, 'PURCHASE', ?3, 'part of the invoice', ?4)`,
      )
      .bind(inv.userId, `wa-seed:${inv.publicId}`, inv.orderId, `order:${inv.orderId}:reserve`)
      .run();
    await deposit(150_000, inv.clickedAt + 10_000);

    expect(await creditWrongAmounts(db)).toBe(1);
    expect(await balanceOf(inv.userId)).toBe(650_000);
    const text = await messageTo(inv.telegramId);
    expect(text).toContain('قرار بود 150,000 تومان واریز کنید، ولی 15,000 تومان');
    expect(text).toContain('مابه‌التفاوت (135,000 تومان)');
  });

  it('runs once: a second sweep finds nothing and credits nothing', async () => {
    const inv = await claimedInvoice({ cardIrr: 900_000 });
    await deposit(90_000, inv.clickedAt + 5_000);
    expect(await creditWrongAmounts(db)).toBe(1);
    expect(await creditWrongAmounts(db)).toBe(0);
    expect(await balanceOf(inv.userId)).toBe(90_000);
  });
});

describe('anything short of plainly this customer’s stays for a person', () => {
  it('leaves an exact amount to the matcher', async () => {
    const inv = await claimedInvoice({ cardIrr: 800_000 });
    await deposit(800_000, inv.clickedAt + 5_000);
    expect(await creditWrongAmounts(db)).toBe(0);
    expect((await statuses(inv))?.claim).toBe('MATCH_SUGGESTED');
  });

  it('waits while the matcher is still waiting for the bank', async () => {
    const inv = await claimedInvoice({ cardIrr: 700_000, ago: 3 * MINUTE, suspect: null });
    await deposit(70_000, inv.clickedAt + 5_000);
    expect(await creditWrongAmounts(db)).toBe(0);
  });

  it('does not reach back to a claim older than a day — that one is already an operator’s', async () => {
    const inv = await claimedInvoice({ cardIrr: 650_000, ago: 25 * 60 * MINUTE });
    await deposit(65_000, inv.clickedAt + 5_000);
    expect(await creditWrongAmounts(db)).toBe(0);
    expect(await balanceOf(inv.userId)).toBe(0);
  });

  it('ignores a transfer outside five minutes of «پرداخت کردم»', async () => {
    const inv = await claimedInvoice({ cardIrr: 600_000 });
    await deposit(60_000, inv.clickedAt + 5 * MINUTE + 1_000);
    expect(await creditWrongAmounts(db)).toBe(0);
    expect(await balanceOf(inv.userId)).toBe(0);
  });

  it('does not choose between two transfers', async () => {
    const inv = await claimedInvoice({ cardIrr: 500_000 });
    await deposit(50_000, inv.clickedAt + 5_000);
    await deposit(450_000, inv.clickedAt + 60_000);
    expect(await creditWrongAmounts(db)).toBe(0);
    expect(await balanceOf(inv.userId)).toBe(0);
  });

  it('does not choose between two customers who pressed near the transfer', async () => {
    const a = await claimedInvoice({ cardIrr: 400_000 });
    const b = await claimedInvoice({ cardIrr: 410_000, ago: 11 * MINUTE - 30_000 });
    await deposit(40_000, a.clickedAt + 10_000);
    expect(await creditWrongAmounts(db)).toBe(0);
    expect(await balanceOf(a.userId)).toBe(0);
    expect(await balanceOf(b.userId)).toBe(0);
  });

  it('leaves a transfer that is exactly somebody’s invoice — it may be their correct payment', async () => {
    const inv = await claimedInvoice({ cardIrr: 300_000 });
    // Another customer's invoice for 250,000, on the same card, never claimed.
    const other = await makeCustomer(793_900 + seq);
    const order = await db
      .prepare(
        `INSERT INTO orders (public_id, user_id, kind, quantity, unit_price_irr, total_irr, status)
         VALUES (?1, ?2, 'NEW_PURCHASE', 1, 250000, 250000, 'AWAITING_PAYMENT') RETURNING id`,
      )
      .bind(`oother${RUN}${seq}`, other)
      .first<{ id: number }>();
    await db
      .prepare(
        `INSERT INTO payments
           (public_id, user_id, order_id, amount_irr, method, status, assigned_card_number,
            created_at, updated_at)
         VALUES (?1, ?2, ?3, 250000, 'CARD_TO_CARD', 'PENDING', ?4, now() - interval '20 minutes', now())`,
      )
      .bind(`other${RUN}${seq}`, other, order!.id, CARD)
      .run();
    await deposit(250_000, inv.clickedAt + 5_000);

    expect(await creditWrongAmounts(db)).toBe(0);
    expect(await balanceOf(inv.userId)).toBe(0);
  });

  it('neither credits a transfer already spent nor counts it against the one that is not', async () => {
    const inv = await claimedInvoice({ cardIrr: 200_000 });
    const spent = await deposit(20_000, inv.clickedAt + 5_000);
    await db
      .prepare(
        `INSERT INTO wallet_entries (user_id, amount_irr, kind, note, idempotency_key)
         VALUES (?1, 20000, 'TOPUP', 'by hand', ?2)`,
      )
      .bind(inv.userId, `deposit:${spent}:wallet`)
      .run();
    expect(await creditWrongAmounts(db)).toBe(0);
    expect(await balanceOf(inv.userId)).toBe(20_000);

    // The spent one is nobody's any more, so a second transfer near the same
    // click is the only one — not one of two.
    await deposit(20_500, inv.clickedAt + 20_000);
    expect(await creditWrongAmounts(db)).toBe(1);
    expect(await balanceOf(inv.userId)).toBe(40_500);
  });

  /**
   * 1 Mehr 1405, production: 100,000 against a 1,000,000 invoice at 20:15; an
   * operator credited it by hand from the customer's page at 20:56; the
   * customer spent it; at 02:37 this sweep paid the same deposit in again.
   */
  it('leaves a transfer the customer was already credited for by hand, and tells the report group once', async () => {
    await withReportGroup(async () => {
      const inv = await claimedInvoice({ cardIrr: 10_000_000 });
      const tx = await deposit(1_000_000, inv.clickedAt - 40_000);
      await creditByHand(inv.userId, inv.clickedAt + MINUTE);

      expect(await creditWrongAmounts(db)).toBe(0);
      expect(await balanceOf(inv.userId)).toBe(1_000_000);
      expect(await statuses(inv)).toEqual({ claim: 'MATCH_SUGGESTED', order: 'AWAITING_PAYMENT', payment: 'AWAITING_REVIEW' });
      expect(await messageTo(inv.telegramId)).toBeUndefined();

      const report = await db
        .prepare(`SELECT body FROM bot_notifications WHERE dedupe_key = ?1`)
        .bind(`report:paymentreport:hand-credited:${tx}`)
        .first<{ body: string }>();
      expect(report?.body).toContain('ربات این واریزی را به کیف پول نبرد');
      expect(report?.body).toContain('۱۰۰٬۰۰۰ تومان دستی شارژ گرفته');
      expect(report?.body).toContain('«اشتباه واریزی»');

      // Told once: the next sweep leaves it alone.
      expect(await creditWrongAmounts(db)).toBe(0);
      expect(await balanceOf(inv.userId)).toBe(1_000_000);
    });
  });

  // CodeRabbit on #450: the held transfer still counts. Dropped from the
  // pairs instead, a second transfer for the same claim — after the hand
  // credit, so the hand-credit check does not stop it — became «the only one».
  it('a transfer held back still counts, so a later one for the same claim is not «the only one»', async () => {
    await withReportGroup(async () => {
      const inv = await claimedInvoice({ cardIrr: 10_000_000 });
      await deposit(1_000_000, inv.clickedAt - 40_000);
      await creditByHand(inv.userId, inv.clickedAt + MINUTE);
      expect(await creditWrongAmounts(db)).toBe(0); // A: held back, reported

      await deposit(1_500_000, inv.clickedAt + 2 * MINUTE); // B: after the hand credit
      expect(await creditWrongAmounts(db)).toBe(0);
      expect(await balanceOf(inv.userId)).toBe(1_000_000);
    });
  });
});
