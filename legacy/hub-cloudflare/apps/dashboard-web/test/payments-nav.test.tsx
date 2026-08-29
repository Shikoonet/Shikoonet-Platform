import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { act } from '@testing-library/react';
import { createCache, DASHBOARD_POLL_INTERVAL_MS } from '../src/query.js';
import { PaymentsView } from '../src/PaymentsView.js';

const COUNTS = {
  needsReview: 2,
  waiting: 3,
  suspectedFake: 1,
  autoVerified: 10,
  botAutoVerified: 10,
  income: 4,
  manuallyVerified: 3,
  declinedIncome: 0,
  reseller: 2,
  all: 20,
};

function mockPaymentsFetch(counts: typeof COUNTS = COUNTS) {
  globalThis.fetch = vi.fn().mockImplementation(async (input: string) => {
    const url = String(input);
    if (url.startsWith('/api/v1/analytics')) {
      return new Response(JSON.stringify({ ok: true, range: 'all' }), { status: 200 });
    }
    const tab = new URL(url, 'http://local').searchParams.get('tab') ?? 'needs_review';
    return new Response(
      JSON.stringify({
        ok: true,
        tab,
        range: 'all',
        items: [],
        counts,
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
  });
}

function opsNav() {
  return within(screen.getByRole('tablist', { name: 'Payment sections' }));
}

function hubNav() {
  return within(screen.getByRole('navigation', { name: 'Payment hub views' }));
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  mockPaymentsFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Payments grouped navigation', () => {
  it('shows Review, Reseller, and Payments controls', async () => {
    render(<PaymentsView cache={createCache()} />);
    expect(await screen.findByRole('navigation', { name: 'Payment hub views' })).toBeTruthy();
    expect(opsNav().getByRole('tab', { name: 'Review' })).toBeTruthy();
    expect(opsNav().getByRole('tab', { name: /Reseller/i })).toBeTruthy();
    expect(opsNav().getByRole('tab', { name: 'Payments' })).toBeTruthy();
  });

  it('shows item counts on every Review sub-tab when > 0', async () => {
    render(<PaymentsView cache={createCache()} />);
    const hub = await screen.findByRole('navigation', { name: 'Payment hub views' });
    expect(within(hub).getByRole('tab', { name: /Income 4/i })).toBeTruthy();
    expect(within(hub).getByRole('tab', { name: /Needs Review 2/i })).toBeTruthy();
    expect(within(hub).getByRole('tab', { name: /Waiting 3/i })).toBeTruthy();
    expect(within(hub).getByRole('tab', { name: /Suspected Fake 1/i })).toBeTruthy();
    expect(within(hub).getByRole('tab', { name: /Bot Auto Verified 10/i })).toBeTruthy();
    const reviewTab = opsNav().getByRole('tab', { name: 'Review' });
    expect(reviewTab.textContent).toContain('20');
  });

  it('updates Review sub-tab counts on poll without reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });

    let counts = { ...COUNTS, waiting: 3 };
    mockPaymentsFetch(counts);

    const cache = createCache();
    render(<PaymentsView cache={cache} />);
    expect(await screen.findByRole('tab', { name: /Waiting 3/i })).toBeTruthy();

    counts = { ...COUNTS, waiting: 4 };
    mockPaymentsFetch(counts);

    await act(async () => {
      vi.advanceTimersByTime(DASHBOARD_POLL_INTERVAL_MS);
    });
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Waiting 4/i })).toBeTruthy();
    });
  });

  it('opens Reseller directly from center tab', async () => {
    render(<PaymentsView cache={createCache()} />);
    fireEvent.click(await opsNav().findByRole('tab', { name: /Reseller/i }));
    expect(await screen.findByText('No reseller payments in this range.')).toBeTruthy();
  });

  it('selects Income from Review sub-nav (first tab)', async () => {
    render(<PaymentsView cache={createCache()} />);
    fireEvent.click(await hubNav().findByRole('tab', { name: /Income 4/i }));
    expect(await screen.findByText('No unassigned bank income in this range.')).toBeTruthy();
  });

  it('selects Manually Verified from Payments sub-nav', async () => {
    render(<PaymentsView cache={createCache()} />);
    fireEvent.click(await opsNav().findByRole('tab', { name: 'Payments' }));
    fireEvent.click(await hubNav().findByRole('tab', { name: /Manually Verified 3/i }));
    expect(await screen.findByText('No manually verified payments in this range.')).toBeTruthy();
  });

  it('selects Bot Auto Verified from Review sub-nav', async () => {
    render(<PaymentsView cache={createCache()} />);
    fireEvent.click(await hubNav().findByRole('tab', { name: /Bot Auto Verified 10/i }));
    expect(await screen.findByText('No bot auto-verified payments in this range.')).toBeTruthy();
  });

  it('shows total and unread badges on Bot Auto Verified sub-tab', async () => {
    mockPaymentsFetch({ ...COUNTS, botAutoVerified: 61, botAutoVerifiedUnread: 5 });
    render(<PaymentsView cache={createCache()} />);
    const tab = await screen.findByRole('tab', { name: /Bot Auto Verified/i });
    expect(tab.textContent).toContain('61');
    expect(tab.textContent).toContain('+5');
  });

  it('keeps Review active when Bot Auto Verified tab is selected', async () => {
    window.history.replaceState(null, '', '/?tab=bot_auto_verified');
    render(<PaymentsView cache={createCache()} />);
    const hub = await screen.findByRole('navigation', { name: 'Payment hub views' });
    expect(opsNav().getByRole('tab', { name: 'Review' }).getAttribute('aria-selected')).toBe('true');
    expect(within(hub).getByRole('tab', { name: /Bot Auto Verified 10/i }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('does not show Income under Payments sub-nav', async () => {
    render(<PaymentsView cache={createCache()} />);
    fireEvent.click(await opsNav().findByRole('tab', { name: 'Payments' }));
    expect(screen.queryByRole('tab', { name: /Income/i })).toBeNull();
  });
});
