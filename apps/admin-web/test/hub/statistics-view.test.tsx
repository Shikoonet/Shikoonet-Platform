import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createCache } from '../../src/hub/query.js';
import { StatisticsView } from '../../src/hub/StatisticsView.js';

const ANALYTICS = {
  ok: true,
  range: 'all',
  sales: {
    count: 12,
    amountIrr: 24_000_000,
    amountChange: { kind: 'change', percent: 8.5 },
    countChange: { kind: 'change', percent: 5 },
  },
  botAutoVerified: { count: 10, amountIrr: 20_000_000 },
  manualVerified: { count: 2, amountIrr: 4_000_000 },
  bankInflowIrr: 50_000_000,
  reseller: { count: 3, amountIrr: 6_000_000 },
  unassignedIncome: { count: 5, amountIrr: 1_000_000 },
  balances: { totalKnownIrr: 100_000_000, knownAccounts: 4, totalActiveAccounts: 5 },
  trend: [
    { bucketStart: 1, label: 'Mon', salesCount: 4, salesAmountIrr: 8_000_000 },
    { bucketStart: 2, label: 'Tue', salesCount: 8, salesAmountIrr: 16_000_000 },
  ],
};

beforeEach(() => {
  globalThis.fetch = vi.fn().mockImplementation(async (input: string) => {
    const url = String(input);
    if (url.includes('/api/v1/analytics')) {
      return new Response(JSON.stringify(ANALYTICS), { status: 200 });
    }
    if (url.includes('/api/v1/payments')) {
      return new Response(
        JSON.stringify({
          ok: true,
          tab: 'needs_review',
          range: 'all',
          items: [],
          counts: {
            needsReview: 2,
            waiting: 3,
            suspectedFake: 1,
            income: 5,
            declinedIncome: 0,
            reseller: 3,
            all: 20,
          },
          summary: {
            range: 'all',
            bankIncomeIrr: 50_000_000,
            botAutoVerified: { payments: 10, amountIrr: 20_000_000 },
            reseller: { payments: 3, amountIrr: 6_000_000, activeResellers: 2 },
            unassignedIncome: { count: 5, amountIrr: 1_000_000 },
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes('/api/v1/accounts/analytics')) {
      return new Response(
        JSON.stringify({
          ok: true,
          range: 'all',
          totals: { totalKnownBalanceIrr: 100_000_000, knownAccounts: 4, totalActiveAccounts: 5 },
          distribution: { min: 1, average: 3, max: 5, uneven: false },
          items: [
            {
              accountId: 'acc-1',
              displayName: 'Melli Main',
              ownerLabel: 'Puyan',
              bankName: 'Melli',
              accountHint: '7613',
              status: 'ACTIVE',
              mappedCards: 1,
              currentBalanceIrr: 12_000_000,
              balanceAsOf: Date.now(),
              balanceFreshness: 'fresh',
              purchaseCount: 5,
              salesCount: 6,
              salesAmountIrr: 10_000_000,
              bankInflowIrr: 0,
              bankInflowCount: 0,
              unassignedIncomeIrr: 0,
              unassignedIncomeCount: 0,
              resellerAmountIrr: 0,
              resellerCount: 0,
              purchaseBarPercent: 100,
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes('/api/v1/cards/analytics')) {
      return new Response(
        JSON.stringify({
          ok: true,
          range: 'all',
          entity: 'card_number',
          metric: 'hub_auto_verified_purchases',
          note: 'diagnostic note',
          distribution: { min: 0, max: 5, gap: 5 },
          items: [
            {
              cardDigits: '5054161706277613',
              cardMasked: '****7613',
              accountId: 'acc-1',
              displayName: 'Melli Main',
              ownerLabel: 'Puyan',
              accountHint: '7613',
              accountStatus: 'ACTIVE',
              purchaseCount: 5,
              purchaseBarPercent: 100,
              hubEligible: true,
              exclusionReason: 'hub_active',
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ok: true, items: [] }), { status: 200 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StatisticsView', () => {
  it('shows three top metrics and sales trend', async () => {
    render(<StatisticsView cache={createCache()} />);
    expect(await screen.findByText('آمار مالی')).toBeTruthy();
    expect(await screen.findByText('موجودی کل')).toBeTruthy();
    expect(await screen.findByText('فروش ربات')).toBeTruthy();
    expect(await screen.findByText('فروش نمایندگی')).toBeTruthy();
    expect(await screen.findByText('روند فروش')).toBeTruthy();
    expect(screen.queryByText(/Open queues/i)).toBeNull();
    expect(screen.queryByText('Verification mix')).toBeNull();
  });

  it('shows simplified account usage rows', async () => {
    render(<StatisticsView cache={createCache()} />);
    expect(await screen.findByText('میزان استفاده از حساب‌ها')).toBeTruthy();
    expect(screen.getAllByText(/7613/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Puyan/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('۵ خرید').length).toBeGreaterThan(0);
    expect(screen.queryByText(/دستگاه/i)).toBeNull();
  });

  it('shows card balancing diagnostic panel', async () => {
    render(<StatisticsView cache={createCache()} />);
    expect(await screen.findByText('توازن کارت‌ها (تشخیصی)')).toBeTruthy();
    expect(screen.getByText(/فاصلهٔ بیشترین تا کمترین: ۵/)).toBeTruthy();
  });
});
