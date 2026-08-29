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
 * Covers Today and the <DeviceName /> component itself.
 *
 * It used to cover Suggested, Unmatched and the details modal too, through
 * `MatchesView`. That screen was deleted on 2026-08-16: no file under `src`
 * imported it and there was no tab for it in `App.tsx` — it was reachable only
 * from this test. The rule those cases asserted still holds and is still
 * asserted here, against the component and the screen that are actually
 * rendered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DeviceName } from '../../src/hub/DeviceName.js';
import { TodayView } from '../../src/hub/TodayView.js';
import { createCache } from '../../src/hub/query.js';
import { QK } from '../../src/hub/queries.js';

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
    const deviceHeader = await screen.findByText('دستگاه');
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
    // `.hub-card` since 2026-08-25, when the hub's own status-striped card
    // stopped answering to `.card` — a name the panel had already given to a
    // different component. `closest('.card')` returned null here and the
    // failure read as "container is not an Element", which is what a rename
    // looks like from inside `within()`.
    const card = screen.getByText('Poyan Android Phone').closest('.hub-card') as HTMLElement;
    expect(within(card).getByText('poyan-01')).toBeTruthy();
    expect(within(card).getByText('دستگاه')).toBeTruthy();
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
    expect(labels).toContain('نام دستگاه: صعودی');
    expect(labels).toContain('نام دستگاه: نزولی');
  });
});

// ---------------------------------------------------------------------------
// Matches: Suggested
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Matches: Unmatched — mobile sort, fallback, internal UUID never shown
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Polling preserves sort state
// ---------------------------------------------------------------------------

describe('Today sort state survives polling', () => {
  /*
   * This used to invalidate a cache nobody was rendering.
   *
   * `render(<TodayView cache={createCache()} />)` did not keep the cache it
   * made, and the line below built a SECOND one — through a ternary whose two
   * branches were identical — and invalidated that. No refetch ever happened.
   * With a `setTimeout(50)` in the middle, the test read the same rows twice
   * and called the second read «after the refetch».
   *
   * So its only live assertion was «one click sorts ascending», which the test
   * directly above already proves, and which depends on sort state left in
   * `sessionStorage` by that very test. That is the assertion that went red in
   * CI on 2026-08-29 while passing twelve times locally: the same code, the
   * same test, green on a re-run.
   *
   * Now the rendered cache is the invalidated one, the wait is for the second
   * fetch rather than for the clock, and the assertion is the invariant this
   * test is named after — the order does not change — rather than a direction
   * it has to guess at.
   */
  it('keeps the Device sort after a background refetch', async () => {
    wideMatchMedia();
    const items = [
      todayItem({ id: 'a', displayName: 'Alice Phone', deviceCode: 'alice-01' }),
      todayItem({ id: 'b', displayName: 'Bob Phone', deviceCode: 'bob-01' }),
    ];
    const fetchMock = vi.fn().mockResolvedValue(todayResponse(items));
    globalThis.fetch = fetchMock;
    const cache = createCache();
    render(<TodayView cache={cache} />);
    const deviceHeader = await screen.findByText('دستگاه');
    fireEvent.click(deviceHeader);

    const order = () =>
      Array.from(document.querySelector('tbody')!.querySelectorAll('tr')).map((r) =>
        r.textContent!.includes('Alice Phone') ? 'Alice' : 'Bob',
      );
    // Whichever way the click sorted — both directions are asserted by the
    // test above, and asserting one here made this depend on state that test
    // leaves behind.
    const before = order();
    expect(before).toHaveLength(2);
    expect(new Set(before).size).toBe(2);

    const callsBefore = fetchMock.mock.calls.length;
    cache.invalidate(QK.today);
    // Waiting for the refetch itself, not for a number of milliseconds. The
    // old wall-clock sleep would have passed even if the request never went.
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore));
    await waitFor(() => expect(order()).toEqual(before));
  });
});

// ---------------------------------------------------------------------------
// View Details modal includes both fields
// ---------------------------------------------------------------------------
