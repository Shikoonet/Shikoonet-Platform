/**
 * The books, per account and per Jalali month — Sam, 2026-09-17: «باید سر ماه
 * به ادمین کل حساب پس بدهم».
 *
 * A statement explains the bank's movements; it never replaces them. The
 * opening and closing balances are the bank's own (the balance on the last
 * SMS before the month and the last one inside it), and every line between
 * them is a bank movement sorted into one of five boxes:
 *
 *   - customer income        credits on the books (BANK_INCOME_TX_WHERE)
 *   - off-books credits      a transfer from our own account, a relative's
 *                            deposit, interest … by category
 *   - explained withdrawals  debits an expense row points at
 *   - unexplained withdrawals debits nothing points at — the number that
 *                            tells the operator what still needs a tag
 *   - off-books debits       the loan instalment, the returned deposit …
 *
 * and one check: opening + every credit − every debit should be the closing
 * balance. When it is not, an SMS is missing, and the statement says by how
 * much rather than pretending.
 *
 * The first month opens from `account_opening_balances` — the fresh start
 * written once by `openBooks` — because before that night the books did not
 * exist, whatever the SMS history says.
 */

import type { D1Database } from '@shikoo/database';
import { jalaliToEpochMs, toJalali, JALALI_MONTHS } from '@shikoo/contracts';
import { jalaliMonthBounds, tehranDateStringFromMs } from './historyRange.js';
import { BANK_INCOME_TX_WHERE, BANK_OUTFLOW_TX_WHERE, TX_OFF_BOOKS } from './incomeEligibility.js';
import type { OffBooksCategory } from './declineIncomeTransaction.js';

export interface JalaliMonth {
  year: number;
  month: number;
  /** UTC epoch-ms, half-open. */
  start: number;
  end: number;
  /** «شهریور ۱۴۰۵» */
  label: string;
}

/** `1405-06` → the month; anything else → null. Today's month when absent. */
export function parseJalaliMonth(raw: string | null | undefined, nowMs = Date.now()): JalaliMonth | null {
  let year: number;
  let month: number;
  if (raw == null || raw === '') {
    const j = toJalali(nowMs);
    year = j.year;
    month = j.month;
  } else {
    const m = /^(\d{4})-(\d{1,2})$/.exec(raw);
    if (!m) return null;
    year = Number(m[1]);
    month = Number(m[2]);
    if (month < 1 || month > 12 || year < 1390 || year > 1500) return null;
  }
  const { start, end } = jalaliMonthBounds(jalaliToEpochMs({ year, month, day: 1 }));
  return { year, month, start, end, label: `${JALALI_MONTHS[month - 1]} ${year}` };
}

export interface BalancePoint {
  balanceIrr: number;
  asOf: number;
  source: 'sms' | 'opening';
}

export interface OffBooksLine {
  category: OffBooksCategory;
  count: number;
  amountIrr: number;
}

export interface AccountStatement {
  accountId: string;
  displayName: string;
  bankName: string;
  accountHint: string | null;
  active: boolean;
  opening: BalancePoint | null;
  closing: BalancePoint | null;
  customerIncome: { count: number; amountIrr: number };
  offBooksCredits: OffBooksLine[];
  explainedWithdrawals: { count: number; amountIrr: number };
  unexplainedWithdrawals: { count: number; amountIrr: number };
  offBooksDebits: OffBooksLine[];
  /** The ledger's side of the same month, for comparison with the bank's. */
  ledger: { expenseCount: number; expenseIrr: number; feeIrr: number; unlinkedCount: number; unlinkedIrr: number };
  /** Every valid credit minus every valid debit, off-books included. */
  bankDeltaIrr: number;
  /**
   * closing − (opening + every movement up to the closing SMS); null when
   * either balance is unknown. Movements after the last balance-bearing SMS
   * are in the boxes above but not in this check — the bank gave no figure
   * to hold them against.
   */
  gapIrr: number | null;
  /** The whole month lies before the fresh start: nothing in it counts. */
  beforeStart: boolean;
}

const num = (v: unknown): number => Number(v ?? 0);

async function lastBalanceBefore(db: D1Database, accountId: string, beforeMs: number) {
  return db
    .prepare(
      `SELECT t.balance_irr, t.bank_timestamp
         FROM transaction_candidates t
        WHERE t.financial_account_id = ?1 AND t.balance_irr IS NOT NULL
          AND t.status NOT IN ('REJECTED','IGNORED')
          AND t.bank_timestamp < ?2
        ORDER BY t.bank_timestamp DESC, t.created_at DESC
        LIMIT 1`,
    )
    .bind(accountId, beforeMs)
    .first<{ balance_irr: string | number; bank_timestamp: string | number }>();
}

export async function accountStatement(
  db: D1Database,
  accountId: string,
  month: Pick<JalaliMonth, 'start' | 'end'>,
): Promise<AccountStatement | null> {
  const acc = await db
    .prepare(
      `SELECT id, display_name, bank_name, account_hint, active, status FROM financial_accounts WHERE id = ?1`,
    )
    .bind(accountId)
    .first<{ id: string; display_name: string; bank_name: string; account_hint: string | null; active: number | boolean; status: string }>();
  if (!acc) return null;

  // Opening: the fresh start wins when it falls inside or after the month's
  // start-of-history; otherwise the last SMS before the month.
  const openingRow = await db
    .prepare(`SELECT balance_irr, as_of FROM account_opening_balances WHERE financial_account_id = ?1`)
    .bind(accountId)
    .first<{ balance_irr: string | number; as_of: string | number }>();
  let opening: BalancePoint | null = null;
  const openingAsOf = openingRow ? num(openingRow.as_of) : null;
  const base = {
    accountId: acc.id,
    displayName: acc.display_name,
    bankName: acc.bank_name,
    accountHint: acc.account_hint,
    active: (acc.active === true || acc.active === 1) && acc.status === 'ACTIVE',
  };
  if (openingAsOf !== null && openingAsOf >= month.end) {
    // Before the books existed. Shown empty rather than as history, so the
    // fresh start means what it says.
    const none = { count: 0, amountIrr: 0 };
    return {
      ...base,
      opening: null,
      closing: null,
      customerIncome: none,
      offBooksCredits: [],
      explainedWithdrawals: none,
      unexplainedWithdrawals: none,
      offBooksDebits: [],
      ledger: { expenseCount: 0, expenseIrr: 0, feeIrr: 0, unlinkedCount: 0, unlinkedIrr: 0 },
      bankDeltaIrr: 0,
      gapIrr: null,
      beforeStart: true,
    };
  }
  if (openingRow && openingAsOf !== null && openingAsOf >= month.start && openingAsOf < month.end) {
    // The books opened inside this month: nothing before that instant counts.
    opening = { balanceIrr: num(openingRow.balance_irr), asOf: openingAsOf, source: 'opening' };
  } else {
    const sms = await lastBalanceBefore(db, accountId, month.start);
    if (sms && (openingAsOf === null || num(sms.bank_timestamp) >= openingAsOf)) {
      opening = { balanceIrr: num(sms.balance_irr), asOf: num(sms.bank_timestamp), source: 'sms' };
    } else if (openingRow && openingAsOf !== null && openingAsOf < month.start) {
      opening = { balanceIrr: num(openingRow.balance_irr), asOf: openingAsOf, source: 'opening' };
    }
  }
  // Movements strictly after the opening point, never before the fresh start.
  const from = Math.max(month.start, opening?.source === 'opening' ? opening.asOf + 1 : month.start);

  const closingSms = await lastBalanceBefore(db, accountId, month.end);
  const closing: BalancePoint | null =
    closingSms && num(closingSms.bank_timestamp) >= from
      ? { balanceIrr: num(closingSms.balance_irr), asOf: num(closingSms.bank_timestamp), source: 'sms' }
      : opening;

  const range = `AND t.bank_timestamp >= ?2 AND t.bank_timestamp < ?3`;
  const bind = [accountId, from, month.end];

  const income = await db
    .prepare(
      `SELECT count(*)::int AS n, COALESCE(SUM(t.amount_irr),0) AS irr FROM transaction_candidates t
        WHERE t.financial_account_id = ?1 AND ${BANK_INCOME_TX_WHERE} ${range}`,
    )
    .bind(...bind)
    .first<{ n: number; irr: string | number }>();

  const offBooks = await db
    .prepare(
      `SELECT t.direction, idt.category, count(*)::int AS n, COALESCE(SUM(t.amount_irr),0) AS irr
         FROM transaction_candidates t
         JOIN income_declined_transactions idt ON idt.transaction_candidate_id = t.id AND idt.restored_at IS NULL
        WHERE t.financial_account_id = ?1 AND t.status NOT IN ('REJECTED','IGNORED') ${range}
        GROUP BY t.direction, idt.category ORDER BY idt.category`,
    )
    .bind(...bind)
    .all<{ direction: string; category: OffBooksCategory; n: number; irr: string | number }>();

  const withdrawals = await db
    .prepare(
      `SELECT
         count(*) FILTER (WHERE ra.id IS NOT NULL)::int AS explained_n,
         COALESCE(SUM(t.amount_irr) FILTER (WHERE ra.id IS NOT NULL),0) AS explained_irr,
         count(*) FILTER (WHERE ra.id IS NULL)::int AS unexplained_n,
         COALESCE(SUM(t.amount_irr) FILTER (WHERE ra.id IS NULL),0) AS unexplained_irr
         FROM transaction_candidates t
         LEFT JOIN revenue_adjustments ra ON ra.transaction_candidate_id = t.id AND ra.voided_at IS NULL
        WHERE t.financial_account_id = ?1 AND ${BANK_OUTFLOW_TX_WHERE} ${range}`,
    )
    .bind(...bind)
    .first<{ explained_n: number; explained_irr: string | number; unexplained_n: number; unexplained_irr: string | number }>();

  // The whole bank month, off-books included — what the balances must agree
  // with. Bounded by the closing SMS: a movement after the last balance the
  // bank stated has nothing to be checked against.
  const delta = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN t.direction = 'CREDIT' THEN t.amount_irr ELSE -t.amount_irr END),0) AS irr
         FROM transaction_candidates t
        WHERE t.financial_account_id = ?1 AND t.direction IN ('CREDIT','DEBIT')
          AND t.status NOT IN ('REJECTED','IGNORED') ${range}
          AND t.bank_timestamp <= ?4`,
    )
    .bind(...bind, closing ? closing.asOf : month.end)
    .first<{ irr: string | number }>();

  const ledger = await db
    .prepare(
      `SELECT count(*)::int AS n, COALESCE(SUM(-ra.amount_irr),0) AS expense_irr, COALESCE(SUM(ra.fee_irr),0) AS fee_irr,
              count(*) FILTER (WHERE ra.transaction_candidate_id IS NULL)::int AS unlinked_n,
              COALESCE(SUM(-ra.amount_irr + ra.fee_irr) FILTER (WHERE ra.transaction_candidate_id IS NULL),0) AS unlinked_irr
         FROM revenue_adjustments ra
        WHERE ra.financial_account_id = ?1 AND ra.kind = 'EXPENSE' AND ra.voided_at IS NULL
          AND ra.spent_on >= ?2::date AND ra.spent_on < ?3::date`,
    )
    .bind(accountId, tehranDateStringFromMs(from), tehranDateStringFromMs(month.end))
    .first<{ n: number; expense_irr: string | number; fee_irr: string | number; unlinked_n: number; unlinked_irr: string | number }>();

  const lines = (direction: string): OffBooksLine[] =>
    (offBooks.results ?? [])
      .filter((r) => r.direction === direction)
      .map((r) => ({ category: r.category, count: r.n, amountIrr: num(r.irr) }));

  const bankDeltaIrr = num(delta?.irr);
  const gapIrr =
    opening && closing && closing.asOf > opening.asOf
      ? closing.balanceIrr - (opening.balanceIrr + bankDeltaIrr)
      : opening && closing
        ? 0 - bankDeltaIrr || 0 // `|| 0` turns the -0 of an unmoved month into 0
        : null;

  return {
    ...base,
    opening,
    closing,
    customerIncome: { count: income?.n ?? 0, amountIrr: num(income?.irr) },
    offBooksCredits: lines('CREDIT'),
    explainedWithdrawals: { count: withdrawals?.explained_n ?? 0, amountIrr: num(withdrawals?.explained_irr) },
    unexplainedWithdrawals: { count: withdrawals?.unexplained_n ?? 0, amountIrr: num(withdrawals?.unexplained_irr) },
    offBooksDebits: lines('DEBIT'),
    ledger: {
      expenseCount: ledger?.n ?? 0,
      expenseIrr: num(ledger?.expense_irr),
      feeIrr: num(ledger?.fee_irr),
      unlinkedCount: ledger?.unlinked_n ?? 0,
      unlinkedIrr: num(ledger?.unlinked_irr),
    },
    bankDeltaIrr,
    gapIrr,
    beforeStart: false,
  };
}

/** Every account that has a row anywhere in the month, live ones first. */
export async function monthStatements(
  db: D1Database,
  month: Pick<JalaliMonth, 'start' | 'end'>,
): Promise<AccountStatement[]> {
  const ids = await db
    .prepare(
      `SELECT fa.id FROM financial_accounts fa
        WHERE (fa.active = 1 AND fa.status = 'ACTIVE')
           OR EXISTS (SELECT 1 FROM transaction_candidates t WHERE t.financial_account_id = fa.id
                        AND t.bank_timestamp >= ?1 AND t.bank_timestamp < ?2)
           OR EXISTS (SELECT 1 FROM revenue_adjustments ra WHERE ra.financial_account_id = fa.id AND ra.voided_at IS NULL
                        AND ra.spent_on >= ?3::date AND ra.spent_on < ?4::date)
        ORDER BY fa.active DESC, fa.display_name`,
    )
    .bind(month.start, month.end, tehranDateStringFromMs(month.start), tehranDateStringFromMs(month.end))
    .all<{ id: string }>();
  const out: AccountStatement[] = [];
  for (const r of ids.results ?? []) {
    const s = await accountStatement(db, r.id, month);
    if (s) out.push(s);
  }
  return out;
}

export interface OpenBooksResult {
  openedAt: number;
  accounts: Array<{ accountId: string; displayName: string; balanceIrr: number | null; asOf: number | null }>;
  walletIrr: number;
}

/** Has the fresh start been written, and when. */
export async function booksOpening(db: D1Database): Promise<{ openedAt: number; walletIrr: number; accounts: number } | null> {
  const row = await db
    .prepare(
      `SELECT MIN(created_at) AS opened_at, COALESCE(SUM(balance_irr),0) AS wallet, count(*)::int AS n
         FROM account_opening_balances`,
    )
    .first<{ opened_at: string | number | null; wallet: string | number; n: number }>();
  if (!row || row.n === 0 || row.opened_at == null) return null;
  return { openedAt: num(row.opened_at), walletIrr: num(row.wallet), accounts: row.n };
}

/**
 * The fresh start. Every account in service gets its last bank balance
 * written as the opening; their sum is the wallet on day one. An account
 * that never sent a balance opens at nothing — listed, so the operator sees
 * it rather than a total that quietly omits it. Refuses when already opened
 * unless told to overwrite; the previous rows are replaced, not kept, and
 * the caller audits the call.
 */
export async function openBooks(
  db: D1Database,
  args: { actorEmail: string; now: number; force?: boolean },
): Promise<{ ok: true; result: OpenBooksResult } | { ok: false; error: 'ALREADY_OPENED' }> {
  const existing = await booksOpening(db);
  if (existing && !args.force) return { ok: false, error: 'ALREADY_OPENED' };

  const rows = await db
    .prepare(
      `SELECT fa.id, fa.display_name, bal.balance_irr, bal.bank_timestamp, bal.id AS tx_id
         FROM financial_accounts fa
         LEFT JOIN LATERAL (
           SELECT t.id, t.balance_irr, t.bank_timestamp FROM transaction_candidates t
            WHERE t.financial_account_id = fa.id AND t.balance_irr IS NOT NULL
              AND t.status NOT IN ('REJECTED','IGNORED') AND t.bank_timestamp <= ?1
            ORDER BY t.bank_timestamp DESC, t.created_at DESC LIMIT 1) bal ON TRUE
        WHERE fa.active = 1 AND fa.status = 'ACTIVE'
        ORDER BY fa.display_name`,
    )
    .bind(args.now)
    .all<{ id: string; display_name: string; balance_irr: string | number | null; bank_timestamp: string | number | null; tx_id: string | null }>();

  const statements = [db.prepare(`DELETE FROM account_opening_balances`)];
  const accounts: OpenBooksResult['accounts'] = [];
  let walletIrr = 0;
  for (const r of rows.results ?? []) {
    const balance = r.balance_irr == null ? null : num(r.balance_irr);
    const asOf = r.bank_timestamp == null ? null : num(r.bank_timestamp);
    accounts.push({ accountId: r.id, displayName: r.display_name, balanceIrr: balance, asOf });
    if (balance === null || asOf === null) continue;
    walletIrr += balance;
    statements.push(
      db
        .prepare(
          `INSERT INTO account_opening_balances
             (financial_account_id, balance_irr, as_of, transaction_candidate_id, created_by, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(r.id, balance, asOf, r.tx_id, args.actorEmail, args.now),
    );
  }
  await db.batch(statements);
  return { ok: true, result: { openedAt: args.now, accounts, walletIrr } };
}

/** Withdrawals an expense on `accountId` around `day` could be — for the picker. */
export async function withdrawalsNear(
  db: D1Database,
  args: { accountId: string; dayStartMs: number; dayEndMs: number; days?: number },
) {
  const pad = (args.days ?? 1) * 86_400_000;
  const rows = await db
    .prepare(
      `SELECT t.id, t.amount_irr, t.bank_timestamp, t.balance_irr,
              ra.id AS expense_id
         FROM transaction_candidates t
         LEFT JOIN revenue_adjustments ra ON ra.transaction_candidate_id = t.id AND ra.voided_at IS NULL
        WHERE t.financial_account_id = ?1 AND t.direction = 'DEBIT'
          AND t.status NOT IN ('REJECTED','IGNORED') AND NOT ${TX_OFF_BOOKS}
          AND t.bank_timestamp >= ?2 AND t.bank_timestamp < ?3
        ORDER BY t.bank_timestamp DESC LIMIT 50`,
    )
    .bind(args.accountId, args.dayStartMs - pad, args.dayEndMs + pad)
    .all<{ id: string; amount_irr: string | number; bank_timestamp: string | number; balance_irr: string | number | null; expense_id: number | null }>();
  return (rows.results ?? []).map((r) => ({
    id: r.id,
    amountIrr: num(r.amount_irr),
    bankTimestamp: num(r.bank_timestamp),
    balanceIrr: r.balance_irr == null ? null : num(r.balance_irr),
    linkedExpenseId: r.expense_id == null ? null : Number(r.expense_id),
  }));
}
