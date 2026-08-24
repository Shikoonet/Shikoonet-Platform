/**
 * Payment review inbox.
 *
 * The engine's decisions arrive pre-made; these tests pin how the operator sees
 * them — three buckets, plain-language reasons, and no way to approve without
 * naming the bank transaction.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within, act } from '@testing-library/react';
import { createCache } from '../../src/hub/query.js';
import { PaymentsView } from '../../src/hub/PaymentsView.js';
import {
  reasonText,
  defaultCandidateId,
  formatExactDateTime,
  type PaymentItem,
  type PaymentsResponse,
} from '../../src/hub/paymentReview.js';

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
  // The badge on «در انتظار بررسی», summed the way the server sums it. Not a
  // fourth independent number: the point of the merged queue is that the count
  // and the rows are one population, so a fixture that could disagree with
  // itself would be testing the wrong shape.
  open: 17,
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

// Every tab, not just the claim tabs: `income` carries `IncomeItem` rows with an
// `amountIrr`, which a `PaymentItem[]` annotation rejected.
function mockApi(byTab: Record<string, PaymentsResponse['items']>) {
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
    // `open`, matching the real default in `parsePaymentTabFromLocation` and in
    // the worker. It used to be `income`, and that was the bug: a claim is never
    // in `transaction_candidates`, so the landing screen could not show the
    // thing an operator had just come to look at.
    const tab = new URL(url, 'http://local').searchParams.get('tab') ?? 'open';
    const range = new URL(url, 'http://local').searchParams.get('range') ?? 'all';
    return new Response(
      JSON.stringify({
        ok: true,
        tab,
        range,
        // «در انتظار بررسی» is every undecided claim, so unless a test says
        // otherwise it is the three old queues put together — exactly what the
        // server returns for `tab=open`. Tests that seeded one of those three
        // therefore keep meaning what they meant.
        items:
          byTab[tab] ??
          (tab === 'open'
            ? [
                ...(byTab['needs_review'] ?? []),
                ...(byTab['waiting'] ?? []),
                ...(byTab['suspected_fake'] ?? []),
              ]
            : []),
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
  return within(screen.getByRole('navigation', { name: 'نماهای پرداخت' }));
}

function opsNav() {
  return within(screen.getByRole('tablist', { name: 'بخش‌های پرداخت' }));
}

/**
 * The merged review queue.
 *
 * «نیاز به بررسی» · «در انتظار» · «مشکوک به جعل» were three tabs and are one.
 * The state they used to name is drawn on the row instead, so these walks reach
 * the same rows through one door.
 */
async function goOpenQueue() {
  fireEvent.click(await hubNav().findByRole('tab', { name: /در انتظار بررسی/i }));
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

    expect(await screen.findByRole('navigation', { name: 'نماهای پرداخت' })).toBeTruthy();
    expect(opsNav().getByRole('tab', { name: 'بررسی' })).toBeTruthy();
    expect(hubNav().getByRole('tab', { name: /واریزی‌ها/i })).toBeTruthy();
    expect(opsNav().getByRole('tab', { name: /نمایندگی/i })).toBeTruthy();
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
    await goOpenQueue();
    expect(await screen.findByText(/سفارش WAIT1/)).toBeTruthy();
    expect(screen.getByText('About 6 minutes remaining')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Review$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'علامت‌زدن به‌عنوان جعلی' })).toBeNull();
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
    await goOpenQueue();
    expect(await screen.findByText(/سفارش SF1/)).toBeTruthy();
    expect(screen.getByText(/تا ۱۰ دقیقه هیچ واریزی پیدا نشد/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Review suspected fake/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'حذف' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'علامت‌زدن به‌عنوان جعلی' })).toBeNull();
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
    await goOpenQueue();
    fireEvent.click(await screen.findByRole('button', { name: 'حذف' }));
    fireEvent.click(await screen.findByRole('button', { name: 'تایید' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe('/api/v1/suspects/sf1/reject');
    expect(posts[0]!.body).toEqual({ reason: 'NO_BANK_TRANSACTION' });
  });

  it('lists engine-flagged payments under نیاز به بررسی', async () => {
    mockApi({ needs_review: [item({ id: 'p1', orderId: 'A12B' })] });
    renderView();
    await goOpenQueue();

    expect(await screen.findByText(/@ali/)).toBeTruthy();
    expect(await screen.findByText(/سفارش A12B/)).toBeTruthy();
    expect(screen.getByText('۱۹۵٬۰۰۰ تومان')).toBeTruthy();
    expect(screen.getByText(/چند تراکنش بانکی با این پرداخت می‌خوانند/)).toBeTruthy();
    // Once, on the ROW. It used to appear twice — the tab and the pill — and the
    // test reached past the tab to index [1]. With one queue the state has only
    // one place left to be said, which is where it belongs.
    expect(screen.getByText('نیاز به بررسی')).toBeTruthy();
  });

  it('lists automatically verified payments under تایید خودکار ربات', async () => {
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
    fireEvent.click(await hubNav().findByRole('tab', { name: /تایید خودکار ربات 143/i }));
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
    fireEvent.click(await hubNav().findByRole('tab', { name: /تایید خودکار ربات 143/i }));
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reject/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();
  });

  it('marks bot auto verified tab read via خواندن همه', async () => {
    mockApi({
      needs_review: [],
      bot_auto_verified: [
        item({ id: 'p2', reviewState: 'AUTO_VERIFIED', suspectReason: null, isNew: true }),
      ],
    });
    renderView();
    fireEvent.click(await hubNav().findByRole('tab', { name: /تایید خودکار ربات 143/i }));
    fireEvent.click(await screen.findByRole('button', { name: /علامت‌زدن 4 مورد خوانده‌نشده/i }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe('/api/v1/payments/tabs/read-all');
    expect(posts[0]!.body).toEqual({ tab: 'bot_auto_verified' });
  });

  it('shows خواندن همه on income tab when unread', async () => {
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
          statusLabel: 'واریزی تخصیص‌نیافته',
          isNew: true,
        },
      ],
    });
    renderView();
    // Navigated to, not landed on. «واریزی‌ها» was the default tab and is not
    // any more — the queue is.
    fireEvent.click(await hubNav().findByRole('tab', { name: /واریزی‌ها/i }));
    await waitFor(() => expect(screen.getByText('۵۰٬۰۰۰ تومان')).toBeTruthy());
    fireEvent.click(
      await screen.findByLabelText('علامت‌زدن 3 مورد خوانده‌نشده به‌عنوان خوانده‌شده'),
    );

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
    fireEvent.click(await opsNav().findByRole('tab', { name: 'بایگانی' }));
    fireEvent.click(await hubNav().findByRole('tab', { name: /همه 157/i }));
    await screen.findAllByRole('listitem');
    const pills = screen.getByRole('list').querySelectorAll('.status-pill');
    expect([...pills].map((p) => p.textContent)).toEqual([
      'تایید خودکار ربات',
      'نیاز به بررسی',
      'تایید دستی',
      'در انتظار',
      'رد شده',
    ]);
  });

  it('shows Reopen on تایید دستی tab for reopen-eligible items', async () => {
    mockApi({
      needs_review: [],
      manually_verified: [
        item({ id: 'a-manual', reviewState: 'MANUALLY_VERIFIED', reopenEligible: true }),
      ],
    });
    renderView();
    fireEvent.click(await opsNav().findByRole('tab', { name: 'بایگانی' }));
    fireEvent.click(await hubNav().findByRole('tab', { name: /تایید دستی/i }));
    await screen.findAllByRole('listitem');
    fireEvent.click(screen.getByRole('button', { name: 'عملیات' }));
    expect(screen.getByRole('menuitem', { name: 'بازکردن دوبارهٔ تایید' })).toBeTruthy();
  });

  it('confirms reopen on تایید دستی tab and calls reopen API', async () => {
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
    fireEvent.click(await opsNav().findByRole('tab', { name: 'بایگانی' }));
    fireEvent.click(await hubNav().findByRole('tab', { name: /تایید دستی/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'عملیات' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'بازکردن دوبارهٔ تایید' }));
    fireEvent.change(screen.getByLabelText(/دلیل \(الزامی\)/i), {
      target: { value: 'Wrong transaction' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'بازکردن دوبارهٔ تایید' }));

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
    fireEvent.click(await opsNav().findByRole('tab', { name: 'بایگانی' }));
    fireEvent.click(await hubNav().findByRole('tab', { name: /تایید دستی/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'عملیات' }));
    const reopen = screen.getByRole('menuitem', { name: 'بازکردن دوبارهٔ تایید' });
    expect(reopen).toHaveProperty('disabled', true);
    expect(reopen.getAttribute('title')).toMatch(/revert snapshot/i);
  });

  it('shows Reopen in بررسی پرداخت drawer for manually verified items', async () => {
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
    fireEvent.click(await opsNav().findByRole('tab', { name: 'بایگانی' }));
    fireEvent.click(await hubNav().findByRole('tab', { name: /تایید دستی/i }));
    fireEvent.click(await screen.findByText(/سفارش A12B/i));
    const drawer = await screen.findByRole('dialog', { name: 'بررسی پرداخت' });
    const reopen = within(drawer).getByRole('button', { name: 'بازکردن دوبارهٔ تایید' });
    expect(reopen).toHaveProperty('disabled', false);
    fireEvent.click(reopen);
    expect(await screen.findByRole('dialog', { name: 'بازکردن دوبارهٔ تایید دستی' })).toBeTruthy();
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
    fireEvent.click(await opsNav().findByRole('tab', { name: 'بایگانی' }));
    fireEvent.click(await hubNav().findByRole('tab', { name: /تایید دستی/i }));
    fireEvent.click(await screen.findByText(/سفارش A12B/i));
    const drawer = await screen.findByRole('dialog', { name: 'بررسی پرداخت' });
    const reopen = within(drawer).getByRole('button', { name: 'بازکردن دوبارهٔ تایید' });
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

    // The landing screen is the queue now, so this is the first thing an
    // operator reads — and on this screen it is the one empty state that is
    // good news rather than a dead end.
    expect(await screen.findByText('هیچ پرداختی منتظر تصمیم نیست.')).toBeTruthy();
    expect(screen.queryByText(/Every payment was handled automatically/)).toBeNull();

    fireEvent.click(await hubNav().findByRole('tab', { name: /واریزی‌ها/i }));
    expect(await screen.findByText('در این بازه واریزی تخصیص‌نیافته‌ای نیست.')).toBeTruthy();

    fireEvent.click(await opsNav().findByRole('tab', { name: 'بایگانی' }));
    fireEvent.click(await hubNav().findByRole('tab', { name: /همه 157/i }));
    expect(await screen.findByText('پرداختی پیدا نشد.')).toBeTruthy();
  });

  it('says so when the inbox cannot be loaded, instead of loading forever', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    renderView();

    expect(await screen.findByText(/Could not load payments/)).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.getByRole('button', { name: 'تلاش دوباره' })).toBeTruthy();
  });

  it('مشکوک به جعل Review opens mark-fake confirmation flow', async () => {
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
    await goOpenQueue();
    fireEvent.click(await screen.findByRole('button', { name: /Review suspected fake/i }));
    const drawer = await screen.findByRole('dialog', { name: 'بررسی پرداخت' });
    expect(within(drawer).getByRole('button', { name: 'علامت‌زدن به‌عنوان جعلی' })).toBeTruthy();
    expect(within(drawer).queryByRole('button', { name: 'رد پرداخت' })).toBeNull();
  });

  it('never renders a full card number in the list', async () => {
    mockApi({ needs_review: [item({ id: 'p1' })] });
    const { container } = renderView();
    await goOpenQueue();
    await screen.findByText(/سفارش A12B/);
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
    await goOpenQueue();

    fireEvent.click(await screen.findByRole('button', { name: /Review payment from/i }));
    const drawer = await screen.findByRole('dialog', { name: 'بررسی پرداخت' });
    expect(within(drawer).getByText('بررسی پرداخت')).toBeTruthy();
    expect(within(drawer).getByText('سفارش: A12B')).toBeTruthy();
    expect(within(drawer).getByText('User ID: 42')).toBeTruthy();
    expect(within(drawer).getByText('تراکنش')).toBeTruthy();
    expect(within(drawer).getAllByRole('radio')).toHaveLength(2);
    expect(within(drawer).getByText(/Δ 21 sec/)).toBeTruthy();
    expect(within(drawer).getByText(/Δ 37 sec/)).toBeTruthy();
  });

  it('cannot verify manually until the operator picks a transaction', async () => {
    mockApi({ needs_review: [ambiguous] });
    renderView();
    await goOpenQueue();

    fireEvent.click(await screen.findByRole('button', { name: /Review payment from/i }));
    const approve = await screen.findByRole('button', { name: 'تایید انتخاب‌شده‌ها' });
    expect((approve as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getAllByRole('radio')[1]!);
    expect((approve as HTMLButtonElement).disabled).toBe(false);
  });

  it('تایید انتخاب‌شده‌ها posts the chosen transaction to the existing endpoint', async () => {
    mockApi({ needs_review: [ambiguous] });
    renderView();
    await goOpenQueue();

    fireEvent.click(await screen.findByRole('button', { name: /Review payment from/i }));
    fireEvent.click(screen.getAllByRole('radio')[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'تایید انتخاب‌شده‌ها' }));

    await waitFor(() =>
      expect(posts.some((p) => p.url === '/api/v1/suspects/p1/approve')).toBe(true),
    );
    const approvePost = posts.find((p) => p.url === '/api/v1/suspects/p1/approve')!;
    expect(approvePost.body).toEqual({ transactionId: 't2' });
  });

  it('رد پرداخت posts a rejection reason to the existing endpoint', async () => {
    mockApi({ needs_review: [ambiguous] });
    renderView();
    await goOpenQueue();

    fireEvent.click(await screen.findByRole('button', { name: /Review payment from/i }));
    fireEvent.click(screen.getByRole('button', { name: 'رد پرداخت' }));

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
    ['AMBIGUOUS_TRANSACTIONS', 'چند تراکنش بانکی با این پرداخت می‌خوانند'],
    ['AMBIGUOUS_CLAIMS', 'چند پرداخت می‌توانند با این واریزی بخوانند'],
    // «پرداخت», not «رسید». This reason is stamped off
    // `COALESCE(receipt_submitted_at, paid_clicked_at)`, so it fires for a claim
    // that has no receipt at all — and it lands on «مشکوک به جعل», where
    // claiming a receipt exists turns "never paid" into "forged a document" in
    // the mind of whoever is about to decide. What is guaranteed here is the
    // button press, and that is all this sentence may assert.
    // See `test/hub/reason-text.test.ts` for the rule rather than the string.
    ['NO_TRANSACTION_AFTER_10M', 'پرداخت ثبت شد، ولی تا ۱۰ دقیقه هیچ واریزی پیدا نشد'],
    ['UNMAPPED_CARD', 'کارت به هیچ حساب بانکی وصل نیست'],
    ['ACCOUNT_NOT_ACTIVE', 'این حساب بانکی فعال نیست'],
    ['AMOUNT_MISMATCH', 'یک واریزی نزدیک، مبلغش فرق دارد'],
    ['TRANSACTION_ALREADY_CONSUMED', 'این تراکنش بانکی قبلاً برای پرداخت دیگری استفاده شده'],
    ['PARSER_FAILURE_NEARBY', 'یک پیامک بانکی نزدیک پردازش نشد'],
  ])('%s reads as a sentence', (code, text) => {
    expect(reasonText(code)).toBe(text);
  });

  it('OUTSIDE_AUTO_MATCH_WINDOW names the 5-minute window', () => {
    expect(reasonText('OUTSIDE_AUTO_MATCH_WINDOW')).toBe(
      'واریزی منطبق پیدا شد، ولی بیرون از پنجرهٔ ۵ دقیقه‌ای تایید خودکار',
    );
  });

  it('falls back to a neutral sentence for unknown or absent codes', () => {
    expect(reasonText('SOMETHING_NEW')).toBe('به‌صورت خودکار تایید نشد');
    expect(reasonText(null)).toBe('در انتظار واریز بانکی');
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
    await goOpenQueue();
    expect(await screen.findByText(/دستگاه: Puyan-iPhone/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Review payment from/i }));
    const drawer = await screen.findByRole('dialog', { name: 'بررسی پرداخت' });
    expect(within(drawer).getByText('Puyan-iPhone')).toBeTruthy();
  });

  it('shows Device: — when no SMS source device is known', async () => {
    mockApi({
      waiting: [item({ id: 'w1', reviewState: 'WAITING', suspectReason: null, device: null })],
    });
    renderView();
    await goOpenQueue();
    expect(await screen.findByText(/دستگاه: —/)).toBeTruthy();
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
    expect(await screen.findByText(/سفارش STAY/)).toBeTruthy();

    needsReviewItems = [];
    const { DASHBOARD_POLL_INTERVAL_MS } = await import('../../src/hub/query.js');
    await act(async () => {
      vi.advanceTimersByTime(DASHBOARD_POLL_INTERVAL_MS);
    });
    await waitFor(() => {
      expect(screen.queryByText(/سفارش STAY/)).toBeNull();
      expect(screen.getByText('چیزی نیاز به بررسی ندارد.')).toBeTruthy();
    });
    vi.useRealTimers();
  });
});

describe('PaymentsView تایید خودکار ربات read state', () => {
  it('خواندن همه clears unread badge but keeps total count', async () => {
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
          items:
            tab === 'bot_auto_verified'
              ? [item({ id: 'b1', reviewState: 'AUTO_VERIFIED', isNew: unread > 0 })]
              : [],
          counts: { ...COUNTS, botAutoVerified: 143, botAutoVerifiedUnread: unread },
          summary: SUMMARY,
        }),
        { status: 200 },
      );
    });

    window.history.replaceState(null, '', '/?tab=bot_auto_verified');
    renderView();
    expect(
      await screen.findByRole('button', { name: /علامت‌زدن 4 مورد خوانده‌نشده/i }),
    ).toBeTruthy();

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

    fireEvent.click(screen.getByRole('button', { name: /علامت‌زدن 4 مورد خوانده‌نشده/i }));
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /تایید خودکار ربات 143/i })).toBeTruthy();
      expect(screen.queryByText('+4')).toBeNull();
    });
  });
});
