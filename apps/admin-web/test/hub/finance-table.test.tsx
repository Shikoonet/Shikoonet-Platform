/**
 * «حساب‌ها و کارت‌ها» — the table that replaced two blocks on «آمار مالی»
 * (Sam, 2026-09-12: «مثل یک مدیر مالی به من اطلاعات درست بده»).
 *
 * Three things the old «توازن کارت‌ها» panel was tested for are carried over
 * unchanged — an unmapped card still shows with its money, a label never says
 * the same thing twice, and a reason is Persian — and three are new: a card
 * sits under its account, every row carries the ربات/دستی split, and the total
 * row is the server's total rather than a sum of what happens to be listed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { createCache } from '../../src/hub/query.js';
import { FinanceTable } from '../../src/hub/financeTable.js';

function card(over: Record<string, unknown>) {
  return {
    cardDigits: '6037000000000095',
    cardMasked: '****0095',
    displayWeight: 1,
    accountId: 'acc-1',
    displayName: 'حساب ملی',
    ownerLabel: null,
    accountHint: '6006',
    accountStatus: 'ACTIVE',
    purchaseCount: 2,
    verifiedCount: 2,
    takingsIrr: 3_000_000,
    botCount: 1,
    botAmountIrr: 1_000_000,
    manualCount: 1,
    manualAmountIrr: 2_000_000,
    uniqueCustomers: 2,
    activity: { h12: 0, h24: 1 },
    cardStatus: 'ACTIVE',
    hubEligible: true,
    exclusionReason: 'hub_active',
    purchaseBarPercent: 100,
    ...over,
  };
}

const CARDS = {
  ok: true,
  range: 'all',
  entity: 'card_number',
  metric: 'hub_verified_purchases',
  note: 'یادداشت',
  windows: [],
  distribution: { min: 0, max: 2, gap: 2 },
  items: [
    card({}),
    card({
      cardDigits: '6104999988887777',
      cardMasked: '****7777',
      accountId: null,
      displayName: 'کارت نگاشت‌نشده',
      accountHint: null,
      accountStatus: 'UNMAPPED',
      cardStatus: 'UNMAPPED',
      purchaseCount: 0,
      verifiedCount: 1,
      takingsIrr: 5_000_000,
      botCount: 0,
      botAmountIrr: 0,
      manualCount: 1,
      manualAmountIrr: 5_000_000,
      hubEligible: false,
      exclusionReason: 'card_not_mapped',
      purchaseBarPercent: 0,
    }),
    card({
      cardDigits: '5054161706275678',
      cardMasked: '****5678',
      hubEligible: false,
      exclusionReason: 'account_deactivated',
      purchaseCount: 0,
      takingsIrr: 0,
      verifiedCount: 0,
      botCount: 0,
      botAmountIrr: 0,
      manualCount: 0,
      manualAmountIrr: 0,
      uniqueCustomers: 0,
      purchaseBarPercent: 0,
    }),
  ],
};

const ACCOUNTS = {
  ok: true,
  range: 'all',
  totals: { totalKnownBalanceIrr: 12_000_000, knownAccounts: 1, totalActiveAccounts: 1 },
  distribution: { min: 1, average: 1, max: 1, uneven: false },
  items: [
    {
      accountId: 'acc-1',
      displayName: 'حساب ملی',
      ownerLabel: 'پویان',
      bankName: 'ملی',
      accountHint: '6006',
      status: 'ACTIVE',
      mappedCards: 2,
      currentBalanceIrr: 12_000_000,
      balanceAsOf: 1,
      balanceFreshness: 'fresh',
      purchaseCount: 2,
      salesCount: 2,
      salesAmountIrr: 3_000_000,
      botCount: 1,
      botAmountIrr: 1_000_000,
      manualCount: 1,
      manualAmountIrr: 2_000_000,
      bankInflowIrr: 9_000_000,
      bankInflowCount: 4,
      unassignedIncomeIrr: 1_000_000,
      unassignedIncomeCount: 1,
      resellerAmountIrr: 5_000_000,
      resellerCount: 1,
      purchaseBarPercent: 100,
    },
  ],
};

// The server's totals — deliberately NOT the sum of the rows above, so a
// footer that added the rows up would be caught.
const ANALYTICS = {
  ok: true,
  range: 'all' as const,
  sales: {
    count: 7,
    amountIrr: 70_000_000,
    amountChange: { kind: 'change' as const, percent: 3 },
    countChange: { kind: 'change' as const, percent: 3 },
  },
  botAutoVerified: { count: 4, amountIrr: 40_000_000 },
  manualVerified: { count: 3, amountIrr: 30_000_000 },
  bankInflowIrr: 99_000_000,
  reseller: { count: 2, amountIrr: 20_000_000 },
  unassignedIncome: { count: 1, amountIrr: 9_000_000 },
  balances: { totalKnownIrr: 12_000_000, knownAccounts: 1, totalActiveAccounts: 1 },
  trend: [],
};

beforeEach(() => {
  globalThis.fetch = vi.fn().mockImplementation(async (input: string) => {
    const url = String(input);
    const body = url.includes('/cards/analytics') ? CARDS : ACCOUNTS;
    return new Response(JSON.stringify(body), { status: 200 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const draw = () =>
  render(
    <FinanceTable cache={createCache()} rangeState={{ preset: 'all' }} analytics={ANALYTICS} />,
  );

describe('the accounts-and-cards table', () => {
  it('puts a card under its account, and an unmapped card in its own group', async () => {
    draw();
    const rows = (await screen.findAllByRole('row')).map((r) => r.textContent ?? '');
    const account = rows.findIndex((t) => t.includes('**** 6006 · پویان'));
    const mapped = rows.findIndex((t) => t.includes('****0095'));
    const orphanHead = rows.findIndex((t) => t.includes('کارت‌های نگاشت‌نشده'));
    const orphan = rows.findIndex((t) => t.includes('****7777'));
    expect(account).toBeGreaterThan(0);
    expect(mapped).toBe(account + 1);
    expect(orphanHead).toBeGreaterThan(mapped);
    expect(orphan).toBe(orphanHead + 1);
  });

  it('gives every row the money split by who verified it', async () => {
    draw();
    const account = (await screen.findByText('**** 6006 · پویان')).closest('tr')!;
    const cells = within(account).getAllByRole('cell').map((c) => c.textContent);
    // واریز بانکی · فروش · ربات · دستی · نمایندگی · تخصیص‌نیافته · موجودی
    expect(cells[0]).toContain('۹۰۰٬۰۰۰ تومان');
    expect(cells[0]).toContain('۴ تراکنش');
    expect(cells[2]).toContain('۱۰۰٬۰۰۰ تومان');
    expect(cells[3]).toContain('۲۰۰٬۰۰۰ تومان');
    expect(cells[4]).toContain('۵۰۰٬۰۰۰ تومان');

    const mapped = screen.getByText('****0095').closest('tr')!;
    const cardCells = within(mapped).getAllByRole('cell').map((c) => c.textContent);
    expect(cardCells[1]).toContain('۳۰۰٬۰۰۰ تومان');
    expect(cardCells[2]).toContain('۱۰۰٬۰۰۰ تومان');
    expect(cardCells[3]).toContain('۲۰۰٬۰۰۰ تومان');
    // The bank names the account, not the card — the cell says so instead of
    // printing a zero that would read as «no reseller money here».
    expect(cardCells[4]).toBe('—');
  });

  it('takes the total row from the server, not from the rows it lists', async () => {
    draw();
    const total = (await screen.findByText('جمع همه')).closest('tr')!;
    const cells = within(total).getAllByRole('cell').map((c) => c.textContent);
    expect(cells[0]).toContain('۹٬۹۰۰٬۰۰۰ تومان');
    expect(cells[1]).toContain('۷٬۰۰۰٬۰۰۰ تومان');
    expect(cells[1]).toContain('۷ تراکنش');
    expect(cells[2]).toContain('۴٬۰۰۰٬۰۰۰ تومان');
    expect(cells[3]).toContain('۳٬۰۰۰٬۰۰۰ تومان');
    expect(cells[4]).toContain('۲٬۰۰۰٬۰۰۰ تومان');
  });

  it('lists a card the table no longer has, with the money that went to it', async () => {
    draw();
    const orphan = (await screen.findByText('****7777')).closest('tr')!;
    expect(orphan.textContent).toContain('۵۰۰٬۰۰۰ تومان');
    expect(within(orphan).getByText('کنار گذاشته‌شده')).toBeTruthy();
  });

  it('says why a card is out in Persian, never in the API’s own words', async () => {
    draw();
    const out = (await screen.findByText('****5678')).closest('tr')!;
    expect(within(out).getByText('کنار گذاشته‌شده').getAttribute('title')).toBe(
      'حساب این کارت غیرفعال شده است',
    );
    expect(screen.getByText('این کارت دیگر در فهرست کارت‌ها نیست — پولش این‌جاست، خودش نه')).toBeTruthy();
    expect(screen.queryByText(/card_not_mapped|account_deactivated/)).toBeNull();
    // A card in rotation wears no tag at all — the tag is the exception.
    const ok = screen.getByText('****0095').closest('tr')!;
    expect(within(ok).queryByText('کنار گذاشته‌شده')).toBeNull();
  });

  it('keeps the balance gap as one sentence, without the six window columns', async () => {
    draw();
    expect(await screen.findByText(/فاصلهٔ پرکارترین تا کم‌کارترین کارتِ در گردش: ۲ فروش/)).toBeTruthy();
    expect(screen.queryByText('۱۲ ساعت')).toBeNull();
    expect(screen.queryByText('۲۴ ساعت')).toBeNull();
  });
});
