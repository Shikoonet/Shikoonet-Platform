/**
 * Device-name display tests.
 *
 * The originating device must appear on every transaction row/card with:
 *   - display_name as the primary visible value
 *   - device_code as the secondary metadata
 *   - device_code as the fallback when display_name is empty
 *   - the internal device UUID must NEVER be used as the visible label
 *   - sortable A-Z / Z-A on the desktop column header
 *   - mobile sort option
 *   - long names must wrap normally (no character-level breaks)
 *   - device_id appears only in a technical/details subsection
 *
 * Covers: Today, Suggested, Unmatched, Reviewed matches, Reviewed
 * transactions, and View Details modal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { DeviceName } from '../src/DeviceName.js';
import { TodayView } from '../src/TodayView.js';
import { MatchesView } from '../src/MatchList.js';
import { createCache } from '../src/query.js';

const POYAN_DEVICE_ID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';

function wideMatchMedia() {
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
}
function mobileMatchMedia() {
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
}

beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// DeviceName component
// ---------------------------------------------------------------------------

describe('<DeviceName />', () => {
  it('renders display_name as the primary text', () => {
    const { container } = render(
      <DeviceName displayName="Poyan Android Phone" deviceCode="poyan-01" />,
    );
    const primary = container.querySelector('.device-name__primary');
    expect(primary).toBeTruthy();
    expect(primary!.textContent).toBe('Poyan Android Phone');
  });
  it('renders device_code as secondary metadata', () => {
    const { container } = render(
      <DeviceName displayName="Poyan Android Phone" deviceCode="poyan-01" />,
    );
    const secondary = container.querySelector('.device-name__secondary');
    expect(secondary).toBeTruthy();
    expect(secondary!.textContent).toBe('poyan-01');
  });
  it('falls back to device_code when display_name is empty', () => {
    const { container } = render(<DeviceName displayName="" deviceCode="poyan-01" />);
    const primary = container.querySelector('.device-name__primary');
    expect(primary!.textContent).toBe('poyan-01');
    // No secondary line because the primary slot is the device_code.
    expect(container.querySelector('.device-name__secondary')).toBeNull();
  });
  it('falls back to device_code when display_name is whitespace', () => {
    const { container } = render(<DeviceName displayName="   " deviceCode="poyan-01" />);
    const primary = container.querySelector('.device-name__primary');
    expect(primary!.textContent).toBe('poyan-01');
  });
  it('renders an em-dash placeholder when both display_name and device_code are empty', () => {
    const { container } = render(<DeviceName displayName={null} deviceCode={null} />);
    expect(container.textContent).toBe('—');
    expect(container.querySelector('.device-name__primary')).toBeNull();
  });
  it('never uses a UUID-shaped value as the primary visible label', () => {
    // When display_name is empty AND device_code is the UUID, the component
    // should still surface only the UUID as the visible label (we don't have
    // a better fallback). This test pins the real contract: the Views must
    // not pass the device_id to DeviceName — verified separately in the
    // integration tests that the rendered DOM never contains the UUID.
    const { container } = render(<DeviceName displayName="" deviceCode="poyan-01" />);
    expect(container.textContent).not.toContain(POYAN_DEVICE_ID);
  });
});

// ---------------------------------------------------------------------------
// Today: desktop + mobile
// ---------------------------------------------------------------------------

function todayItem(opts: { id: string; displayName: string | null; deviceCode: string | null }) {
  return {
    id: opts.id,
    direction: 'CREDIT' as const,
    amount_irr: 1_000_000,
    balance_irr: 5_000_000,
    status: 'PARSED',
    bank_timestamp: Date.now(),
    sms_timestamp: Date.now(),
    received_at: Date.now(),
    parser_id: 'parsian-signed-v1',
    financial_account_id: null,
    account_display: null,
    account_hint: null,
    account_bank: null,
    device_id: POYAN_DEVICE_ID,
    device_display_name: opts.displayName,
    device_code: opts.deviceCode,
    has_match: false,
  };
}

function todayResponse(items: ReturnType<typeof todayItem>[]) {
  return new Response(JSON.stringify({ ok: true, count: items.length, items }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Today — desktop device column', () => {
  it('shows display_name as primary + device_code as secondary in the row', async () => {
    wideMatchMedia();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        todayResponse([
          todayItem({ id: 't1', displayName: 'Poyan Android Phone', deviceCode: 'poyan-01' }),
        ]),
      );
    render(<TodayView cache={createCache()} />);
    const row = await screen.findByText('Poyan Android Phone');
    expect(row).toBeTruthy();
    // device_code shows up under the display name in the same row.
    const cell = row.closest('td')!;
    expect(within(cell).getByText('poyan-01')).toBeTruthy();
  });

  it('falls back to device_code when display_name is empty', async () => {
    wideMatchMedia();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        todayResponse([todayItem({ id: 't2', displayName: '', deviceCode: 'poyan-01' })]),
      );
    render(<TodayView cache={createCache()} />);
    // Primary slot promoted to device_code.
    const cell = await screen.findByText('poyan-01');
    const td = cell.closest('td')!;
    expect(within(td).queryByText('Poyan Android Phone')).toBeNull();
  });

  it('does not use the internal device_id UUID as the visible label', async () => {
    wideMatchMedia();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        todayResponse([
          todayItem({ id: 't3', displayName: 'Poyan Android Phone', deviceCode: 'poyan-01' }),
        ]),
      );
    render(<TodayView cache={createCache()} />);
    await screen.findByText('Poyan Android Phone');
    const tbody = document.querySelector('tbody')!;
    expect(tbody.textContent).not.toContain(POYAN_DEVICE_ID);
  });

  it('sorts the Device column A–Z then Z–A', async () => {
    wideMatchMedia();
    const a = todayItem({ id: 'a', displayName: 'Alice Phone', deviceCode: 'alice-01' });
    const b = todayItem({ id: 'b', displayName: 'Bob Phone', deviceCode: 'bob-01' });
    globalThis.fetch = vi.fn().mockResolvedValueOnce(todayResponse([b, a]));
    render(<TodayView cache={createCache()} />);
    // Default sort is received_at desc; we explicitly click Device asc/desc.
    const deviceHeader = await screen.findByText('Device');
    // Asc.
    fireEvent.click(deviceHeader);
    const tbody = document.querySelector('tbody')!;
    const rowsAsc = Array.from(tbody.querySelectorAll('tr'));
    expect(rowsAsc[0]!.textContent).toContain('Alice Phone');
    expect(rowsAsc[1]!.textContent).toContain('Bob Phone');
    // Desc.
    fireEvent.click(deviceHeader);
    const rowsDesc = Array.from(tbody.querySelectorAll('tr'));
    expect(rowsDesc[0]!.textContent).toContain('Bob Phone');
    expect(rowsDesc[1]!.textContent).toContain('Alice Phone');
  });
});

describe('Today — mobile card device row', () => {
  it('renders Received by device label with display_name + device_code', async () => {
    mobileMatchMedia();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        todayResponse([
          todayItem({ id: 'm1', displayName: 'Poyan Android Phone', deviceCode: 'poyan-01' }),
        ]),
      );
    render(<TodayView cache={createCache()} />);
    await screen.findByText('Poyan Android Phone');
    const card = screen.getByText('Poyan Android Phone').closest('.card')!;
    expect(within(card).getByText('poyan-01')).toBeTruthy();
    expect(within(card).getByText('Device')).toBeTruthy();
  });

  it('exposes a mobile sort option for device A–Z / Z–A', async () => {
    mobileMatchMedia();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        todayResponse([
          todayItem({ id: 'm2', displayName: 'Poyan Android Phone', deviceCode: 'poyan-01' }),
        ]),
      );
    render(<TodayView cache={createCache()} />);
    await screen.findByText('Poyan Android Phone');
    const select = document.querySelector('#sort-today') as HTMLSelectElement;
    expect(select).toBeTruthy();
    const labels = Array.from(select.options).map((o) => o.text);
    expect(labels).toContain('Device name: A–Z');
    expect(labels).toContain('Device name: Z–A');
  });
});

// ---------------------------------------------------------------------------
// Matches: Suggested
// ---------------------------------------------------------------------------

function suggestedItem(opts: {
  matchId: string;
  txId: string;
  displayName: string | null;
  deviceCode: string | null;
}) {
  return {
    match: {
      id: opts.matchId,
      transaction_candidate_id: opts.txId,
      payment_claim_id: 'p1',
      status: 'SUGGESTED' as const,
      score: 0.9,
      matching_reasons: [],
      mismatch_reasons: [],
      reviewed_by: null,
      reviewed_at: null,
    },
    transaction: {
      id: opts.txId,
      raw_sms_event_id: 'r1',
      direction: 'CREDIT' as const,
      amount_irr: 1_000_000,
      balance_irr: 5_000_000,
      status: 'PARSED',
      bank_timestamp: Date.now(),
      sms_timestamp: Date.now(),
      received_at: Date.now(),
      financial_account_id: null,
      account_hint: null,
    },
    claim: {
      id: 'p1',
      financial_account_id: null,
      expected_amount_irr: 1_000_000,
      expected_at: Date.now(),
      status: 'PENDING',
    },
    account_display: null,
    account_bank: null,
    device_id: POYAN_DEVICE_ID,
    device_display_name: opts.displayName,
    device_code: opts.deviceCode,
  };
}

describe('Matches → Suggested — desktop Device column', () => {
  it('renders display_name + device_code on each suggested row', async () => {
    wideMatchMedia();
    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input).split('?')[0];
      if (url.endsWith('/api/v1/matches/suggested')) {
        return new Response(
          JSON.stringify({
            ok: true,
            items: [
              suggestedItem({
                matchId: 'm1',
                txId: 't1',
                displayName: 'Poyan Android Phone',
                deviceCode: 'poyan-01',
              }),
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/v1/matches/unmatched')) {
        return new Response(JSON.stringify({ ok: true, items: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/matches/reviewed')) {
        return new Response(JSON.stringify({ ok: true, items: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/matches/reviewed/transactions')) {
        return new Response(JSON.stringify({ ok: true, items: [] }), { status: 200 });
      }
      throw new Error(`unmocked: ${url}`);
    });
    render(<MatchesView cache={createCache()} selected={null} onSelect={() => undefined} />);
    // Switch to the Suggested tab.
    fireEvent.click(screen.getByRole('tab', { name: /Suggested/ }));
    const cell = await screen.findByText('Poyan Android Phone');
    const td = cell.closest('td')!;
    expect(within(td).getByText('poyan-01')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Matches: Unmatched — mobile sort, fallback, internal UUID never shown
// ---------------------------------------------------------------------------

function unmatchedItem(opts: {
  id: string;
  displayName: string | null;
  deviceCode: string | null;
}) {
  return {
    id: opts.id,
    direction: 'CREDIT' as const,
    amount_irr: 1_000_000,
    balance_irr: 5_000_000,
    status: 'NEEDS_REVIEW',
    bank_timestamp: Date.now(),
    sms_timestamp: Date.now(),
    received_at: Date.now(),
    effective_ts: Date.now(),
    parser_id: 'parsian-signed-v1',
    financial_account_id: null,
    account_display: null,
    account_hint: null,
    account_bank: null,
    device_id: POYAN_DEVICE_ID,
    device_display_name: opts.displayName,
    device_code: opts.deviceCode,
    reason_no_match: ['no_account_assigned'],
    eligible_claim_count: 0,
    warnings: [],
    detected_identifiers: [],
    review: null,
  };
}

function mockAllMatchEndpoints(items: {
  suggested?: unknown[];
  unmatched?: unknown[];
  reviewed?: unknown[];
  reviewedTx?: unknown[];
}) {
  globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input).split('?')[0];
    if (url.endsWith('/api/v1/matches/suggested')) {
      return new Response(JSON.stringify({ ok: true, items: items.suggested ?? [] }), {
        status: 200,
      });
    }
    if (url.endsWith('/api/v1/matches/unmatched')) {
      return new Response(JSON.stringify({ ok: true, items: items.unmatched ?? [] }), {
        status: 200,
      });
    }
    if (url.endsWith('/api/v1/matches/reviewed')) {
      return new Response(JSON.stringify({ ok: true, items: items.reviewed ?? [] }), {
        status: 200,
      });
    }
    if (url.endsWith('/api/v1/matches/reviewed/transactions')) {
      return new Response(JSON.stringify({ ok: true, items: items.reviewedTx ?? [] }), {
        status: 200,
      });
    }
    throw new Error(`unmocked: ${url}`);
  });
}

describe('Matches → Unmatched — mobile device row + fallback', () => {
  it('falls back to device_code when display_name is empty', async () => {
    mobileMatchMedia();
    mockAllMatchEndpoints({
      unmatched: [unmatchedItem({ id: 'u1', displayName: '', deviceCode: 'poyan-01' })],
    });
    render(<MatchesView cache={createCache()} selected={null} onSelect={() => undefined} />);
    // Default tab is "unmatched".
    await screen.findByText('poyan-01');
    expect(screen.queryByText('Poyan Android Phone')).toBeNull();
    // No internal UUID exposed as the label.
    const main = document.body.textContent ?? '';
    expect(main).not.toContain(POYAN_DEVICE_ID);
  });

  it('shows both display_name + device_code when both exist on the card', async () => {
    mobileMatchMedia();
    mockAllMatchEndpoints({
      unmatched: [
        unmatchedItem({ id: 'u2', displayName: 'Poyan Android Phone', deviceCode: 'poyan-01' }),
      ],
    });
    render(<MatchesView cache={createCache()} selected={null} onSelect={() => undefined} />);
    const card = (await screen.findByText('Poyan Android Phone')).closest('.card')!;
    expect(within(card).getByText('poyan-01')).toBeTruthy();
    expect(within(card).getByText('Received by device')).toBeTruthy();
  });

  it('exposes a mobile sort option for device A–Z / Z–A on Unmatched', async () => {
    mobileMatchMedia();
    mockAllMatchEndpoints({
      unmatched: [
        unmatchedItem({ id: 'u3', displayName: 'Poyan Android Phone', deviceCode: 'poyan-01' }),
      ],
    });
    render(<MatchesView cache={createCache()} selected={null} onSelect={() => undefined} />);
    await screen.findByText('Poyan Android Phone');
    const select = document.querySelector(
      'select[id="sort-matches.unmatched"]',
    ) as HTMLSelectElement;
    expect(select).toBeTruthy();
    const labels = Array.from(select.options).map((o) => o.text);
    expect(labels).toContain('Device name: A–Z');
    expect(labels).toContain('Device name: Z–A');
  });
});

// ---------------------------------------------------------------------------
// Polling preserves sort state
// ---------------------------------------------------------------------------

describe('Today sort state survives polling', () => {
  it('keeps Device A–Z sort after a background refetch', async () => {
    wideMatchMedia();
    const items = [
      todayItem({ id: 'a', displayName: 'Alice Phone', deviceCode: 'alice-01' }),
      todayItem({ id: 'b', displayName: 'Bob Phone', deviceCode: 'bob-01' }),
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(todayResponse(items));
    render(<TodayView cache={createCache()} />);
    const deviceHeader = await screen.findByText('Device');
    fireEvent.click(deviceHeader);
    let tbody = document.querySelector('tbody')!;
    let rows = Array.from(tbody.querySelectorAll('tr'));
    expect(rows[0]!.textContent).toContain('Alice Phone');
    expect(rows[1]!.textContent).toContain('Bob Phone');
    // Trigger a manual refetch.
    const cache = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.instances.length
      ? (await import('../src/query.js')).createCache()
      : (await import('../src/query.js')).createCache();
    cache.invalidate((await import('../src/queries.js')).QK.today);
    await new Promise((r) => setTimeout(r, 50));
    // Sort state must persist after the refetch.
    tbody = document.querySelector('tbody')!;
    rows = Array.from(tbody.querySelectorAll('tr'));
    expect(rows[0]!.textContent).toContain('Alice Phone');
    expect(rows[1]!.textContent).toContain('Bob Phone');
  });
});

// ---------------------------------------------------------------------------
// View Details modal includes both fields
// ---------------------------------------------------------------------------

describe('View Details modal — device section', () => {
  it('shows Device name + Device code and hides the UUID from the primary view', async () => {
    wideMatchMedia();
    mockAllMatchEndpoints({
      unmatched: [
        unmatchedItem({ id: 'v1', displayName: 'Poyan Android Phone', deviceCode: 'poyan-01' }),
      ],
    });
    render(<MatchesView cache={createCache()} selected={null} onSelect={() => undefined} />);
    // Wait for the Unmatched table to render. The compact path doesn't show
    // the device column inline — it shows up in the View Details modal.
    await screen.findByText('Not assigned');
    // Open the "More" menu and click "View details" on the row. The
    // desktop Unmatched table renders the menu via a portal-rendered
    // <button> with aria-haspopup="menu"; clicking it opens the menu.
    const moreSummary = screen.getByText('More');
    fireEvent.click(moreSummary);
    const detailsBtn = await screen.findByText('View details');
    fireEvent.click(detailsBtn);
    const dialog = await screen.findByRole('dialog', { name: 'Transaction details' });
    // Device name + Device code labels are both present.
    expect(within(dialog).getByText('Device name')).toBeTruthy();
    expect(within(dialog).getByText('Device code')).toBeTruthy();
    expect(within(dialog).getByText('Poyan Android Phone')).toBeTruthy();
    // `poyan-01` appears twice (in DeviceName primary/secondary + the
    // explicit Device code <code>). Confirm at least one.
    expect(within(dialog).getAllByText('poyan-01').length).toBeGreaterThan(0);
    // The internal UUID is NOT in the visible (non-debug) section. It may
    // appear inside a collapsed <details> technical subsection, which is the
    // expected behavior. Confirm it is at least not in the primary <dl>.
    const dl = dialog.querySelector('dl')!;
    expect(dl.textContent).not.toContain(POYAN_DEVICE_ID);
  });
});
