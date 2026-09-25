/**
 * «صف پیام همگانی» on the bulk page (Sam, 2026-09-25).
 *
 * Pinned: the message going is named as going and the next as waiting its
 * turn, the pace and the time left come from the last minute, the wait before
 * the queued one is what is left ahead of it at that pace, and «لغو» asks
 * first and then posts the cancel for exactly that broadcast.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BulkPage } from '../src/pages/BulkPage.js';

const GOING = {
  id: '11111111-1111-4111-8111-111111111111',
  preview: 'تخفیف پاییزه',
  post: null,
  by: 'sam@example.com',
  createdAt: Date.parse('2026-09-25T08:00:00Z'),
  cancelledAt: null,
  startedAt: Date.parse('2026-09-25T08:00:05Z'),
  total: 1000,
  sent: 400,
  failed: 0,
  cancelled: 0,
  sentLastMinute: 30,
};
const WAITING = {
  ...GOING,
  id: '22222222-2222-4222-8222-222222222222',
  preview: 'سرور جدید',
  startedAt: null,
  total: 500,
  sent: 0,
  sentLastMinute: 0,
};

let posts: string[] = [];

beforeEach(() => {
  posts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        posts.push(String(url));
        return { ok: true, status: 200, json: async () => ({ ok: true, notSent: 500 }) } as Response;
      }
      const items = String(url).endsWith('/bulk/queue') ? [GOING, WAITING] : [];
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, reach: 3, credit: null, broadcast: null, items }),
      } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the broadcast queue', () => {
  it('names what is going and what waits, with the pace and the times', async () => {
    render(<BulkPage />);
    const queue = (await screen.findByText('صف پیام همگانی')).closest(
      '.broadcast-queue',
    ) as HTMLElement;
    const [first, second] = within(queue).getAllByRole('listitem');

    expect(within(first!).getByText('در حال ارسال')).toBeTruthy();
    expect(first!.textContent).toContain('تخفیف پاییزه');
    // 400 of 1000, 30 a minute: 600 left is twenty minutes.
    expect(first!.textContent).toContain('۴۰۰ از ۱٬۰۰۰ نفر رسید');
    expect(first!.textContent).toContain('۳۰ در دقیقه');
    expect(first!.textContent).toContain('حدود ۲۰ دقیقه مانده');

    expect(within(second!).getByText('در صف — نوبت ۲')).toBeTruthy();
    // It starts when the 600 ahead of it are through.
    expect(second!.textContent).toContain('شروع حدود ۲۰ دقیقه دیگر');
  });

  it('asks before cancelling, then cancels that broadcast', async () => {
    render(<BulkPage />);
    const queue = (await screen.findByText('صف پیام همگانی')).closest(
      '.broadcast-queue',
    ) as HTMLElement;
    const second = within(queue).getAllByRole('listitem')[1]!;

    fireEvent.click(within(second).getByRole('button', { name: 'لغو' }));
    expect(posts).toEqual([]);
    const box = screen.getByRole('group', { name: 'این پیام همگانی لغو شود؟' });
    expect(box.textContent).toContain('۵۰۰');
    fireEvent.click(within(box).getByRole('button', { name: /تایید|بله|انجام/ }));

    await waitFor(() =>
      expect(posts).toEqual([`/api/v1/admin/bulk/broadcast/${WAITING.id}/cancel`]),
    );
  });
});
