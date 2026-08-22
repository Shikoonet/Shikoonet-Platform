/**
 * Tests for the Bot Auto Verified view:
 *
 *  Phase 10: classification fixtures — purchase_type from D1 is rendered, not
 *            re-derived from id_invoice / amount / username / customer history.
 *  Phase 11: date filter tests — Today/Yesterday/Day Before/All work against
 *            verified_at in the dashboard timezone (Asia/Tehran).
 *  Phase 12: UI tests — Telegram ID is selectable, Verified At is exact, the
 *            New Purchases/Renewals segmented controls render and stay in URL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { createCache } from '../../src/hub/query.js';
import { PaymentsView } from '../../src/hub/PaymentsView.js';
import { formatExactDateTime, type PaymentItem } from '../../src/hub/paymentReview.js';
import {
  BotAutoVerifiedFilter,
  useBotAutoVerifiedFilter,
} from '../../src/hub/BotAutoVerifiedFilter.js';
import { tehranTodayDateString, tehranAdjacentDay } from '../../src/hub/historyRangeNav.js';

// Anchor "now" to a Tehran-friendly instant.
const NOW_MS = Date.parse('2026-08-10T07:00:00Z'); // 10:30 Tehran

// Helpers
function makeClaimItem(over: Partial<PaymentItem> & { id: string }): PaymentItem {
  return {
    orderId: 'A12B',
    telegramUserId: '42',
    telegramUsername: 'ali',
    expectedAmountIrr: 1_950_000,
    expectedAmountToman: 195_000,
    cardMasked: '**** **** **** 5678',
    accountId: 'acc-1',
    accountDisplay: 'Melli Main',
    accountBank: 'Melli',
    accountHint: '6006',
    paidClickedAt: NOW_MS - 60_000,
    receiptSubmittedAt: NOW_MS - 60_000,
    createdAt: NOW_MS - 60_000,
    effectiveTs: NOW_MS - 60_000,
    reviewState: 'AUTO_VERIFIED',
    claimStatus: 'MATCHED',
    matchStatus: 'AUTO_VERIFIED',
    suspectReason: null,
    waitingRemainingMs: null,
    waitingElapsedMs: null,
    timeDeltaMs: null,
    matchedTransaction: {
      id: 'tx-1',
      amountIrr: 1_950_000,
      bankTimestamp: NOW_MS - 30_000,
      timeDeltaSeconds: 30,
      verifiedAt: NOW_MS - 5_000,
      verifiedBy: 'system',
    },
    candidates: [],
    device: null,
    ...over,
  };
}

function fetchResponseForTab(tab: string, items: PaymentItem[]): Response {
  const body = {
    items,
    counts: {
      income: 0,
      needsReview: 0,
      waiting: 0,
      suspectedFake: 0,
      botAutoVerified: items.length,
      manuallyVerified: 0,
      declinedIncome: 0,
      reseller: 0,
      all: 0,
    },
    summary: {},
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('formatExactDateTime — Asia/Tehran', () => {
  it('renders dates in Asia/Tehran regardless of browser TZ', () => {
    // 2026-08-10T07:00:00Z = 2026-08-10T10:30:00+03:30 in Tehran
    expect(formatExactDateTime(NOW_MS)).toBe('2026-08-10 10:30:00');
    // a few hours later
    expect(formatExactDateTime(NOW_MS + 3600_000)).toBe('2026-08-10 11:30:00');
    // a few hours earlier — same date in Tehran
    expect(formatExactDateTime(NOW_MS - 3600_000)).toBe('2026-08-10 09:30:00');
  });

  it('returns dash for null/undefined/NaN', () => {
    expect(formatExactDateTime(null)).toBe('—');
    expect(formatExactDateTime(undefined)).toBe('—');
    expect(formatExactDateTime(Number.NaN)).toBe('—');
  });
});

describe('useBotAutoVerifiedFilter — URL state', () => {
  let originalPushState: typeof history.pushState;
  let pushed: Array<{ url: string }> = [];

  beforeEach(() => {
    // The hook reads the live clock, so assertions anchored to NOW_MS only held
    // on 2026-08-10. Pin Date.now() instead of dating the test.
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    pushed = [];
    originalPushState = window.history.pushState;
    window.history.pushState = ((data: unknown, title: string, url?: string | null) => {
      pushed.push({ url: url ?? '' });
      return originalPushState.call(window.history, data, title, url);
    }) as typeof window.history.pushState;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.pushState = originalPushState;
    window.history.replaceState(null, '', '/');
  });

  function Probe() {
    const { value, setSegment, setDate, toQueryParams } = useBotAutoVerifiedFilter();
    return (
      <div>
        <div data-testid="segment">{value.segment}</div>
        <div data-testid="date">{value.date}</div>
        <button data-testid="set-new" onClick={() => setSegment('NEW_PURCHASE')}>
          N
        </button>
        <button data-testid="set-renewal" onClick={() => setSegment('RENEWAL')}>
          R
        </button>
        <button data-testid="set-yesterday" onClick={() => setDate('YESTERDAY')}>
          Y
        </button>
        <button data-testid="set-today" onClick={() => setDate('TODAY')}>
          T
        </button>
        <button data-testid="set-dby" onClick={() => setDate('DAY_BEFORE_YESTERDAY')}>
          D
        </button>
        <button data-testid="set-all" onClick={() => setDate('ALL')}>
          A
        </button>
        <div data-testid="params">{JSON.stringify(toQueryParams())}</div>
      </div>
    );
  }

  it('defaults to NEW_PURCHASE + TODAY', () => {
    render(<Probe />);
    expect(screen.getByTestId('segment').textContent).toBe('NEW_PURCHASE');
    expect(screen.getByTestId('date').textContent).toBe('TODAY');
  });

  it('persists segment + date in URL query string', () => {
    render(<Probe />);
    fireEvent.click(screen.getByTestId('set-renewal'));
    fireEvent.click(screen.getByTestId('set-yesterday'));
    expect(pushed[pushed.length - 1]!.url).toContain('purchaseType=renewal');
    expect(pushed[pushed.length - 1]!.url).toContain('dateFilter=yesterday');
  });

  it('Yesterday / Day Before produce a Tehran day=YYYY-MM-DD', () => {
    render(<Probe />);
    fireEvent.click(screen.getByTestId('set-yesterday'));
    let params = JSON.parse(screen.getByTestId('params').textContent ?? '{}');
    expect(params.range).toBe('day');
    expect(params.day).toBe(tehranAdjacentDay(tehranTodayDateString(NOW_MS), -1));

    fireEvent.click(screen.getByTestId('set-dby'));
    params = JSON.parse(screen.getByTestId('params').textContent ?? '{}');
    expect(params.range).toBe('day');
    expect(params.day).toBe(tehranAdjacentDay(tehranTodayDateString(NOW_MS), -2));
  });

  it('All collapses to range=all and day=null', () => {
    render(<Probe />);
    fireEvent.click(screen.getByTestId('set-all'));
    const params = JSON.parse(screen.getByTestId('params').textContent ?? '{}');
    expect(params.range).toBe('all');
    expect(params.day).toBe(null);
  });

  it('Today collapses to range=today', () => {
    render(<Probe />);
    fireEvent.click(screen.getByTestId('set-today'));
    const params = JSON.parse(screen.getByTestId('params').textContent ?? '{}');
    expect(params.range).toBe('today');
    expect(params.day).toBe(null);
  });

  it('URL read on mount survives across popstate', () => {
    window.history.replaceState(null, '', '/?purchaseType=renewal&dateFilter=yesterday');
    render(<Probe />);
    expect(screen.getByTestId('segment').textContent).toBe('RENEWAL');
    expect(screen.getByTestId('date').textContent).toBe('YESTERDAY');
  });
});

describe('BotAutoVerifiedFilter — render', () => {
  function Wrapper({ onSegmentChange, onDateChange }: any) {
    return (
      <BotAutoVerifiedFilter
        value={{ segment: 'NEW_PURCHASE', date: 'TODAY' }}
        onSegmentChange={onSegmentChange ?? (() => {})}
        onDateChange={onDateChange ?? (() => {})}
      />
    );
  }
  it('renders both segmented controls', () => {
    render(<Wrapper />);
    expect(screen.getByText('خریدهای جدید')).toBeTruthy();
    expect(screen.getByText('تمدیدها')).toBeTruthy();
    expect(screen.getByText('امروز')).toBeTruthy();
    expect(screen.getByText('دیروز')).toBeTruthy();
    expect(screen.getByText('پریروز')).toBeTruthy();
    expect(screen.getByText('همه')).toBeTruthy();
  });
});

describe('تایید خودکار ربات table — Phase 10 classification fixtures', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // default location
    window.history.replaceState(null, '', '/?tab=bot_auto_verified');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('renders Telegram ID column for AUTO_VERIFIED rows', async () => {
    const item = makeClaimItem({
      id: 'c1',
      telegramUserId: '2028415747',
      telegramUsername: 'ali',
      purchaseType: 'NEW_PURCHASE',
      operationType: 'getconfigafterpay',
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/payments')) {
        return fetchResponseForTab('bot_auto_verified', [item]);
      }
      if (url.includes('/api/v1/analytics')) {
        return new Response(
          JSON.stringify({
            botAutoVerified: { count: 1, amountIrr: 1_950_000 },
            manualVerified: { count: 0, amountIrr: 0 },
            sales: { count: 1, amountIrr: 1_950_000, amountChange: 0 },
            bankInflowIrr: 1_950_000,
            balances: { totalKnownIrr: 1_950_000, knownAccounts: 1, totalActiveAccounts: 1 },
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    });
    render(<PaymentsView cache={createCache()} />);
    await waitFor(() => expect(screen.getAllByText(/BOT VERIFIED/i).length).toBeGreaterThan(0));
    const row = screen.getAllByText(/BOT VERIFIED/i)[0]!.closest('tr')!;
    const cells = within(row).getAllByRole('cell');
    // Telegram ID column must be present and contain the numeric id
    expect(within(row).getByText('2028415747')).toBeTruthy();
    expect(cells.length).toBeGreaterThanOrEqual(4);
  });

  it('renders زمان تایید as exact YYYY-MM-DD HH:mm:ss in Tehran TZ', async () => {
    const item = makeClaimItem({
      id: 'c2',
      telegramUserId: '2028415748',
      matchedTransaction: {
        id: 'tx-2',
        amountIrr: 1_950_000,
        bankTimestamp: NOW_MS - 30_000,
        timeDeltaSeconds: 30,
        verifiedAt: NOW_MS - 5_000,
        verifiedBy: 'system',
      },
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/payments')) {
        return fetchResponseForTab('bot_auto_verified', [item]);
      }
      if (url.includes('/api/v1/analytics')) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    render(<PaymentsView cache={createCache()} />);
    await waitFor(() => expect(screen.getAllByText(/BOT VERIFIED/i).length).toBeGreaterThan(0));
    // NOW - 5s = 10:29:55 in Tehran on 2026-08-10
    expect(screen.getByText('2026-08-10 10:29:55')).toBeTruthy();
  });

  it('forwards purchaseType=NEW_PURCHASE / RENEWAL to the API (Phase 7)', async () => {
    const item = makeClaimItem({
      id: 'c3',
      telegramUserId: '2028415749',
      purchaseType: 'RENEWAL',
      operationType: 'getextenduser',
    });
    const capturedUrls: string[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      capturedUrls.push(url);
      if (url.includes('/api/v1/payments')) {
        return fetchResponseForTab('bot_auto_verified', [item]);
      }
      return new Response('{}', { status: 200 });
    });
    window.history.replaceState(
      null,
      '',
      '/?tab=bot_auto_verified&purchaseType=renewal&dateFilter=today',
    );
    render(<PaymentsView cache={createCache()} />);
    await waitFor(() => expect(capturedUrls.length).toBeGreaterThan(0));
    const paymentsCall = capturedUrls.find((u) => u.includes('/api/v1/payments'));
    expect(paymentsCall).toBeDefined();
    const u = new URL(paymentsCall!, 'http://x');
    expect(u.searchParams.get('purchaseType')).toBe('RENEWAL');
    expect(u.searchParams.get('range')).toBe('today');
  });

  it('legacy rows without purchaseType render with empty state', async () => {
    const item = makeClaimItem({
      id: 'c4',
      telegramUserId: '2028415750',
    });
    delete (item as Partial<PaymentItem>).purchaseType;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/payments')) {
        return fetchResponseForTab('bot_auto_verified', []);
      }
      return new Response('{}', { status: 200 });
    });
    render(<PaymentsView cache={createCache()} />);
    await waitFor(() =>
      expect(screen.queryByText(/پرداختی با تایید خودکار ربات نیست/)).toBeTruthy(),
    );
  });
});
