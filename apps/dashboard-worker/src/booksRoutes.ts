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
 *   GET  /admin/books/opening                                 has the fresh start been written
 *   POST /admin/books/open {force?}                            write it
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
  OFF_BOOKS_CATEGORIES,
  accountStatement,
  booksOpening,
  monthStatements,
  openBooks,
  parseJalaliMonth,
  tehranDayBoundsFromDate,
  withdrawalsNear,
  type AccountStatement,
  type OffBooksCategory,
} from '@shikoo/domain';
import { audit, type Ident } from './adminAudit.js';
import { csvCell } from './revenueRoutes.js';

const IRR_PER_TOMAN = 10;

export const OFF_BOOKS_CATEGORY_FA: Record<OffBooksCategory, string> = {
  TRANSFER: 'جابه‌جایی بین حساب‌های خودمان',
  PERSONAL: 'شخصی',
  MISTAKE_RETURNED: 'اشتباهی و برگشت‌داده‌شده',
  BANK_FEE: 'کارمزد بانک',
  OTHER: 'سایر',
};

const toman = (irr: number) => irr / IRR_PER_TOMAN;

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
    return c.json({
      ok: true,
      month: { ...monthOut, start: loaded.month.start, end: loaded.month.end },
      accounts: loaded.accounts,
      totals: statementTotals(loaded.accounts),
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
      'جابه‌جایی (واریز)', 'شخصی (واریز)', 'اشتباهی (واریز)', 'سایر (واریز)',
      'برداشت با هزینهٔ ثبت‌شده', 'برداشت بی‌توضیح', 'تعداد بی‌توضیح',
      'جابه‌جایی (برداشت)', 'شخصی (برداشت)', 'اشتباهی (برداشت)', 'کارمزد بانک', 'سایر (برداشت)',
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
        line(s.offBooksCredits, 'MISTAKE_RETURNED'), line(s.offBooksCredits, 'OTHER'),
        toman(s.explainedWithdrawals.amountIrr), toman(s.unexplainedWithdrawals.amountIrr), s.unexplainedWithdrawals.count,
        line(s.offBooksDebits, 'TRANSFER'), line(s.offBooksDebits, 'PERSONAL'),
        line(s.offBooksDebits, 'MISTAKE_RETURNED'), line(s.offBooksDebits, 'BANK_FEE'), line(s.offBooksDebits, 'OTHER'),
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
    const items = (rows.results ?? []).map((r) => ({
      id: r.id,
      transactionId: r.transaction_id,
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
    }));
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
    const rows = await c.env.DB.prepare(
      `SELECT t.id, t.direction, t.amount_irr, t.balance_irr, t.bank_timestamp, t.status,
              idt.category AS off_books_category, idt.reason AS off_books_note,
              ra.id AS expense_id, ra.note AS expense_note,
              EXISTS (SELECT 1 FROM reconciliation_matches m WHERE m.transaction_candidate_id = t.id
                        AND m.status IN ('CONFIRMED','AUTO_VERIFIED')) AS matched
         FROM transaction_candidates t
         LEFT JOIN income_declined_transactions idt
                ON idt.transaction_candidate_id = t.id AND idt.restored_at IS NULL
         LEFT JOIN revenue_adjustments ra
                ON ra.transaction_candidate_id = t.id AND ra.voided_at IS NULL
        WHERE t.financial_account_id = ?1 AND t.direction IN ('CREDIT','DEBIT')
          AND t.status NOT IN ('REJECTED','IGNORED')
          AND t.bank_timestamp >= ?2 AND t.bank_timestamp < ?3
        ORDER BY t.bank_timestamp DESC LIMIT 1000`,
    )
      .bind(accountId, month.start, month.end)
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
        matched: boolean;
      }>();
    return c.json({
      ok: true,
      items: (rows.results ?? []).map((r) => ({
        id: r.id,
        direction: r.direction,
        amountIrr: Number(r.amount_irr),
        balanceIrr: r.balance_irr == null ? null : Number(r.balance_irr),
        bankTimestamp: Number(r.bank_timestamp),
        matched: r.matched === true,
        offBooks: r.off_books_category
          ? { category: r.off_books_category, categoryFa: OFF_BOOKS_CATEGORY_FA[r.off_books_category], note: r.off_books_note }
          : null,
        expense: r.expense_id == null ? null : { id: Number(r.expense_id), note: r.expense_note },
      })),
    });
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
    return c.json({ ok: true, opening: await booksOpening(c.env.DB) });
  });

  const OpenBody = z.object({ force: z.boolean().optional() }).strict();

  app.post('/api/v1/admin/books/open', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const body = OpenBody.safeParse((await c.req.json().catch(() => ({}))) ?? {});
    if (!body.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const before = await booksOpening(c.env.DB);
    const now = Date.now();
    const r = await openBooks(c.env.DB, { actorEmail: ident.email, now, force: body.data.force === true });
    if (!r.ok) return c.json({ ok: false, error: r.error.toLowerCase() }, 409);
    await audit(
      c.env.DB,
      ident,
      'books.opened',
      'BOOKS',
      String(now),
      before,
      { openedAt: now, walletIrr: r.result.walletIrr, accounts: r.result.accounts.length },
      body.data.force ? 'overwrite' : null,
    );
    return c.json({ ok: true, ...r.result });
  });
}
