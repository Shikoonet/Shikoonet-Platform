/**
 * «برای چه کسانی» — choosing who hears an announcement, on the screen.
 *
 * The filter itself is the server's business and is tested there. What can only
 * be got wrong here is the number: an operator reads it, believes it, and
 * presses a button with no undo. So these are about the count and about the
 * button, and mostly about the moments when the count is NOT yet an answer.
 *
 * Two of those moments are easy to ship broken. «یک پنل مشخص» before a panel is
 * chosen is not an audience at all, and an audience just switched to has no
 * count yet — in both, a button that is still armed sends to whoever the last
 * number happened to describe.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BulkPage } from '../src/pages/BulkPage.js';

/** Every POST the screen made. */
let sent: { url: string; body: Record<string, unknown> }[] = [];
/** Every `/bulk/reach` the screen asked, in order, as a query string. */
let asked: string[] = [];
/** Held answers, when a test wants to look at the moment before one arrives. */
let holdReach: ((n: number) => void) | null = null;

/** What the server answers for each audience, so the screen cannot invent one. */
const REACH: Record<string, number> = {
  all: 15524,
  never_bought: 11037,
  service_ended: 196,
  'provider:7': 2288,
  'provider:9': 0,
};

beforeEach(() => {
  sent = [];
  asked = [];
  holdReach = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        sent.push({ url: u, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return { ok: true, status: 200, json: async () => ({ ok: true, queued: 1, reach: 1 }) } as Response;
      }
      if (u.includes('/bulk/reach')) {
        const q = new URL(u, 'https://x').searchParams;
        const kind = q.get('audience') ?? 'all';
        asked.push(kind === 'provider' ? `provider:${q.get('providerId')}` : kind);
        const answer = REACH[asked[asked.length - 1]!] ?? 0;
        if (holdReach !== null) {
          const wait = new Promise<number>((resolve) => {
            holdReach = resolve;
          });
          return { ok: true, status: 200, json: async () => ({ ok: true, reach: await wait }) } as Response;
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, reach: answer }) } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          reach: REACH['all'],
          credit: null,
          broadcast: null,
          items: [
            { id: 7, code: 'p7', name: 'سرویس تیتانیوم', kind: 'manual', status: 'ACTIVE', baseUrl: null, capacity: null, sortOrder: 1 },
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

function messageCard(): HTMLElement {
  return screen.getByText('پیام همگانی').closest('.card') as HTMLElement;
}

const go = () =>
  within(messageCard()).getByRole('button', { name: 'ادامه' }) as HTMLButtonElement;

async function open() {
  render(<BulkPage />);
  await screen.findByText('پیام همگانی');
  const box = within(messageCard()).getByLabelText('متن پیام') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: 'سلام' } });
  return within(messageCard()).getByLabelText('برای چه کسانی') as HTMLSelectElement;
}

describe('choosing who hears a broadcast', () => {
  it('shows the server’s count for the audience, not one of its own', async () => {
    const picker = await open();
    await waitFor(() => expect(within(messageCard()).getByText(/۱۵٬۵۲۴ نفر/)).toBeTruthy());

    fireEvent.change(picker, { target: { value: 'never_bought' } });
    await waitFor(() => expect(within(messageCard()).getByText(/۱۱٬۰۳۷ نفر/)).toBeTruthy());
    expect(asked).toContain('never_bought');

    fireEvent.change(picker, { target: { value: 'service_ended' } });
    await waitFor(() => expect(within(messageCard()).getByText(/۱۹۶ نفر/)).toBeTruthy());
  });

  /**
   * «یک پنل مشخص» with no panel picked yet. If the button stayed armed here it
   * would send to whoever the PREVIOUS count described, under the new label.
   */
  it('will not send to a panel audience before a panel is chosen', async () => {
    const picker = await open();
    await waitFor(() => expect(go().disabled).toBe(false));

    fireEvent.change(picker, { target: { value: 'provider' } });
    await waitFor(() => expect(go().disabled).toBe(true));
    expect(within(messageCard()).getByText(/اول پنل را انتخاب کنید/)).toBeTruthy();

    fireEvent.change(within(messageCard()).getByLabelText('پنل'), { target: { value: '7' } });
    await waitFor(() => expect(within(messageCard()).getByText(/۲٬۲۸۸ نفر/)).toBeTruthy());
    expect(go().disabled).toBe(false);
    expect(asked).toContain('provider:7');
  });

  /**
   * An audience nobody is in. Queueing it would return zero and the screen
   * would say «در صف قرار گرفت» — a success sentence for a send that never
   * happened.
   */
  it('refuses an audience with nobody in it, and says so', async () => {
    const picker = await open();
    fireEvent.change(picker, { target: { value: 'provider' } });
    fireEvent.change(within(messageCard()).getByLabelText('پنل'), { target: { value: '9' } });

    await waitFor(() => expect(within(messageCard()).getByText(/هیچ‌کس در این گروه نیست/)).toBeTruthy());
    expect(go().disabled).toBe(true);
  });

  /**
   * The window between choosing an audience and the server answering.
   *
   * The count used to stay in state while the new one loaded, so the button
   * stayed armed and the confirmation put one audience's NAME beside another's
   * NUMBER. On the least reversible button in the project. Found by CodeRabbit
   * on PR #93.
   */
  it('will not send on a stale count while the new one is still loading', async () => {
    const picker = await open();
    await waitFor(() => expect(go().disabled).toBe(false));
    expect(within(messageCard()).getByText(/۱۵٬۵۲۴ نفر/)).toBeTruthy();

    // Now make the next answer arrive late, and switch audience.
    holdReach = () => undefined;
    fireEvent.change(picker, { target: { value: 'service_ended' } });

    // The old number is gone the moment the audience changes, not when the new
    // one lands — and the button is down until it does.
    await waitFor(() => expect(go().disabled).toBe(true));
    expect(within(messageCard()).queryByText(/۱۵٬۵۲۴ نفر/)).toBeNull();
    expect(within(messageCard()).getByText(/در حال شمردن/)).toBeTruthy();
  });

  it('sends the audience with the message, and names it on the confirmation', async () => {
    const picker = await open();
    fireEvent.change(picker, { target: { value: 'never_bought' } });
    await waitFor(() => expect(go().disabled).toBe(false));
    fireEvent.click(go());

    const confirm = screen.getByRole('group', { name: 'پیام همگانی فرستاده شود؟' });
    // The count and the audience together: either alone is a number without a
    // subject, or a subject without a size.
    expect(confirm.textContent).toContain('۱۱٬۰۳۷');
    expect(confirm.textContent).toContain('استارت زده و هیچ خریدی نکرده');

    fireEvent.click(within(confirm).getByRole('button', { name: 'تایید' }));
    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(sent[0]!.body['audience']).toEqual({ kind: 'never_bought' });
  });

  it('sends the panel by id when that is the audience', async () => {
    const picker = await open();
    fireEvent.change(picker, { target: { value: 'provider' } });
    fireEvent.change(within(messageCard()).getByLabelText('پنل'), { target: { value: '7' } });
    await waitFor(() => expect(go().disabled).toBe(false));
    fireEvent.click(go());
    fireEvent.click(
      within(screen.getByRole('group', { name: 'پیام همگانی فرستاده شود؟' })).getByRole('button', {
        name: 'تایید',
      }),
    );

    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(sent[0]!.body['audience']).toEqual({ kind: 'provider', providerId: 7 });
  });

  it('still defaults to everybody, which is what it did before', async () => {
    await open();
    await waitFor(() => expect(go().disabled).toBe(false));
    fireEvent.click(go());
    fireEvent.click(
      within(screen.getByRole('group', { name: 'پیام همگانی فرستاده شود؟' })).getByRole('button', {
        name: 'تایید',
      }),
    );

    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(sent[0]!.body['audience']).toEqual({ kind: 'all' });
  });
});
