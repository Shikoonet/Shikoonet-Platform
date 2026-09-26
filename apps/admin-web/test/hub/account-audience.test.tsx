/**
 * «کارت‌ها برای» — the three-way audience of an account's cards (0104).
 *
 * `customer_visible` was an on/off, and the switch sent `!on`. With a third
 * value that is a trap: «on» for a reseller-only account (2) is `true`, so one
 * click sent «off», and the next sent `1` — reseller cards on a customer's
 * invoice. The control now sends the number that was chosen, and these tests
 * pin that no press can arrive at 1 from 2 without the operator choosing 1.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccountsView } from '../../src/hub/AccountsView.js';
import { createCache } from '../../src/hub/query.js';
import { RoleProvider } from '../../src/role.js';

function account(over: Record<string, unknown> = {}) {
  return {
    id: 'acc-r',
    bank_name: 'MELLI',
    display_name: 'حساب نماینده',
    owner_label: null,
    account_type: 'CARD',
    account_hint: null,
    card_last_four: '0037',
    account_last_four: null,
    iban: null,
    device_id: null,
    active: 1,
    customer_visible: 2,
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

const control = async (name = 'حساب نماینده') =>
  (await screen.findAllByLabelText(`کارت‌های «${name}» برای`))[0] as HTMLSelectElement;

describe('the audience of an account’s cards', () => {
  it('shows a reseller-only account as «نماینده», and there is no on/off switch left', async () => {
    render(<AccountsView cache={createCache()} />);

    expect((await control()).value).toBe('2');
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.getAllByText('فقط نماینده').length).toBeGreaterThan(0);
  });

  it('sends each of 0, 1 and 2 as the number chosen', async () => {
    rows = [account({ customer_visible: 0 })];
    render(<AccountsView cache={createCache()} />);

    fireEvent.change(await control(), { target: { value: '2' } });
    await waitFor(() => expect(sent).toHaveLength(1));
    fireEvent.change(await control(), { target: { value: '1' } });
    await waitFor(() => expect(sent).toHaveLength(2));

    expect(sent.map(([m]) => m)).toEqual(['PATCH', 'PATCH']);
    expect(sent[0]![1]).toContain('/api/v1/accounts/acc-r');
    expect(sent.map(([, , b]) => b)).toEqual([{ customer_visible: 2 }, { customer_visible: 1 }]);
  });

  it('hides a reseller account with 0, never with a customer 1', async () => {
    render(<AccountsView cache={createCache()} />);

    fireEvent.change(await control(), { target: { value: '0' } });
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]![2]).toEqual({ customer_visible: 0 });
    // Hiding is the safe direction and is not asked about.
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('asks before handing reseller cards to customers, and sends nothing on «no»', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    render(<AccountsView cache={createCache()} />);

    fireEvent.change(await control(), { target: { value: '1' } });
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(vi.mocked(window.confirm).mock.calls[0]![0]).toContain('مشتری');
    expect(sent).toHaveLength(0);
  });

  it('keeps «نماینده» out of a REVIEWER’s reach, as the server does', async () => {
    rows = [account(), account({ id: 'acc-c', display_name: 'حساب مشتری', customer_visible: 1 })];
    render(
      <RoleProvider role="REVIEWER">
        <AccountsView cache={createCache()} />
      </RoleProvider>,
    );

    // Already a reseller account: not movable at all by this role.
    expect((await control()).disabled).toBe(true);
    // A customer account: movable, but not to «نماینده».
    const other = await control('حساب مشتری');
    expect(other.disabled).toBe(false);
    const reseller = Array.from(other.options).find((o) => o.value === '2')!;
    expect(reseller.disabled).toBe(true);
  });
});
