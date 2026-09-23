/**
 * «دفتر بانک» — the books per account, per Jalali month, and the fresh start.
 *
 * Sam, 2026-09-17: «باید سر ماه به ادمین کل حساب پس بدهم». Four routes and
 * one button:
 *
 *   GET  /admin/books/statement?month=1405-06[&accountId=]   the reconciliation
 *   GET  /admin/books/statement.csv?month=                     the same, for the admin
 *   GET  /admin/books/off-books?month=[&accountId=&category=]  every movement tagged «not ours»
 *   GET  /admin/books/off-books.csv?month=
 *   GET  /admin/books/withdrawals?accountId=&day=YYYY-MM-DD    debits the expense form may link
 *   GET  /admin/books/opening                                 has the fresh start been written, and the wallet now
 *   POST /admin/books/open {force?}                            write it
 *   POST /admin/books/manual {accountId,direction,amountToman,movedAt,category,note?}
 *                                                              a movement the bank did not text (0079)
 *   DELETE /admin/books/manual/:id                             void it
 *   PATCH /admin/books/off-books/:id {category,note?}          re-label a tag without restoring and re-tagging
 *
 * The arithmetic lives in `@shikoo/domain` (`books.ts`); this file only
 * parses, checks the role, and shapes. Reads are open to ADMIN and REVIEWER
 * — a reviewer reconciles against these figures — and `access.ts` keeps the
 * whole prefix away from READ_ONLY. The fresh start is ADMIN only: it is the
 * one write here, and it is the owner's.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import type { EnvName } from '@shikoo/contracts';
import { formatJalali } from '@shikoo/contracts';
import {
  LEDGER_OUTFLOW_KINDS_SQL,
  OFF_BOOKS_CATEGORIES,
  accountStatement,
  addManualMovement,
  booksOpening,
  monthStatements,
  openBooks,
  parseJalaliMonth,
  tehranDateStringFromMs,
  tehranDayBoundsFromDate,
  voidManualMovement,
  walletNow,
  withdrawalsNear,
  type AccountStatement,
  type OffBooksCategory,
  INCOME_QUEUE_TX_WHERE,
  OFF_BOOKS_ELIGIBLE_TX_WHERE,
  TX_WALLET_CREDITED,
} from '@shikoo/domain';
import { audit, type Ident } from './adminAudit.js';
import { csvCell } from './revenueRoutes.js';

const IRR_PER_TOMAN = 10;

export const OFF_BOOKS_CATEGORY_FA: Record<OffBooksCategory, string> = {
  TRANSFER: 'جابه‌جایی بین حساب‌های خودمان',
  PERSONAL: 'شخصی',
  MISTAKE_RETURNED: 'اشتباهی و برگشت‌داده‌شده',
  BANK_FEE: 'کارمزد بانک',
  BANK_INTEREST: 'سود بانکی',
  OTHER: 'سایر',
};

const toman = (irr: number) => irr / IRR_PER_TOMAN;

/** Expenses of the month that name no account — real money the bank pages cannot see. */
async function expensesWithoutAccount(db: D1Database, month: { start: number; end: number }) {
  const row = await db
    .prepare(
      `SELECT count(*)::int AS n, COALESCE(SUM(-amount_irr + fee_irr),0) AS irr
         FROM revenue_adjustments
        WHERE kind IN ${LEDGER_OUTFLOW_KINDS_SQL} AND voided_at IS NULL AND financial_account_id IS NULL
          AND spent_on >= ?1::date AND spent_on < ?2::date`,
    )
    .bind(tehranDateStringFromMs(month.start), tehranDateStringFromMs(month.end))
    .first<{ n: number; irr: string | number }>();
  return { count: row?.n ?? 0, amountIrr: Number(row?.irr ?? 0) };
}

function statementTotals(accounts: AccountStatement[]) {
  const sum = (pick: (s: AccountStatement) => number) => accounts.reduce((acc, s) => acc + pick(s), 0);
  const live = accounts.filter((s) => s.active);
  const offBooks = (dir: 'offBooksCredits' | 'offBooksDebits') =>
    accounts.reduce((acc, s) => acc + s[dir].reduce((a, l) => a + l.amountIrr, 0), 0);
  return {
    accounts: accounts.length,
    /** The wallet: what the live accounts hold, per the bank, at month end. */
    openingIrr: live.reduce((a, s) => a + (s.opening?.balanceIrr ?? 0), 0),
    closingIrr: live.reduce((a, s) => a + (s.closing?.balanceIrr ?? 0), 0),
    customerIncomeIrr: sum((s) => s.customerIncome.amountIrr),
    customerIncomeCount: sum((s) => s.customerIncome.count),
    offBooksCreditsIrr: offBooks('offBooksCredits'),
    explainedWithdrawalsIrr: sum((s) => s.explainedWithdrawals.amountIrr),
    unexplainedWithdrawalsIrr: sum((s) => s.unexplainedWithdrawals.amountIrr),
    unexplainedWithdrawalsCount: sum((s) => s.unexplainedWithdrawals.count),
    offBooksDebitsIrr: offBooks('offBooksDebits'),
    ledgerExpenseIrr: sum((s) => s.ledger.expenseIrr),
    ledgerFeeIrr: sum((s) => s.ledger.feeIrr),
    gapIrr: sum((s) => s.gapIrr ?? 0),
    accountsWithGap: accounts.filter((s) => s.gapIrr !== null && s.gapIrr !== 0).length,
    /** Rows whose opening or closing the bank never said — «می‌خواند» cannot be claimed over them. */
    accountsUnknown: accounts.filter((s) => s.gapIrr === null).length,
  };
}

export function registerBooksRoutes(
  app: Hono<{ Bindings: { DB: D1Database; ENV_NAME: EnvName }; Variables: { identity: Ident } }>,
): void {
  const mayRead = (role: string) => role === 'ADMIN' || role === 'REVIEWER';

  async function loadStatements(c: { req: { query(k: string): string | undefined }; env: { DB: D1Database } }) {
    const month = parseJalaliMonth(c.req.query('month'));
    if (!month) return { error: 'invalid_month' as const };
    const accountId = c.req.query('accountId');
    if (accountId) {
      const one = await accountStatement(c.env.DB, accountId, month);
      return { month, accounts: one ? [one] : [] };
    }
    return { month, accounts: await monthStatements(c.env.DB, month) };
  }

  app.get('/api/v1/admin/books/statement', async (c) => {
    const ident = c.get('identity');
    if (!mayRead(ident.role)) return c.json({ ok: false, error: 'forbidden' }, 403);
    const loaded = await loadStatements(c);
    if ('error' in loaded) return c.json({ ok: false, error: loaded.error }, 400);
    const { start: _s, end: _e, ...monthOut } = loaded.month;
    const noAccount = c.req.query('accountId') ? { count: 0, amountIrr: 0 } : await expensesWithoutAccount(c.env.DB, loaded.month);
    return c.json({
      ok: true,
      month: { ...monthOut, start: loaded.month.start, end: loaded.month.end },
      accounts: loaded.accounts,
      totals: { ...statementTotals(loaded.accounts), expensesNoAccountCount: noAccount.count, expensesNoAccountIrr: noAccount.amountIrr },
      opening: await booksOpening(c.env.DB),
    });
  });

  app.get('/api/v1/admin/books/statement.csv', async (c) => {
    const ident = c.get('identity');
    if (!mayRead(ident.role)) return c.json({ ok: false, error: 'forbidden' }, 403);
    const loaded = await loadStatements(c);
    if ('error' in loaded) return c.json({ ok: false, error: loaded.error }, 400);
    const header = [
      'حساب', 'بانک', 'شماره', 'وضعیت',
      'موجودی اول ماه', 'واریز مشتری‌ها', 'تعداد واریز',
      'جابه‌جایی (واریز)', 'شخصی (واریز)', 'اشتباهی (واریز)', 'سود بانکی (واریز)', 'سایر (واریز)',
      'برداشت با هزینهٔ ثبت‌شده', 'برداشت بی‌توضیح', 'تعداد بی‌توضیح',
      'جابه‌جایی (برداشت)', 'شخصی (برداشت)', 'اشتباهی (برداشت)', 'کارمزد بانک', 'سود بانکی (برداشت)', 'سایر (برداشت)',
      'هزینه‌های دفتر', 'کارمزد دفتر', 'موجودی آخر ماه', 'اختلاف با بانک',
    ];
    const line = (lines: AccountStatement['offBooksCredits'], cat: OffBooksCategory) =>
      toman(lines.find((l) => l.category === cat)?.amountIrr ?? 0);
    const rows = loaded.accounts.map((s) =>
      [
        s.displayName, s.bankName, s.accountHint ?? '', s.active ? 'فعال' : 'خاموش',
        s.opening ? toman(s.opening.balanceIrr) : '',
        toman(s.customerIncome.amountIrr), s.customerIncome.count,
        line(s.offBooksCredits, 'TRANSFER'), line(s.offBooksCredits, 'PERSONAL'),
        line(s.offBooksCredits, 'MISTAKE_RETURNED'), line(s.offBooksCredits, 'BANK_INTEREST'), line(s.offBooksCredits, 'OTHER'),
        toman(s.explainedWithdrawals.amountIrr), toman(s.unexplainedWithdrawals.amountIrr), s.unexplainedWithdrawals.count,
        line(s.offBooksDebits, 'TRANSFER'), line(s.offBooksDebits, 'PERSONAL'),
        line(s.offBooksDebits, 'MISTAKE_RETURNED'), line(s.offBooksDebits, 'BANK_FEE'), line(s.offBooksDebits, 'BANK_INTEREST'), line(s.offBooksDebits, 'OTHER'),
        toman(s.ledger.expenseIrr), toman(s.ledger.feeIrr),
        s.closing ? toman(s.closing.balanceIrr) : '',
        s.gapIrr === null ? '' : toman(s.gapIrr),
      ]
        .map(csvCell)
        .join(','),
    );
    const name = `statement-${loaded.month.year}-${String(loaded.month.month).padStart(2, '0')}.csv`;
    return c.body(`﻿${[header.map(csvCell).join(','), ...rows].join('\r\n')}\r\n`, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${name}"`,
    });
  });

  const OffBooksQuery = z.object({
    month: z.string().optional(),
    accountId: z.string().optional(),
    category: z.enum(OFF_BOOKS_CATEGORIES).optional(),
  });

  interface OffBooksRow {
    id: string;
    transaction_id: string;
    direction: 'CREDIT' | 'DEBIT';
    amount_irr: string | number;
    bank_timestamp: string | number;
    account_id: string | null;
    account_name: string | null;
    category: OffBooksCategory;
    reason: string | null;
    declined_by: string;
    declined_at: string | number;
  }

  async function loadOffBooks(db: D1Database, q: z.infer<typeof OffBooksQuery>) {
    const month = parseJalaliMonth(q.month);
    if (!month) return { error: 'invalid_month' as const };
    const binds: unknown[] = [month.start, month.end];
    let extra = '';
    if (q.accountId) {
      binds.push(q.accountId);
      extra += ` AND t.financial_account_id = ?${binds.length}`;
    }
    if (q.category) {
      binds.push(q.category);
      extra += ` AND idt.category = ?${binds.length}`;
    }
    const rows = await db
      .prepare(
        `SELECT idt.id, t.id AS transaction_id, t.direction, t.amount_irr, t.bank_timestamp,
                t.financial_account_id AS account_id, fa.display_name AS account_name,
                idt.category, idt.reason, idt.declined_by, idt.declined_at
           FROM income_declined_transactions idt
           JOIN transaction_candidates t ON t.id = idt.transaction_candidate_id
           LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
          WHERE idt.restored_at IS NULL
            AND t.bank_timestamp >= ?1 AND t.bank_timestamp < ?2${extra}
          ORDER BY t.bank_timestamp DESC`,
      )
      .bind(...binds)
      .all<OffBooksRow>();
    const mbinds: unknown[] = [month.start, month.end];
    let mextra = '';
    if (q.accountId) {
      mbinds.push(q.accountId);
      mextra += ` AND m.financial_account_id = ?${mbinds.length}`;
    }
    if (q.category) {
      mbinds.push(q.category);
      mextra += ` AND m.category = ?${mbinds.length}`;
    }
    const manual = await db
      .prepare(
        `SELECT m.id, m.direction, m.amount_irr, m.moved_at, m.financial_account_id AS account_id,
                fa.display_name AS account_name, m.category, m.note, m.created_by, m.created_at
           FROM manual_bank_movements m
           LEFT JOIN financial_accounts fa ON fa.id = m.financial_account_id
          WHERE m.voided_at IS NULL AND m.moved_at >= ?1 AND m.moved_at < ?2${mextra}`,
      )
      .bind(...mbinds)
      .all<{
        id: string;
        direction: 'CREDIT' | 'DEBIT';
        amount_irr: string | number;
        moved_at: string | number;
        account_id: string;
        account_name: string | null;
        category: OffBooksCategory;
        note: string | null;
        created_by: string;
        created_at: string | number;
      }>();
    const items = [
      ...(rows.results ?? []).map((r) => ({
        id: r.id,
        kind: 'sms' as const,
        transactionId: r.transaction_id as string | null,
        direction: r.direction,
        amountIrr: Number(r.amount_irr),
        bankTimestamp: Number(r.bank_timestamp),
        accountId: r.account_id,
        accountName: r.account_name,
        category: r.category,
        categoryFa: OFF_BOOKS_CATEGORY_FA[r.category] ?? r.category,
        note: r.reason,
        by: r.declined_by,
        at: Number(r.declined_at),
      })),
      ...(manual.results ?? []).map((m) => ({
        id: m.id,
        kind: 'manual' as const,
        transactionId: null as string | null,
        direction: m.direction,
        amountIrr: Number(m.amount_irr),
        bankTimestamp: Number(m.moved_at),
        accountId: m.account_id as string | null,
        accountName: m.account_name,
        category: m.category,
        categoryFa: OFF_BOOKS_CATEGORY_FA[m.category] ?? m.category,
        note: m.note,
        by: m.created_by,
        at: Number(m.created_at),
      })),
    ].sort((x, y) => y.bankTimestamp - x.bankTimestamp);
    const totals: Record<string, { count: number; creditIrr: number; debitIrr: number }> = {};
    for (const it of items) {
      const t = (totals[it.category] ??= { count: 0, creditIrr: 0, debitIrr: 0 });
      t.count += 1;
      if (it.direction === 'CREDIT') t.creditIrr += it.amountIrr;
      else t.debitIrr += it.amountIrr;
    }
    return { month, items, totals };
  }

  app.get('/api/v1/admin/books/off-books', async (c) => {
    const ident = c.get('identity');
    if (!mayRead(ident.role)) return c.json({ ok: false, error: 'forbidden' }, 403);
    const q = OffBooksQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ ok: false, error: 'invalid_query' }, 400);
    const loaded = await loadOffBooks(c.env.DB, q.data);
    if ('error' in loaded) return c.json({ ok: false, error: loaded.error }, 400);
    const { start, end, ...month } = loaded.month;
    return c.json({ ok: true, month: { ...month, start, end }, items: loaded.items, totals: loaded.totals });
  });

  app.get('/api/v1/admin/books/off-books.csv', async (c) => {
    const ident = c.get('identity');
    if (!mayRead(ident.role)) return c.json({ ok: false, error: 'forbidden' }, 403);
    const q = OffBooksQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ ok: false, error: 'invalid_query' }, 400);
    const loaded = await loadOffBooks(c.env.DB, q.data);
    if ('error' in loaded) return c.json({ ok: false, error: loaded.error }, 400);
    const header = ['تاریخ', 'حساب', 'واریز/برداشت', 'مبلغ (تومان)', 'دلیل', 'یادداشت', 'ثبت‌کننده', 'زمان ثبت'];
    const rows = loaded.items.map((it) =>
      [
        formatJalali(it.bankTimestamp, true),
        it.accountName ?? '',
        it.direction === 'CREDIT' ? 'واریز' : 'برداشت',
        toman(it.amountIrr),
        it.categoryFa,
        it.note ?? '',
        it.by,
        formatJalali(it.at, true),
      ]
        .map(csvCell)
        .join(','),
    );
    const name = `off-books-${loaded.month.year}-${String(loaded.month.month).padStart(2, '0')}.csv`;
    return c.body(`﻿${[header.map(csvCell).join(','), ...rows].join('\r\n')}\r\n`, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${name}"`,
    });
  });

  /**
   * The bank's movements of one account in one month, each with what the
   * books say about it — the list the operator tags from. Credits and
   * debits alike; `offBooks` and `expenseId` say what has already been done.
   */
  app.get('/api/v1/admin/books/movements', async (c) => {
    const ident = c.get('identity');
    if (!mayRead(ident.role)) return c.json({ ok: false, error: 'forbidden' }, 403);
    const month = parseJalaliMonth(c.req.query('month'));
    const accountId = c.req.query('accountId');
    if (!month || !accountId) return c.json({ ok: false, error: 'invalid_query' }, 400);
    // Nothing before the fresh start, the same cut the statement makes: a
    // list that showed the old rows beside a statement that ignores them
    // read as a disagreement on the walk of 2026-09-17.
    const openedAt = await c.env.DB.prepare(
      `SELECT as_of FROM account_opening_balances WHERE financial_account_id = ?1`,
    )
      .bind(accountId)
      .first<{ as_of: string | number }>();
    const from = Math.max(month.start, openedAt ? Number(openedAt.as_of) + 1 : month.start);
    const rows = await c.env.DB.prepare(
      `SELECT t.id, t.direction, t.amount_irr, t.balance_irr, t.bank_timestamp, t.status,
              idt.category AS off_books_category, idt.reason AS off_books_note,
              ra.id AS expense_id, ra.note AS expense_note, COALESCE(ra.fee_irr, 0) AS fee_irr,
              -- «فروش»: spent on an order, or paid into the customer wallet by
              -- hand — a bot top-up is matched to its order, so both read the same.
              (EXISTS (SELECT 1 FROM reconciliation_matches m WHERE m.transaction_candidate_id = t.id
                         AND m.status IN ('CONFIRMED','AUTO_VERIFIED'))
               OR ${TX_WALLET_CREDITED}) AS matched,
              -- What the row's buttons may offer, asked of the same predicates
              -- the routes check, so the page never shows a button the server
              -- refuses (a reseller credit offered «خارج از دفتر», 409).
              (${OFF_BOOKS_ELIGIBLE_TX_WHERE}) AS off_books_eligible,
              -- In «واریزی‌ها» right now: the one place a deposit is given an
              -- owner. The row links there only when the link would find it.
              (${INCOME_QUEUE_TX_WHERE}) AS in_queue,
              r.name AS reseller_name
         FROM transaction_candidates t
         LEFT JOIN reseller_transactions rtx ON rtx.transaction_candidate_id = t.id
         LEFT JOIN resellers r ON r.id = rtx.reseller_id
         LEFT JOIN income_declined_transactions idt
                ON idt.transaction_candidate_id = t.id AND idt.restored_at IS NULL
         LEFT JOIN revenue_adjustments ra
                ON ra.transaction_candidate_id = t.id AND ra.voided_at IS NULL
        WHERE t.financial_account_id = ?1 AND t.direction IN ('CREDIT','DEBIT')
          AND t.status NOT IN ('REJECTED','IGNORED')
          AND t.bank_timestamp >= ?2 AND t.bank_timestamp < ?3
        ORDER BY t.bank_timestamp DESC LIMIT 1000`,
    )
      .bind(accountId, from, month.end)
      .all<{
        id: string;
        direction: 'CREDIT' | 'DEBIT';
        amount_irr: string | number;
        balance_irr: string | number | null;
        bank_timestamp: string | number;
        status: string;
        off_books_category: OffBooksCategory | null;
        off_books_note: string | null;
        expense_id: number | null;
        expense_note: string | null;
        fee_irr: string | number;
        matched: boolean;
        off_books_eligible: boolean;
        in_queue: boolean;
        reseller_name: string | null;
      }>();
    const manual = await c.env.DB.prepare(
      `SELECT id, direction, amount_irr, moved_at, category, note, created_by
         FROM manual_bank_movements
        WHERE financial_account_id = ?1 AND voided_at IS NULL AND moved_at >= ?2 AND moved_at < ?3`,
    )
      .bind(accountId, from, month.end)
      .all<{
        id: string;
        direction: 'CREDIT' | 'DEBIT';
        amount_irr: string | number;
        moved_at: string | number;
        category: OffBooksCategory;
        note: string | null;
        created_by: string;
      }>();
    // An expense on this account that no SMS carries is a movement the
    // ledger knows and the bank never texted — the other way a hole gets
    // closed. Placed at the start of its day: the withdrawal happened some
    // time that day, and the SMS whose balance revealed it came after.
    const unlinked = await c.env.DB.prepare(
      `SELECT ra.id, ra.note, ra.spent_on::text AS spent_on, (-ra.amount_irr + ra.fee_irr) AS irr
         FROM revenue_adjustments ra
        WHERE ra.financial_account_id = ?1 AND ra.kind IN ${LEDGER_OUTFLOW_KINDS_SQL} AND ra.voided_at IS NULL
          AND ra.transaction_candidate_id IS NULL
          AND ra.spent_on >= ?2::date AND ra.spent_on < ?3::date`,
    )
      .bind(accountId, tehranDateStringFromMs(from), tehranDateStringFromMs(month.end))
      .all<{ id: number; note: string | null; spent_on: string; irr: string | number }>();
    const items = [
      ...(unlinked.results ?? []).map((e) => ({
        id: `expense:${e.id}`,
        kind: 'expense' as const,
        direction: 'DEBIT' as const,
        amountIrr: Number(e.irr),
        balanceIrr: null as number | null,
        bankTimestamp: Math.max(from, tehranDayBoundsFromDate(e.spent_on.slice(0, 10)).start),
        matched: false,
        offBooks: null as null | { category: OffBooksCategory; categoryFa: string; note: string | null },
        expense: { id: Number(e.id), note: e.note } as null | { id: number; note: string | null },
      })),
      ...(rows.results ?? []).map((r) => ({
        id: r.id,
        kind: 'sms' as const,
        direction: r.direction,
        amountIrr: Number(r.amount_irr),
        // What the bank took beyond the text — typed on the linked expense,
        // as the tag form says to. The hole finder adds it to the debit.
        feeIrr: Number(r.fee_irr),
        balanceIrr: r.balance_irr == null ? null : Number(r.balance_irr),
        bankTimestamp: Number(r.bank_timestamp),
        matched: r.matched === true,
        offBooksEligible: r.off_books_eligible === true,
        inQueue: r.in_queue === true,
        // «نمایندگی»: classified to a reseller in «واریزی‌ها». Still the
        // customer income it always was; the label says whose.
        reseller: r.reseller_name,
        offBooks: r.off_books_category
          ? { category: r.off_books_category, categoryFa: OFF_BOOKS_CATEGORY_FA[r.off_books_category], note: r.off_books_note }
          : null,
        expense: r.expense_id == null ? null : { id: Number(r.expense_id), note: r.expense_note },
      })),
      // Hand-written rows sit in the same list, at the moment the operator
      // said the bank moved the money, so the balance chain can be read
      // across them.
      ...(manual.results ?? []).map((m) => ({
        id: m.id,
        kind: 'manual' as const,
        direction: m.direction,
        amountIrr: Number(m.amount_irr),
        balanceIrr: null,
        bankTimestamp: Number(m.moved_at),
        matched: false,
        offBooks: { category: m.category, categoryFa: OFF_BOOKS_CATEGORY_FA[m.category], note: m.note },
        expense: null,
        by: m.created_by,
      })),
    ].sort((a, b) => b.bankTimestamp - a.bankTimestamp);
    return c.json({ ok: true, items });
  });

  const ManualBody = z
    .object({
      accountId: z.string().min(1),
      direction: z.enum(['CREDIT', 'DEBIT']),
      amountToman: z.number().int().positive(),
      movedAt: z.number().int().positive(),
      category: z.enum(OFF_BOOKS_CATEGORIES),
      note: z.string().trim().max(200).optional(),
    })
    .strict();

  /**
   * A movement the bank did not text. ADMIN only, like the fresh start:
   * every write under `/admin/` is the owner's (`write-roles.test.ts`), and
   * this one puts the owner's own word into the monthly statement. Never in
   * the future — the operator is explaining a hole the bank has already
   * shown, not predicting one.
   */
  app.post('/api/v1/admin/books/manual', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const body = ManualBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const now = Date.now();
    if (body.data.movedAt > now) return c.json({ ok: false, error: 'in_the_future' }, 400);
    const r = await addManualMovement(c.env.DB, {
      accountId: body.data.accountId,
      direction: body.data.direction,
      amountIrr: body.data.amountToman * IRR_PER_TOMAN,
      movedAt: body.data.movedAt,
      category: body.data.category,
      note: body.data.note || null,
      actorEmail: ident.email,
      now,
    });
    if (!r.ok) return c.json({ ok: false, error: 'account_not_found' }, 404);
    await audit(c.env.DB, ident, 'books.manual_movement', 'MANUAL_BANK_MOVEMENT', r.id, null, body.data, body.data.note ?? null);
    return c.json({ ok: true, id: r.id });
  });

  app.delete('/api/v1/admin/books/manual/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const id = c.req.param('id');
    const r = await voidManualMovement(c.env.DB, { id, actorEmail: ident.email, now: Date.now() });
    if (!r.ok) return c.json({ ok: false, error: 'not_found' }, 404);
    await audit(c.env.DB, ident, 'books.manual_movement_voided', 'MANUAL_BANK_MOVEMENT', id, null, null, null);
    return c.json({ ok: true });
  });

  const RelabelBody = z
    .object({ category: z.enum(OFF_BOOKS_CATEGORIES), note: z.string().trim().max(200).optional() })
    .strict();

  /**
   * Change a tag's reason in place. Eight of the first ten tags on
   * production were «سایر» because «رد کردن» on the payments page had no
   * category picker; restoring and re-tagging each one is the wrong price
   * for that.
   */
  app.patch('/api/v1/admin/books/off-books/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const id = c.req.param('id');
    const body = RelabelBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const before = await c.env.DB.prepare(
      `SELECT category, reason FROM income_declined_transactions WHERE id = ?1 AND restored_at IS NULL`,
    )
      .bind(id)
      .first<{ category: OffBooksCategory; reason: string | null }>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);
    await c.env.DB.prepare(
      `UPDATE income_declined_transactions SET category = ?2, reason = COALESCE(?3, reason) WHERE id = ?1 AND restored_at IS NULL`,
    )
      .bind(id, body.data.category, body.data.note ?? null)
      .run();
    await audit(c.env.DB, ident, 'books.off_books_relabelled', 'INCOME_DECLINED', id, before, body.data, null);
    return c.json({ ok: true });
  });

  app.get('/api/v1/admin/books/withdrawals', async (c) => {
    const ident = c.get('identity');
    if (!mayRead(ident.role)) return c.json({ ok: false, error: 'forbidden' }, 403);
    const accountId = c.req.query('accountId');
    const day = c.req.query('day');
    if (!accountId || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return c.json({ ok: false, error: 'invalid_query' }, 400);
    }
    const { start, end } = tehranDayBoundsFromDate(day);
    const items = await withdrawalsNear(c.env.DB, { accountId, dayStartMs: start, dayEndMs: end });
    return c.json({ ok: true, items });
  });

  app.get('/api/v1/admin/books/opening', async (c) => {
    const ident = c.get('identity');
    if (!mayRead(ident.role)) return c.json({ ok: false, error: 'forbidden' }, 403);
    // The wallet this instant beside the opening: the card that offers the
    // fresh start reads it, whichever month the page is on.
    return c.json({ ok: true, opening: await booksOpening(c.env.DB), now: await walletNow(c.env.DB, Date.now()) });
  });

  /**
   * `asOf` opens the books at the start of a Tehran day already past — Sam,
   * 1 Mehr 1405: «از اول مهر». The balances are the last the bank stated
   * before that midnight, and every report starts there (`sinceBooks`).
   * Without it, this instant, as before. When it was pressed is in the audit
   * row; `created_at` is the start the books keep.
   */
  const OpenBody = z
    .object({ force: z.boolean().optional(), asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
    .strict();

  app.post('/api/v1/admin/books/open', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const body = OpenBody.safeParse((await c.req.json().catch(() => ({}))) ?? {});
    if (!body.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const before = await booksOpening(c.env.DB);
    const pressed = Date.now();
    const now = body.data.asOf ? tehranDayBoundsFromDate(body.data.asOf).start : pressed;
    if (!Number.isFinite(now)) return c.json({ ok: false, error: 'invalid_body' }, 400);
    if (now > pressed) return c.json({ ok: false, error: 'as_of_in_future' }, 400);
    const r = await openBooks(c.env.DB, { actorEmail: ident.email, now, force: body.data.force === true });
    if (!r.ok) return c.json({ ok: false, error: r.error.toLowerCase() }, 409);
    await audit(
      c.env.DB,
      ident,
      'books.opened',
      'BOOKS',
      String(now),
      before,
      { openedAt: now, pressedAt: pressed, walletIrr: r.result.walletIrr, accounts: r.result.accounts.length },
      body.data.force ? 'overwrite' : null,
    );
    return c.json({ ok: true, ...r.result });
  });
}
