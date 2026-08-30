/**
 * «آمار فروشگاه», asked the two questions the screen it replaces gets wrong.
 *
 * **Does it keep stocks and flows apart?** The PHP screen puts a wallet balance
 * and an hour's sales under the same period button. If this page ever draws
 * them in one list again, an operator reading «موجودی کل کاربران» under «یک
 * ساعت اخیر» will believe the shop took nineteen million Toman that hour.
 *
 * **Does it say what it will not count?** Two figures the legacy has are not
 * computed here. A `0` under either label is indistinguishable from «none in
 * this window», so the requirement is that no such number appears and that the
 * reason does.
 *
 * The fixture numbers are the ones from Sam's screenshot of the live PHP bot on
 * 2026-08-29, so what renders here is what he will compare against.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { StatsPage } from '../src/pages/StatsPage.js';
import type { ShopStatsResponse, StatsRange } from '../src/api.js';

const BASE: ShopStatsResponse = {
  ok: true,
  range: 'all',
  startMs: null,
  endMs: null,

  newCustomers: 15025,
  buyers: 4617,
  salesCount: 4994,
  salesIrr: 3_508_678_650,
  renewalsCount: 480,
  renewalsIrr: 825_450_000,
  addonsCount: 37,
  addonsIrr: 34_160_000,
  // The three above it, and written as the sum so a reader can see that it is.
  earnedIrr: 3_508_678_650 + 825_450_000 + 34_160_000,
  topupsIrr: 120_000_000,
  conversionPercent: 30.73,
  avgPerBuyerIrr: 1_701_850,
  renewalSharePercent: 9.66,
  projectedMonthlyIrr: 7_069_800_000,
  projectionDays: 30,

  customersTotal: 15025,
  activeSubscriptions: 4932,
  activeSubscriptionsIrr: 8_549_303_500,
  walletHeldIrr: 191_757_500,
  walletOwedToShopIrr: 0,
  walletDebtors: 0,
  resellers: 1,
  panels: 6,
  claimsWaiting: 3,

  gateways: [{ method: 'CARD_TO_CARD', count: 5352, irr: 9_662_580_180 }],
  notMeasured: [
    { label: 'نمایندگان نوع N و N2', reason: 'این‌جا نمایندگی یک وضعیت است، نه دو نوع.' },
    { label: 'اکانت‌های تست', reason: 'ربات قدیمی آن‌ها را از روی نام محصول می‌شمارد.' },
  ],
};

const stats = vi.fn(async (range: StatsRange, _day?: string, _to?: string): Promise<ShopStatsResponse> => ({
  ...BASE,
  range,
  // Only the flows move. The stocks are returned unchanged on purpose — the
  // assertion below is that the page shows it that way too.
  ...(range === '1h' ? { salesCount: 0, salesIrr: 0, startMs: 1, endMs: 2 } : {}),
}));

/**
 * The books, from the route that owns them.
 *
 * Expenses are negative, exactly as `revenue_adjustments` stores them and as
 * «هزینه‌ها و تعدیل‌ها» renders them. The figures are production's: 219 rows
 * netting −697,371,750 Toman, which is the number that made «درآمد کل» negative
 * before the importer started writing an order per invoice.
 */
const LIFE = { expensesIrr: -7_012_000_000, creditsIrr: 38_282_500, netIrr: -6_973_717_500 };
const revenueAdjustments = vi.fn(async (_p?: unknown) => ({
  ok: true,
  total: 219,
  page: 1,
  pageSize: 1,
  items: [],
  totals: LIFE,
  rangeTotals: null,
}));

const WALLETS = [
  { id: 9, telegramId: 314985971, username: 'poyan_b', balanceIrr: 41_000_000 },
  { id: 4, telegramId: 200100300, username: null, balanceIrr: 12_500_000 },
];
const customers = vi.fn(async (_p?: unknown) => ({ ok: true, total: 2, page: 1, pageSize: 10, items: WALLETS }));

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      // Every one of these is wrapped rather than passed by reference: the
      // factory is hoisted above the `const`s, so naming one directly reads it
      // before it exists.
      stats: (r: StatsRange, d?: string, t?: string) => stats(r, d, t),
      revenueAdjustments: (p: unknown) => revenueAdjustments(p),
      customers: (p: unknown) => customers(p),
    },
  };
});

const draw = () =>
  render(
    <RoleProvider role="ADMIN">
      <StatsPage />
    </RoleProvider>,
  );

beforeEach(() => {
  stats.mockClear();
  revenueAdjustments.mockClear();
  customers.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('the seven windows', () => {
  it('offers every period the legacy screen has', async () => {
    draw();
    await screen.findByText('تعداد فروش');

    for (const label of [
      'آمار کل',
      'یک ساعت اخیر',
      'امروز',
      'دیروز',
      'ماه جاری',
      'ماه گذشته',
      'تاریخ مشخص',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
  });

  it('opens on «آمار کل» and asks the server for it', async () => {
    draw();
    await waitFor(() => expect(stats).toHaveBeenCalledWith('all', expect.anything(), undefined));
  });

  it('re-asks the server when a period is chosen', async () => {
    draw();
    await screen.findByText('تعداد فروش');

    fireEvent.click(screen.getByRole('button', { name: 'یک ساعت اخیر' }));
    await waitFor(() => expect(stats).toHaveBeenCalledWith('1h', expect.anything(), undefined));
  });

  it('shows a Jalali date picker only for «تاریخ مشخص», never a Gregorian one', async () => {
    const { container } = draw();
    await screen.findByText('تعداد فروش');
    expect(screen.queryByLabelText('ماه تاریخ')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'تاریخ مشخص' }));
    await screen.findByLabelText('ماه تاریخ');

    // The browser's own date input renders a Gregorian calendar whatever the
    // page language is, which is the whole reason this picker exists.
    expect(container.querySelector('input[type="date"]')).toBeNull();
    expect(screen.getByLabelText('ماه تاریخ').textContent).toContain('شهریور');
    expect(screen.getByLabelText('سال تاریخ').textContent).toContain('۱۴۰۵');
  });

  it('offers only the days the chosen Jalali month really has', async () => {
    draw();
    await screen.findByText('تعداد فروش');
    fireEvent.click(screen.getByRole('button', { name: 'تاریخ مشخص' }));

    const month = await screen.findByLabelText('ماه تاریخ');
    const days = () => screen.getByLabelText('روز تاریخ').querySelectorAll('option').length;

    fireEvent.change(month, { target: { value: '1' } }); // فروردین
    await waitFor(() => expect(days()).toBe(31));

    fireEvent.change(month, { target: { value: '7' } }); // مهر
    await waitFor(() => expect(days()).toBe(30));

    fireEvent.change(month, { target: { value: '12' } }); // اسفند
    await waitFor(() => expect(days()).toBeLessThanOrEqual(30));
  });

  it('sends the Gregorian date the API takes, converted from the Jalali choice', async () => {
    draw();
    await screen.findByText('تعداد فروش');
    fireEvent.click(screen.getByRole('button', { name: 'تاریخ مشخص' }));
    await screen.findByLabelText('ماه تاریخ');

    fireEvent.change(screen.getByLabelText('ماه تاریخ'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('روز تاریخ'), { target: { value: '1' } });

    // 1 Farvardin 1405 is Nowruz — 21 March 2026.
    await waitFor(() => expect(stats).toHaveBeenCalledWith('day', '2026-03-21', undefined));
  });
});

describe('the date fields read the way a Persian date is spoken', () => {
  it('puts day first in the DOM, so RTL renders روز | ماه | سال', async () => {
    draw();
    await screen.findByText('تعداد فروش');
    fireEvent.click(screen.getByRole('button', { name: 'تاریخ مشخص' }));

    const row = (await screen.findByLabelText('ماه تاریخ')).closest('.datefield__row')!;
    const parts = [...row.querySelectorAll('select')].map((el) => el.dataset.part);
    // The page is RTL, so the first element is the rightmost one on screen.
    expect(parts).toEqual(['day', 'month', 'year']);
  });

  it('dresses them as one control rather than three loose dropdowns', async () => {
    draw();
    await screen.findByText('تعداد فروش');
    fireEvent.click(screen.getByRole('button', { name: 'بازهٔ دلخواه' }));

    const fields = await screen.findAllByText(/^(از|تا)$/);
    expect(fields.map((f) => f.textContent)).toEqual(['از', 'تا']);
    for (const f of fields) expect(f.closest('.datefield')).not.toBeNull();
  });
});

describe('the custom window', () => {
  it('names the last day inside it, not the exclusive edge past it', async () => {
    // 2026-08-29 00:00 Tehran to 2026-10-30 00:00 Tehran — «۷ شهریور تا ۷ آبان».
    stats.mockResolvedValueOnce({
      ...BASE,
      range: 'between',
      startMs: Date.UTC(2026, 7, 28, 20, 30),
      endMs: Date.UTC(2026, 9, 29, 20, 30),
    });
    draw();

    const window = (await screen.findByText('در این بازه')).closest('.card')!;
    expect(window.textContent).toContain('۷ شهریور');
    expect(window.textContent).toContain('۷ آبان');
    // The exclusive edge is 8 Aban; naming it means naming a day nobody chose.
    expect(window.textContent).not.toContain('۸ آبان');
  });

  it('offers two dates and sends both', async () => {
    draw();
    await screen.findByText('تعداد فروش');
    fireEvent.click(screen.getByRole('button', { name: 'بازهٔ دلخواه' }));

    await screen.findByLabelText('ماه از');
    fireEvent.change(screen.getByLabelText('ماه از'), { target: { value: '6' } });
    fireEvent.change(screen.getByLabelText('روز از'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('ماه تا'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('روز تا'), { target: { value: '7' } });

    // 7 Shahrivar 1405 → 2026-08-29, 7 Aban 1405 → 2026-10-29.
    await waitFor(() =>
      expect(stats).toHaveBeenCalledWith('between', '2026-08-29', '2026-10-29'),
    );
  });

  it('opens on a window that is not empty', async () => {
    draw();
    await screen.findByText('تعداد فروش');
    fireEvent.click(screen.getByRole('button', { name: 'بازهٔ دلخواه' }));

    // A custom range defaulting to today–today shows an empty screen and reads
    // as broken. Both edges must not be the same day on first open.
    await waitFor(() => {
      const call = stats.mock.calls.find((c) => c[0] === 'between');
      expect(call).toBeTruthy();
      expect(call![1]).not.toBe(call![2]);
    });
  });
});

describe('the exact figure under a compacted one', () => {
  it('appears when the compact form abbreviated', async () => {
    draw();
    const card = (await screen.findByText('جمع فروش')).closest('.stat-card')!;
    expect(card.textContent).toContain('میلیون ت');
    expect(card.textContent).toContain('۳۵۰٬۸۶۷٬۸۶۵ تومان');
  });

  it('is not repeated when the compact form printed every digit anyway', async () => {
    stats.mockResolvedValueOnce({ ...BASE, topupsIrr: 0 });
    draw();
    const card = (await screen.findByText('شارژ کیف پول')).closest('.stat-card')!;
    // It read «۰ ت» with «۰ تومان» underneath — the same number, twice.
    expect(card.textContent).not.toContain('تومان');
  });
});

describe('stocks are not drawn as if the period changed them', () => {
  it('puts them under their own heading that says «هم‌اکنون»', async () => {
    draw();
    expect(await screen.findByText('هم‌اکنون')).toBeTruthy();
    expect(
      screen.getByText(/موجودی‌اند، نه جریان/),
      'the heading has to say why these ignore the period',
    ).toBeTruthy();
  });

  it('quotes the debt in Toman, like every other figure on the panel', async () => {
    // It said «۱۱٬۰۰۰٬۰۰۰ ریال» once, on a panel where nothing else is Rial.
    // A tenfold unit change in a footnote is a misread waiting to happen.
    const withDebt = { ...BASE, walletDebtors: 2, walletOwedToShopIrr: 11_000_000 };
    stats.mockResolvedValueOnce(withDebt);
    draw();

    const wallets = (await screen.findByText('کیف پول مشتریان')).closest('.card')!;
    expect(wallets.textContent).toContain('۱٬۱۰۰٬۰۰۰ تومان');
    expect(wallets.textContent).not.toContain('ریال');
  });

  it('keeps the wallet out of the period section', async () => {
    draw();
    await screen.findByText('تعداد فروش');

    const flows = screen.getByText('در این بازه').closest('.card')!;
    const wallets = screen.getByText('کیف پول مشتریان').closest('.card')!;
    const stocks = screen.getByText('هم‌اکنون').closest('.card')!;

    expect(flows.textContent).not.toContain('جمع اعتبار مشتریان');
    expect(wallets.textContent).toContain('جمع اعتبار مشتریان');
    // The heading has to keep saying the period does not move it, now that the
    // figure lives under its own title rather than under «هم‌اکنون».
    expect(wallets.textContent).toContain('نه در بازهٔ انتخابی');
    expect(stocks.textContent).toContain('پنل‌ها');
    expect(stocks.textContent).toContain('نمایندگان');
  });
});

/**
 * The three questions Sam asked on 2026-08-30, in his words: «نمی‌دونم هزینه‌ها
 * چیه، درآمد چیه، مانده چقدره، چقدر پول داخل کیف پول مردم هست، کی بیشترین مقدار
 * رو داره». Every assertion below is one of them.
 */
describe('the books', () => {
  it('states revenue, costs and the difference before breaking any of them up', async () => {
    draw();
    const books = (await screen.findByText('دفتر فروشگاه')).closest('.card')!;
    for (const label of ['درآمد', 'هزینه‌ها', 'مانده']) {
      expect(books.textContent).toContain(label);
    }
  });

  /**
   * The arithmetic, asserted rather than trusted.
   *
   * 436.83 million Toman earned against 697.37 million of net adjustments is
   * **minus** 260.54 million. `expensesIrr` is stored negative, so the code
   * adds — and getting that backwards produces 1,134 million, a plausible
   * healthy figure with the wrong sign on two thirds of it. In a compacted
   * «میلیارد» that is invisible, which is why the wrong answer is named here
   * as well as the right one.
   */
  it('subtracts the costs instead of adding them', async () => {
    draw();
    const card = (await screen.findByText('مانده')).closest('.stat-card')!;
    expect(card.textContent).toContain('۲۶۰٫۵ میلیون ت');
    expect(card.textContent).not.toContain('میلیارد');
  });

  it('leaves wallet top-ups out of revenue, and says why on the screen', async () => {
    draw();
    const books = (await screen.findByText('دفتر فروشگاه')).closest('.card')!;
    // 350.87 + 82.55 + 3.42 = 436.83 crore Toman. The 12 million of top-ups is
    // not in it: counting money the customer has not spent yet reports it once
    // arriving and again when it buys something.
    expect(books.textContent).toContain('۴۳۶٫۸ میلیون ت');
    expect(books.textContent).toContain('دو بار می‌شمارد');
  });

  it('measures costs over the window it measures revenue over', async () => {
    // A month of revenue against a lifetime of costs is the arithmetic that had
    // the panel reporting «درآمد کل: −۶۱۶ میلیون». The route is asked for the
    // same window the stats route is.
    draw();
    await screen.findByText('تعداد فروش');
    fireEvent.click(screen.getByRole('button', { name: 'ماه جاری' }));

    await waitFor(() =>
      expect(revenueAdjustments).toHaveBeenCalledWith(
        expect.objectContaining({ range: 'month' }),
      ),
    );
  });

  it('tells a reader why the books are missing rather than showing an error', async () => {
    revenueAdjustments.mockRejectedValueOnce(new Error('forbidden'));
    draw();
    const books = (await screen.findByText('دفتر فروشگاه')).closest('.card')!;
    await waitFor(() => expect(books.textContent).toContain('دسترسی'));
    expect(screen.queryByText(/^forbidden$/)).toBeNull();
  });
});

describe('who holds the money', () => {
  it('lists the biggest wallets, largest first, asked of the server in that order', async () => {
    draw();
    await screen.findByText('کیف پول مشتریان');
    await waitFor(() =>
      expect(customers).toHaveBeenCalledWith(expect.objectContaining({ sort: 'balance' })),
    );

    const wallets = screen.getByText('کیف پول مشتریان').closest('.card')!;
    expect(wallets.textContent).toContain('@poyan_b');
    expect(wallets.textContent).toContain('۴٬۱۰۰٬۰۰۰ تومان');
  });

  it('shows the Telegram id for the customers who have no username', async () => {
    // 2,924 legacy rows store the literal 'NOT_USERNAME' and the import drops
    // it, so a dash in the name column is the common case rather than the odd
    // one — the id beside it is the only identifier that always exists.
    draw();
    const wallets = (await screen.findByText('کیف پول مشتریان')).closest('.card')!;
    await waitFor(() => expect(wallets.textContent).toContain('200100300'));
  });

  it('still shows the live services after a period with no sales at all', async () => {
    draw();
    await screen.findByText('تعداد فروش');
    fireEvent.click(screen.getByRole('button', { name: 'یک ساعت اخیر' }));

    await waitFor(() => {
      const stocks = screen.getByText('هم‌اکنون').closest('.card')!;
      // 4,932 live services, unchanged, while the hour sold nothing.
      expect(stocks.textContent).toContain('۴٬۹۳۲');
    });
  });
});

describe('what it refuses to invent', () => {
  it('names each uncounted figure with its reason, and shows no number for it', async () => {
    draw();
    await screen.findByText('تعداد فروش');

    const section = (await screen.findByText('آنچه این‌جا شمرده نمی‌شود')).closest('.card')!;
    expect(section.textContent).toContain('نمایندگان نوع N و N2');
    expect(section.textContent).toContain('اکانت‌های تست');
    expect(section.textContent).toContain('نه دو نوع');
    // The one thing that must never appear here.
    expect(section.textContent).not.toMatch(/[۰0]\s*(نفر|عدد)/);
  });
});

describe('the payment gateway table', () => {
  it('translates the method and shows both figures', async () => {
    draw();
    const row = (await screen.findByText('کارت به کارت')).closest('tr')!;
    expect(row.textContent).toContain('۵٬۳۵۲');
    expect(row.textContent).toContain('۹۶۶٬۲۵۸٬۰۱۸');
  });
});
