import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { act } from '@testing-library/react';
import { createCache, DASHBOARD_POLL_INTERVAL_MS } from '../../src/hub/query.js';
import { PaymentsView } from '../../src/hub/PaymentsView.js';
import type { PaymentsResponse } from '../../src/hub/paymentReview.js';

const COUNTS = {
  needsReview: 2,
  waiting: 3,
  suspectedFake: 1,
  // 2 + 3 + 1 — the three undecided states, which is what «در انتظار بررسی»
  // shows. Summed rather than picked, so the badge and the list cannot drift.
  open: 6,
  autoVerified: 10,
  botAutoVerified: 10,
  continuity: 4,
  continuityPending: 2,
  income: 4,
  manuallyVerified: 3,
  declinedIncome: 0,
  reseller: 2,
  all: 20,
};

// The response's own counts type, not `typeof COUNTS`. The literal above has no
// unread keys, so inferring from it made `botAutoVerifiedUnread: 5` a type error
// in a test that goes on to assert the badge reads «+5» — the field the UI reads
// was one the fixture was not allowed to set.
function mockPaymentsFetch(counts: PaymentsResponse['counts'] = COUNTS) {
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
  return within(screen.getByRole('tablist', { name: 'بخش‌های پرداخت' }));
}

function hubNav() {
  return within(screen.getByRole('navigation', { name: 'نماهای پرداخت' }));
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
    expect(await screen.findByRole('navigation', { name: 'نماهای پرداخت' })).toBeTruthy();
    expect(opsNav().getByRole('tab', { name: 'بررسی' })).toBeTruthy();
    expect(opsNav().getByRole('tab', { name: /نمایندگی/i })).toBeTruthy();
    expect(opsNav().getByRole('tab', { name: 'بایگانی' })).toBeTruthy();
  });

  it('shows item counts on every Review sub-tab when > 0', async () => {
    render(<PaymentsView cache={createCache()} />);
    const hub = await screen.findByRole('navigation', { name: 'نماهای پرداخت' });
    expect(within(hub).getByRole('tab', { name: /واریزی‌ها 4/i })).toBeTruthy();
    // One badge where there were three. The number is the sum, so an operator
    // learns whether there is work from a single glance instead of adding up
    // three tabs — and, more to the point, without a fourth population of
    // pending claims that belonged to none of them going uncounted.
    expect(within(hub).getByRole('tab', { name: /در انتظار بررسی 6/i })).toBeTruthy();
    expect(within(hub).getByRole('tab', { name: /حالت تداوم 4/i })).toBeTruthy();
    expect(within(hub).getByRole('tab', { name: /تایید خودکار ربات 10/i })).toBeTruthy();
    const reviewTab = opsNav().getByRole('tab', { name: 'بررسی' });
    // Only the two unreconciled Continuity rows add work to the primary badge;
    // reconciled history stays available in its tab without double-counting
    // rows that also belong to Bot Auto Verified.
    expect(reviewTab.textContent).toContain('22');
  });

  it('updates Review sub-tab counts on poll without reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });

    let counts = { ...COUNTS, open: 6 };
    mockPaymentsFetch(counts);

    const cache = createCache();
    render(<PaymentsView cache={cache} />);
    expect(await screen.findByRole('tab', { name: /در انتظار بررسی 6/i })).toBeTruthy();

    counts = { ...COUNTS, open: 7 };
    mockPaymentsFetch(counts);

    await act(async () => {
      vi.advanceTimersByTime(DASHBOARD_POLL_INTERVAL_MS);
    });
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /در انتظار بررسی 7/i })).toBeTruthy();
    });
  });

  it('opens Reseller directly from center tab', async () => {
    render(<PaymentsView cache={createCache()} />);
    fireEvent.click(await opsNav().findByRole('tab', { name: /نمایندگی/i }));
    expect(await screen.findByText('در این بازه پرداخت نمایندگی نیست.')).toBeTruthy();
  });

  it('selects Income from Review sub-nav (first tab)', async () => {
    render(<PaymentsView cache={createCache()} />);
    fireEvent.click(await hubNav().findByRole('tab', { name: /واریزی‌ها 4/i }));
    expect(await screen.findByText('در این بازه واریزی تخصیص‌نیافته‌ای نیست.')).toBeTruthy();
  });

  it('selects تایید دستی from Payments sub-nav', async () => {
    render(<PaymentsView cache={createCache()} />);
    fireEvent.click(await opsNav().findByRole('tab', { name: 'بایگانی' }));
    fireEvent.click(await hubNav().findByRole('tab', { name: /تایید دستی 3/i }));
    expect(await screen.findByText('در این بازه پرداختی با تایید دستی نیست.')).toBeTruthy();
  });

  it('selects تایید خودکار ربات from Review sub-nav', async () => {
    render(<PaymentsView cache={createCache()} />);
    fireEvent.click(await hubNav().findByRole('tab', { name: /تایید خودکار ربات 10/i }));
    expect(await screen.findByText('در این بازه پرداختی با تایید خودکار ربات نیست.')).toBeTruthy();
  });

  it('selects the separate حالت تداوم review tab', async () => {
    render(<PaymentsView cache={createCache()} />);
    fireEvent.click(await hubNav().findByRole('tab', { name: /حالت تداوم 4/i }));
    const pending = await screen.findByRole('region', { name: 'در انتظار تطبیق بانکی' });
    const history = screen.getByRole('region', { name: 'سابقه تطبیق‌شده' });
    expect(within(pending).getByText('موردی در انتظار تطبیق بانکی نیست.')).toBeTruthy();
    expect(within(history).getByText('در این بازه سابقه تطبیق‌شده‌ای نیست.')).toBeTruthy();
    expect(window.location.search).toContain('tab=continuity');
  });

  it('shows total and unread badges on تایید خودکار ربات sub-tab', async () => {
    mockPaymentsFetch({ ...COUNTS, botAutoVerified: 61, botAutoVerifiedUnread: 5 });
    render(<PaymentsView cache={createCache()} />);
    const tab = await screen.findByRole('tab', { name: /تایید خودکار ربات/i });
    expect(tab.textContent).toContain('61');
    expect(tab.textContent).toContain('+5');
  });

  it('keeps Review active when تایید خودکار ربات tab is selected', async () => {
    window.history.replaceState(null, '', '/?tab=bot_auto_verified');
    render(<PaymentsView cache={createCache()} />);
    const hub = await screen.findByRole('navigation', { name: 'نماهای پرداخت' });
    expect(opsNav().getByRole('tab', { name: 'بررسی' }).getAttribute('aria-selected')).toBe('true');
    expect(
      within(hub)
        .getByRole('tab', { name: /تایید خودکار ربات 10/i })
        .getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('does not show Income under Payments sub-nav', async () => {
    render(<PaymentsView cache={createCache()} />);
    fireEvent.click(await opsNav().findByRole('tab', { name: 'بایگانی' }));
    expect(screen.queryByRole('tab', { name: /واریزی‌ها/i })).toBeNull();
  });
});
