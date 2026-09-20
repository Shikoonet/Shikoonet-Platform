/**
 * «تکراری» on a deposit row — the door for a bank re-send that got through
 * as a second deposit. Production, 2026-09-20: «رد» left the row in the bank's
 * arithmetic and ملی-آینده read 1,200,000 over all day; this goes through the
 * transaction's own reject with reason `duplicate`, and nothing else.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createCache } from '../../src/hub/query.js';
import { PaymentsView } from '../../src/hub/PaymentsView.js';
import type { IncomeItem } from '../../src/hub/paymentReview.js';

const ITEM: IncomeItem = {
  id: 'tx-dup',
  amountIrr: 1_200_000,
  amountToman: 120_000,
  bankTimestamp: Date.now(),
  accountId: 'acc-1',
  accountDisplay: 'ملی-آینده',
  accountBank: 'Melli',
  accountHint: '06006',
  reference: null,
  statusLabel: 'واریزی تخصیص‌نیافته',
};

const counts = { needsReview: 0, waiting: 0, suspectedFake: 0, autoVerified: 0, botAutoVerified: 0, income: 1, declinedIncome: 0, reseller: 0, all: 1 };
const summary = { range: 'all', bankIncomeIrr: 0, botAutoVerified: { payments: 0, amountIrr: 0 }, reseller: { payments: 0, amountIrr: 0, activeResellers: 0 }, unassignedIncome: { count: 1, amountIrr: 1_200_000 } };

const posts: Array<{ url: string; body: unknown }> = [];

beforeEach(() => {
  posts.length = 0;
  window.history.replaceState(null, '', '/');
  globalThis.fetch = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ ok: true, decision: 'REJECTED' }), { status: 200 });
    }
    const tab = new URL(url, 'http://local').searchParams.get('tab') ?? 'needs_review';
    return new Response(
      JSON.stringify({
        ok: true,
        tab,
        range: 'all',
        items: tab === 'income' ? [ITEM] : [],
        incomeTotals: { count: 1, amountIrr: 1_200_000 },
        counts,
        summary,
      }),
      { status: 200 },
    );
  });
});

afterEach(() => vi.restoreAllMocks());

describe('a deposit that is a re-sent text', () => {
  it('is rejected as a duplicate through the transaction, not tagged off the books', async () => {
    render(<PaymentsView cache={createCache()} />);
    fireEvent.click(await screen.findByRole('tab', { name: /واریزی‌ها 1/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'تکراری' }));
    expect(await screen.findByText('این واریزی تکراری است؟')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'تکراری است' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toContain('/api/v1/transactions/tx-dup/reject');
    expect(posts[0]!.body).toMatchObject({ reason: 'duplicate' });
    // Not the off-books door.
    expect(posts.some((p) => p.url.includes('decline-income'))).toBe(false);
    await waitFor(() => expect(screen.queryByText('این واریزی تکراری است؟')).toBeNull());
  });

  it('does nothing when the operator backs out', async () => {
    render(<PaymentsView cache={createCache()} />);
    fireEvent.click(await screen.findByRole('tab', { name: /واریزی‌ها 1/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'تکراری' }));
    fireEvent.click(await screen.findByRole('button', { name: 'انصراف' }));
    await waitFor(() => expect(screen.queryByText('این واریزی تکراری است؟')).toBeNull());
    expect(posts).toHaveLength(0);
  });
});
