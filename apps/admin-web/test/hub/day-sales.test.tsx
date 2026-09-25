/**
 * «فروش امروز / دیروز / پریروز» on the bot-auto-verified tab.
 *
 * Pinned: the line asks «آمار فروشگاه» for exactly the day the chip names —
 * the Tehran day, computed the same way the list's own query is — and prints
 * the shop's earned total and its purchase / renewal split from that answer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { createCache } from '../../src/hub/query.js';
import { DaySalesMetrics } from '../../src/hub/paymentsComponents.js';

const STATS = {
  ok: true,
  earnedIrr: 12_500_000,
  salesCount: 3,
  salesIrr: 9_000_000,
  renewalsCount: 2,
  renewalsIrr: 3_500_000,
  addonsCount: 0,
  addonsIrr: 0,
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(STATS), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DaySalesMetrics', () => {
  it('asks for today and prints the total and its split', async () => {
    render(<DaySalesMetrics cache={createCache()} date="TODAY" range="today" day={null} />);
    await waitFor(() => expect(screen.getByText('۱٬۲۵۰٬۰۰۰', { exact: false })).toBeTruthy());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/v1/admin/stats?range=today');
    expect(screen.getByText('فروش امروز', { exact: false })).toBeTruthy();
    expect(screen.getByText('تمدید', { exact: false })).toBeTruthy();
    // No add-ons that day: the third term is left out rather than printed as 0.
    expect(screen.queryByText('افزودنی', { exact: false })).toBeNull();
  });

  it('asks for the named Tehran day for «دیروز»', async () => {
    render(
      <DaySalesMetrics cache={createCache()} date="YESTERDAY" range="day" day="2026-09-24" />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      '/api/v1/admin/stats?range=day&day=2026-09-24',
    );
    expect(screen.getByText('فروش دیروز', { exact: false })).toBeTruthy();
  });
});
