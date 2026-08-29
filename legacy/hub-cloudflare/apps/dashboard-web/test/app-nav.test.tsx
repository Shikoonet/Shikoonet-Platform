import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { App } from '../src/App.js';

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch() {
  globalThis.fetch = vi.fn().mockImplementation(async (input: string) => {
    const url = String(input);
    if (url.includes('/api/v1/payments')) {
      return new Response(
        JSON.stringify({
          ok: true,
          tab: 'needs_review',
          items: [],
          counts: {
            needsReview: 0,
            waiting: 0,
            suspectedFake: 0,
            autoVerified: 0,
            botAutoVerified: 0,
            income: 0,
            reseller: 0,
            all: 0,
          },
          summary: {
            range: 'all',
            bankIncomeIrr: 0,
            botAutoVerified: { payments: 0, amountIrr: 0 },
            reseller: { payments: 0, amountIrr: 0, activeResellers: 0 },
            unassignedIncome: { count: 0, amountIrr: 0 },
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes('/api/v1/analytics')) {
      return new Response(
        JSON.stringify({
          ok: true,
          range: 'all',
          sales: { amountIrr: 0, count: 0, amountChange: { kind: 'all_time' }, countChange: { kind: 'all_time' } },
          bankInflowIrr: 0,
          botAutoVerified: { count: 0, amountIrr: 0 },
          manualVerified: { count: 0, amountIrr: 0 },
          reseller: { count: 0, amountIrr: 0 },
          unassignedIncome: { count: 0, amountIrr: 0 },
          balances: { totalKnownIrr: 0, knownAccounts: 0, totalActiveAccounts: 0 },
          trend: [],
        }),
        { status: 200 },
      );
    }
    if (url.includes('/api/v1/accounts/analytics') || url.includes('/api/v1/cards/analytics')) {
      return new Response(
        JSON.stringify({
          ok: true,
          range: 'all',
          items: [],
          totals: { totalKnownBalanceIrr: 0, knownAccounts: 0, totalActiveAccounts: 0 },
          distribution: { gap: 0, max: 0, min: 0 },
          note: 'test',
        }),
        { status: 200 },
      );
    }
    if (url.includes('/api/v1/notifications/counts')) {
      return new Response(
        JSON.stringify({
          ok: true,
          counts: {
            unread: 3,
            incomeUnread: 2,
            botAutoVerifiedUnread: 1,
          },
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ok: true, items: [] }), { status: 200 });
  });
}

describe('App navigation', () => {
  it('shows payments ops nav on the payments workspace', async () => {
    mockFetch();
    render(<App />);
    const opsNav = await screen.findByRole('tablist', { name: 'Payment sections' });
    expect(within(opsNav).getByRole('tab', { name: 'Review' })).toBeTruthy();
    expect(within(opsNav).getByRole('tab', { name: /Reseller/i })).toBeTruthy();
    expect(within(opsNav).getByRole('tab', { name: 'Payments' })).toBeTruthy();
    expect(screen.getByText('SHIKOONET')).toBeTruthy();
    expect(screen.queryByRole('tablist', { name: 'Main sections' })).toBeNull();
  });

  it('shows main sections nav on non-payments views via operator menu', async () => {
    mockFetch();
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Operator menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Statistics' }));
    expect(await screen.findByRole('tablist', { name: 'Main sections' })).toBeTruthy();
    expect(screen.queryByRole('tablist', { name: 'Payment sections' })).toBeNull();
  });

  it('does not expose a separate Matches top-level tab', async () => {
    mockFetch();
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Operator menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Statistics' }));
    const mainNav = await screen.findByRole('tablist', { name: 'Main sections' });
    expect(within(mainNav).queryByRole('tab', { name: 'Matches' })).toBeNull();
    expect(within(mainNav).queryByRole('tab', { name: /Matches/i })).toBeNull();
  });
});
