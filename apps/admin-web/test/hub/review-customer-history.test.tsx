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
import type { NearbyOrder, PaymentItem } from '../../src/hub/paymentReview.js';

const BASE = Date.parse('2026-09-02T09:00:00Z');

function claim(over: Partial<PaymentItem> = {}): PaymentItem {
  return {
    id: 'claim-hist-1',
    orderId: '90001',
    telegramUserId: '555000111',
    telegramUsername: null,
    expectedAmountIrr: 1_500_000,
    expectedAmountToman: 150_000,
    walletPaidToman: 0,
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

/**
 * Sam, 2026-09-23: a 330,000 renewal claim held a 231,000 receipt, because the
 * customer had bought the same plan new with a 30% code four minutes later and
 * paid THAT invoice. The page now lists the orders around the claim, this one
 * marked, each with its card, code and wallet share — and names the code on
 * the claim's own order under «پرداخت».
 */
describe('the orders around the claim', () => {
  const nearby = (over: Partial<NearbyOrder>): NearbyOrder => ({
    publicId: 'o',
    kind: 'RENEWAL',
    status: 'AWAITING_PAYMENT',
    totalIrr: 3_300_000,
    createdAt: BASE,
    planName: '2ماهه-50گیگ-330.000ت',
    cardLast4: '7781',
    discountIrr: 0,
    code: null,
    walletIrr: 0,
    isThis: true,
    ...over,
  });

  it('shows the second order, its card, its code and its wallet share', async () => {
    mockApi(
      claim({
        nearbyOrders: [
          nearby({ publicId: 'rnw' }),
          nearby({
            publicId: 'new',
            kind: 'NEW_PURCHASE',
            status: 'COMPLETED',
            totalIrr: 2_310_000,
            discountIrr: 990_000,
            cardLast4: '8903',
            code: 'OFF30',
            walletIrr: 100_000,
            isThis: false,
            createdAt: BASE + 240_000,
          }),
        ],
      }),
    );
    renderReview();

    const list = await screen.findByTestId('nearby-orders');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText(/همین پرداخت/)).toBeTruthy();
    expect(within(rows[0]!).getByText('…7781')).toBeTruthy();
    expect(within(rows[1]!).queryByText(/همین پرداخت/)).toBeNull();
    expect(within(rows[1]!).getByText(/^۲\. خرید جدید/)).toBeTruthy();
    expect(within(rows[1]!).getByText('…8903')).toBeTruthy();
    expect(within(rows[1]!).getByText('کد OFF30')).toBeTruthy();
    expect(within(rows[1]!).getByText(/کیف پول ۱۰٬۰۰۰ تومان/)).toBeTruthy();
    expect(within(rows[1]!).getByText('تکمیل شده')).toBeTruthy();
  });

  it('draws nothing when this is the only order, and names the claim’s own code', async () => {
    mockApi(claim({ nearbyOrders: [nearby({ discountIrr: 990_000, code: 'OFF30' })] }));
    renderReview();

    const page = await screen.findByTestId('review-page');
    expect(within(page).queryByTestId('nearby-orders')).toBeNull();
    expect(within(page).getByText(/۹۹٬۰۰۰ تومان — کد OFF30/)).toBeTruthy();
  });
});

describe('the «حساب» block', () => {
  it('shows the card the customer was shown, under the account number (#335)', async () => {
    mockApi(
      claim({
        accountBank: 'بانک ملی',
        accountHint: '7001018421022',
        cardDisplay: '6037 9975 1234 5678',
        cardMasked: '6037 **** **** 5678',
      }),
    );
    renderReview();

    const page = await screen.findByTestId('review-page');
    const block = within(page).getByRole('heading', { name: 'حساب' }).parentElement!;
    expect(within(block).getByText('7001018421022')).toBeTruthy();
    expect(within(block).getByText('6037 9975 1234 5678')).toBeTruthy();
  });
});
