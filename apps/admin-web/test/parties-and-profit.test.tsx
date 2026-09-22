/**
 * «اشخاص» and «سود و زیان», rendered from the shapes the server sends.
 *
 * The arithmetic is the server's and is tested there
 * (`apps/dashboard-worker/test/people-and-profit.test.ts`). What is asked here
 * is what the two pages were built for: that «من چقدر گرفتم؟» is a column you
 * can read, that a draw is shown below the profit and never inside the costs,
 * and that a new person is sent with the roles and share that were ticked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PartiesPage } from '../src/pages/PartiesPage.js';
import { ProfitPage } from '../src/pages/ProfitPage.js';
import type { Party, ShopProfit } from '../src/api.js';

const PARTIES: Party[] = [
  {
    id: 1,
    name: 'حسام',
    roles: ['PARTNER'],
    sharePercent: 40,
    active: true,
    note: '',
    drawnIrr: 3_777_060_000,
    paidIrr: 0,
    receivedIrr: 0,
    rowCount: 9,
    lastOn: '2026-09-10',
  },
  {
    id: 2,
    name: 'هتزنر',
    roles: ['SUPPLIER'],
    sharePercent: null,
    active: true,
    note: 'سرور آلمان',
    drawnIrr: 0,
    paidIrr: 830_500_000,
    receivedIrr: 0,
    rowCount: 13,
    lastOn: '2026-09-01',
  },
];

const PROFIT: ShopProfit = {
  startMs: Date.UTC(2026, 7, 22, 20, 30),
  endMs: Date.UTC(2026, 8, 22, 20, 30),
  salesIrr: 65_000_000,
  revenueFixIrr: -1_000_000,
  manualIncomeIrr: 2_000_000,
  revenueIrr: 66_000_000,
  giftsIrr: 1_000_000,
  sharedGiftsIrr: 0,
  expensesIrr: 25_000_000,
  serviceExpensesIrr: 20_000_000,
  sharedExpensesIrr: 5_000_000,
  profitIrr: 40_000_000,
  drawsIrr: 30_000_000,
  retainedIrr: 10_000_000,
  services: [
    {
      productId: 3,
      name: 'الماس',
      categoryName: 'V2ray',
      revenueIrr: 40_000_000,
      expensesIrr: 15_000_000,
      giftsIrr: 1_000_000,
      profitIrr: 24_000_000,
      marginPercent: 60,
    },
    {
      productId: null,
      name: 'سفارش‌های قدیمی',
      categoryName: null,
      revenueIrr: 25_000_000,
      expensesIrr: 0,
      giftsIrr: 0,
      profitIrr: 25_000_000,
      marginPercent: 100,
    },
  ],
  unallocated: [],
  partners: [{ partyId: 1, name: 'حسام', sharePercent: 40, shareIrr: 16_000_000, drawnIrr: 30_000_000, balanceIrr: -14_000_000 }],
  undividedPercent: 60,
};

const parties = vi.fn(async () => ({ ok: true, items: PARTIES }));
const addParty = vi.fn(async (_b: unknown) => ({ ok: true, id: 9 }));
const shopProfit = vi.fn(async (_r: string, _d?: string, _t?: string) => ({ ok: true, ...PROFIT }));

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      parties: () => parties(),
      addParty: (b: unknown) => addParty(b),
      editParty: async () => ({ ok: true }),
      shopProfit: (r: string, d?: string, t?: string) => shopProfit(r, d, t),
    },
  };
});

beforeEach(() => {
  parties.mockClear();
  addParty.mockClear();
  shopProfit.mockClear();
});

describe('«اشخاص»', () => {
  it('shows what each person drew apart from what he was paid, and links to his rows', async () => {
    render(<PartiesPage />);
    const hesam = (await screen.findByText('حسام')).closest('tr')!;
    // 377,706,000 Toman drawn as a partner — the answer to «چقدر گرفته».
    expect(within(hesam).getByText(/۳۷۷٬۷۰۶٬۰۰۰/)).toBeTruthy();
    expect(within(hesam).getByText('ردیف‌ها').getAttribute('href')).toMatch(/expenses\?party=1$/);
    const host = screen.getByText('هتزنر').closest('tr')!;
    expect(within(host).getByText(/۸۳٬۰۵۰٬۰۰۰/)).toBeTruthy();
    expect(within(host).getByText('تأمین‌کننده')).toBeTruthy();
  });

  it('adds a person with the roles and share that were ticked', async () => {
    render(<PartiesPage />);
    fireEvent.click(await screen.findByText('شخص تازه'));
    fireEvent.change(screen.getByLabelText('نام'), { target: { value: 'سام' } });
    fireEvent.click(screen.getByLabelText('شریک'));
    fireEvent.change(screen.getByLabelText('سهم از سود (٪، اختیاری)'), { target: { value: '۳۳٫۳۴' } });
    fireEvent.click(screen.getByText('اضافه کن'));
    await waitFor(() => expect(addParty).toHaveBeenCalled());
    expect(addParty.mock.calls[0]![0]).toEqual({ name: 'سام', roles: ['PARTNER'], sharePercent: 33.34, note: '' });
  });
});

describe('«سود و زیان»', () => {
  it('puts the draws below the profit, never among the costs', async () => {
    render(<ProfitPage />);
    await screen.findByText('صورت سود و زیان');
    const rows = screen.getAllByRole('row').map((r) => r.textContent ?? '');
    // «سود» is its own bold line: 66M revenue − 1M gifts − 25M costs.
    expect(rows.find((t) => t.startsWith('سوددرآمد خالص منهای'))).toMatch(/۴٬۰۰۰٬۰۰۰/);
    const at = (label: string) => rows.findIndex((t) => t.startsWith(label));
    expect(at('برداشت شرکا')).toBeGreaterThan(at('سوددرآمد'));
    expect(at('برداشت شرکا')).toBeGreaterThan(at('هزینه‌های مشترک'));
    expect(at('ماندهٔ سود')).toBeGreaterThan(at('برداشت شرکا'));
    // The month by default — the question is «this month».
    expect(shopProfit.mock.calls[0]![0]).toBe('month');
  });

  it('shows each service’s profit and says the imported orders carry no costs', async () => {
    render(<ProfitPage />);
    const diamond = (await screen.findByText('الماس')).closest('tr')!;
    expect(within(diamond).getByText(/۲٬۴۰۰٬۰۰۰/)).toBeTruthy();
    expect(screen.getByText(/هزینه‌ای به آن‌ها وصل نیست/)).toBeTruthy();
  });

  it('says a partner took more than his share', async () => {
    render(<ProfitPage />);
    const row = (await screen.findAllByText('حسام')).at(-1)!.closest('tr')!;
    expect(within(row).getByText('بیشتر از سهمش برداشته')).toBeTruthy();
    expect(screen.getByText(/۶۰٪ از سود به کسی نسبت داده نشده/)).toBeTruthy();
  });
});
