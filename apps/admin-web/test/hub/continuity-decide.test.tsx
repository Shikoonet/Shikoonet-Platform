/**
 * Deciding on a claim that was delivered before the money arrived.
 *
 * «حالت تداوم» was the one tab in the panel whose rows exist to be decided and
 * which offered nothing to press. Its claims are `FULFILLED_UNRECONCILED`, and
 * all three gates in the review panel were written against the other states:
 * `actionable` (approve/reject), `canFulfil` (deliver by hand) and
 * `canMarkFake`. So the screen drew six lines of facts and no control, and the
 * only way to act on a fake receipt was to copy the Telegram id into another
 * page.
 *
 * What may be done to such a claim is genuinely narrower, and the narrowing is
 * the state machine's rather than a preference: `CLAIM_TRANSITIONS` gives
 * `FULFILLED_UNRECONCILED` exactly one exit, `VERIFIED`. It cannot be rejected
 * or marked fake, because the customer is holding the product. So these tests
 * pin both halves — what appeared, and what must NOT.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createCache } from '../../src/hub/query.js';
import { PaymentsView } from '../../src/hub/PaymentsView.js';
import { RoleProvider } from '../../src/role.js';
import { reconcileNote, type PaymentItem } from '../../src/hub/paymentReview.js';

const BASE = Date.parse('2026-09-05T09:00:00Z');

/** A claim continuity mode delivered, still waiting for its bank credit. */
function continuityClaim(over: Partial<PaymentItem> = {}): PaymentItem {
  return {
    id: 'claim-cont-1',
    orderId: '77001',
    telegramUserId: '555000111',
    telegramUsername: 'demo',
    expectedAmountIrr: 2_000_000,
    expectedAmountToman: 200_000,
    cardMasked: null,
    accountId: null,
    accountDisplay: null,
    accountBank: null,
    accountHint: null,
    paidClickedAt: BASE,
    receiptSubmittedAt: BASE,
    createdAt: BASE,
    effectiveTs: BASE,
    reviewState: 'FULFILLED_UNRECONCILED',
    claimStatus: 'FULFILLED_UNRECONCILED',
    matchStatus: null,
    suspectReason: null,
    waitingRemainingMs: null,
    waitingElapsedMs: null,
    timeDeltaMs: null,
    matchedTransaction: null,
    candidates: [],
    device: null,
    fulfilmentMode: 'CONTINUITY',
    fulfilledAt: BASE,
    fulfilledBy: 'ops@example.com',
    fulfilmentReason: 'رله پیامک قطع است',
    reconciledAt: null,
    customerUserId: 42,
    customerStatus: 'ACTIVE',
    customerBlockedReason: null,
    ...over,
  };
}

const COUNTS = {
  needsReview: 0,
  waiting: 0,
  suspectedFake: 0,
  open: 0,
  autoVerified: 0,
  botAutoVerified: 0,
  continuity: 1,
  continuityPending: 1,
  income: 0,
  manuallyVerified: 0,
  declinedIncome: 0,
  reseller: 0,
  all: 1,
};

const posts: { url: string; body: unknown }[] = [];

function mockApi(item: PaymentItem) {
  posts.length = 0;
  globalThis.fetch = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.startsWith('/api/v1/analytics')) {
      return new Response(
        JSON.stringify({
          ok: true,
          range: 'all',
          sales: { amountIrr: 0, count: 0, amountChange: 0 },
          bankInflowIrr: 0,
          botAutoVerified: { count: 0, amountIrr: 0 },
          manualVerified: { count: 0, amountIrr: 0 },
          reseller: { count: 0, amountIrr: 0 },
          unassignedIncome: { count: 0, amountIrr: 0 },
          balances: { totalKnownIrr: 0, knownAccounts: 0, totalActiveAccounts: 0 },
          trend: [],
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({ ok: true, items: [item], counts: COUNTS, total: 1, page: 1, pageSize: 50 }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

function renderPanel(role: 'ADMIN' | 'REVIEWER' | 'READ_ONLY' = 'ADMIN') {
  window.history.pushState({}, '', '/admin/payments?claim=claim-cont-1');
  return render(
    <RoleProvider role={role}>
      <PaymentsView cache={createCache()} />
    </RoleProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('the queue finally has an exit', () => {
  it('offers «تایید انتخاب‌شده‌ها», which is the only transition this state has', async () => {
    mockApi(continuityClaim());
    renderPanel();
    await screen.findByTestId('review-page');
    // The control that attaches the late bank credit. The server has always
    // accepted it — `verifyMirzabotClaim` has a `reconciling` branch — and the
    // screen simply never drew it.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'تایید انتخاب‌شده‌ها' })).toBeTruthy(),
    );
  });

  it('offers «یافتن یا تغییر تراکنش», because the right credit is rarely a candidate here', async () => {
    mockApi(continuityClaim());
    renderPanel();
    await screen.findByTestId('review-page');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'یافتن یا تغییر تراکنش' })).toBeTruthy(),
    );
  });
});

describe('what must NOT appear, because the state machine forbids it', () => {
  it('does not offer to deliver a claim that is already delivered', async () => {
    mockApi(continuityClaim());
    renderPanel();
    await screen.findByTestId('review-page');
    await waitFor(() => expect(screen.queryByText('حالت تداوم')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'تأیید و تحویل دستی' })).toBeNull();
  });

  it('does not offer «با این حال دستی تایید کن» — the delivery already happened', async () => {
    mockApi(continuityClaim());
    renderPanel();
    await screen.findByTestId('review-page');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'تایید انتخاب‌شده‌ها' })).toBeTruthy(),
    );
    // This control asserts «the payment really arrived» and writes VERIFIED
    // with no match behind it. On a delivered claim what is owed is evidence,
    // which is the approve button above.
    expect(screen.queryByRole('button', { name: 'با این حال دستی تایید کن' })).toBeNull();
  });

  it('prints the status once, not twice — the flag says what is still missing', async () => {
    mockApi(continuityClaim({ suspectReason: 'OUTSIDE_AUTO_MATCH_WINDOW' }));
    renderPanel();
    await screen.findByTestId('review-page');
    await waitFor(() =>
      expect(screen.getAllByText('تحویل‌شده، در انتظار تطبیق').length).toBe(1),
    );
  });
});

describe('blocking the payer, from the payment', () => {
  it('asks before it acts, and says what a block actually does', async () => {
    mockApi(continuityClaim());
    renderPanel();
    await screen.findByTestId('review-page');
    fireEvent.click(await screen.findByRole('button', { name: 'مسدود کردن مشتری' }));
    expect(screen.getByText(/دیگر نه منویی می‌بیند نه پیامی می‌گیرد/)).toBeTruthy();
  });

  it('posts to the customer route with the reason typed', async () => {
    mockApi(continuityClaim());
    renderPanel();
    await screen.findByTestId('review-page');
    fireEvent.click(await screen.findByRole('button', { name: 'مسدود کردن مشتری' }));
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'رسید جعلی' } });
    fireEvent.click(screen.getByRole('button', { name: 'مسدود کن' }));

    await waitFor(() => expect(posts.length).toBeGreaterThan(0));
    const call = posts.find((c) => c.url.includes('/customers/'));
    // The customer route, keyed on the users row — not the Telegram id, and
    // not a payment route. There is one statement in the codebase that may put
    // a customer in this state.
    expect(call?.url).toBe('/api/v1/admin/customers/42/status');
    expect(call?.body).toEqual({ status: 'BLOCKED', reason: 'رسید جعلی' });
  });

  it('shows the block instead of the button once they are blocked', async () => {
    mockApi(continuityClaim({ customerStatus: 'BLOCKED', customerBlockedReason: 'رسید جعلی' }));
    renderPanel();
    await screen.findByTestId('review-page');
    expect(await screen.findByText(/این مشتری مسدود است: رسید جعلی/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'مسدود کردن مشتری' })).toBeNull();
    expect(screen.getByRole('button', { name: 'رفع مسدودی' })).toBeTruthy();
  });

  it('offers nothing when the claim matches no customer at all', async () => {
    // One production claim holds «Poyan test payment» in `customer_reference`.
    mockApi(continuityClaim({ customerUserId: null, customerStatus: null }));
    renderPanel();
    await screen.findByTestId('review-page');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'تایید انتخاب‌شده‌ها' })).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: 'مسدود کردن مشتری' })).toBeNull();
  });

  it('a READ_ONLY operator is offered no block button', async () => {
    mockApi(continuityClaim());
    renderPanel('READ_ONLY');
    await screen.findByTestId('review-page');
    await waitFor(() => expect(screen.queryByText('حالت تداوم')).toBeTruthy());
    const btn = screen.queryByRole('button', { name: 'مسدود کردن مشتری' }) as HTMLButtonElement | null;
    // Either absent or inert — never a control a reader can press.
    expect(btn === null || btn.disabled || btn.getAttribute('aria-disabled') === 'true').toBe(true);
  });
});

describe('why it is still unreconciled, said out loud', () => {
  it('separates «a credit was found but refused» from «nothing has arrived»', () => {
    const outside = continuityClaim({ suspectReason: 'OUTSIDE_AUTO_MATCH_WINDOW' });
    const nothing = continuityClaim({ suspectReason: 'NO_TRANSACTION_AFTER_10M' });
    expect(reconcileNote(outside)).toContain('بیرون از بازهٔ تطبیق');
    expect(reconcileNote(nothing)).toContain('هیچ واریزی');
    // The two used to draw identically, and they are the difference between
    // «attach this transaction» and «suspect this customer».
    expect(reconcileNote(outside)).not.toBe(reconcileNote(nothing));
  });

  it('says nothing once the credit has been matched', () => {
    expect(reconcileNote(continuityClaim({ reconciledAt: BASE + 1000 }))).toBeNull();
  });

  it('says nothing about a claim that was never delivered', () => {
    expect(reconcileNote(continuityClaim({ fulfilledAt: null }))).toBeNull();
  });
});
