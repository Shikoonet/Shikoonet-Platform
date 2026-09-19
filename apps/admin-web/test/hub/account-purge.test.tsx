/**
 * DeleteAccountModal — the purge path.
 *
 * Sam, 2026-09-19: «میخوام بشه ازم سوال کنه: میخوای کامل حذف کنی؟ بگم بله،
 * بعد بگه با پاک کردن کامل X تراکنش و Y مبلغ از سیستم حسابداری و دیتابیس
 * حذف می‌شه، بعد که تایید کردم کامل حذف کنه.»
 *
 * So, in order:
 *   1. an account with transactions is blocked, and offers «حذف کامل»
 *   2. saying yes shows the count and the sum in Toman, and asks for «Delete»
 *   3. the confirm sends purgeTransactions: true and nothing before that
 *   4. an account whose transactions are pinned does not get the offer
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DeleteAccountModal } from '../../src/hub/DeleteAccountModal.js';
import type { AccountListItem } from '../../src/hub/api.js';

const ACCOUNT = {
  id: 'acc-auto',
  bank_name: 'UNKNOWN',
  display_name: 'Auto: ****04.1',
  owner_label: null,
  account_type: 'ACCOUNT',
  account_hint: '04.1',
  card_last_four: null,
  account_last_four: null,
  iban: null,
  device_id: null,
  active: 0,
  status: 'DECLINED',
  parser_configuration: '{}',
  created_at: 0,
  updated_at: 0,
  device_display_name: null,
  additional_identifiers: [],
} as unknown as AccountListItem;

function preview(purge: { transactions: number; amountIrr: number; pinnedTransactions: number; canPurge: boolean }) {
  return new Response(
    JSON.stringify({
      ok: true,
      account: { id: ACCOUNT.id, displayName: ACCOUNT.display_name, bank: 'UNKNOWN', active: false },
      references: { transactions: purge.transactions, paymentClaims: 0, matches: 0, identifiers: 1 },
      canDelete: false,
      blockingReasons: ['account_in_use'],
      purge,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function mockFetch(routes: Record<string, () => Response>) {
  const calls: Array<{ key: string; body: unknown }> = [];
  const fn = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const raw = typeof input === 'string' ? input : input.toString();
    const url = raw.startsWith('http') ? new URL(raw).pathname : (raw.split('?')[0] ?? raw);
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${url}`;
    calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = routes[key];
    if (!r) throw new Error(`unmocked fetch: ${key}`);
    return r();
  });
  return { fn, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DeleteAccountModal purge', () => {
  it('asks, then names the count and the sum, then purges on the typed name', async () => {
    const { fn, calls } = mockFetch({
      'GET /api/v1/accounts/acc-auto/delete-preview': () =>
        preview({ transactions: 2, amountIrr: 183_000_000, pinnedTransactions: 0, canPurge: true }),
      'DELETE /api/v1/accounts/acc-auto': () =>
        new Response(JSON.stringify({ ok: true, deleted: 'acc-auto', purged: { transactions: 2, amountIrr: 183_000_000 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    vi.stubGlobal('fetch', fn);
    const onDeleted = vi.fn();
    render(<DeleteAccountModal account={ACCOUNT} onClose={() => undefined} onDeleted={onDeleted} />);

    // 1. blocked, and the question is offered
    const ask = await screen.findByRole('button', { name: /حذف کامل با تراکنش‌ها/ });
    expect(screen.getByText(/تراکنش یا ادعای پرداخت مرتبط دارد/)).toBeTruthy();
    fireEvent.click(ask);

    // 2. the price of saying yes, in the operator's units
    expect(screen.getByText(/۲ تراکنش/)).toBeTruthy();
    expect(screen.getByText(/۱۸٬۳۰۰٬۰۰۰ تومان/)).toBeTruthy();
    expect(screen.getByText(/از حسابداری و دیتابیس/)).toBeTruthy();
    const confirm = screen.getByRole('button', { name: /بله، همه‌چیز را پاک کن/ });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    // 3. the word, then the one request that deletes
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Delete' } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    expect(calls.filter((c) => c.key.startsWith('DELETE'))).toHaveLength(0);
    fireEvent.click(confirm);
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('acc-auto'));
    const del = calls.filter((c) => c.key.startsWith('DELETE'));
    expect(del).toHaveLength(1);
    expect(del[0]!.body).toEqual({ purgeTransactions: true });
  });

  it('does not offer the purge while a transaction is pinned to the books', async () => {
    const { fn } = mockFetch({
      'GET /api/v1/accounts/acc-auto/delete-preview': () =>
        preview({ transactions: 2, amountIrr: 200_000, pinnedTransactions: 1, canPurge: false }),
    });
    vi.stubGlobal('fetch', fn);
    render(<DeleteAccountModal account={ACCOUNT} onClose={() => undefined} onDeleted={() => undefined} />);
    await screen.findByText(/تراکنش یا ادعای پرداخت مرتبط دارد/);
    expect(screen.queryByRole('button', { name: /حذف کامل با تراکنش‌ها/ })).toBeNull();
    expect(screen.getByText(/۱ تراکنش .*حساب شده/)).toBeTruthy();
  });
});
