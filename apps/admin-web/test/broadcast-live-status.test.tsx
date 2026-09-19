/**
 * The bar says WHY it is not moving, and the page says WHO was missed (#364).
 *
 * On 2026-09-17 the header bar sat on 12% for fifty minutes. Telegram had
 * asked for exactly that — a 429 with retry_after ≈ 3,000s — and nothing on
 * any screen said so. And «۸۰۰ نرسید» was a number with no names behind it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BroadcastProgress } from '../src/hub/BroadcastProgress.js';
import { BulkPage } from '../src/pages/BulkPage.js';

const NOW = Date.now();

function broadcast(progress: Record<string, unknown>) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    by: 'ops@example.com',
    at: NOW - 20 * 60_000,
    count: 16_000,
    amountIrr: null,
    progress: {
      total: 16_000,
      sent: 1_920,
      failed: 3,
      pending: 0,
      waiting: 0,
      waitingUntil: null,
      sending: 0,
      stranded: 0,
      sentLastMinute: 0,
      lastAt: NOW - 10_000,
      ...progress,
    },
  };
}

let recent: ReturnType<typeof broadcast> | null = null;
let failuresAsked = 0;

beforeEach(() => {
  failuresAsked = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/failures')) {
        failuresAsked += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            byKind: { blocked: 2, rate_limited: 1 },
            items: [
              { userId: 7, username: 'ali', kind: 'blocked', reason: 'Forbidden: bot was blocked by the user', attempts: 0 },
              { userId: 8, username: null, kind: 'blocked', reason: 'Forbidden: bot was blocked by the user', attempts: 0 },
              { userId: 9, username: 'sara', kind: 'rate_limited', reason: 'Too Many Requests: retry after 3000', attempts: 5 },
            ],
          }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, reach: 16_000, credit: null, broadcast: recent, items: [] }),
      } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the header bar', () => {
  it('says Telegram asked for the wait, and for how long', async () => {
    recent = broadcast({ waiting: 14_077, waitingUntil: NOW + 48 * 60_000 });
    render(<BroadcastProgress />);
    await screen.findByText(/تلگرام گفته صبر کنید/);
    expect(screen.getByRole('status').textContent).toContain('۴۸ دقیقه');
  });

  it('says so even while unclaimed rows remain — one 429 holds the whole queue', async () => {
    // What a real ban looks like: ONE row carries the deadline, the other
    // fourteen thousand are still PENDING, and the bot has been quiet for a
    // while. Before the fix this read as «ارسالی نمی‌رود».
    recent = broadcast({
      pending: 14_076,
      waiting: 1,
      waitingUntil: NOW + 30 * 60_000,
      lastAt: NOW - 95_000,
    });
    render(<BroadcastProgress />);
    await screen.findByText(/تلگرام گفته صبر کنید/);
    expect(screen.getByRole('status').textContent).toContain('۳۰ دقیقه');
  });

  it('says the bot has gone quiet rather than showing a frozen number', async () => {
    recent = broadcast({ pending: 14_077, lastAt: NOW - 95_000 });
    render(<BroadcastProgress />);
    await screen.findByText(/ارسالی نمی‌رود/);
    expect(screen.getByRole('status').textContent).toContain('ثانیه پیش');
  });

  it('names stranded rows as a restart mid-send', async () => {
    recent = broadcast({ pending: 14_000, stranded: 77 });
    render(<BroadcastProgress />);
    await screen.findByText(/۷۷ ردیف نیمه‌کاره/);
  });

  it('shows the pace as it is when everything is fine', async () => {
    recent = broadcast({ pending: 14_000, sentLastMinute: 29 });
    render(<BroadcastProgress />);
    await screen.findByText(/۲۹ در دقیقه/);
  });
});

describe('the bulk page', () => {
  it('lists who was missed and why, grouped, only when opened', async () => {
    recent = broadcast({ pending: 0, sent: 15_997, failed: 3 });
    render(<BulkPage />);
    const summary = await screen.findByText('۳ نرسید — کی و چرا');
    expect(failuresAsked).toBe(0);

    const details = summary.closest('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    // Twice, the way a browser can deliver it: the list is asked for once.
    fireEvent(details, new Event('toggle'));

    await waitFor(() => expect(failuresAsked).toBe(1));
    await screen.findByText('۲ ربات را بلاک کرده · ۱ تلگرام محدود کرد و ربات تسلیم شد');
    expect(screen.getByText('@ali')).toBeTruthy();
    expect(screen.getByText('#8')).toBeTruthy();
    expect(screen.getByText('Too Many Requests: retry after 3000')).toBeTruthy();
  });
});
