/**
 * The review page's «هویت» block, 2026-09-17: the Telegram id is a link to
 * the customer's card, and under it the page says how much of a customer they
 * are — «تا حالا N اکانت خریده، M فعال». Beside the title, whether this is a
 * new purchase or a renewal. Before this the reviewer copied the id into the
 * «کاربران» search box to learn any of it.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { createCache } from '../../src/hub/query.js';
import { PaymentsView } from '../../src/hub/PaymentsView.js';
import { RoleProvider } from '../../src/role.js';
import type { PaymentItem } from '../../src/hub/paymentReview.js';

const BASE = Date.parse('2026-09-02T09:00:00Z');

function claim(over: Partial<PaymentItem> = {}): PaymentItem {
  return {
    id: 'claim-hist-1',
    orderId: '90001',
    telegramUserId: '555000111',
    telegramUsername: null,
    expectedAmountIrr: 1_500_000,
    expectedAmountToman: 150_000,
    cardMasked: null,
    cardDisplay: null,
    accountId: null,
    accountDisplay: null,
    accountBank: null,
    accountHint: null,
    paidClickedAt: BASE,
    receiptSubmittedAt: null,
    createdAt: BASE,
    effectiveTs: BASE,
    reviewState: 'WAITING',
    claimStatus: 'PENDING',
    matchStatus: null,
    suspectReason: null,
    waitingRemainingMs: 300_000,
    waitingElapsedMs: 60_000,
    timeDeltaMs: null,
    matchedTransaction: null,
    candidates: [],
    device: null,
    ...over,
  };
}

const COUNTS = {
  needsReview: 0, waiting: 1, suspectedFake: 0, open: 1, autoVerified: 0, botAutoVerified: 0,
  income: 0, manuallyVerified: 0, declinedIncome: 0, reseller: 0, all: 1,
};

function mockApi(item: PaymentItem) {
  globalThis.fetch = vi.fn().mockImplementation(async (input: string) => {
    const url = String(input);
    if (url.startsWith('/api/v1/payments')) {
      return new Response(
        JSON.stringify({ ok: true, tab: 'open', range: 'all', items: [item], counts: COUNTS }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ok: true, items: [] }), { status: 200 });
  });
}

function renderReview() {
  window.history.pushState({}, '', '/admin/payments?claim=claim-hist-1');
  return render(
    <RoleProvider role="ADMIN">
      <PaymentsView cache={createCache()} />
    </RoleProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  window.history.pushState({}, '', '/admin/payments');
});

describe('who is paying', () => {
  it('links the id to the customer and says what they bought so far', async () => {
    mockApi(
      claim({
        customerUserId: 77,
        customerSubscriptions: 3,
        customerLiveSubscriptions: 2,
        purchaseType: 'RENEWAL',
      }),
    );
    renderReview();

    const page = await screen.findByTestId('review-page');
    const link = within(page).getByRole('link', { name: '555000111' });
    expect(link.getAttribute('href')).toContain('id=77');
    expect(within(page).getByText(/تا حالا ۳ اکانت خریده، ۲ فعال/)).toBeTruthy();
    expect(within(page).getByText('تمدید')).toBeTruthy();
  });

  it('says nothing about history when the reference matched nobody', async () => {
    mockApi(claim({ customerUserId: null, customerSubscriptions: null, purchaseType: 'NEW_PURCHASE' }));
    renderReview();

    const page = await screen.findByTestId('review-page');
    expect(within(page).queryByText(/اکانت خریده/)).toBeNull();
    expect(within(page).getByText('خرید جدید')).toBeTruthy();
    // Still a way to them: a search by id, since there is no card to open.
    expect(within(page).getByRole('link', { name: '555000111' }).getAttribute('href')).toContain('q=555000111');
  });
});
