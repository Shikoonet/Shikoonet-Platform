/**
 * «ریست سقف اکانت تست» on the bulk screen.
 *
 * Sam, 2026-09-16: an admin must be able to reset the trial counter for
 * everybody, for one group, or for one person. The card reuses the broadcast's
 * audience picker; what these tests pin is that the number it shows is the
 * server's count of customers who USED a trial (not the audience size), that
 * the button stays down while that count is zero, and that the reset sends the
 * audience it showed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BulkPage } from '../src/pages/BulkPage.js';

let sent: { url: string; body: Record<string, unknown> }[] = [];
const USED: Record<string, number> = { all: 15329, 'provider:9': 0, 'customer:111713193': 1 };

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if ((init?.method ?? 'GET') === 'POST') {
        sent.push({ url: u, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return { ok: true, status: 200, json: async () => ({ ok: true, reset: 3 }) } as Response;
      }
      if (u.includes('/bulk/trial-used')) {
        const q = new URL(u, 'https://x').searchParams;
        const kind = q.get('audience') ?? 'all';
        const key =
          kind === 'provider'
            ? `provider:${q.get('providerId')}`
            : kind === 'customer'
              ? `customer:${q.get('telegramId')}`
              : kind;
        return { ok: true, status: 200, json: async () => ({ ok: true, used: USED[key] ?? 0 }) } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          reach: 15524,
          credit: null,
          broadcast: null,
          items: [
            { id: 9, code: 'p9', name: 'پنل خالی', kind: 'manual', status: 'ACTIVE', baseUrl: null, capacity: null, sortOrder: 2 },
          ],
        }),
      } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function card(): HTMLElement {
  return screen.getByText('ریست سقف اکانت تست').closest('.card') as HTMLElement;
}

async function open() {
  render(<BulkPage />);
  await screen.findByText('ریست سقف اکانت تست');
  return within(card()).getByLabelText('برای چه کسانی') as HTMLSelectElement;
}

describe('resetting the trial quota', () => {
  it('shows how many in the audience have used a trial, and resets exactly that audience', async () => {
    const pick = await open();
    fireEvent.change(pick, { target: { value: 'all' } });
    await within(card()).findByText(/۱۵٬۳۲۹ نفر اکانت تست گرفته‌اند/);

    fireEvent.click(within(card()).getByRole('button', { name: 'ادامه' }));
    fireEvent.click(screen.getByRole('button', { name: 'تایید' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.url).toContain('/bulk/trial-reset');
    expect(sent[0]!.body).toEqual({ audience: { kind: 'all' } });
    await within(card()).findByText(/۳ مشتری صفر شد/);
  });

  it('keeps the button down while nobody in the audience has a trial to reset', async () => {
    const pick = await open();
    fireEvent.change(pick, { target: { value: 'provider' } });
    fireEvent.change(within(card()).getByLabelText('پنل'), { target: { value: '9' } });
    await within(card()).findByText(/کسی در این گروه اکانت تست نگرفته/);
    expect((within(card()).getByRole('button', { name: 'ادامه' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(sent).toHaveLength(0);
  });

  it('resets one customer by Telegram id', async () => {
    await open();
    // The card opens on «فقط یک مشتری» — the safe default for a button that
    // hands out free accounts.
    fireEvent.change(within(card()).getByLabelText('آی‌دی تلگرام مشتری'), {
      target: { value: '111713193' },
    });
    await within(card()).findByText(/۱ نفر اکانت تست گرفته‌اند/);
    fireEvent.click(within(card()).getByRole('button', { name: 'ادامه' }));
    fireEvent.click(screen.getByRole('button', { name: 'تایید' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toEqual({ audience: { kind: 'customer', telegramId: 111713193 } });
  });
});
