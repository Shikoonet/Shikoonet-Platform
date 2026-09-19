/**
 * The coverage table must add up. 2026-09-19 on production it read «TourismBank
 * · همه ۷۲ · نام‌دار ۷۱» with nothing to explain the one, and «B.Pasargad ·
 * همه ۲ · نام‌دار ۰» under a «خوانده» badge: the filtered texts (OTP, promo,
 * purged) had no column and no word.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { BanksView } from '../../src/hub/BanksView.js';

const coverage = [
  { sender: 'TourismBank', total: 72, filtered: 1, named: 71, generic: 0, unread: 0, lastAt: 0, parsers: [{ parserId: 'gardeshgari-credit-v1', n: 72 }] },
  { sender: 'B.Pasargad', total: 2, filtered: 2, named: 0, generic: 0, unread: 0, lastAt: 0, parsers: [{ parserId: 'compact-signed-v1', n: 2 }] },
];

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/sms/reparse/dry-run')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, report: { days: 30, scanned: 0, candidates: [], stillUnread: 0 } }) } as Response;
      }
      const items = u.includes('/sms/coverage') ? coverage : [];
      return { ok: true, status: 200, json: async () => ({ ok: true, items }) } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the coverage table', () => {
  it('has a «فیلترشده» column, and a sender whose every text was filtered is not called «خوانده»', async () => {
    render(<BanksView />);
    const table = await screen.findByTestId('sms-coverage');
    expect(within(table).getByRole('columnheader', { name: 'فیلترشده' })).toBeTruthy();
    const rows = within(table).getAllByRole('row').slice(1);
    const tourism = rows.find((r) => r.textContent?.includes('TourismBank'))!;
    const cells = within(tourism).getAllByRole('cell').map((c) => c.textContent?.trim());
    // همه · نام‌دار · عمومی · بی‌ردیف · فیلترشده
    expect(cells.slice(1, 6)).toEqual(['۷۲', '۷۱', '—', '—', '۱']);
    expect(tourism.textContent).toContain('خوانده');
    const pasargad = rows.find((r) => r.textContent?.includes('B.Pasargad'))!;
    expect(pasargad.textContent).toContain('فیلترشده');
    expect(pasargad.textContent).not.toContain('خوانده');
  });

  it('a dry run over a full tab says there is nothing to read again, not «از ۰ پیامک، هیچ‌کدام»', async () => {
    render(<BanksView />);
    await screen.findByTestId('sms-coverage');
    fireEvent.click(screen.getByTestId('reparse-dry-run'));
    const report = await screen.findByTestId('reparse-report');
    expect(report.textContent).toContain('چیزی برای بازخوانی نیست');
    expect(report.textContent).not.toContain('۰ پیامک');
  });
});
