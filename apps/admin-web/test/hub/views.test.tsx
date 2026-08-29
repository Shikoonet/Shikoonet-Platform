/**
 * Tests for view rendering with the cache + responsive behavior.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { createCache } from '../../src/hub/query.js';
import { TodayView } from '../../src/hub/TodayView.js';
import { DevicesView } from '../../src/hub/DevicesView.js';

function mockFetchSequence(payloads: object[]) {
  let i = 0;
  globalThis.fetch = vi.fn().mockImplementation(async () => {
    const p = payloads[i++] ?? payloads[payloads.length - 1];
    return new Response(JSON.stringify(p), { status: 200 });
  });
}

describe('TodayView', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders mobile cards when viewport is narrow', async () => {
    // happy-dom default matchMedia returns matches:false; we want narrow.
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: q.includes('max-width: 639'),
      media: q,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
    mockFetchSequence([
      {
        ok: true,
        count: 1,
        items: [
          {
            id: 't1',
            direction: 'CREDIT',
            amount_irr: 100000,
            balance_irr: 500000,
            status: 'PARSED',
            bank_timestamp: 1700000000000,
            parser_id: 'p1',
            financial_account_id: null,
            account_display: null,
            account_hint: '3010',
            account_bank: 'PARSIAN',
            device_display_name: 'poyan-01',
            device_code: 'p1',
          },
        ],
      },
    ]);

    const cache = createCache();
    render(<TodayView cache={cache} />);
    await waitFor(() => screen.getByText(/۱۰٬۰۰۰ تومان/));
    expect(screen.getByText('poyan-01')).toBeTruthy();
    // Should be a list (cards) on mobile.
    expect(document.querySelector('ul.card-list')).toBeTruthy();
  });

  it('renders desktop table when viewport is wide', async () => {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: !q.includes('max-width: 639'),
      media: q,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
    mockFetchSequence([
      {
        ok: true,
        count: 1,
        items: [
          {
            id: 't2',
            direction: 'CREDIT',
            amount_irr: 200000,
            balance_irr: 600000,
            status: 'PARSED',
            bank_timestamp: 1700000000000,
            parser_id: 'p1',
            financial_account_id: null,
            account_display: null,
            account_hint: null,
            account_bank: 'GARDESHGARI',
            device_display_name: 'poyan-01',
            device_code: 'p1',
          },
        ],
      },
    ]);
    const cache = createCache();
    render(<TodayView cache={cache} />);
    // Amount cells show Toman (converted from stored IRR).
    await waitFor(() => screen.getByText('۲۰٬۰۰۰ تومان'));
    expect(document.querySelector('table.data-table')).toBeTruthy();
  });

  it('shows new-transaction banner for previously-unseen ids', async () => {
    const cache = createCache();
    mockFetchSequence([
      {
        ok: true,
        count: 1,
        items: [
          {
            id: 'fresh-id',
            direction: 'CREDIT',
            amount_irr: 100000,
            balance_irr: 0,
            status: 'PARSED',
            bank_timestamp: 1700000000000,
            parser_id: null,
            financial_account_id: null,
            account_display: null,
            account_hint: null,
            account_bank: null,
            device_display_name: null,
            device_code: null,
          },
        ],
      },
    ]);
    render(<TodayView cache={cache} />);
    await waitFor(() => screen.getByText(/تراکنش تازه رسید/));
    expect(screen.getByText(/خواندم/)).toBeTruthy();
  });

  it('shows session_expired error on 401', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    const cache = createCache();
    const { container } = render(<TodayView cache={cache} />);
    await waitFor(() => {
      expect(container.textContent).toMatch(/ناموفق بود|session_expired|تلاش دوباره/);
    });
  });
});

describe('DevicesView', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  function matchMediaAt(narrow: boolean) {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: narrow ? q.includes('max-width: 639') : !q.includes('max-width: 639'),
      media: q,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
  }

  function oneDevice() {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          items: [
            {
              id: 'd1',
              device_code: 'poyan-01',
              display_name: 'Poyan',
              active: 1,
              last_seen_at: 1700000000,
              last_success_at: 1700000000,
              last_auth_failure_at: null,
              created_at: 1690000000,
              updated_at: 1700000000,
            },
          ],
        }),
        { status: 200 },
      ),
    );
  }

  // These were two tests pinning two layouts: cards when narrow, a nine-column
  // `table.data-table` when wide. The wide one is gone deliberately — at panel
  // width those nine columns gave the name about fifty pixels and broke both
  // «Staging Device» and the action buttons mid-word. One layout now, and the
  // test says so at both widths rather than asserting the split it replaced.
  it.each([
    ['narrow', true],
    ['wide', false],
  ])('renders device cards at %s width, and never a table', async (_label, narrow) => {
    matchMediaAt(narrow as boolean);
    oneDevice();
    render(<DevicesView cache={createCache()} />);
    await waitFor(() => screen.getByText('Poyan'));
    expect(document.querySelector('ul.card-list')).toBeTruthy();
    expect(document.querySelector('table.data-table')).toBeNull();
  });
});
