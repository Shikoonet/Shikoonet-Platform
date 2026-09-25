/**
 * «رد» takes an account off the screen.
 *
 * Sam, 2026-09-24: «این حساب رو رد کردم، ولی هنوز داره نمایشش میده. میخوام وقتی
 * رد میزنم کلا دیگه حذفش کنه». The queue listed DECLINED beside PENDING and the
 * list drew it like any other row, so «رد» changed a pill and nothing left.
 *
 * The row is kept on purpose — the next text on the same number lands on it
 * quietly instead of minting a fresh «Auto» account for the queue — so this
 * is about what the screen draws, and the way back («ردشده‌ها» → «بازگرداندن»).
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccountsView } from '../../src/hub/AccountsView.js';
import { createCache } from '../../src/hub/query.js';

function account(over: Record<string, unknown>) {
  return {
    bank_name: 'MELLI',
    owner_label: null,
    account_type: 'ACCOUNT',
    account_hint: null,
    card_last_four: null,
    account_last_four: null,
    iban: null,
    device_id: null,
    active: 1,
    status: 'ACTIVE',
    parser_configuration: '{}',
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

const rows = [
  account({ id: 'acc-live', display_name: 'ملی-سارا' }),
  account({ id: 'acc-year', display_name: 'Auto: ****', account_hint: '1405', status: 'DECLINED' }),
];

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      // The queue is what the server now sends: PENDING only.
      const items = String(url).endsWith('/pending') ? rows.filter((r) => r.status === 'PENDING') : rows;
      return { ok: true, status: 200, json: async () => ({ ok: true, items, totals: {}, accounts: items }) } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a declined account', () => {
  it('is not on the screen, and «ردشده‌ها» says how many are behind it', async () => {
    render(<AccountsView cache={createCache()} />);
    expect((await screen.findAllByText('ملی-سارا')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Auto: ****')).toBeNull();
    expect(screen.queryByRole('region', { name: 'صف بررسی حساب‌ها' })).toBeNull();
    expect(screen.getByTestId('toggle-declined').textContent).toMatch(/ردشده‌ها \(۱\)/);
  });

  it('comes back with «ردشده‌ها», with its «بازگرداندن»', async () => {
    render(<AccountsView cache={createCache()} />);
    fireEvent.click(await screen.findByTestId('toggle-declined'));
    await waitFor(() => expect(screen.getAllByText('Auto: ****').length).toBeGreaterThan(0));
    expect(screen.getAllByRole('button', { name: 'بازگرداندن' }).length).toBeGreaterThan(0);
  });
});
