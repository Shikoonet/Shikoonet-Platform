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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

const month = parseJalaliMonth(undefined)!;
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
afterAll(purge);

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
    const day = new Date(T(4)).toISOString().slice(0, 10);
    await json('POST', '/api/v1/admin/revenue-adjustments', {
      amountToman: 200_000, kind: 'EXPENSE', note: `${P}server`, financialAccountId: ACCT,
      feeToman: 720, transactionCandidateId: server, spentOn: day,
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
    expect(s.ledger).toMatchObject({ expenseIrr: 2_000_000, feeIrr: 7_200, unlinkedCount: 0 });
    // opening + credits − debits = closing, exactly: the bank and the books agree.
    expect(s.bankDeltaIrr).toBe(4_480_000 + 5_000_000 - 2_000_000 - 7_200 - 3_000_000 - 400_000);
    expect(10_000_000 + s.bankDeltaIrr).toBe(14_072_800);
    expect(s.gapIrr).toBe(0);
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
});
