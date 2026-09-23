/**
 * The books — Sam, 2026-09-17: an expense says which account paid it and
 * what the bank charged; a movement can be taken off the books with a
 * reason; a month's statement per account ties out to the bank's own
 * balance; and the fresh start writes tonight's balances as the opening.
 *
 * Every figure here is checked against numbers this file wrote into the
 * bank side (transaction rows with balances), never against the code under
 * test — the statement's job is to agree with the bank, so the test plays
 * the bank.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseJalaliMonth } from '@shikoo/domain';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-books@example.com';
const REVIEWER = 'reviewer-books@example.com';
const READER = 'reader-books@example.com';
const P = 'zz-books-';
const ACCT = `${P}acct`;
const ACCT2 = `${P}acct-2`;
const DEVICE = `${P}device`;

const envAs = (email: string) => ({ ...baseEnv, TEST_ACCESS_USER: email });
const json = (method: string, path: string, body: unknown, email = ADMIN) =>
  app.request(
    path,
    { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    envAs(email),
  );
const get = (path: string, email = ADMIN) => app.request(path, {}, envAs(email));

// Pinned mid-month (2026-09-17 12:30 Tehran = ۲۶ شهریور), so every `T(day)`
// below is in the past for `openBooks`, which takes nothing after «now».
// Live time would put T(1)…T(2) in the future on the first days of a month.
const NOW = Date.UTC(2026, 8, 17, 9, 0, 0);
vi.spyOn(Date, 'now').mockReturnValue(NOW);
const month = parseJalaliMonth(undefined, NOW)!;
const DAY = 86_400_000;
/** Inside the month, in order; never in the future relative to each other. */
const T = (day: number, hour = 12) => month.start + day * DAY + hour * 3_600_000;
const MONTH_Q = `${month.year}-${String(month.month).padStart(2, '0')}`;

let seq = 0;
async function tx(args: {
  account?: string;
  direction: 'CREDIT' | 'DEBIT';
  amountIrr: number;
  balanceIrr: number | null;
  at: number;
}): Promise<string> {
  const id = `${P}tx-${++seq}`;
  const sms = `${P}sms-${seq}`;
  const now = Date.now();
  await baseEnv.DB.prepare(
    `INSERT INTO raw_sms_events
       (id, device_id, sender, normalized_body, body_sha256, app_checksum, sms_timestamp,
        received_at, classification, parser_status, parser_id, parser_version, created_at)
     VALUES (?1, ?2, 'BANK', 'seed', ?3, 'c', ?4, ?5, 'BANK_TRANSACTION', 'OK', 'test', 'v1', ?5)`,
  )
    .bind(sms, DEVICE, `${P}hash-${seq}`, args.at, now)
    .run();
  await baseEnv.DB.prepare(
    `INSERT INTO transaction_candidates
       (id, raw_sms_event_id, financial_account_id, direction, amount_irr, balance_irr, status,
        bank_timestamp, confidence, parser_id, parser_version, parser_evidence_json,
        processing_disposition, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'PARSED', ?7, 1.0, 'test', 'v1', '{}', ?8, ?9, ?9)`,
  )
    .bind(
      id,
      sms,
      args.account ?? ACCT,
      args.direction,
      args.amountIrr,
      args.balanceIrr,
      args.at,
      args.direction === 'DEBIT' ? 'OUTGOING_IGNORED' : 'ACTIONABLE',
      now,
    )
    .run();
  return id;
}

async function purge(): Promise<void> {
  const db = baseEnv.DB;
  await db.prepare(`DELETE FROM revenue_adjustments WHERE note LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM income_declined_transactions WHERE transaction_candidate_id LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM account_opening_balances WHERE financial_account_id LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM manual_bank_movements WHERE financial_account_id LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM transaction_candidates WHERE id LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM raw_sms_events WHERE id LIKE ?1`).bind(`${P}%`).run();
}

beforeAll(async () => {
  await applySchema();
  const now = Date.now();
  for (const [email, role] of [[ADMIN, 'ADMIN'], [REVIEWER, 'REVIEWER'], [READER, 'READ_ONLY']]) {
    await baseEnv.DB.prepare(
      `INSERT INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4) ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, active = 1`,
    )
      .bind(crypto.randomUUID(), email, role, now)
      .run();
  }
  await baseEnv.DB.prepare(
    `INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES (?1, ?1, 'Books Phone', 1, ?2, ?2) ON CONFLICT (id) DO NOTHING`,
  )
    .bind(DEVICE, now)
    .run();
  for (const [id, name] of [[ACCT, 'حساب دفتر'], [ACCT2, 'حساب دوم']]) {
    await baseEnv.DB.prepare(
      `INSERT INTO financial_accounts
         (id, bank_name, display_name, account_type, active, status, parser_configuration, created_at, updated_at)
       VALUES (?1, 'Melli', ?2, 'CARD', 1, 'ACTIVE', '{}', ?3, ?3)
       ON CONFLICT (id) DO UPDATE SET active = 1, status = 'ACTIVE'`,
    )
      .bind(id, name, now)
      .run();
  }
});

beforeEach(purge);
afterAll(async () => {
  await purge();
  vi.restoreAllMocks();
});

describe('an expense knows its account', () => {
  it('stores the account, the fee, and the withdrawal it is', async () => {
    const w = await tx({ direction: 'DEBIT', amountIrr: 2_000_000, balanceIrr: 8_000_000, at: T(3) });
    const r = await json('POST', '/api/v1/admin/revenue-adjustments', {
      amountToman: 200_000,
      kind: 'EXPENSE',
      note: `${P}server bill`,
      financialAccountId: ACCT,
      feeToman: 720,
      transactionCandidateId: w,
    });
    expect(r.status).toBe(200);
    const { id } = (await r.json()) as { id: number };
    const row = await baseEnv.DB.prepare(
      `SELECT financial_account_id, fee_irr, transaction_candidate_id FROM revenue_adjustments WHERE id = ?1`,
    )
      .bind(id)
      .first<{ financial_account_id: string; fee_irr: string | number; transaction_candidate_id: string }>();
    expect(row).toEqual({ financial_account_id: ACCT, fee_irr: 7_200, transaction_candidate_id: w });

    const list = (await (await get(`/api/v1/admin/revenue-adjustments?q=${P}`)).json()) as {
      items: Array<{ id: number; accountName: string; feeIrr: number; transactionCandidateId: string }>;
    };
    const item = list.items.find((i) => i.id === id)!;
    expect(item.accountName).toBe('حساب دفتر');
    expect(item.feeIrr).toBe(7_200);
    expect(item.transactionCandidateId).toBe(w);
  });

  it('refuses a withdrawal that already explains another row', async () => {
    const w = await tx({ direction: 'DEBIT', amountIrr: 500_000, balanceIrr: null, at: T(4) });
    const first = await json('POST', '/api/v1/admin/revenue-adjustments', {
      amountToman: 50_000, kind: 'EXPENSE', note: `${P}one`, transactionCandidateId: w,
    });
    expect(first.status).toBe(200);
    const second = await json('POST', '/api/v1/admin/revenue-adjustments', {
      amountToman: 50_000, kind: 'EXPENSE', note: `${P}two`, transactionCandidateId: w,
    });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe('withdrawal_taken');
  });

  it('refuses a deposit as a withdrawal, and a withdrawal on another account', async () => {
    const credit = await tx({ direction: 'CREDIT', amountIrr: 500_000, balanceIrr: null, at: T(4) });
    const other = await tx({ account: ACCT2, direction: 'DEBIT', amountIrr: 500_000, balanceIrr: null, at: T(4) });
    const a = await json('POST', '/api/v1/admin/revenue-adjustments', {
      amountToman: 50_000, kind: 'EXPENSE', note: `${P}x`, transactionCandidateId: credit,
    });
    expect(((await a.json()) as { error: string }).error).toBe('withdrawal_not_a_debit');
    const b = await json('POST', '/api/v1/admin/revenue-adjustments', {
      amountToman: 50_000, kind: 'EXPENSE', note: `${P}y`, financialAccountId: ACCT, transactionCandidateId: other,
    });
    expect(((await b.json()) as { error: string }).error).toBe('withdrawal_on_other_account');
  });

  it('takes the account from the withdrawal when the row named none', async () => {
    const w = await tx({ account: ACCT2, direction: 'DEBIT', amountIrr: 500_000, balanceIrr: null, at: T(4) });
    const r = await json('POST', '/api/v1/admin/revenue-adjustments', {
      amountToman: 50_000, kind: 'EXPENSE', note: `${P}z`, transactionCandidateId: w,
    });
    const { id } = (await r.json()) as { id: number };
    const row = await baseEnv.DB.prepare(`SELECT financial_account_id FROM revenue_adjustments WHERE id = ?1`)
      .bind(id)
      .first<{ financial_account_id: string }>();
    expect(row?.financial_account_id).toBe(ACCT2);
  });

  it('lists the withdrawals an expense on that day could be', async () => {
    const w = await tx({ direction: 'DEBIT', amountIrr: 999_000, balanceIrr: 1_000, at: T(5) });
    await tx({ direction: 'CREDIT', amountIrr: 1, balanceIrr: 1_001, at: T(5) });
    const day = new Date(T(5)).toISOString().slice(0, 10);
    const r = (await (await get(`/api/v1/admin/books/withdrawals?accountId=${ACCT}&day=${day}`)).json()) as {
      items: Array<{ id: string; amountIrr: number; linkedExpenseId: number | null }>;
    };
    expect(r.items.map((i) => i.id)).toEqual([w]);
    expect(r.items[0]!.linkedExpenseId).toBeNull();
  });
});

describe('off the books', () => {
  it('takes a withdrawal off the books with a category, and a deposit too', async () => {
    const loan = await tx({ direction: 'DEBIT', amountIrr: 3_000_000, balanceIrr: 5_000_000, at: T(6) });
    const gift = await tx({ direction: 'CREDIT', amountIrr: 1_000_000, balanceIrr: 6_000_000, at: T(7) });
    const a = await json('POST', `/api/v1/transactions/${loan}/decline-income`, {
      category: 'PERSONAL', reason: 'قسط وام پارسیان',
    });
    expect(a.status).toBe(200);
    const b = await json('POST', `/api/v1/transactions/${gift}/decline-income`, { category: 'MISTAKE_RETURNED' });
    expect(b.status).toBe(200);

    const rows = await baseEnv.DB.prepare(
      `SELECT transaction_candidate_id AS id, category, reason FROM income_declined_transactions
        WHERE transaction_candidate_id IN (?1, ?2) AND restored_at IS NULL ORDER BY id`,
    )
      .bind(loan, gift)
      .all<{ id: string; category: string; reason: string | null }>();
    expect(rows.results).toEqual([
      { id: loan, category: 'PERSONAL', reason: 'قسط وام پارسیان' },
      { id: gift, category: 'MISTAKE_RETURNED', reason: null },
    ]);

    const list = (await (await get(`/api/v1/admin/books/off-books?month=${MONTH_Q}&accountId=${ACCT}`)).json()) as {
      items: Array<{ transactionId: string; direction: string; categoryFa: string }>;
      totals: Record<string, { count: number; creditIrr: number; debitIrr: number }>;
    };
    expect(list.items.map((i) => [i.transactionId, i.direction])).toEqual([[gift, 'CREDIT'], [loan, 'DEBIT']]);
    expect(list.totals.PERSONAL).toEqual({ count: 1, creditIrr: 0, debitIrr: 3_000_000 });
    expect(list.totals.MISTAKE_RETURNED).toEqual({ count: 1, creditIrr: 1_000_000, debitIrr: 0 });
  });

  it('can be tagged again after being put back — the history stays', async () => {
    const w = await tx({ direction: 'DEBIT', amountIrr: 5, balanceIrr: null, at: T(6) });
    expect((await json('POST', `/api/v1/transactions/${w}/decline-income`, { category: 'PERSONAL' })).status).toBe(200);
    expect((await json('POST', `/api/v1/transactions/${w}/restore-income`, {})).status).toBe(200);
    expect((await json('POST', `/api/v1/transactions/${w}/decline-income`, { category: 'BANK_FEE' })).status).toBe(200);
    const rows = await baseEnv.DB.prepare(
      `SELECT category, restored_at IS NOT NULL AS restored FROM income_declined_transactions
        WHERE transaction_candidate_id = ?1 ORDER BY declined_at`,
    )
      .bind(w)
      .all<{ category: string; restored: boolean }>();
    expect(rows.results).toEqual([
      { category: 'PERSONAL', restored: true },
      { category: 'BANK_FEE', restored: false },
    ]);
  });

  it('refuses to take a withdrawal off the books while an expense explains it, and the reverse', async () => {
    const w = await tx({ direction: 'DEBIT', amountIrr: 500_000, balanceIrr: null, at: T(6) });
    const r = await json('POST', '/api/v1/admin/revenue-adjustments', {
      amountToman: 50_000, kind: 'EXPENSE', note: `${P}explained`, transactionCandidateId: w,
    });
    expect(r.status).toBe(200);
    expect((await json('POST', `/api/v1/transactions/${w}/decline-income`, { category: 'PERSONAL' })).status).toBe(409);

    const loan = await tx({ direction: 'DEBIT', amountIrr: 3_000_000, balanceIrr: null, at: T(6) });
    await json('POST', `/api/v1/transactions/${loan}/decline-income`, { category: 'PERSONAL' });
    const link = await json('POST', '/api/v1/admin/revenue-adjustments', {
      amountToman: 300_000, kind: 'EXPENSE', note: `${P}not-ours`, transactionCandidateId: loan,
    });
    expect(link.status).toBe(400);
    expect(((await link.json()) as { error: string }).error).toBe('withdrawal_off_books');
  });

  it('can be re-labelled in place, and the change is audited', async () => {
    const id = await tx({ direction: 'CREDIT', amountIrr: 300_000, balanceIrr: 300_000, at: T(1) });
    await json('POST', `/api/v1/transactions/${id}/decline-income`, { reason: 'x' });
    const off = (await (await get(`/api/v1/admin/books/off-books?month=${MONTH_Q}&accountId=${ACCT}`)).json()) as {
      items: Array<{ id: string; category: string }>;
    };
    const tag = off.items.find((i) => i.category === 'OTHER')!;
    const r = await json('PATCH', `/api/v1/admin/books/off-books/${tag.id}`, { category: 'TRANSFER' });
    expect(r.status).toBe(200);
    const after = (await (await get(`/api/v1/admin/books/off-books?month=${MONTH_Q}&accountId=${ACCT}`)).json()) as {
      items: Array<{ id: string; category: string }>;
    };
    expect(after.items.find((i) => i.id === tag.id)?.category).toBe('TRANSFER');
    expect((await json('PATCH', `/api/v1/admin/books/off-books/${tag.id}`, { category: 'NOPE' })).status).toBe(400);
    expect((await json('PATCH', `/api/v1/admin/books/off-books/${P}missing`, { category: 'TRANSFER' })).status).toBe(404);
    const audit = await baseEnv.DB.prepare(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'books.off_books_relabelled' AND entity_id = ?1`,
    )
      .bind(tag.id)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it('refuses a category it does not know', async () => {
    const w = await tx({ direction: 'DEBIT', amountIrr: 1, balanceIrr: null, at: T(6) });
    const r = await json('POST', `/api/v1/transactions/${w}/decline-income`, { category: 'GIFT' });
    expect(r.status).toBe(400);
  });

  it('is left out of «واریز بانکی» on the accounts table', async () => {
    const sale = await tx({ direction: 'CREDIT', amountIrr: 1_990_000, balanceIrr: null, at: T(8) });
    const transfer = await tx({ direction: 'CREDIT', amountIrr: 106_646_700, balanceIrr: null, at: T(8, 13) });
    void sale;
    await json('POST', `/api/v1/transactions/${transfer}/decline-income`, { category: 'TRANSFER' });
    const r = (await (await get(`/api/v1/accounts/analytics?range=month`)).json()) as {
      items: Array<{ accountId: string; bankInflowIrr: number; bankInflowCount: number }>;
    };
    const mine = r.items.find((i) => i.accountId === ACCT)!;
    expect(mine.bankInflowIrr).toBe(1_990_000);
    expect(mine.bankInflowCount).toBe(1);
  });

  it('shows what left the account, off-books excluded', async () => {
    const spend = await tx({ direction: 'DEBIT', amountIrr: 700_000, balanceIrr: null, at: T(9) });
    const loan = await tx({ direction: 'DEBIT', amountIrr: 3_000_000, balanceIrr: null, at: T(9, 13) });
    void spend;
    await json('POST', `/api/v1/transactions/${loan}/decline-income`, { category: 'PERSONAL' });
    const r = (await (await get(`/api/v1/accounts/analytics?range=month`)).json()) as {
      items: Array<{ accountId: string; bankOutflowIrr: number; bankOutflowCount: number }>;
    };
    const mine = r.items.find((i) => i.accountId === ACCT)!;
    expect(mine.bankOutflowIrr).toBe(700_000);
    expect(mine.bankOutflowCount).toBe(1);
  });
});

describe('the monthly statement', () => {
  it('opens and closes on the bank, and explains every movement between', async () => {
    // Before the month: the balance the month opens on.
    await tx({ direction: 'CREDIT', amountIrr: 100, balanceIrr: 10_000_000, at: month.start - 2 * DAY });
    // The month: two customer deposits, one transfer in (off books), one
    // expense the ledger explains, one loan instalment (off books), one
    // withdrawal nobody explained. Balances follow the bank's arithmetic.
    await tx({ direction: 'CREDIT', amountIrr: 1_990_000, balanceIrr: 11_990_000, at: T(1) });
    await tx({ direction: 'CREDIT', amountIrr: 2_490_000, balanceIrr: 14_480_000, at: T(2) });
    const transfer = await tx({ direction: 'CREDIT', amountIrr: 5_000_000, balanceIrr: 19_480_000, at: T(3) });
    const server = await tx({ direction: 'DEBIT', amountIrr: 2_000_000, balanceIrr: 17_480_000, at: T(4) });
    const fee = await tx({ direction: 'DEBIT', amountIrr: 7_200, balanceIrr: 17_472_800, at: T(4, 13) });
    const loan = await tx({ direction: 'DEBIT', amountIrr: 3_000_000, balanceIrr: 14_472_800, at: T(5) });
    await tx({ direction: 'DEBIT', amountIrr: 400_000, balanceIrr: 14_072_800, at: T(6) });

    await json('POST', `/api/v1/transactions/${transfer}/decline-income`, { category: 'TRANSFER' });
    await json('POST', `/api/v1/transactions/${fee}/decline-income`, { category: 'BANK_FEE' });
    await json('POST', `/api/v1/transactions/${loan}/decline-income`, { category: 'PERSONAL', reason: 'قسط' });
    // The fee came as its own text and is tagged above; the rule on the screen
    // is «never both», so the expense does not type it again.
    const day = new Date(T(4)).toISOString().slice(0, 10);
    await json('POST', '/api/v1/admin/revenue-adjustments', {
      amountToman: 200_000, kind: 'EXPENSE', note: `${P}server`, financialAccountId: ACCT,
      transactionCandidateId: server, spentOn: day,
    });

    const r = await get(`/api/v1/admin/books/statement?month=${MONTH_Q}&accountId=${ACCT}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { accounts: Array<Record<string, unknown>> };
    const s = body.accounts[0] as {
      opening: { balanceIrr: number; source: string };
      closing: { balanceIrr: number; source: string };
      customerIncome: { count: number; amountIrr: number };
      offBooksCredits: Array<{ category: string; amountIrr: number }>;
      explainedWithdrawals: { count: number; amountIrr: number };
      unexplainedWithdrawals: { count: number; amountIrr: number };
      offBooksDebits: Array<{ category: string; amountIrr: number }>;
      ledger: { expenseIrr: number; feeIrr: number; unlinkedCount: number };
      bankDeltaIrr: number;
      gapIrr: number;
    };
    expect(s.opening).toMatchObject({ balanceIrr: 10_000_000, source: 'sms' });
    expect(s.closing).toMatchObject({ balanceIrr: 14_072_800, source: 'sms' });
    expect(s.customerIncome).toEqual({ count: 2, amountIrr: 4_480_000 });
    expect(s.offBooksCredits).toEqual([{ category: 'TRANSFER', count: 1, amountIrr: 5_000_000 }]);
    expect(s.explainedWithdrawals).toEqual({ count: 1, amountIrr: 2_000_000 });
    expect(s.unexplainedWithdrawals).toEqual({ count: 1, amountIrr: 400_000 });
    expect(s.offBooksDebits).toEqual([
      { category: 'BANK_FEE', count: 1, amountIrr: 7_200 },
      { category: 'PERSONAL', count: 1, amountIrr: 3_000_000 },
    ]);
    expect(s.ledger).toMatchObject({ expenseIrr: 2_000_000, feeIrr: 0, unlinkedCount: 0 });
    // opening + credits − debits = closing, exactly: the bank and the books agree.
    expect(s.bankDeltaIrr).toBe(4_480_000 + 5_000_000 - 2_000_000 - 7_200 - 3_000_000 - 400_000);
    expect(10_000_000 + s.bankDeltaIrr).toBe(14_072_800);
    expect(s.gapIrr).toBe(0);
  });

  /**
   * Production, 2026-09-20: four accounts added after the fresh start showed
   * «؟» for opening and gap all month. Their first text says what they held
   * after one movement; that is enough to open them.
   */
  it('opens an account the books met mid-month on its first text, and the check works from there', async () => {
    // No SMS before the month, no fresh-start row: two credits and a debit.
    await tx({ direction: 'CREDIT', amountIrr: 1_500_000, balanceIrr: 4_500_000, at: T(3) });
    await tx({ direction: 'CREDIT', amountIrr: 500_000, balanceIrr: 5_000_000, at: T(4) });
    await tx({ direction: 'DEBIT', amountIrr: 200_000, balanceIrr: 4_800_000, at: T(5) });
    const s = ((await (await get(`/api/v1/admin/books/statement?month=${MONTH_Q}&accountId=${ACCT}`)).json()) as {
      accounts: Array<{
        opening: { balanceIrr: number; asOf: number; source: string };
        closing: { balanceIrr: number };
        customerIncome: { count: number; amountIrr: number };
        gapIrr: number;
      }>;
    }).accounts[0]!;
    expect(s.opening).toEqual({ balanceIrr: 3_000_000, asOf: T(3) - 1, source: 'first' });
    expect(s.closing.balanceIrr).toBe(4_800_000);
    // The first text is a movement of the month, not part of the opening.
    expect(s.customerIncome).toEqual({ count: 2, amountIrr: 2_000_000 });
    expect(s.gapIrr).toBe(0);
  });

  /**
   * Production, 2026-09-20: Melli re-sent a text and both copies became a
   * deposit. «رد» (off the books) kept the copy in the bank's arithmetic and
   * the account read 1,200,000 over; only rejecting the transaction itself —
   * «تکراری» on the row — takes it out of the statement and the queue.
   */
  it('a re-sent deposit leaves the statement only when rejected as a duplicate, not when tagged off the books', async () => {
    await tx({ direction: 'CREDIT', amountIrr: 100, balanceIrr: 1_000_000, at: month.start - DAY });
    const real = await tx({ direction: 'CREDIT', amountIrr: 1_200_000, balanceIrr: 2_200_000, at: T(2) });
    const copy = await tx({ direction: 'CREDIT', amountIrr: 1_200_000, balanceIrr: 2_200_000, at: T(2, 4) });
    const read = async () =>
      ((await (await get(`/api/v1/admin/books/statement?month=${MONTH_Q}&accountId=${ACCT}`)).json()) as {
        accounts: Array<{ gapIrr: number; customerIncome: { count: number }; offBooksCredits: unknown[] }>;
      }).accounts[0]!;
    expect((await read()).gapIrr).toBe(-1_200_000);

    // «رد»: out of customer income, still in the bank's delta — the gap stays.
    expect((await json('POST', `/api/v1/transactions/${copy}/decline-income`, { category: 'MISTAKE_RETURNED' })).status).toBe(200);
    const tagged = await read();
    expect(tagged.customerIncome.count).toBe(1);
    expect(tagged.gapIrr).toBe(-1_200_000);

    // «تکراری»: the transaction is rejected; the tag stops counting with it.
    expect((await json('POST', `/api/v1/transactions/${copy}/reject`, { reason: 'duplicate' })).status).toBe(200);
    const gone = await read();
    expect(gone.gapIrr).toBe(0);
    expect(gone.customerIncome.count).toBe(1);
    expect(gone.offBooksCredits).toEqual([]);
    expect(real).not.toBe(copy);
  });

  it('says by how much the bank disagrees when an SMS is missing', async () => {
    await tx({ direction: 'CREDIT', amountIrr: 100, balanceIrr: 1_000_000, at: month.start - DAY });
    // The bank says 1.5M after a 200k deposit — 300k moved without an SMS.
    await tx({ direction: 'CREDIT', amountIrr: 200_000, balanceIrr: 1_500_000, at: T(2) });
    const s = ((await (await get(`/api/v1/admin/books/statement?month=${MONTH_Q}&accountId=${ACCT}`)).json()) as {
      accounts: Array<{ gapIrr: number }>;
    }).accounts[0]!;
    expect(s.gapIrr).toBe(300_000);
  });

  /**
   * Production, 2026-09-18: most banks never text a withdrawal. The bank's
   * balance still drops, and the only honest thing the statement can do is
   * show the hole — and then let the operator close it, two ways.
   */
  it('a hole the bank showed closes when the operator writes the movement down', async () => {
    await tx({ direction: 'CREDIT', amountIrr: 100, balanceIrr: 1_000_000, at: month.start - DAY });
    // 1M → a 200k deposit → the bank says 700k: 500k left without an SMS.
    await tx({ direction: 'CREDIT', amountIrr: 200_000, balanceIrr: 700_000, at: T(2) });
    const before = ((await (await get(`/api/v1/admin/books/statement?month=${MONTH_Q}&accountId=${ACCT}`)).json()) as {
      accounts: Array<{ gapIrr: number }>;
    }).accounts[0]!;
    expect(before.gapIrr).toBe(-500_000);

    const r = await json('POST', '/api/v1/admin/books/manual', {
      accountId: ACCT,
      direction: 'DEBIT',
      amountToman: 50_000,
      movedAt: T(2) - 1000,
      category: 'PERSONAL',
      note: `${P}قسط`,
    });
    expect(r.status).toBe(200);
    const { id } = (await r.json()) as { id: string };

    const after = ((await (await get(`/api/v1/admin/books/statement?month=${MONTH_Q}&accountId=${ACCT}`)).json()) as {
      accounts: Array<{ gapIrr: number; offBooksDebits: Array<{ category: string; amountIrr: number }>; manual: { debitIrr: number } }>;
    }).accounts[0]!;
    expect(after.gapIrr).toBe(0);
    expect(after.offBooksDebits).toEqual([{ category: 'PERSONAL', count: 1, amountIrr: 500_000 }]);
    expect(after.manual.debitIrr).toBe(500_000);

    // It is a row in the account's list and in the off-books list, marked as the operator's word.
    const moves = (await (await get(`/api/v1/admin/books/movements?month=${MONTH_Q}&accountId=${ACCT}`)).json()) as {
      items: Array<{ id: string; kind: string; amountIrr: number; balanceIrr: number | null }>;
    };
    expect(moves.items.find((m) => m.id === id)).toMatchObject({ kind: 'manual', amountIrr: 500_000, balanceIrr: null });
    const off = (await (await get(`/api/v1/admin/books/off-books?month=${MONTH_Q}&accountId=${ACCT}`)).json()) as {
      items: Array<{ id: string; kind: string; category: string }>;
    };
    expect(off.items.find((m) => m.id === id)).toMatchObject({ kind: 'manual', category: 'PERSONAL' });

    // Voided: the hole is back, the row is gone, a second void says so.
    expect((await app.request(`/api/v1/admin/books/manual/${id}`, { method: 'DELETE' }, envAs(ADMIN))).status).toBe(200);
    expect((await app.request(`/api/v1/admin/books/manual/${id}`, { method: 'DELETE' }, envAs(ADMIN))).status).toBe(404);
    const again = ((await (await get(`/api/v1/admin/books/statement?month=${MONTH_Q}&accountId=${ACCT}`)).json()) as {
      accounts: Array<{ gapIrr: number }>;
    }).accounts[0]!;
    expect(again.gapIrr).toBe(-500_000);
  });

  it('a hole the bank showed closes when an expense on that account explains it, SMS or not', async () => {
    await tx({ direction: 'CREDIT', amountIrr: 100, balanceIrr: 1_000_000, at: month.start - DAY });
    await tx({ direction: 'CREDIT', amountIrr: 200_000, balanceIrr: 700_000, at: T(2) });
    // 50,000 Toman = 500,000 IRR, dated the day of the hole, no SMS to link.
    const r = await json('POST', '/api/v1/admin/revenue-adjustments', {
      kind: 'EXPENSE',
      amountToman: 50_000,
      note: `${P}سرور`,
      spentOn: new Date(T(2)).toISOString().slice(0, 10),
      financialAccountId: ACCT,
    });
    expect(r.status).toBe(200);
    const s = ((await (await get(`/api/v1/admin/books/statement?month=${MONTH_Q}&accountId=${ACCT}`)).json()) as {
      accounts: Array<{ gapIrr: number; ledger: { unlinkedCount: number; unlinkedIrr: number } }>;
    }).accounts[0]!;
    expect(s.ledger).toMatchObject({ unlinkedCount: 1, unlinkedIrr: 500_000 });
    expect(s.gapIrr).toBe(0);
    // …and the list carries it, so the hole finder on the page closes the same hole.
    const moves = (await (await get(`/api/v1/admin/books/movements?month=${MONTH_Q}&accountId=${ACCT}`)).json()) as {
      items: Array<{ kind: string; amountIrr: number; direction: string; expense: { id: number } | null }>;
    };
    expect(moves.items.find((m) => m.kind === 'expense')).toMatchObject({ direction: 'DEBIT', amountIrr: 500_000 });
  });

  it('a fee typed on the expense behind a withdrawal closes the gap, and rides on the SMS row so the page can too', async () => {
    // گردشگری-سارا, 2026-09-20: the text says 109,000 toman out, the bank took
    // 110,100. The 1,100 went in the expense's fee field, as the screen says
    // to; the statement still read «اختلاف با بانک −۱٬۱۰۰» and the list grew a
    // grey «پیامکش نرسیده» row for it.
    await tx({ direction: 'CREDIT', amountIrr: 100, balanceIrr: 34_861_550, at: month.start - DAY });
    await tx({ direction: 'CREDIT', amountIrr: 10_000_000, balanceIrr: 44_861_550, at: T(1) });
    const paid = await tx({ direction: 'DEBIT', amountIrr: 1_090_000, balanceIrr: 43_760_550, at: T(2) });
    const r = await json('POST', '/api/v1/admin/revenue-adjustments', {
      amountToman: 109_000, kind: 'EXPENSE', note: `${P}پیکومو`, financialAccountId: ACCT,
      feeToman: 1_100, transactionCandidateId: paid, spentOn: new Date(T(2)).toISOString().slice(0, 10),
    });
    expect(r.status).toBe(200);
    const s = ((await (await get(`/api/v1/admin/books/statement?month=${MONTH_Q}&accountId=${ACCT}`)).json()) as {
      accounts: Array<{ gapIrr: number; ledger: { feeIrr: number; unlinkedCount: number } }>;
    }).accounts[0]!;
    expect(s.ledger).toMatchObject({ feeIrr: 11_000, unlinkedCount: 0 });
    expect(s.gapIrr).toBe(0);
    const moves = (await (await get(`/api/v1/admin/books/movements?month=${MONTH_Q}&accountId=${ACCT}`)).json()) as {
      items: Array<{ id: string; kind: string; amountIrr: number; feeIrr: number; expense: { id: number } | null }>;
    };
    expect(moves.items.find((m) => m.id === paid)).toMatchObject({ amountIrr: 1_090_000, feeIrr: 11_000 });
    expect(moves.items.find((m) => m.kind === 'sms' && m.id !== paid)).toMatchObject({ feeIrr: 0 });
  });

  it('refuses a hand-written movement in the future, on no account, or from anyone but an ADMIN', async () => {
    const body = { accountId: ACCT, direction: 'DEBIT', amountToman: 1, movedAt: T(1), category: 'PERSONAL' };
    expect((await json('POST', '/api/v1/admin/books/manual', { ...body, movedAt: NOW + DAY })).status).toBe(400);
    expect((await json('POST', '/api/v1/admin/books/manual', { ...body, accountId: `${P}nope` })).status).toBe(404);
    // The owner's word, like the fresh start: under `/admin/`, ADMIN only.
    expect((await json('POST', '/api/v1/admin/books/manual', body, READER)).status).toBe(403);
    expect((await json('POST', '/api/v1/admin/books/manual', body, REVIEWER)).status).toBe(403);
    expect((await json('POST', '/api/v1/admin/books/manual', body, ADMIN)).status).toBe(200);
  });

  it('counts the month’s expenses that name no account, so the tile can say they are elsewhere', async () => {
    await json('POST', '/api/v1/admin/revenue-adjustments', {
      kind: 'EXPENSE',
      amountToman: 12_000,
      note: `${P}بی‌حساب`,
      spentOn: new Date(T(3)).toISOString().slice(0, 10),
    });
    const t = ((await (await get(`/api/v1/admin/books/statement?month=${MONTH_Q}`)).json()) as {
      totals: { expensesNoAccountCount: number; expensesNoAccountIrr: number };
    }).totals;
    expect(t.expensesNoAccountCount).toBeGreaterThanOrEqual(1);
    expect(t.expensesNoAccountIrr).toBeGreaterThanOrEqual(120_000);
  });

  it('measures the gap up to the last balance the bank gave, not past it', async () => {
    await tx({ direction: 'CREDIT', amountIrr: 100, balanceIrr: 1_000_000, at: month.start - DAY });
    await tx({ direction: 'CREDIT', amountIrr: 200_000, balanceIrr: 1_200_000, at: T(2) });
    // A later SMS the parser could not read a balance from: real money, no
    // figure to check against. Not a gap — the bank never disagreed.
    await tx({ direction: 'CREDIT', amountIrr: 50_000, balanceIrr: null, at: T(3) });
    const s = ((await (await get(`/api/v1/admin/books/statement?month=${MONTH_Q}&accountId=${ACCT}`)).json()) as {
      accounts: Array<{ gapIrr: number; customerIncome: { amountIrr: number }; closing: { balanceIrr: number } }>;
    }).accounts[0]!;
    expect(s.customerIncome.amountIrr).toBe(250_000);
    expect(s.closing.balanceIrr).toBe(1_200_000);
    expect(s.gapIrr).toBe(0);
  });

  it('exports the month as CSV with one row per account', async () => {
    await tx({ direction: 'CREDIT', amountIrr: 1_000, balanceIrr: 1_000, at: T(1) });
    const r = await get(`/api/v1/admin/books/statement.csv?month=${MONTH_Q}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    const text = await r.text();
    expect(text).toContain('حساب دفتر');
    expect(text.split('\r\n')[0]).toContain('موجودی آخر ماه');
  });

  it('is closed to a READ_ONLY operator and open to a REVIEWER', async () => {
    expect((await get(`/api/v1/admin/books/statement?month=${MONTH_Q}`, READER)).status).toBe(403);
    expect((await get(`/api/v1/admin/books/statement?month=${MONTH_Q}`, REVIEWER)).status).toBe(200);
    expect((await json('POST', '/api/v1/admin/books/open', {}, REVIEWER)).status).toBe(403);
  });
});

describe('the fresh start', () => {
  it('writes tonight’s balances as the opening, and the month starts there', async () => {
    // History the fresh start must ignore.
    await tx({ direction: 'CREDIT', amountIrr: 9_000_000, balanceIrr: 9_000_000, at: T(1) });
    await tx({ direction: 'DEBIT', amountIrr: 1_000_000, balanceIrr: 8_000_000, at: T(2) });
    await tx({ account: ACCT2, direction: 'CREDIT', amountIrr: 500_000, balanceIrr: 2_500_000, at: T(2) });

    const opened = await json('POST', '/api/v1/admin/books/open', {});
    expect(opened.status).toBe(200);
    const o = (await opened.json()) as { walletIrr: number; accounts: Array<{ accountId: string; balanceIrr: number | null }> };
    const mine = o.accounts.filter((a) => a.accountId.startsWith(P));
    expect(mine).toEqual([
      { accountId: ACCT, displayName: 'حساب دفتر', balanceIrr: 8_000_000, asOf: T(2) },
      { accountId: ACCT2, displayName: 'حساب دوم', balanceIrr: 2_500_000, asOf: T(2) },
    ]);
    expect(o.walletIrr).toBeGreaterThanOrEqual(10_500_000);

    // A second press is refused; the owner has to say «overwrite».
    expect((await json('POST', '/api/v1/admin/books/open', {})).status).toBe(409);

    // After the start: one sale. The statement opens from the fresh start,
    // not from the 9M that came before it.
    await tx({ direction: 'CREDIT', amountIrr: 1_990_000, balanceIrr: 9_990_000, at: T(3) });
    const s = ((await (await get(`/api/v1/admin/books/statement?month=${MONTH_Q}&accountId=${ACCT}`)).json()) as {
      accounts: Array<{
        opening: { balanceIrr: number; source: string };
        closing: { balanceIrr: number };
        customerIncome: { count: number; amountIrr: number };
        gapIrr: number;
      }>;
    }).accounts[0]!;
    expect(s.opening).toMatchObject({ balanceIrr: 8_000_000, source: 'opening' });
    expect(s.customerIncome).toEqual({ count: 1, amountIrr: 1_990_000 });
    expect(s.closing.balanceIrr).toBe(9_990_000);
    expect(s.gapIrr).toBe(0);

    // The month before the start is not a statement: nothing in it counts.
    const prevKey = month.month === 1 ? `${month.year - 1}-12` : `${month.year}-${String(month.month - 1).padStart(2, '0')}`;
    const before = ((await (await get(`/api/v1/admin/books/statement?month=${prevKey}&accountId=${ACCT}`)).json()) as {
      accounts: Array<{ beforeStart: boolean; opening: unknown; customerIncome: { count: number } }>;
    }).accounts[0]!;
    expect(before.beforeStart).toBe(true);
    expect(before.opening).toBeNull();
    expect(before.customerIncome.count).toBe(0);

    // The month after: no SMS since the start — it opens on the start and moves nothing.
    const nextKey = month.month === 12 ? `${month.year + 1}-01` : `${month.year}-${String(month.month + 1).padStart(2, '0')}`;
    const after = ((await (await get(`/api/v1/admin/books/statement?month=${nextKey}&accountId=${ACCT}`)).json()) as {
      accounts: Array<{ opening: { balanceIrr: number; source: string }; closing: { balanceIrr: number }; gapIrr: number }>;
    }).accounts[0]!;
    expect(after.opening).toMatchObject({ balanceIrr: 9_990_000, source: 'sms' });
    expect(after.closing.balanceIrr).toBe(9_990_000);
    expect(after.gapIrr).toBe(0);

    const status = (await (await get('/api/v1/admin/books/opening')).json()) as { opening: { accounts: number } | null };
    expect(status.opening?.accounts).toBeGreaterThanOrEqual(2);

    // The movements list makes the same cut: the 9M and the 1M before the
    // start are not shown beside a statement that does not count them.
    const moves = (await (await get(`/api/v1/admin/books/movements?month=${MONTH_Q}&accountId=${ACCT}`)).json()) as {
      items: Array<{ amountIrr: number }>;
    };
    expect(moves.items.map((m) => m.amountIrr)).toEqual([1_990_000]);
  });

  it('opens at the start of a chosen day: the balance before that midnight, and nothing after it is lost', async () => {
    // Sam, 1 Mehr 1405: «از اول مهر». Pressed at noon, the books still open
    // at midnight, so the morning's sale is in the new books.
    await tx({ direction: 'CREDIT', amountIrr: 9_000_000, balanceIrr: 9_000_000, at: T(1) });
    await tx({ direction: 'CREDIT', amountIrr: 2_000_000, balanceIrr: 11_000_000, at: T(3, 9) });
    // The Tehran calendar day of T(3), from Intl rather than from our helpers.
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(T(3, 9));
    const midnight = Date.parse(`${day}T00:00:00+03:30`);
    expect(midnight).toBeLessThan(T(3, 9));

    const opened = await json('POST', '/api/v1/admin/books/open', { force: true, asOf: day });
    expect(opened.status).toBe(200);
    const o = (await opened.json()) as { openedAt: number; accounts: Array<{ accountId: string; balanceIrr: number | null; asOf: number | null }> };
    expect(o.openedAt).toBe(midnight);
    expect(o.accounts.find((a) => a.accountId === ACCT)).toMatchObject({ balanceIrr: 9_000_000, asOf: T(1) });
    const status = (await (await get('/api/v1/admin/books/opening')).json()) as { opening: { openedAt: number } };
    expect(status.opening.openedAt).toBe(midnight);

    const s = ((await (await get(`/api/v1/admin/books/statement?month=${MONTH_Q}&accountId=${ACCT}`)).json()) as {
      accounts: Array<{ customerIncome: { amountIrr: number }; closing: { balanceIrr: number }; gapIrr: number }>;
    }).accounts[0]!;
    expect([s.customerIncome.amountIrr, s.closing.balanceIrr, s.gapIrr]).toEqual([2_000_000, 11_000_000, 0]);

    // A day that has not begun cannot be the start.
    const future = await json('POST', '/api/v1/admin/books/open', { force: true, asOf: '2099-01-01' });
    expect(future.status).toBe(400);
    expect(((await future.json()) as { error: string }).error).toBe('as_of_in_future');
  });
});
