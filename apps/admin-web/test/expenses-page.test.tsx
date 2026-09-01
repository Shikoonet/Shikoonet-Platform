/**
 * «هزینه‌ها», asked the two questions Sam asked of it after it shipped.
 *
 * Both were about the screen rather than the arithmetic, which is why nothing
 * else in this repository catches them: the routes were right, the totals were
 * right, and the page was still hard to use.
 *
 * **«دکمه ثبت ردیف تازه میره آخر صفحه یک بخش رو باز میکنه که باید کلی اسکرول
 * کنی».** The forms rendered at the end of the component — below two summary
 * cards, a breakdown, a filter bar and fifty rows — so pressing a button at the
 * top of the page changed something nobody could see. The fix is a mount point
 * under the page head, and what is asserted here is DOCUMENT ORDER: the form
 * comes before the ledger table. A scroll cannot be asserted in happy-dom (it
 * implements neither `scrollIntoView` nor layout), and asserting the call would
 * only prove the call was made. Order is the part that survives a browser
 * without JavaScript scrolling at all.
 *
 * **«معلوم نیست از کجا میاد اطلاعاتش».** Four figures under four bare nouns,
 * printed twice with identical values. Every figure now names what it counts
 * and how many rows it came from, and the card says why the two rows agree when
 * nothing is filtered — because two identical rows read as a bug, not an answer.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { ExpensesPage } from '../src/pages/ExpensesPage.js';
import type { ExpenseCategory, ExpenseRecurrence, RevenueAdjustmentRow } from '../src/api.js';

const CATEGORIES: ExpenseCategory[] = [
  { id: 3, name: 'سرور و زیرساخت', active: true, sortOrder: 30, rowCount: 11 },
  { id: 1, name: 'تبلیغات', active: true, sortOrder: 10, rowCount: 22 },
];

/**
 * A row whose Rial figure is NOT a multiple of ten.
 *
 * The old panel wrote whatever it wrote and the importer carries it, so this is
 * an ordinary imported row rather than a contrived one — `expenses.spec.ts`
 * seeds the same −1,999,995 for the same reason.
 */
const ODD_IRR = -1_999_995;

const ROWS: RevenueAdjustmentRow[] = [
  {
    id: 501,
    amountIrr: -12_000_000,
    note: 'شارژ آروان',
    kind: 'EXPENSE',
    categoryId: 3,
    categoryName: 'سرور و زیرساخت',
    spentOn: '2026-08-20',
    createdBy: 'admin@example.com',
    createdAt: '2026-08-20T09:00:00Z',
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    editCount: 0,
    lastEditedAt: null,
    lastEditedBy: null,
    currency: 'IRR',
    originalAmount: null,
    fxRateIrr: null,
    recurrenceId: null,
  },
  {
    ...{
      id: 502,
      amountIrr: ODD_IRR,
      note: 'ردیف واردشده با رقم فرد',
      kind: 'EXPENSE' as const,
      categoryId: null,
      categoryName: null,
      spentOn: '2026-08-21',
      createdBy: '7137494513',
      createdAt: '2026-08-21T09:00:00Z',
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      editCount: 0,
      lastEditedAt: null,
      lastEditedBy: null,
      currency: 'IRR' as const,
      originalAmount: null,
      fxRateIrr: null,
      recurrenceId: null,
    },
  },
];

/** The three kinds and the counts behind them — the shape the card renders. */
const TOTALS = {
  expensesIrr: -7_545_397_500,
  revenueFixIrr: -293_120_000,
  manualIncomeIrr: 864_800_000,
  netIrr: -6_973_717_500,
  expensesCount: 56,
  revenueFixCount: 120,
  manualIncomeCount: 43,
  netCount: 219,
};

const revenueAdjustments = vi.fn(async (_p?: unknown) => ({
  ok: true,
  total: 219,
  page: 1,
  pageSize: 50,
  items: ROWS,
  totals: TOTALS,
  lifetime: TOTALS,
  rangeTotals: null,
  byCategory: [{ categoryId: 3, name: 'سرور و زیرساخت', count: 11, irr: -410_500_000 }],
}));

const expenseCategories = vi.fn(async () => ({ ok: true, items: CATEGORIES }));
const RECURRENCES: ExpenseRecurrence[] = [];
const expenseRecurrences = vi.fn(async () => ({ ok: true, items: RECURRENCES }));
const editRevenueAdjustment = vi.fn(async (_id: number, _body: unknown) => ({
  ok: true,
  changed: true,
}));

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      // Wrapped rather than passed by reference: the factory is hoisted above
      // the `const`s, so naming one directly reads it before it exists.
      revenueAdjustments: (p: unknown) => revenueAdjustments(p),
      expenseCategories: () => expenseCategories(),
      expenseRecurrences: () => expenseRecurrences(),
      revenueAdjustmentsCsvUrl: () => '/api/v1/admin/revenue-adjustments/export.csv',
      editRevenueAdjustment: (id: number, body: unknown) => editRevenueAdjustment(id, body),
    },
  };
});

const draw = () =>
  render(
    <RoleProvider role="ADMIN">
      <ExpensesPage />
    </RoleProvider>,
  );

beforeEach(() => {
  revenueAdjustments.mockClear();
  expenseCategories.mockClear();
  expenseRecurrences.mockClear();
  editRevenueAdjustment.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('where a form opens', () => {
  it('puts the new-entry form above the ledger table, not after it', async () => {
    draw();
    await screen.findByText('شارژ آروان');

    fireEvent.click(screen.getByRole('button', { name: 'ثبت ردیف تازه' }));

    const form = await screen.findByText('ثبت ردیف تازه', { selector: '.card__title' });
    const table = document.querySelector('.app-table:last-of-type')!;

    // `DOCUMENT_POSITION_FOLLOWING` — the form precedes the table. This is the
    // whole complaint in one bit: it used to be the other way round, with five
    // screens of page in between.
    expect(form.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('opens the edit form in the same place a new row opens', async () => {
    draw();
    await screen.findByText('شارژ آروان');

    // Scoped to one row: the fixture holds two, and «کدام ردیف» is not what
    // this test is about.
    const row = screen.getByText('شارژ آروان').closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'ویرایش' }));
    const form = await screen.findByText('ویرایش ردیف', { selector: '.card__title' });

    // Pressed from a row far down the table, and it still arrives at the top.
    // One mount point, so «ویرایش» and «ثبت ردیف تازه» never disagree about
    // where the form is.
    const table = document.querySelector('.app-table:last-of-type')!;
    expect(form.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('where the totals come from', () => {
  it('says what each column counts, not just its name', async () => {
    draw();
    await screen.findByText('شارژ آروان');

    // «اصلاح درآمد» is the one nobody guesses, and misreading it is what put
    // 35.8 million Toman of fake receipts under «هزینه» on the old screen.
    expect(screen.getByText('فیش فیک، عدم واریزی، تکراری')).toBeTruthy();
    expect(screen.getByText('پولی که فروشگاه خرج کرده')).toBeTruthy();
    expect(screen.getByText('فروشی که دستی ثبت شده')).toBeTruthy();
    expect(screen.getByText('جمع سه ستون قبل')).toBeTruthy();
  });

  it('gives every figure the number of rows it was added up from', async () => {
    draw();
    await screen.findByText('شارژ آروان');

    // A total with no denominator cannot be checked against anything. Both rows
    // of the card carry them, hence two of each.
    expect(screen.getAllByText('از ۵۶ ردیف')).toHaveLength(2);
    expect(screen.getAllByText('از ۱۲۰ ردیف')).toHaveLength(2);
    expect(screen.getAllByText('از ۴۳ ردیف')).toHaveLength(2);
    expect(screen.getAllByText('از ۲۱۹ ردیف')).toHaveLength(2);
  });

  it('says why the two rows agree when nothing is filtered', async () => {
    draw();
    await screen.findByText('شارژ آروان');

    // Identical numbers printed twice read as a bug unless the page says they
    // are meant to be identical.
    expect(screen.getByText(/فیلتری فعال نیست، پس دو سطر عمداً یکی‌اند/)).toBeTruthy();
  });

  it('changes that sentence the moment a filter is on', async () => {
    draw();
    await screen.findByText('شارژ آروان');

    fireEvent.change(screen.getByLabelText('نوع'), { target: { value: 'EXPENSE' } });

    await waitFor(() =>
      expect(screen.getByText(/سطر اول همان ردیف‌هایی است که پایین می‌بینی/)).toBeTruthy(),
    );
    // ...and the claim behind the sentence: the server was asked for that filter.
    expect(revenueAdjustments).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'EXPENSE' }),
    );
  });
});


/**
 * An imported row whose Rial amount is not a multiple of ten.
 *
 * CodeRabbit found this on PR #42 and it was real. The form divided IRR by ten
 * for display, giving «199999.5», and the parser then deleted every non-digit
 * — including the point — so an operator who opened the form to fix a
 * description and pressed «ذخیره» wrote 1,999,995 Toman: **ten times the
 * amount**, past a validator that saw a perfectly good integer.
 *
 * The fix is not a round on load, which would rewrite the row by up to nine
 * Rial every time somebody looked at it. It is that an amount nobody restated
 * is never sent at all.
 */
describe('an amount the operator did not touch', () => {
  const openEditor = async (note: string) => {
    draw();
    await screen.findByText(note);
    const row = screen.getByText(note).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'ویرایش' }));
    return screen.findByText('ویرایش ردیف', { selector: '.card__title' });
  };

  it('shows the exact Toman figure, fraction and all', async () => {
    await openEditor('ردیف واردشده با رقم فرد');
    // Not «۲۰۰٬۰۰۰» and not «199999»: what the row actually holds.
    expect((screen.getByLabelText('مبلغ (تومان)') as HTMLInputElement).value).toBe('199999.5');
  });

  it('sends no amount at all when only the description changed', async () => {
    await openEditor('ردیف واردشده با رقم فرد');

    fireEvent.change(screen.getByLabelText('شرح'), { target: { value: 'شرح تازه' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));

    await waitFor(() => expect(editRevenueAdjustment).toHaveBeenCalled());
    const [, body] = editRevenueAdjustment.mock.calls[0]!;
    expect((body as { note: string }).note).toBe('شرح تازه');
    // The whole fix in one assertion. With `amountToman` present the route
    // treats it as a restatement, and −1,999,995 becomes −19,999,950.
    expect(body).not.toHaveProperty('amountToman');
    expect(body).not.toHaveProperty('currency');
  });

  it('does send the amount once somebody restates it', async () => {
    await openEditor('ردیف واردشده با رقم فرد');

    fireEvent.change(screen.getByLabelText('مبلغ (تومان)'), { target: { value: '250000' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));

    await waitFor(() => expect(editRevenueAdjustment).toHaveBeenCalled());
    const [, body] = editRevenueAdjustment.mock.calls[0]!;
    expect((body as { amountToman: number }).amountToman).toBe(250_000);
  });

  it('refuses to save a restated amount that is still fractional', async () => {
    await openEditor('ردیف واردشده با رقم فرد');

    // Typing a digit onto the fraction restates it — and «1999999.5» Toman is
    // not a figure this ledger can hold, so it is refused rather than silently
    // multiplied.
    fireEvent.change(screen.getByLabelText('مبلغ (تومان)'), { target: { value: '199999.7' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));

    await waitFor(() => expect(screen.getByText(/رقم اعشاری/)).toBeTruthy());
    expect(editRevenueAdjustment).not.toHaveBeenCalled();
  });
});
