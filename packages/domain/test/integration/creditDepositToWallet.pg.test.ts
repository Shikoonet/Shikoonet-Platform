/**
 * `creditDepositToWallet` against a real Postgres — a late deposit paid into
 * the customer's wallet, once, and never also spent on an order.
 *
 * The race is written out by hand rather than hoped for: one connection holds
 * the deposit's row the way the other door would, uncommitted, and the test
 * checks the door under test waits for it and then refuses. A wallet entry and
 * a match share no index, so the row lock is the only thing between them.
 *
 * Needs DATABASE_URL on a migrated database; truncates what it touches.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresD1 } from '@shikoo/db';
import { MIRZABOT_SOURCE } from '@shikoo/contracts';
import { creditDepositInSession, creditDepositToWallet } from '../../src/creditDepositToWallet.js';
import { verifyMirzabotClaim } from '../../src/mirzabotVerify.js';
import { INCOME_TX_WHERE } from '../../src/incomeEligibility.js';

const { db, pool } = createPostgresD1();

afterAll(async () => {
  await pool.end();
});

const NOW = 1_786_000_000_000;
const AMOUNT = 1_200_000;
const MESSAGE = 'کیف پول شما شارژ شد';
let userId: number;

beforeEach(async () => {
  await db
    .prepare(
      `TRUNCATE reconciliation_matches, payment_claims, transaction_candidates,
                raw_sms_events, financial_accounts, devices, reseller_transactions,
                webhook_deliveries, income_declined_transactions, bot_notifications,
                wallet_entries, wallets, users
       RESTART IDENTITY CASCADE`,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO devices (id, device_code, display_name, created_at, updated_at)
       VALUES ('dev-1', 'D1', 'phone', ?1, ?1)`,
    )
    .bind(NOW)
    .run();
  await db
    .prepare(
      `INSERT INTO financial_accounts (id, bank_name, display_name, account_type, created_at, updated_at)
       VALUES ('acct-a', 'melli', 'Melli', 'CARD', ?1, ?1)`,
    )
    .bind(NOW)
    .run();
  await db
    .prepare(
      `INSERT INTO raw_sms_events (id, device_id, sender, body_sha256, app_checksum,
                                   sms_timestamp, received_at, classification, parser_status, created_at)
       VALUES ('sms-1', 'dev-1', '710', 'hash-1', 'c1', ?1, ?1, 'BANK_CREDIT', 'OK', ?1)`,
    )
    .bind(NOW)
    .run();
  await db
    .prepare(
      `INSERT INTO transaction_candidates (id, raw_sms_event_id, financial_account_id, direction,
                                           amount_irr, bank_timestamp, confidence, parser_id,
                                           parser_version, status, processing_disposition,
                                           created_at, updated_at)
       VALUES ('tx-late', 'sms-1', 'acct-a', 'CREDIT', ?1, ?2, 1.0, 'p', 'v1',
               'PARSED', 'ACTIONABLE', ?2, ?2)`,
    )
    .bind(AMOUNT, NOW)
    .run();
  await db
    .prepare(
      `INSERT INTO payment_claims (id, external_order_id, expected_amount_irr,
                                   target_financial_account_id, submitted_at, source_system,
                                   status, metadata_json, suspect_metadata_json, created_at, updated_at)
       VALUES ('claim-1', 'mirzabot:test:claim-1', ?1, 'acct-a', ?2, ?3, 'PENDING', '{}', '{}', ?2, ?2)`,
    )
    .bind(AMOUNT, NOW, MIRZABOT_SOURCE)
    .run();
  const user = await db
    .prepare(
      `INSERT INTO users (telegram_id, username, registered_at) VALUES (990001, 'latepayer', now())
       RETURNING id`,
    )
    .first<{ id: number }>();
  userId = Number(user!.id);
});

const credit = (over: Partial<Parameters<typeof creditDepositToWallet>[1]> = {}) =>
  creditDepositToWallet(db, {
    transactionId: 'tx-late',
    userId,
    actorEmail: 'op@example.com',
    reason: 'paid after the invoice expired',
    message: MESSAGE,
    ...over,
  });

async function balance(): Promise<number> {
  const row = await db
    .prepare(`SELECT balance_irr FROM wallets WHERE user_id = ?1`)
    .bind(userId)
    .first<{ balance_irr: number | string }>();
  return Number(row?.balance_irr ?? 0);
}

async function inIncomeQueue(): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS ok FROM transaction_candidates t WHERE t.id = 'tx-late' AND ${INCOME_TX_WHERE}`)
    .first<{ ok: number }>();
  return row != null;
}

async function matchCount(): Promise<number> {
  const row = await db
    .prepare(
      `SELECT count(*)::int AS n FROM reconciliation_matches
        WHERE transaction_candidate_id = 'tx-late' AND status IN ('CONFIRMED','AUTO_VERIFIED')`,
    )
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

describe('creditDepositToWallet', () => {
  it('pays the deposit into the wallet once, tells the customer, and takes it out of «واریزی‌ها»', async () => {
    expect(await inIncomeQueue()).toBe(true);

    const res = await credit();
    expect(res).toEqual({ ok: true, amountIrr: AMOUNT, balanceIrr: AMOUNT, notified: true });
    expect(await balance()).toBe(AMOUNT);
    expect(await inIncomeQueue()).toBe(false);
    const tx = await db.prepare(`SELECT status FROM transaction_candidates WHERE id = 'tx-late'`).first<string>('status');
    expect(tx).toBe('APPROVED');
    const note = await db
      .prepare(`SELECT chat_id, body FROM bot_notifications WHERE dedupe_key = 'deposit-wallet:tx-late'`)
      .first<{ chat_id: number | string; body: string }>();
    expect(Number(note?.chat_id)).toBe(990001);
    expect(note?.body).toBe(MESSAGE);

    // A second press — or a second operator — moves nothing.
    expect(await credit()).toEqual({ ok: false, error: 'NOT_INCOME_ELIGIBLE' });
    expect(await balance()).toBe(AMOUNT);
  });

  it('credits a blocked customer without messaging them', async () => {
    await db.prepare(`UPDATE users SET status = 'BLOCKED' WHERE id = ?1`).bind(userId).run();
    const res = await credit();
    expect(res).toMatchObject({ ok: true, notified: false });
    expect(await balance()).toBe(AMOUNT);
  });

  it('refuses a deposit already spent on an order, and moves no money', async () => {
    const verified = await verifyMirzabotClaim(db, {
      claimId: 'claim-1',
      transactionId: 'tx-late',
      mode: 'ADMIN_APPROVED',
      actorEmail: 'op@example.com',
    });
    expect(verified.ok).toBe(true);
    expect(await credit()).toEqual({ ok: false, error: 'NOT_INCOME_ELIGIBLE' });
    expect(await balance()).toBe(0);
  });

  it('asks for a reason and a real customer', async () => {
    expect(await credit({ reason: '  ' })).toEqual({ ok: false, error: 'REASON_REQUIRED' });
    expect(await credit({ userId: 999_999 })).toEqual({ ok: false, error: 'USER_NOT_FOUND' });
    expect(await credit({ transactionId: 'tx-none' })).toEqual({ ok: false, error: 'TRANSACTION_NOT_FOUND' });
    expect(await balance()).toBe(0);
  });

  it('writes no message of its own when the caller sends one (the bot’s wrong-amount sweep)', async () => {
    const res = await db.withSession((tx) =>
      creditDepositInSession(tx, {
        transactionId: 'tx-late',
        userId,
        actorEmail: 'system',
        reason: 'wrong amount',
        message: null,
      }),
    );
    expect(res).toMatchObject({ ok: true, amountIrr: AMOUNT, notified: false });
    expect(await balance()).toBe(AMOUNT);
    const notes = await db.prepare(`SELECT count(*)::int AS n FROM bot_notifications`).first<{ n: number }>();
    expect(notes?.n).toBe(0);
  });
});

/**
 * 1 Mehr 1405, production: a customer sent a tenth of a 1,000,000 invoice at
 * 20:15, an operator credited the 100,000 by hand from the customer's page at
 * 20:56, the customer spent it at 21:01, and at 02:37 the bot's wrong-amount
 * sweep paid the same deposit in again. A hand credit names no deposit, so
 * nothing that read the deposit could tell.
 */
describe('a customer already credited by hand since the deposit', () => {
  async function creditByHand(atMs: number | null) {
    await db
      .prepare(
        `INSERT INTO wallet_entries (user_id, amount_irr, kind, actor, note, idempotency_key, created_at)
         VALUES (?1, ?2, 'ADMIN_ADJUST', 'sam@example.com', 'اشتباه واریزی', 'admin-adjust:hand-1',
                 COALESCE(to_timestamp(?3 / 1000.0), now()))`,
      )
      .bind(userId, AMOUNT, atMs)
      .run();
  }

  it('refuses, names the hand credit, and moves no money', async () => {
    await creditByHand(NOW + 41 * 60_000);
    const res = await credit();
    expect(res).toEqual({
      ok: false,
      error: 'HAND_CREDITED',
      handCredit: { amountIrr: AMOUNT, note: 'اشتباه واریزی', actor: 'sam@example.com', at: NOW + 41 * 60_000 },
    });
    expect(await balance()).toBe(AMOUNT); // the hand credit, once
    expect(await inIncomeQueue()).toBe(true);
    const notes = await db.prepare(`SELECT count(*)::int AS n FROM bot_notifications`).first<{ n: number }>();
    expect(notes?.n).toBe(0);
  });

  it('the bot’s own door refuses too', async () => {
    await creditByHand(NOW + 41 * 60_000);
    const res = await db.withSession((tx) =>
      creditDepositInSession(tx, { transactionId: 'tx-late', userId, actorEmail: 'system', reason: 'wrong amount', message: null }),
    );
    expect(res).toMatchObject({ ok: false, error: 'HAND_CREDITED' });
    expect(await balance()).toBe(AMOUNT);
  });

  it('credits anyway once the operator has been shown it', async () => {
    await creditByHand(NOW + 41 * 60_000);
    const res = await credit({ despiteHandCredit: true });
    expect(res).toMatchObject({ ok: true, amountIrr: AMOUNT, balanceIrr: 2 * AMOUNT });
    expect(await inIncomeQueue()).toBe(false);
  });

  it('a hand credit from before the deposit arrived is about something else', async () => {
    await creditByHand(NOW - 60_000);
    expect(await credit()).toMatchObject({ ok: true, balanceIrr: 2 * AMOUNT });
  });
});

describe('one deposit, one use — the wallet and an order', () => {
  it('an order cannot be verified on a deposit that went to a wallet', async () => {
    await credit();
    const res = await verifyMirzabotClaim(db, {
      claimId: 'claim-1',
      transactionId: 'tx-late',
      mode: 'ADMIN_APPROVED',
      actorEmail: 'op@example.com',
      enqueueWebhook: true,
    });
    expect(res).toEqual({ ok: false, error: 'TRANSACTION_ALREADY_CONSUMED' });
    expect(await matchCount()).toBe(0);
    const claim = await db.prepare(`SELECT status FROM payment_claims WHERE id = 'claim-1'`).first<string>('status');
    expect(claim).toBe('PENDING');
  });

  it('a verify that starts while the wallet credit holds the deposit waits, then refuses', async () => {
    // The credit's own statements, held open on another connection.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM transaction_candidates WHERE id = 'tx-late' FOR UPDATE`);
      await holder.query(
        `INSERT INTO wallet_entries (user_id, amount_irr, kind, actor, note, idempotency_key)
         VALUES ($1, $2, 'TOPUP', 'op@example.com', 'held', 'deposit:tx-late:wallet')`,
        [userId, AMOUNT],
      );

      const verifying = verifyMirzabotClaim(db, {
        claimId: 'claim-1',
        transactionId: 'tx-late',
        mode: 'ADMIN_APPROVED',
        actorEmail: 'op@example.com',
        enqueueWebhook: true,
      });
      // Long enough for the verify batch to reach the row lock and wait on it.
      await new Promise((r) => setTimeout(r, 500));
      await holder.query('COMMIT');

      expect(await verifying).toEqual({ ok: false, error: 'TRANSACTION_ALREADY_CONSUMED' });
    } finally {
      holder.release();
    }
    expect(await matchCount()).toBe(0);
    const claim = await db.prepare(`SELECT status FROM payment_claims WHERE id = 'claim-1'`).first<string>('status');
    expect(claim).toBe('PENDING');
    const notices = await db
      .prepare(`SELECT count(*)::int AS n FROM webhook_deliveries`)
      .first<{ n: number }>();
    expect(Number(notices?.n)).toBe(0);
  });

  it('a wallet credit that starts while a verify holds the deposit waits, then refuses', async () => {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM transaction_candidates WHERE id = 'tx-late' FOR UPDATE`);
      await holder.query(
        `INSERT INTO reconciliation_matches (id, transaction_candidate_id, payment_claim_id, score,
                                             matching_reasons_json, mismatch_reasons_json, status,
                                             created_at, updated_at)
         VALUES ('m-held', 'tx-late', 'claim-1', 1.0, '[]', '[]', 'CONFIRMED', $1, $1)`,
        [NOW],
      );

      const crediting = credit();
      await new Promise((r) => setTimeout(r, 500));
      await holder.query('COMMIT');

      expect(await crediting).toEqual({ ok: false, error: 'NOT_INCOME_ELIGIBLE' });
    } finally {
      holder.release();
    }
    expect(await balance()).toBe(0);
  });
});
