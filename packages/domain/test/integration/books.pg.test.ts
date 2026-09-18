/**
 * The books, at the domain seam — Sam, 2026-09-17.
 *
 * `apps/dashboard-worker/test/books.test.ts` walks the routes; this file asks
 * the functions directly, with the test playing the bank: every balance on
 * every row is written here, and the statement has to agree with it. A
 * figure computed by the code under test is never the thing checked against.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPostgresD1 } from '@shikoo/db';
import {
  accountStatement,
  addManualMovement,
  booksOpening,
  monthStatements,
  openBooks,
  parseJalaliMonth,
  voidManualMovement,
  walletNow,
  withdrawalsNear,
} from '../../src/books.js';
import { declineIncomeTransaction, restoreIncomeTransaction, isOffBooksEligible } from '../../src/declineIncomeTransaction.js';

const { db, pool } = createPostgresD1();

const P = 'zz-dbooks-';
const ACCT = `${P}acct`;
const ACCT2 = `${P}acct-2`;
const DEVICE = `${P}device`;
const DAY = 86_400_000;
// Pinned mid-month: `T(day)` must be in the past for `openBooks` (below) and
// a live clock on the 1st of a Jalali month would put it in the future.
const NOW = Date.UTC(2026, 8, 17, 9, 0, 0);
vi.spyOn(Date, 'now').mockReturnValue(NOW);
const month = parseJalaliMonth(undefined, NOW)!;
const T = (day: number, hour = 12) => month.start + day * DAY + hour * 3_600_000;

let seq = 0;
async function tx(args: {
  account?: string;
  direction: 'CREDIT' | 'DEBIT';
  amountIrr: number;
  balanceIrr: number | null;
  at: number;
  status?: string;
}): Promise<string> {
  const id = `${P}tx-${++seq}`;
  const sms = `${P}sms-${seq}`;
  await db
    .prepare(
      `INSERT INTO raw_sms_events
         (id, device_id, sender, normalized_body, body_sha256, app_checksum, sms_timestamp,
          received_at, classification, parser_status, parser_id, parser_version, created_at)
       VALUES (?1, ?2, 'BANK', 'seed', ?3, 'c', ?4, ?4, 'BANK_TRANSACTION', 'OK', 'test', 'v1', ?4)`,
    )
    .bind(sms, DEVICE, `${P}hash-${seq}`, args.at)
    .run();
  await db
    .prepare(
      `INSERT INTO transaction_candidates
         (id, raw_sms_event_id, financial_account_id, direction, amount_irr, balance_irr, status,
          bank_timestamp, confidence, parser_id, parser_version, parser_evidence_json,
          processing_disposition, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1.0, 'test', 'v1', '{}', ?9, ?8, ?8)`,
    )
    .bind(
      id,
      sms,
      args.account ?? ACCT,
      args.direction,
      args.amountIrr,
      args.balanceIrr,
      args.status ?? 'PARSED',
      args.at,
      args.direction === 'DEBIT' ? 'OUTGOING_IGNORED' : 'ACTIONABLE',
    )
    .run();
  return id;
}

async function expense(txId: string | null, amountIrr: number, feeIrr = 0, day = T(4)): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO revenue_adjustments
         (amount_irr, note, created_by, created_at, kind, spent_on, financial_account_id, fee_irr, transaction_candidate_id)
       VALUES (?1, ?2, 'test', now(), 'EXPENSE', to_timestamp(?3 / 1000.0)::date, ?4, ?5, ?6)
       RETURNING id`,
    )
    .bind(-amountIrr, `${P}expense`, day, ACCT, feeIrr, txId)
    .first<{ id: number }>();
  return Number(row!.id);
}

async function purge(): Promise<void> {
  await db.prepare(`DELETE FROM revenue_adjustments WHERE note LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM income_declined_transactions WHERE transaction_candidate_id LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM account_opening_balances WHERE financial_account_id LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM manual_bank_movements WHERE financial_account_id LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM transaction_candidates WHERE id LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM raw_sms_events WHERE id LIKE ?1`).bind(`${P}%`).run();
}

beforeEach(async () => {
  await purge();
  await db
    .prepare(
      `INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at)
       VALUES (?1, ?1, 'Books Phone', 1, 0, 0) ON CONFLICT (id) DO NOTHING`,
    )
    .bind(DEVICE)
    .run();
  for (const [id, name] of [[ACCT, 'حساب دفتر'], [ACCT2, 'حساب دوم']]) {
    await db
      .prepare(
        `INSERT INTO financial_accounts
           (id, bank_name, display_name, account_type, active, status, parser_configuration, created_at, updated_at)
         VALUES (?1, 'Melli', ?2, 'CARD', 1, 'ACTIVE', '{}', 0, 0)
         ON CONFLICT (id) DO UPDATE SET active = 1, status = 'ACTIVE'`,
      )
      .bind(id, name)
      .run();
  }
});

afterAll(async () => {
  await purge();
  await pool.end();
  vi.restoreAllMocks();
});

describe('parseJalaliMonth', () => {
  it('reads YYYY-MM, refuses nonsense, and defaults to the month of the instant given', () => {
    const m = parseJalaliMonth('1405-06')!;
    expect(m.year).toBe(1405);
    expect(m.month).toBe(6);
    expect(m.label).toBe('شهریور 1405');
    expect(m.end).toBeGreaterThan(m.start);
    expect(parseJalaliMonth('1405-13')).toBeNull();
    expect(parseJalaliMonth('abc')).toBeNull();
    expect(parseJalaliMonth('')).not.toBeNull();
    // 1405-06-01 00:00 Tehran is 2026-08-23 — a Gregorian instant inside it maps back.
    expect(parseJalaliMonth(undefined, Date.UTC(2026, 8, 1, 12))?.month).toBe(6);
  });
});

describe('accountStatement', () => {
  it('opens and closes on the bank and explains every movement between', async () => {
    await tx({ direction: 'CREDIT', amountIrr: 100, balanceIrr: 10_000_000, at: month.start - 2 * DAY });
    await tx({ direction: 'CREDIT', amountIrr: 1_990_000, balanceIrr: 11_990_000, at: T(1) });
    const transfer = await tx({ direction: 'CREDIT', amountIrr: 5_000_000, balanceIrr: 16_990_000, at: T(2) });
    const server = await tx({ direction: 'DEBIT', amountIrr: 2_000_000, balanceIrr: 14_990_000, at: T(4) });
    const loan = await tx({ direction: 'DEBIT', amountIrr: 3_000_000, balanceIrr: 11_990_000, at: T(5) });
    await tx({ direction: 'DEBIT', amountIrr: 400_000, balanceIrr: 11_590_000, at: T(6) });
    // Refused rows are not the bank's word.
    await tx({ direction: 'CREDIT', amountIrr: 9_999_999, balanceIrr: null, at: T(6, 13), status: 'REJECTED' });

    expect((await declineIncomeTransaction(db, { transactionId: transfer, actorEmail: 't', category: 'TRANSFER' })).ok).toBe(true);
    expect((await declineIncomeTransaction(db, { transactionId: loan, actorEmail: 't', category: 'PERSONAL', reason: 'قسط' })).ok).toBe(true);
    await expense(server, 2_000_000, 7_200);
    await expense(null, 500_000, 0, T(7));

    const s = (await accountStatement(db, ACCT, month))!;
    expect(s.beforeStart).toBe(false);
    expect(s.opening).toMatchObject({ balanceIrr: 10_000_000, source: 'sms' });
    expect(s.closing).toMatchObject({ balanceIrr: 11_590_000, source: 'sms' });
    expect(s.customerIncome).toEqual({ count: 1, amountIrr: 1_990_000 });
    expect(s.offBooksCredits).toEqual([{ category: 'TRANSFER', count: 1, amountIrr: 5_000_000 }]);
    expect(s.explainedWithdrawals).toEqual({ count: 1, amountIrr: 2_000_000 });
    expect(s.unexplainedWithdrawals).toEqual({ count: 1, amountIrr: 400_000 });
    expect(s.offBooksDebits).toEqual([{ category: 'PERSONAL', count: 1, amountIrr: 3_000_000 }]);
    expect(s.ledger).toEqual({ expenseCount: 2, expenseIrr: 2_500_000, feeIrr: 7_200, unlinkedCount: 1, unlinkedIrr: 500_000 });
    expect(s.bankDeltaIrr).toBe(1_990_000 + 5_000_000 - 2_000_000 - 3_000_000 - 400_000);
    expect(s.gapIrr).toBe(0);
  });

  it('is null for an account that does not exist, and «؟» for one the bank never priced', async () => {
    expect(await accountStatement(db, `${P}nobody`, month)).toBeNull();
    await tx({ direction: 'CREDIT', amountIrr: 1, balanceIrr: null, at: T(1) });
    const s = (await accountStatement(db, ACCT, month))!;
    expect(s.opening).toBeNull();
    expect(s.closing).toBeNull();
    expect(s.gapIrr).toBeNull();
    expect(s.customerIncome.count).toBe(1);
  });

  it('reports a missing SMS as the gap, measured only up to the last balance', async () => {
    await tx({ direction: 'CREDIT', amountIrr: 100, balanceIrr: 1_000_000, at: month.start - DAY });
    await tx({ direction: 'CREDIT', amountIrr: 200_000, balanceIrr: 1_500_000, at: T(2) });
    await tx({ direction: 'CREDIT', amountIrr: 50_000, balanceIrr: null, at: T(3) });
    const s = (await accountStatement(db, ACCT, month))!;
    expect(s.closing?.balanceIrr).toBe(1_500_000);
    expect(s.gapIrr).toBe(300_000);
  });

  it('a hole the bank showed is closed by a hand-written movement, and reopens when it is voided', async () => {
    await tx({ direction: 'CREDIT', amountIrr: 100, balanceIrr: 1_000_000, at: month.start - DAY });
    // 1M, then a 200k deposit and the bank says 700k: 500k left, no SMS.
    await tx({ direction: 'CREDIT', amountIrr: 200_000, balanceIrr: 700_000, at: T(2) });
    expect((await accountStatement(db, ACCT, month))!.gapIrr).toBe(-500_000);

    const w = await addManualMovement(db, {
      accountId: ACCT,
      direction: 'DEBIT',
      amountIrr: 500_000,
      movedAt: T(2) - 1000,
      category: 'PERSONAL',
      actorEmail: 't',
      now: NOW,
    });
    expect(w.ok).toBe(true);
    const s = (await accountStatement(db, ACCT, month))!;
    expect(s.gapIrr).toBe(0);
    expect(s.manual).toEqual({ count: 1, creditIrr: 0, debitIrr: 500_000 });
    expect(s.offBooksDebits).toEqual([{ category: 'PERSONAL', count: 1, amountIrr: 500_000 }]);
    // Written after the closing SMS: in the boxes, not in the check.
    await addManualMovement(db, { accountId: ACCT, direction: 'DEBIT', amountIrr: 1, movedAt: T(3), category: 'PERSONAL', actorEmail: 't', now: NOW });
    expect((await accountStatement(db, ACCT, month))!.gapIrr).toBe(0);

    expect(w.ok && (await voidManualMovement(db, { id: w.id, actorEmail: 't', now: NOW })).ok).toBe(true);
    expect(w.ok && (await voidManualMovement(db, { id: w.id, actorEmail: 't', now: NOW })).ok).toBe(false);
    expect((await accountStatement(db, ACCT, month))!.gapIrr).toBe(-500_000);
    expect((await addManualMovement(db, { accountId: `${P}nope`, direction: 'DEBIT', amountIrr: 1, movedAt: T(1), category: 'OTHER', actorEmail: 't', now: NOW })).ok).toBe(false);
  });

  it('the wallet this instant is the last balance of every live account, and says who never sent one', async () => {
    await tx({ direction: 'CREDIT', amountIrr: 100, balanceIrr: 1_000_000, at: T(1) });
    await tx({ account: ACCT2, direction: 'CREDIT', amountIrr: 100, balanceIrr: 250_000, at: T(1) });
    await tx({ account: ACCT2, direction: 'CREDIT', amountIrr: 100, balanceIrr: null, at: T(2) });
    const w = await walletNow(db, NOW);
    expect(w.walletIrr).toBeGreaterThanOrEqual(1_250_000);
    expect(w.accounts).toBeGreaterThanOrEqual(2);
  });

  it('closes on the opening when the month moved nothing', async () => {
    await tx({ direction: 'CREDIT', amountIrr: 100, balanceIrr: 7_000_000, at: month.start - DAY });
    const s = (await accountStatement(db, ACCT, month))!;
    expect(s.closing).toEqual(s.opening);
    expect(s.gapIrr).toBe(0);
  });
});

describe('the fresh start', () => {
  it('writes each live account’s last balance, refuses a second press, and cuts the statement there', async () => {
    await tx({ direction: 'CREDIT', amountIrr: 9_000_000, balanceIrr: 9_000_000, at: T(1) });
    await tx({ direction: 'DEBIT', amountIrr: 1_000_000, balanceIrr: 8_000_000, at: T(2) });
    await tx({ account: ACCT2, direction: 'CREDIT', amountIrr: 1, balanceIrr: null, at: T(2) });

    expect(await booksOpening(db)).toBeNull();
    const first = await openBooks(db, { actorEmail: 't', now: T(2, 18) });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const mine = first.result.accounts.filter((a) => a.accountId.startsWith(P));
    expect(mine).toEqual([
      { accountId: ACCT, displayName: 'حساب دفتر', balanceIrr: 8_000_000, asOf: T(2) },
      { accountId: ACCT2, displayName: 'حساب دوم', balanceIrr: null, asOf: null },
    ]);
    expect(first.result.walletIrr).toBeGreaterThanOrEqual(8_000_000);

    const second = await openBooks(db, { actorEmail: 't', now: T(3) });
    expect(second).toEqual({ ok: false, error: 'ALREADY_OPENED' });
    const forced = await openBooks(db, { actorEmail: 't', now: T(2, 19), force: true });
    expect(forced.ok).toBe(true);

    await tx({ direction: 'CREDIT', amountIrr: 1_990_000, balanceIrr: 9_990_000, at: T(3) });
    const s = (await accountStatement(db, ACCT, month))!;
    expect(s.opening).toMatchObject({ balanceIrr: 8_000_000, source: 'opening' });
    expect(s.customerIncome).toEqual({ count: 1, amountIrr: 1_990_000 });
    expect(s.gapIrr).toBe(0);

    const opened = await booksOpening(db);
    expect(opened?.accounts).toBeGreaterThanOrEqual(1);

    // The month before the start: empty. The month after: opens on the last SMS.
    const prev = parseJalaliMonth(month.month === 1 ? `${month.year - 1}-12` : `${month.year}-${month.month - 1}`)!;
    expect((await accountStatement(db, ACCT, prev))!.beforeStart).toBe(true);
    const next = parseJalaliMonth(month.month === 12 ? `${month.year + 1}-1` : `${month.year}-${month.month + 1}`)!;
    const after = (await accountStatement(db, ACCT, next))!;
    expect(after.opening).toMatchObject({ balanceIrr: 9_990_000, source: 'sms' });
    expect(after.closing).toEqual(after.opening);

    // Every account with a row in the month, live first.
    const all = await monthStatements(db, month);
    expect(all.map((a) => a.accountId)).toEqual(expect.arrayContaining([ACCT, ACCT2]));
  });
});

describe('off the books', () => {
  it('a debit is eligible until an expense explains it; a restored one is eligible again', async () => {
    const w = await tx({ direction: 'DEBIT', amountIrr: 5, balanceIrr: null, at: T(6) });
    expect(await isOffBooksEligible(db, w)).toBe(true);
    expect((await declineIncomeTransaction(db, { transactionId: w, actorEmail: 't', category: 'BANK_FEE' })).ok).toBe(true);
    expect((await declineIncomeTransaction(db, { transactionId: w, actorEmail: 't' })).ok).toBe(false);
    expect((await restoreIncomeTransaction(db, { transactionId: w, actorEmail: 't' })).ok).toBe(true);
    expect((await declineIncomeTransaction(db, { transactionId: w, actorEmail: 't', category: 'PERSONAL' })).ok).toBe(true);

    const explained = await tx({ direction: 'DEBIT', amountIrr: 7, balanceIrr: null, at: T(6) });
    await expense(explained, 7);
    expect(await isOffBooksEligible(db, explained)).toBe(false);
  });

  it('lists the withdrawals an expense on that day could be — not the tagged, and says which are taken', async () => {
    const free = await tx({ direction: 'DEBIT', amountIrr: 1_000, balanceIrr: null, at: T(5) });
    const taken = await tx({ direction: 'DEBIT', amountIrr: 2_000, balanceIrr: null, at: T(5, 13) });
    const tagged = await tx({ direction: 'DEBIT', amountIrr: 3_000, balanceIrr: null, at: T(5, 14) });
    await tx({ direction: 'CREDIT', amountIrr: 4_000, balanceIrr: null, at: T(5, 15) });
    await tx({ direction: 'DEBIT', amountIrr: 5_000, balanceIrr: null, at: T(5) - 3 * DAY });
    const id = await expense(taken, 2_000);
    await declineIncomeTransaction(db, { transactionId: tagged, actorEmail: 't', category: 'PERSONAL' });

    const items = await withdrawalsNear(db, { accountId: ACCT, dayStartMs: T(5, 0), dayEndMs: T(6, 0) });
    expect(items.map((i) => [i.id, i.linkedExpenseId])).toEqual([
      [taken, id],
      [free, null],
    ]);
  });
});
