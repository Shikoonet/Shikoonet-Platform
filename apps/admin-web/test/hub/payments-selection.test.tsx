import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createCache } from '../../src/hub/query.js';
import { PaymentsView } from '../../src/hub/PaymentsView.js';
import type { IncomeItem } from '../../src/hub/paymentReview.js';

const INCOME_ITEMS: IncomeItem[] = [
  {
    id: 'tx-1',
    amountIrr: 1_000_000,
    amountToman: 100_000,
    bankTimestamp: Date.now(),
    accountId: 'acc-1',
    accountDisplay: 'Main',
    accountBank: 'Melli',
    accountHint: '6006',
    reference: null,
    statusLabel: 'Unassigned income',
  },
  {
    id: 'tx-2',
    amountIrr: 2_000_000,
    amountToman: 200_000,
    bankTimestamp: Date.now(),
    accountId: 'acc-2',
    accountDisplay: 'Alt',
    accountBank: 'Saderat',
    accountHint: '7007',
    reference: null,
    statusLabel: 'Unassigned income',
  },
];

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  globalThis.fetch = vi.fn().mockImplementation(async (input: string) => {
    const url = String(input);
    if (url.includes('tab=income')) {
      return new Response(
        JSON.stringify({
          ok: true,
          tab: 'income',
          range: 'all',
          items: INCOME_ITEMS,
          incomeTotals: { count: 2, amountIrr: 3_000_000 },
          counts: {
            needsReview: 0,
            waiting: 0,
            suspectedFake: 0,
            autoVerified: 0,
            botAutoVerified: 0,
            income: 2,
            declinedIncome: 0,
            reseller: 0,
            all: 2,
          },
          summary: {
            range: 'all',
            bankIncomeIrr: 0,
            botAutoVerified: { payments: 0, amountIrr: 0 },
            reseller: { payments: 0, amountIrr: 0, activeResellers: 0 },
            unassignedIncome: { count: 2, amountIrr: 3_000_000 },
          },
        }),
        { status: 200 },
      );
    }
    const tab = new URL(url, 'http://local').searchParams.get('tab') ?? 'needs_review';
    return new Response(
      JSON.stringify({
        ok: true,
        tab,
        range: 'all',
        items: [],
        counts: {
          needsReview: 0,
          waiting: 0,
          suspectedFake: 0,
          autoVerified: 0,
          botAutoVerified: 0,
          income: 2,
          declinedIncome: 0,
          reseller: 0,
          all: 2,
        },
        summary: {
          range: 'all',
          bankIncomeIrr: 0,
          botAutoVerified: { payments: 0, amountIrr: 0 },
          reseller: { payments: 0, amountIrr: 0, activeResellers: 0 },
          unassignedIncome: { count: 2, amountIrr: 3_000_000 },
        },
      }),
      { status: 200 },
    );
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PaymentsView income selection', () => {
  it('supports header checkbox select-all without decline all', async () => {
    render(<PaymentsView cache={createCache()} />);
    fireEvent.click(await screen.findByRole('tab', { name: /Income 2/i }));
    expect(await screen.findByLabelText('Select all rows')).toBeTruthy();
    expect(screen.queryByText(/Decline all/i)).toBeNull();

    fireEvent.click(screen.getByLabelText('Select all rows'));
    expect(await screen.findByText('Decline selected (2)')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Select all rows'));
    await waitFor(() => {
      expect(screen.queryByText(/Decline selected/i)).toBeNull();
    });
  });
});
