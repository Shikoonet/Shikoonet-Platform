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

const ROWS_BASE: RevenueAdjustmentRow = {
  id: 0,
  amountIrr: 0,
  note: '',
  kind: 'EXPENSE',
  categoryId: null,
  categoryName: null,
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
  financialAccountId: null,
  accountName: null,
  feeIrr: 0,
  transactionCandidateId: null,
  partyId: null,
  partyName: null,
  scope: { level: 'SHOP', id: null, name: null },
};

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
    financialAccountId: null,
    accountName: null,
    feeIrr: 0,
    transactionCandidateId: null,
    partyId: null,
    partyName: null,
    scope: { level: 'SHOP', id: null, name: null },
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
      financialAccountId: null,
      accountName: null,
      feeIrr: 0,
      transactionCandidateId: null,
      partyId: null,
      partyName: null,
      scope: { level: 'SHOP', id: null, name: null },
    },
  },
  // گردشگری‑۱‑سارا, 2026-09-20: 109,000 on the invoice, 1,100 the bank took on top.
  {
    ...ROWS_BASE,
    id: 641,
    amountIrr: -1_090_000,
    note: 'هزینه اشترک VPN پیکومو',
    spentOn: '2026-09-20',
    financialAccountId: 'acct-gardeshgari',
    accountName: 'گردشگری۱-سارا',
    feeIrr: 11_000,
    transactionCandidateId: 'tx-641',
  },
];

/** The three kinds and the counts behind them — the shape the card renders. */
const TOTALS = {
  expensesIrr: -7_545_397_500,
  revenueFixIrr: -293_120_000,
  manualIncomeIrr: 864_800_000,
  netIrr: -6_973_717_500,
  feesIrr: 11_000,
  expensesCount: 56,
  revenueFixCount: 120,
  manualIncomeCount: 43,
  partnerDrawsIrr: 0,
  partnerDrawsCount: 0,
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
const addRevenueAdjustment = vi.fn(async (_body: unknown) => ({ ok: true, id: 900, amountIrr: -10_000 }));
const voidRevenueAdjustment = vi.fn(async (_id: number, _reason: string): Promise<{ ok: boolean }> => ({ ok: true }));
const parties = vi.fn(async () => ({
  ok: true,
  items: [
    { id: 1, name: 'حسام', roles: ['PARTNER'], sharePercent: 40, active: true, note: '', drawnIrr: 0, paidIrr: 0, receivedIrr: 0, rowCount: 0, lastOn: null },
    { id: 2, name: 'هتزنر', roles: ['SUPPLIER'], sharePercent: null, active: true, note: '', drawnIrr: 0, paidIrr: 0, receivedIrr: 0, rowCount: 0, lastOn: null },
  ],
}));
const expenseScopes = vi.fn(async () => ({
  ok: true,
  categories: [{ id: 10, name: 'V2ray' }, { id: 11, name: 'OpenVPN' }],
  products: [
    { id: 20, name: 'الماس', categoryId: 10, providerId: 30, active: true },
    { id: 21, name: 'تیتانیوم', categoryId: 10, providerId: 30, active: true },
    { id: 22, name: 'OPENVPN', categoryId: 11, providerId: 31, active: true },
  ],
  providers: [{ id: 30, name: 'پنل آلمان' }, { id: 31, name: 'openvpn' }, { id: 32, name: 'سرویس الماس' }],
}));

const withdrawalsNear = vi.fn(async (_account: string, _day: string) => ({
  ok: true,
  items: [{ id: 'tx-7m', amountIrr: 70_000_000, bankTimestamp: Date.parse('2026-09-23T08:26:00Z'), balanceIrr: 1_106_070, linkedExpenseId: null }],
}));

// «رسالت-پگاه» is retired: a withdrawal on it still has to be explainable.
vi.mock('../src/hub/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/hub/api.js')>('../src/hub/api.js');
  return {
    ...actual,
    api: {
      ...actual.api,
      accounts: async () => ({
        items: [
          { id: 'acc-mellat', display_name: 'ملت-سارا', active: 1, status: 'ACTIVE', card_last_four: null },
          { id: 'acc-resalat', display_name: 'رسالت-پگاه', active: 0, status: 'ACTIVE', card_last_four: null },
        ],
      }),
    },
  };
});

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
      addRevenueAdjustment: (body: unknown) => addRevenueAdjustment(body),
      voidRevenueAdjustment: (id: number, reason: string) => voidRevenueAdjustment(id, reason),
      parties: () => parties(),
      expenseScopes: () => expenseScopes(),
      withdrawalsNear: (a: string, d: string) => withdrawalsNear(a, d),
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
  addRevenueAdjustment.mockClear();
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
    expect(screen.getByText('پولی که فروشگاه خرج کرده، با کارمزد بانک')).toBeTruthy();
    expect(screen.getByText('فروشی که دستی ثبت شده')).toBeTruthy();
    expect(screen.getByText('جمع ستون‌های قبل')).toBeTruthy();
  });

  it('a row shows what left the account, and says how much of it was the fee', async () => {
    draw();
    const row = (await screen.findByText('هزینه اشترک VPN پیکومو')).closest('tr')!;
    // 109,000 + 1,100: the badge is the money gone, the line under it the split.
    expect(within(row).getByText(/−۱۱۰٬۱۰۰ تومان/)).toBeTruthy();
    expect(within(row).getByText(/۱۰۹٬۰۰۰ \+ کارمزد ۱٬۱۰۰/)).toBeTruthy();
    // And the card says how much of «هزینه» was fees, in this filter and over the ledger.
    expect(screen.getAllByText(/از این، کارمزد بانک ۱٬۱۰۰ تومان/)).toHaveLength(2);
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

/**
 * «به کی» and «مالِ کدام» — Sam, 2026-09-22: «وقتی هزینه تعریف می‌کنم باید
 * بتونم وصلش کنم به سرویس‌هامون، مثلاً v2ray یا openvpn».
 */
describe('who and what for', () => {
  const openNew = async () => {
    draw();
    await screen.findByText('شارژ آروان');
    fireEvent.click(screen.getByRole('button', { name: 'ثبت ردیف تازه' }));
    await screen.findByText('ثبت ردیف تازه', { selector: '.card__title' });
    fireEvent.change(screen.getByLabelText('مبلغ (تومان)'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('شرح'), { target: { value: 'تبلیغ کانال' } });
  };

  it('sends a cost for «V2ray» as that category, and says which services it will be spread over', async () => {
    await openNew();
    fireEvent.change(screen.getByLabelText('مالِ کدام'), { target: { value: 'CATEGORY' } });
    fireEvent.change(await screen.findByLabelText('دستهٔ سرویس', { selector: '#entry-scope-id' }), { target: { value: '10' } });
    expect(screen.getByText(/بین الماس، تیتانیوم پخش می‌شود/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ثبت' }));
    await waitFor(() => expect(addRevenueAdjustment).toHaveBeenCalled());
    expect(addRevenueAdjustment.mock.calls[0]![0]).toMatchObject({
      kind: 'EXPENSE',
      scope: { level: 'CATEGORY', id: 10 },
      partyId: null,
    });
  });

  it('says how many services are under each panel, and that a cost on an empty one is spread nowhere', async () => {
    // Production, 2026-09-22: two panels are both «سرویس الماس» and only one
    // carries the service. By name alone the two cannot be told apart.
    await openNew();
    fireEvent.change(screen.getByLabelText('مالِ کدام'), { target: { value: 'PROVIDER' } });
    const panel = (await screen.findByLabelText('پنل', { selector: '#entry-scope-id' })) as HTMLSelectElement;
    expect([...panel.options].map((o) => o.textContent)).toEqual([
      '— انتخاب کن —',
      'پنل آلمان (۲ سرویس)',
      'openvpn (۱ سرویس)',
      'سرویس الماس (بدون سرویس)',
    ]);
    fireEvent.change(panel, { target: { value: '32' } });
    expect(screen.getByText(/زیر این هیچ سرویسی نیست/)).toBeTruthy();
  });

  it('will not send a partner draw without a partner, and offers only partners for one', async () => {
    await openNew();
    fireEvent.click(screen.getByLabelText('برداشت شریک'));
    const who = (await screen.findByLabelText('کدام شریک')) as HTMLSelectElement;
    expect([...who.options].map((o) => o.textContent)).toEqual(['— انتخاب کن —', 'حسام · شریک']);
    // No «مالِ کدام» on a draw: it is not a cost of any service.
    expect(screen.queryByLabelText('مالِ کدام')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ثبت' }));
    await waitFor(() => expect(screen.getByText('برداشت سود مال کدام شریک است؟')).toBeTruthy());
    expect(addRevenueAdjustment).not.toHaveBeenCalled();

    fireEvent.change(who, { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'ثبت' }));
    await waitFor(() => expect(addRevenueAdjustment).toHaveBeenCalled());
    expect(addRevenueAdjustment.mock.calls[0]![0]).toMatchObject({ kind: 'PARTNER_DRAW', partyId: 1 });
  });
});

/**
 * «دفتر بانک» › «برداشت شریک» on an unexplained withdrawal (Sam, 1 Mehr 1405):
 * the form opens already on that SMS — account, amount, day, the SMS itself,
 * and the kind — so the operator only picks the partner.
 */
describe('opened from a withdrawal in «دفتر بانک»', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('is a partner draw on that withdrawal, and sends it linked', async () => {
    window.history.replaceState(null, '', '/admin/expenses?account=acc-resalat&amount=7000000&date=2026-09-23&tx=tx-7m&kind=PARTNER_DRAW');
    draw();
    expect((await screen.findByLabelText('برداشت شریک')) as HTMLInputElement).toMatchObject({ checked: true });
    await waitFor(() => expect(withdrawalsNear).toHaveBeenCalledWith('acc-resalat', '2026-09-23'));
    // Retired, and still the account the picker shows — not «مشخص نشده».
    await waitFor(() =>
      expect((document.getElementById('entry-account') as HTMLSelectElement).selectedOptions[0]?.textContent).toBe('رسالت-پگاه'),
    );
    fireEvent.change(await screen.findByLabelText('کدام شریک'), { target: { value: '1' } });
    // The one thing the link cannot know: what it was for.
    fireEvent.change(screen.getByLabelText('شرح'), { target: { value: 'سهم سود شهریور' } });
    fireEvent.click(screen.getByRole('button', { name: 'ثبت' }));
    await waitFor(() => expect(addRevenueAdjustment).toHaveBeenCalled());
    expect(addRevenueAdjustment.mock.calls[0]![0]).toMatchObject({
      kind: 'PARTNER_DRAW',
      partyId: 1,
      amountToman: 7_000_000,
      spentOn: '2026-09-23',
      financialAccountId: 'acc-resalat',
      transactionCandidateId: 'tx-7m',
    });
    // Used once (CodeRabbit on #445): the next new row starts empty, and the
    // address no longer names the withdrawal a reload would open again.
    await waitFor(() => expect(window.location.search).toBe(''));
    fireEvent.click(await screen.findByRole('button', { name: 'ثبت ردیف تازه' }));
    expect(((await screen.findByLabelText('مبلغ (تومان)')) as HTMLInputElement).value).toBe('');
    // A form that holds no account offers only the live ones.
    await waitFor(() =>
      expect([...(document.getElementById('entry-account') as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
        '— مشخص نشده —',
        'ملت-سارا',
      ]),
    );
  });

  it('is a cost when no kind is asked for', async () => {
    window.history.replaceState(null, '', '/admin/expenses?account=acc-resalat&amount=7000000&date=2026-09-23&tx=tx-7m');
    draw();
    expect((await screen.findByLabelText('هزینه')) as HTMLInputElement).toMatchObject({ checked: true });
  });
});

/**
 * Sam, 2026-09-24: «تو هزینه ها دکمه ابطال کار نمی کند». It did — out of sight.
 * Walked on the built panel: with the form a «دفتر بانک» link opens still up,
 * «ابطال» on a row far down drew its form UNDER that one, 1,859 px above the
 * screen, and nothing scrolled, because the scroll ran only when the slot went
 * from empty to open. Nothing on screen changed. Now the slot holds one form,
 * every form that opens is scrolled to, and what the server says lands in it.
 */
describe('«ابطال» while another form is open', () => {
  const scrolls: Element[] = [];
  beforeEach(() => {
    scrolls.length = 0;
    voidRevenueAdjustment.mockClear();
    // happy-dom has no scrollIntoView; the page calls it only if present.
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolls.push(this);
    };
  });
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    window.history.replaceState(null, '', '/');
  });

  const voidOf = async (note: string) => {
    const row = (await screen.findByText(note)).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'ابطال' }));
    return screen.findByText('ابطال ردیف', { selector: '.card__title' });
  };

  it('takes the place of the open form, and the page goes to it', async () => {
    window.history.replaceState(null, '', '/admin/expenses?account=acc-resalat&amount=7000000&date=2026-09-23&tx=tx-7m');
    draw();
    await screen.findByText('ثبت ردیف تازه', { selector: '.card__title' });
    scrolls.length = 0;

    await voidOf('شارژ آروان');

    expect(screen.queryByText('ثبت ردیف تازه', { selector: '.card__title' })).toBeNull();
    await waitFor(() => expect(scrolls.some((el) => el.classList.contains('scroll-target'))).toBe(true));
  });

  it('starts empty for the next row, and shows the server\'s refusal where the form is', async () => {
    draw();
    await voidOf('شارژ آروان');
    fireEvent.change(screen.getByLabelText('دلیل ابطال'), { target: { value: 'دو بار ثبت شده' } });
    await voidOf('هزینه اشترک VPN پیکومو');
    expect((screen.getByLabelText('دلیل ابطال') as HTMLInputElement).value).toBe('');

    voidRevenueAdjustment.mockRejectedValueOnce(new Error('already_voided'));
    fireEvent.change(screen.getByLabelText('دلیل ابطال'), { target: { value: 'دو بار ثبت شده' } });
    fireEvent.click(screen.getByRole('button', { name: 'بله، باطل کن' }));
    const alert = await screen.findByText(/already_voided/);
    expect(alert.closest('.scroll-target')).not.toBeNull();
  });
});
