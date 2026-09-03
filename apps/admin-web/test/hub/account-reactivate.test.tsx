/**
 * The way back from «غیرفعال‌کردن».
 *
 * Sam, 2026-09-03: «I have now disabled all of them, but there is no more
 * active button.» He was right — once `active` was 0 the row offered «حذف
 * همیشگی» and nothing else, so switching an account off was a one-way door
 * with a permanent delete at the end of it.
 *
 * `PATCH /api/v1/accounts/:id` had always accepted `{ active }` and the hub
 * client had always carried it. Only the button was missing, which is what
 * makes this a screen test and not a route one: the assertion is that the
 * button EXISTS on an inactive row, and that pressing it sends the one field
 * that turns the account back on.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccountsView } from '../../src/hub/AccountsView.js';
import { createCache } from '../../src/hub/query.js';

function account(over: Record<string, unknown> = {}) {
  return {
    id: 'acc-off',
    bank_name: 'MELLI',
    display_name: 'حساب خاموش',
    owner_label: null,
    account_type: 'CARD',
    account_hint: null,
    card_last_four: '0037',
    account_last_four: null,
    iban: null,
    device_id: null,
    active: 0,
    status: 'ACTIVE',
    parser_configuration: '{}',
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

/** Every write the screen sent, as `[method, url, parsedBody]`. */
let sent: [string, string, Record<string, unknown>][] = [];
let rows: Record<string, unknown>[] = [];

beforeEach(() => {
  sent = [];
  rows = [account()];
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        sent.push([method, String(url), init?.body ? JSON.parse(String(init.body)) : {}]);
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, items: rows, totals: {}, accounts: rows }),
      } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('an account that has been switched off', () => {
  it('offers a way back, not only a permanent delete', async () => {
    render(<AccountsView cache={createCache()} />);

    // The button that did not exist. Found by name, because the bug was that a
    // press had nowhere to land — not that a handler was wrong.
    const back = await screen.findAllByRole('button', { name: 'فعال‌کردن' });
    expect(back.length).toBeGreaterThan(0);
    // And the irreversible one is still there, beside it rather than instead.
    expect(screen.getAllByRole('button', { name: 'حذف همیشگی' }).length).toBeGreaterThan(0);
  });

  it('turns it back on with the one field that does it', async () => {
    render(<AccountsView cache={createCache()} />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'فعال‌کردن' }))[0]!);

    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    const [method, url, body] = sent[0]!;
    expect(method).toBe('PATCH');
    expect(url).toContain('/api/v1/accounts/acc-off');
    expect(body).toEqual({ active: true });
  });

  /**
   * Turning an account back on is what lets the bot hand customers its cards
   * again — that is the half an operator is deciding, and the question has to
   * say so rather than name the column.
   */
  it('asks first, and the question names what comes back', async () => {
    render(<AccountsView cache={createCache()} />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'فعال‌کردن' }))[0]!);

    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    const asked = vi.mocked(window.confirm).mock.calls[0]![0] as string;
    expect(asked).toContain('حساب خاموش');
    expect(asked).toContain('کارت');
  });

  it('leaves a live account alone — it still only offers the way out', async () => {
    rows = [account({ id: 'acc-on', display_name: 'حساب زنده', active: 1 })];

    render(<AccountsView cache={createCache()} />);

    await screen.findAllByRole('button', { name: 'غیرفعال‌کردن' });
    expect(screen.queryByRole('button', { name: 'فعال‌کردن' })).toBeNull();
  });
});
