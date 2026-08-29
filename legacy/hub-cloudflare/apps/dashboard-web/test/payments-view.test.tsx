/**
 * Payment review inbox.
 *
 * The engine's decisions arrive pre-made; these tests pin how the operator sees
 * them — three buckets, plain-language reasons, and no way to approve without
 * naming the bank transaction.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within, act } from '@testing-library/react';
import { createCache } from '../src/query.js';
import { PaymentsView } from '../src/PaymentsView.js';
import { reasonText, defaultCandidateId, formatExactDateTime, type PaymentItem } from '../src/paymentReview.js';

const FULL_CARD = '5054161706275678';
const BASE = Date.parse('2026-08-07T09:00:00Z');

function item(over: Partial<PaymentItem> & { id: string }): PaymentItem {
  return {
    orderId: 'A12B',
    telegramUserId: '42',
    telegramUsername: 'ali',
    expectedAmountIrr: 1_950_000,
    expectedAmountToman: 195_000,
    cardMasked: '**** **** **** 5678',
    accountId: 'acc-1',
    accountDisplay: 'Melli Main',
    accountBank: 'Melli',
    accountHint: '6006',
    paidClickedAt: BASE,
    receiptSubmittedAt: BASE + 5_000,
    createdAt: BASE,
    effectiveTs: BASE,
    reviewState: 'NEEDS_REVIEW',
    claimStatus: 'PENDING',
    matchStatus: null,
    suspectReason: 'AMBIGUOUS_TRANSACTIONS',
    waitingRemainingMs: null,
    waitingElapsedMs: null,
    timeDeltaMs: null,
    matchedTransaction: null,
    candidates: [],
    device: null,
    ...over,
  };
}

function candidate(id: string, deltaSeconds: number) {
  return {
    id,
    amountIrr: 1_950_000,
    bankTimestamp: BASE + deltaSeconds * 1000,
    timeDeltaSeconds: deltaSeconds,
    accountId: 'acc-1',
    accountDisplay: 'Melli Main',
    accountBank: 'Melli',
    accountHint: '6006',
    alreadyConsumed: false,
  };
}

const COUNTS = {
  needsReview: 7,
  waiting: 8,
  suspectedFake: 2,
  autoVerified: 143,
  botAutoVerified: 143,
  income: 5,
  manuallyVerified: 4,
  declinedIncome: 0,
  reseller: 3,
  all: 157,
  needsReviewUnread: 2,
  suspectedFakeUnread: 1,
  botAutoVerifiedUnread: 4,
  incomeUnread: 3,
  resellerUnread: 1,
};
const SUMMARY = {
  range: 'all' as const,
  bankIncomeIrr: 100_000_000,
  botAutoVerified: { payments: 12, amountIrr: 12_000_000 },
  reseller: { payments: 2, amountIrr: 3_000_000, activeResellers: 1 },
  unassignedIncome: { count: 5, amountIrr: 1_000_000 },
};

const posts: Array<{ url: string; body: unknown }> = [];

function mockApi(byTab: Record<string, PaymentItem[]>) {
  globalThis.fetch = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
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
    if (url.startsWith('/api/v1/accounts')) {
      return new Response(JSON.stringify({ ok: true, items: [] }), { status: 200 });
    }
    if (url.startsWith('/api/v1/resellers')) {
      return new Response(JSON.stringify({ ok: true, items: [] }), { status: 200 });
    }
    const tab = new URL(url, 'http://local').searchParams.get('tab') ?? 'income';
    const range = new URL(url, 'http://local').searchParams.get('range') ?? 'all';
    return new Response(
      JSON.stringify({
        ok: true,
        tab,
        range,
        items: byTab[tab] ?? [],
        counts: COUNTS,
        summary: SUMMARY,
        incomeTotals: { count: 5, amountIrr: 1_000_000 },
        declinedTotals: { count: 0, amountIrr: 0 },
        resellerStats: {
          payments: 2,
          amountIrr: 3_000_000,
          activeResellers: 1,
          breakdown: [],
        },
      }),
      { status: 200 },
    );
  });
}

function renderView() {
  return render(<PaymentsView cache={createCache()} />);
}

function hubNav() {
  return within(screen.getByRole('navigation', { name: 'Payment hub views' }));
}

function opsNav() {
  return within(screen.getByRole('tablist', { name: 'Payment sections' }));
}

async function goNeedsReview() {
  fireEvent.click(await hubNav().findByRole('tab', { name: /Needs Review/i }));
}

beforeEach(() => {
  posts.length = 0;
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PaymentsView tabs', () => {
  it('opens on Income (first Review tab) with grouped navigation', async () => {
    mockApi({ needs_review: [item({ id: 'p1' })], income: [] });
    renderView();

    expect(await screen.findByRole('navigation', { name: 'Payment hub views' })).toBeTruthy();
    expect(opsNav().getByRole('tab', { name: 'Review' })).toBeTruthy();
    expect(hubNav().getByRole('tab', { name: /Income/i })).toBeTruthy();
    expect(opsNav().getByRole('tab', { name: /Reseller/i })).toBeTruthy();
  });

  it('lists waiting payments in the Waiting tab without approve actions', async () => {
    mockApi({
      needs_review: [],
      waiting: [
        item({
          id: 'w1',
          reviewState: 'WAITING',
          suspectReason: null,
          orderId: 'WAIT1',
          waitingRemainingMs: 360_000,
          waitingElapsedMs: 240_000,
        }),
      ],
    });
    renderView();
    fireEvent.click(await hubNav().findByRole('tab', { name: /Waiting 8/i }));
    expect(await screen.findByText(/Order WAIT1/)).toBeTruthy();
    expect(screen.getByText('About 6 minutes remaining')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Review$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark as fake' })).toBeNull();
  });

  it('lists NO_TRANSACTION_AFTER_10M under Suspected Fake with review and Remove', async () => {
    mockApi({
      needs_review: [],
      suspected_fake: [
        item({
          id: 'sf1',
          reviewState: 'SUSPECTED_FAKE',
          suspectReason: 'NO_TRANSACTION_AFTER_10M',
          orderId: 'SF1',
          waitingElapsedMs: 872_000,
        }),
      ],
    });
    renderView();
    fireEvent.click(await hubNav().findByRole('tab', { name: /Suspected Fake 2/i }));
    expect(await screen.findByText(/Order SF1/)).toBeTruthy();
    expect(screen.getByText(/no bank transfer was found within 10 minutes/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Review suspected fake/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mark as fake' })).toBeNull();
  });

  it('Remove on Suspected Fake rejects with NO_BANK_TRANSACTION', async () => {
    mockApi({
      needs_review: [],
      suspected_fake: [
        item({
          id: 'sf1',
          reviewState: 'SUSPECTED_FAKE',
          suspectReason: 'NO_TRANSACTION_AFTER_10M',
        }),
      ],
    });
    renderView();
    fireEvent.click(await hubNav().findByRole('tab', { name: /Suspected Fake 2/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe('/api/v1/suspects/sf1/reject');
    expect(posts[0]!.body).toEqual({ reason: 'NO_BANK_TRANSACTION' });
  });

  it('lists engine-flagged payments under Needs Review', async () => {
    mockApi({ needs_review: [item({ id: 'p1', orderId: 'A12B' })] });
    renderView();
    await goNeedsReview();

    expect(await screen.findByText(/@ali/)).toBeTruthy();
    expect(await screen.findByText(/Order A12B/)).toBeTruthy();
    expect(screen.getByText('195,000 Toman')).toBeTruthy();
    expect(screen.getByText(/Multiple bank transactions match this payment/)).toBeTruthy();
    expect(screen.getByText('Needs review')).toBeTruthy();
  });

  it('lists automatically verified payments under Bot Auto Verified', async () => {
    mockApi({
      needs_review: [],
      bot_auto_verified: [
        item({
          id: 'p2',
          reviewState: 'AUTO_VERIFIED',
          claimStatus: 'VERIFIED',
          matchStatus: 'AUTO_VERIFIED',
          suspectReason: null,
          telegramUsername: 'sara',
          matchedTransaction: {
            id: 't1',
            amountIrr: 1_950_000,
            bankTimestamp: BASE + 18_000,
            timeDeltaSeconds: 18,
            verifiedAt: BASE + 19_000,
            verifiedBy: null,
          },
        }),
      ],
    });
    renderView();
    fireEvent.click(await hubNav().findByRole('tab', { name: /Bot Auto Verified 143/i }));
    expect(await screen.findByText(/@sara/)).toBeTruthy();
    expect(screen.getByText('A12B')).toBeTruthy();
    // Verified At must be rendered as exact YYYY-MM-DD HH:mm:ss (Asia/Tehran)
    // rather than a relative "X minutes ago".
    expect(screen.queryByText(/minutes ago/)).toBeNull();
    const verifiedAt = formatExactDateTime(BASE + 19_000);
    expect(screen.getAllByText(verifiedAt).length).toBeGreaterThan(0);
  });

  it('does not offer a casual Approve / Reject / Undo on auto verified rows', async () => {
    mockApi({
      needs_review: [],
      bot_auto_verified: [item({ id: 'p2', reviewState: 'AUTO_VERIFIED', suspectReason: null })],
    });
    renderView();
    fireEvent.click(await hubNav().findByRole('tab', { name: /Bot Auto Verified 143/i }));
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reject/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();
  });

  it('marks bot auto verified tab read via Read all', async () => {
    mockApi({
      needs_review: [],
      bot_auto_verified: [item({ id: 'p2', reviewState: 'AUTO_VERIFIED', suspectReason: null, isNew: true })],
    });
    renderView();
    fireEvent.click(await hubNav().findByRole('tab', { name: /Bot Auto Verified 143/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Mark 4 unread items as read/i }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe('/api/v1/payments/tabs/read-all');
    expect(posts[0]!.body).toEqual({ tab: 'bot_auto_verified' });
  });

  it('shows Read all on income tab when unread', async () => {
    mockApi({
      needs_review: [],
      income: [
        {
          id: 'tx1',
          amountIrr: 500_000,
          amountToman: 50_000,
          bankTimestamp: BASE,
          accountId: 'acc-1',
          accountDisplay: 'Melli Main',
          accountBank: 'Melli',
          accountHint: '6006',
          reference: null,
          statusLabel: 'Unassigned income',
          isNew: true,
        },
      ],
    });
    renderView();
    await waitFor(() => expect(screen.getByText('50,000 Toman')).toBeTruthy());
    fireEvent.click(await screen.findByLabelText('Mark 3 unread items as read'));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe('/api/v1/payments/tabs/read-all');
    expect(posts[0]!.body).toEqual({ tab: 'income' });
  });

  it('shows every status in All, including Waiting', async () => {
    mockApi({
      needs_review: [],
      all: [
        item({ id: 'a1', reviewState: 'AUTO_VERIFIED' }),
        item({ id: 'a2', reviewState: 'NEEDS_REVIEW' }),
        item({ id: 'a3', reviewState: 'MANUALLY_VERIFIED' }),
        item({ id: 'a4', reviewState: 'WAITING' }),
        item({ id: 'a5', reviewState: 'REJECTED' }),
      ],
    });
    renderView();
    fireEvent.click(await opsNav().findByRole('tab', { name: 'Payments' }));
    fireEvent.click(await hubNav().findByRole('tab', { name: /All 157/i }));
    await screen.findAllByRole('listitem');
    const pills = screen.getByRole('list').querySelectorAll('.status-pill');
    expect([...pills].map((p) => p.textContent)).toEqual([
      'Bot auto verified',
      'Needs review',
      'Manually verified',
      'Waiting',
      'Rejected',
    ]);
  });

  it('shows Reopen on Manually Verified tab for reopen-eligible items', async () => {
    mockApi({
      needs_review: [],
      manually_verified: [
        item({ id: 'a-manual', reviewState: 'MANUALLY_VERIFIED', reopenEligible: true }),
      ],
    });
    renderView();
    fireEvent.click(await opsNav().findByRole('tab', { name: 'Payments' }));
    fireEvent.click(await hubNav().findByRole('tab', { name: /Manually Verified/i }));
    await screen.findAllByRole('listitem');
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menuitem', { name: 'Reopen verification' })).toBeTruthy();
  });

  it('confirms reopen on Manually Verified tab and calls reopen API', async () => {
    mockApi({
      needs_review: [],
      manually_verified: [
        item({
          id: 'a-manual',
          reviewState: 'MANUALLY_VERIFIED',
          reopenEligible: true,
          matchedTransaction: {
            id: 't1',
            amountIrr: 1_950_000,
            bankTimestamp: BASE,
            timeDeltaSeconds: 18,
            verifiedAt: BASE,
            verifiedBy: 'admin@example.com',
          },
        }),
      ],
    });
    renderView();
    fireEvent.click(await opsNav().findByRole('tab', { name: 'Payments' }));
    fireEvent.click(await hubNav().findByRole('tab', { name: /Manually Verified/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reopen verification' }));
    fireEvent.change(screen.getByLabelText(/Reason \(required\)/i), {
      target: { value: 'Wrong transaction' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Reopen verification' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe('/api/v1/payment-claims/a-manual/reopen-manual-verification');
    expect(posts[0]!.body).toEqual({ reason: 'Wrong transaction' });
  });

  it('shows disabled Reopen in row menu when not reopen-eligible', async () => {
    mockApi({
      needs_review: [],
      manually_verified: [
        item({
          id: 'a-old',
          reviewState: 'MANUALLY_VERIFIED',
          reopenEligible: false,
          matchedTransaction: {
            id: 't1',
            amountIrr: 1_950_000,
            bankTimestamp: BASE,
            timeDeltaSeconds: 18,
            verifiedAt: BASE,
            verifiedBy: 'admin@example.com',
          },
        }),
      ],
    });
    renderView();
    fireEvent.click(await opsNav().findByRole('tab', { name: 'Payments' }));
    fireEvent.click(await hubNav().findByRole('tab', { name: /Manually Verified/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Actions' }));
    const reopen = screen.getByRole('menuitem', { name: 'Reopen verification' });
    expect(reopen).toHaveProperty('disabled', true);
    expect(reopen.getAttribute('title')).toMatch(/revert snapshot/i);
  });

  it('shows Reopen in Payment Review drawer for manually verified items', async () => {
    mockApi({
      needs_review: [],
      manually_verified: [
        item({
          id: 'a-manual',
          reviewState: 'MANUALLY_VERIFIED',
          reopenEligible: true,
          matchedTransaction: {
            id: 't1',
            amountIrr: 1_950_000,
            bankTimestamp: BASE,
            timeDeltaSeconds: 18,
            verifiedAt: BASE,
            verifiedBy: 'admin@example.com',
          },
        }),
      ],
    });
    renderView();
    fireEvent.click(await opsNav().findByRole('tab', { name: 'Payments' }));
    fireEvent.click(await hubNav().findByRole('tab', { name: /Manually Verified/i }));
    fireEvent.click(await screen.findByText(/Order A12B/i));
    const drawer = await screen.findByRole('dialog', { name: 'Payment review' });
    const reopen = within(drawer).getByRole('button', { name: 'Reopen verification' });
    expect(reopen).toHaveProperty('disabled', false);
    fireEvent.click(reopen);
    expect(await screen.findByRole('dialog', { name: 'Reopen manual verification' })).toBeTruthy();
  });

  it('shows disabled Reopen in drawer when not reopen-eligible', async () => {
    mockApi({
      needs_review: [],
      manually_verified: [
        item({
          id: 'a-old',
          reviewState: 'MANUALLY_VERIFIED',
          reopenEligible: false,
          matchedTransaction: {
            id: 't1',
            amountIrr: 1_950_000,
            bankTimestamp: BASE,
            timeDeltaSeconds: 18,
            verifiedAt: BASE,
            verifiedBy: 'admin@example.com',
          },
        }),
      ],
    });
    renderView();
    fireEvent.click(await opsNav().findByRole('tab', { name: 'Payments' }));
    fireEvent.click(await hubNav().findByRole('tab', { name: /Manually Verified/i }));
    fireEvent.click(await screen.findByText(/Order A12B/i));
    const drawer = await screen.findByRole('dialog', { name: 'Payment review' });
    const reopen = within(drawer).getByRole('button', { name: 'Reopen verification' });
    expect(reopen).toHaveProperty('disabled', true);
    expect(within(drawer).getByText(/revert snapshot/i)).toBeTruthy();
  });

  it('uses tab-specific empty messages', async () => {
    mockApi({
      needs_review: [],
      income: [],
      waiting: [],
      suspected_fake: [],
      bot_auto_verified: [],
      all: [],
    });
    renderView();
    expect(await screen.findByText('No unassigned bank income in this range.')).toBeTruthy();

    await goNeedsReview();
    expect(await screen.findByText('Nothing needs review.')).toBeTruthy();
    expect(screen.queryByText(/Every payment was handled automatically/)).toBeNull();

    fireEvent.click(await hubNav().findByRole('tab', { name: /Waiting 8/i }));
    expect(await screen.findByText('No payments waiting.')).toBeTruthy();

    fireEvent.click(await hubNav().findByRole('tab', { name: /Suspected Fake 2/i }));
    expect(await screen.findByText('No suspicious receipts are waiting for review.')).toBeTruthy();

    fireEvent.click(await opsNav().findByRole('tab', { name: 'Payments' }));
    fireEvent.click(await hubNav().findByRole('tab', { name: /All 157/i }));
    expect(await screen.findByText('No payments found.')).toBeTruthy();
  });

  it('says so when the inbox cannot be loaded, instead of loading forever', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    renderView();

    expect(await screen.findByText(/Could not load payments/)).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('Suspected Fake Review opens mark-fake confirmation flow', async () => {
    mockApi({
      needs_review: [],
      suspected_fake: [
        item({
          id: 'sf1',
          reviewState: 'SUSPECTED_FAKE',
          suspectReason: 'NO_TRANSACTION_AFTER_10M',
          candidates: [candidate('t1', 400)],
        }),
      ],
    });
    renderView();
    fireEvent.click(await hubNav().findByRole('tab', { name: /Suspected Fake 2/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Review suspected fake/i }));
    const drawer = await screen.findByRole('dialog', { name: 'Payment review' });
    expect(within(drawer).getByRole('button', { name: 'Mark as fake' })).toBeTruthy();
    expect(within(drawer).queryByRole('button', { name: 'Reject payment' })).toBeNull();
  });

  it('never renders a full card number in the list', async () => {
    mockApi({ needs_review: [item({ id: 'p1' })] });
    const { container } = renderView();
    await goNeedsReview();
    await screen.findByText(/Order A12B/);
    expect(container.textContent).not.toContain(FULL_CARD);
    expect(container.textContent).toContain('****6006');
  });
});

describe('review drawer', () => {
  const ambiguous = item({
    id: 'p1',
    suspectReason: 'AMBIGUOUS_TRANSACTIONS',
    candidates: [candidate('t1', 21), candidate('t2', 37)],
  });

  it('Review opens the details drawer with the candidate transactions', async () => {
    mockApi({ needs_review: [ambiguous] });
    renderView();
    await goNeedsReview();

    fireEvent.click(await screen.findByRole('button', { name: /Review payment from/i }));
    const drawer = await screen.findByRole('dialog', { name: 'Payment review' });
    expect(within(drawer).getByText('Payment Review')).toBeTruthy();
    expect(within(drawer).getByText('Order: A12B')).toBeTruthy();
    expect(within(drawer).getByText('User ID: 42')).toBeTruthy();
    expect(within(drawer).getByText('Transaction')).toBeTruthy();
    expect(within(drawer).getAllByRole('radio')).toHaveLength(2);
    expect(within(drawer).getByText(/Δ 21 sec/)).toBeTruthy();
    expect(within(drawer).getByText(/Δ 37 sec/)).toBeTruthy();
  });

  it('cannot verify manually until the operator picks a transaction', async () => {
    mockApi({ needs_review: [ambiguous] });
    renderView();
    await goNeedsReview();

    fireEvent.click(await screen.findByRole('button', { name: /Review payment from/i }));
    const approve = await screen.findByRole('button', { name: 'Verify selected' });
    expect((approve as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getAllByRole('radio')[1]!);
    expect((approve as HTMLButtonElement).disabled).toBe(false);
  });

  it('Verify selected posts the chosen transaction to the existing endpoint', async () => {
    mockApi({ needs_review: [ambiguous] });
    renderView();
    await goNeedsReview();

    fireEvent.click(await screen.findByRole('button', { name: /Review payment from/i }));
    fireEvent.click(screen.getAllByRole('radio')[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Verify selected' }));

    await waitFor(() =>
      expect(posts.some((p) => p.url === '/api/v1/suspects/p1/approve')).toBe(true),
    );
    const approvePost = posts.find((p) => p.url === '/api/v1/suspects/p1/approve')!;
    expect(approvePost.body).toEqual({ transactionId: 't2' });
  });

  it('Reject payment posts a rejection reason to the existing endpoint', async () => {
    mockApi({ needs_review: [ambiguous] });
    renderView();
    await goNeedsReview();

    fireEvent.click(await screen.findByRole('button', { name: /Review payment from/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject payment' }));

    await waitFor(() =>
      expect(posts.some((p) => p.url === '/api/v1/suspects/p1/reject')).toBe(true),
    );
    const rejectPost = posts.find((p) => p.url === '/api/v1/suspects/p1/reject')!;
    expect(rejectPost.body).toEqual({ reason: 'NO_BANK_TRANSACTION' });
  });

  it('preselects the only candidate when auto-verification failed purely on timing', () => {
    const late = item({
      id: 'p9',
      suspectReason: 'OUTSIDE_AUTO_MATCH_WINDOW',
      candidates: [candidate('t9', 92)],
    });
    expect(defaultCandidateId(late)).toBe('t9');
    expect(defaultCandidateId(ambiguous)).toBeNull();
    expect(defaultCandidateId(item({ id: 'p8', candidates: [candidate('t8', 12)] }))).toBeNull();
  });
});

describe('reason presentation', () => {
  it.each([
    ['AMBIGUOUS_TRANSACTIONS', 'Multiple bank transactions match this payment'],
    ['AMBIGUOUS_CLAIMS', 'Multiple payments could match this bank transfer'],
    ['NO_TRANSACTION_AFTER_10M', 'Receipt submitted, but no bank transfer was found within 10 minutes'],
    ['UNMAPPED_CARD', 'Card is not linked to a bank account'],
    ['ACCOUNT_NOT_ACTIVE', 'This bank account is not active'],
    ['AMOUNT_MISMATCH', 'A nearby bank transfer has a different amount'],
    ['TRANSACTION_ALREADY_CONSUMED', 'This bank transaction was already used for another payment'],
    ['PARSER_FAILURE_NEARBY', 'A nearby bank SMS could not be processed'],
  ])('%s reads as a sentence', (code, text) => {
    expect(reasonText(code)).toBe(text);
  });

  it('OUTSIDE_AUTO_MATCH_WINDOW names the 5-minute window', () => {
    expect(reasonText('OUTSIDE_AUTO_MATCH_WINDOW')).toBe(
      'Matching transfer found, but outside the 5-minute auto-verify window',
    );
  });

  it('falls back to a neutral sentence for unknown or absent codes', () => {
    expect(reasonText('SOMETHING_NEW')).toBe('Could not be verified automatically');
    expect(reasonText(null)).toBe('Waiting for bank transfer');
  });
});

describe('PaymentsView device display', () => {
  it('shows device name on review rows and drawer', async () => {
    mockApi({
      needs_review: [
        item({
          id: 'p1',
          device: { id: 'dev-1', name: 'Puyan-iPhone' },
        }),
      ],
    });
    renderView();
    await goNeedsReview();
    expect(await screen.findByText(/Device: Puyan-iPhone/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Review payment from/i }));
    const drawer = await screen.findByRole('dialog', { name: 'Payment review' });
    expect(within(drawer).getByText('Puyan-iPhone')).toBeTruthy();
  });

  it('shows Device: — when no SMS source device is known', async () => {
    mockApi({ waiting: [item({ id: 'w1', reviewState: 'WAITING', suspectReason: null, device: null })] });
    renderView();
    fireEvent.click(await hubNav().findByRole('tab', { name: /Waiting 8/i }));
    expect(await screen.findByText(/Device: —/)).toBeTruthy();
  });
});

describe('PaymentsView live refresh', () => {
  it('drops rows that leave the active queue on poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });

    let needsReviewItems = [item({ id: 'p1', orderId: 'STAY' })];
    globalThis.fetch = vi.fn().mockImplementation(async (input: string) => {
      const url = String(input);
      if (url.startsWith('/api/v1/analytics')) {
        return new Response(JSON.stringify({ ok: true, range: 'all' }), { status: 200 });
      }
      const tab = new URL(url, 'http://local').searchParams.get('tab') ?? 'needs_review';
      return new Response(
        JSON.stringify({
          ok: true,
          tab,
          range: 'all',
          items: tab === 'needs_review' ? needsReviewItems : [],
          counts: { ...COUNTS, needsReview: needsReviewItems.length },
          summary: SUMMARY,
        }),
        { status: 200 },
      );
    });

    const cache = createCache();
    window.history.replaceState(null, '', '/?tab=needs_review');
    render(<PaymentsView cache={cache} />);
    expect(await screen.findByText(/Order STAY/)).toBeTruthy();

    needsReviewItems = [];
    const { DASHBOARD_POLL_INTERVAL_MS } = await import('../src/query.js');
    await act(async () => {
      vi.advanceTimersByTime(DASHBOARD_POLL_INTERVAL_MS);
    });
    await waitFor(() => {
      expect(screen.queryByText(/Order STAY/)).toBeNull();
      expect(screen.getByText('Nothing needs review.')).toBeTruthy();
    });
    vi.useRealTimers();
  });
});

describe('PaymentsView Bot Auto Verified read state', () => {
  it('Read all clears unread badge but keeps total count', async () => {
    mockApi({
      bot_auto_verified: [item({ id: 'b1', reviewState: 'AUTO_VERIFIED', isNew: true })],
    });
    globalThis.fetch = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url === '/api/v1/payments/tabs/read-all') {
        return new Response(JSON.stringify({ ok: true, marked: 1 }), { status: 200 });
      }
      if (url.startsWith('/api/v1/analytics')) {
        return new Response(JSON.stringify({ ok: true, range: 'all' }), { status: 200 });
      }
      const tab = new URL(url, 'http://local').searchParams.get('tab') ?? 'needs_review';
      const unread = url.includes('after-read') ? 0 : COUNTS.botAutoVerifiedUnread;
      return new Response(
        JSON.stringify({
          ok: true,
          tab,
          range: 'all',
          items: tab === 'bot_auto_verified' ? [item({ id: 'b1', reviewState: 'AUTO_VERIFIED', isNew: unread > 0 })] : [],
          counts: { ...COUNTS, botAutoVerified: 143, botAutoVerifiedUnread: unread },
          summary: SUMMARY,
        }),
        { status: 200 },
      );
    });

    window.history.replaceState(null, '', '/?tab=bot_auto_verified');
    renderView();
    expect(await screen.findByRole('button', { name: /Mark 4 unread items as read/i })).toBeTruthy();

    globalThis.fetch = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url === '/api/v1/payments/tabs/read-all') {
        return new Response(JSON.stringify({ ok: true, marked: 1 }), { status: 200 });
      }
      if (url.startsWith('/api/v1/analytics')) {
        return new Response(JSON.stringify({ ok: true, range: 'all' }), { status: 200 });
      }
      const tab = new URL(url, 'http://local').searchParams.get('tab') ?? 'needs_review';
      return new Response(
        JSON.stringify({
          ok: true,
          tab,
          range: 'all',
          items:
            tab === 'bot_auto_verified'
              ? [item({ id: 'b1', reviewState: 'AUTO_VERIFIED', isNew: false })]
              : [],
          counts: { ...COUNTS, botAutoVerified: 143, botAutoVerifiedUnread: 0 },
          summary: SUMMARY,
        }),
        { status: 200 },
      );
    });

    fireEvent.click(screen.getByRole('button', { name: /Mark 4 unread items as read/i }));
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Bot Auto Verified 143/i })).toBeTruthy();
      expect(screen.queryByText('+4')).toBeNull();
    });
  });
});
