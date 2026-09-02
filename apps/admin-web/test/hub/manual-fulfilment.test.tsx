/**
 * «تأیید و تحویل دستی» — the one action a waiting customer depends on.
 *
 * The report was «پرداخت در انتظار واریز بانکی است و هیچ کاری نمی‌شود کرد», and
 * it was accurate. `actionable` — the flag that draws the whole «تصمیم» block —
 * is `NEEDS_REVIEW || NO_TRANSFER_FOUND`, and a claim nobody has flagged yet is
 * `WAITING`. So the decision section of the review page held one sentence and
 * no control, for exactly the state a customer sits in while an operator
 * watches them wait. The fulfil button existed, in the page's title bar, which
 * is not where anyone looks for a decision and was not gated by role either.
 *
 * These tests pin the four things that were wrong, from the browser's side:
 * that the control is there for a pending claim, that it is there without any
 * shop-wide switch, that a reader cannot press it, and that what the operator
 * is told afterwards does not read as «paid».
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createCache } from '../../src/hub/query.js';
import { PaymentsView } from '../../src/hub/PaymentsView.js';
import { RoleProvider } from '../../src/role.js';
import type { PaymentItem } from '../../src/hub/paymentReview.js';

const BASE = Date.parse('2026-09-02T09:00:00Z');

/**
 * A claim in the state the report named: pending, unflagged, no transaction.
 *
 * `suspectReason: null` is the load-bearing field — it is what makes the server
 * derive `WAITING` and what makes the panel print «در انتظار واریز بانکی».
 */
function waitingClaim(over: Partial<PaymentItem> = {}): PaymentItem {
  return {
    id: 'claim-waiting-1',
    orderId: '90001',
    telegramUserId: '555000111',
    telegramUsername: 'demo',
    expectedAmountIrr: 1_500_000,
    expectedAmountToman: 150_000,
    cardMasked: null,
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
  needsReview: 0,
  waiting: 1,
  suspectedFake: 0,
  open: 1,
  autoVerified: 0,
  botAutoVerified: 0,
  income: 0,
  manuallyVerified: 0,
  declinedIncome: 0,
  reseller: 0,
  all: 1,
};

const requests: Array<{ url: string; method: string; body: unknown }> = [];

/**
 * The server, answering with whatever `items` says on each successive read.
 *
 * A list rather than one fixed answer, because the point of the last test is
 * that the screen re-reads after the delivery and shows what came back.
 */
function mockApi(
  pages: PaymentItem[][],
  fulfil: () => Response = () =>
    new Response(
      JSON.stringify({ ok: true, claimId: 'claim-waiting-1', mode: 'MANUAL', already: false }),
      { status: 200 },
    ),
  queueEmpty = false,
) {
  let read = 0;
  globalThis.fetch = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.includes('/fulfil-without-payment')) return fulfil();
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
    if (url.startsWith('/api/v1/payments')) {
      // `?claim=` is a different cache key from the queue's, and the last test
      // in this file is about exactly that. When `queueEmpty` is set the queue
      // answers with nothing, so the review resolves through the `claim=` fetch
      // the way a link opened from outside the page does.
      const isClaimFetch = url.includes('claim=');
      if (queueEmpty && !isClaimFetch) {
        return new Response(
          JSON.stringify({ ok: true, tab: 'open', range: 'all', items: [], counts: COUNTS }),
          { status: 200 },
        );
      }
      const items = pages[Math.min(read, pages.length - 1)] ?? [];
      read += 1;
      return new Response(
        JSON.stringify({ ok: true, tab: 'open', range: 'all', items, counts: COUNTS }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ok: true, items: [] }), { status: 200 });
  });
}

function renderAt(role: 'ADMIN' | 'REVIEWER' | 'READ_ONLY') {
  window.history.pushState({}, '', '/admin/payments?claim=claim-waiting-1');
  return render(
    <RoleProvider role={role}>
      <PaymentsView cache={createCache()} />
    </RoleProvider>,
  );
}

/** The button, by the words an operator reads on it. */
function fulfilButton(): HTMLButtonElement | null {
  return screen.queryByRole('button', { name: 'تأیید و تحویل دستی' }) as HTMLButtonElement | null;
}

afterEach(() => {
  requests.length = 0;
  vi.restoreAllMocks();
  window.history.pushState({}, '', '/admin/payments');
});

describe('an individual pending purchase can be delivered by hand', () => {
  it('offers the action on a WAITING claim, in «تصمیم» where decisions are taken', async () => {
    mockApi([[waitingClaim()]]);
    renderAt('ADMIN');

    const page = await screen.findByTestId('review-page');
    // The state is exactly the one the report named, and the button is beside
    // it rather than in a title bar three sections up.
    expect(within(page).getByText('در انتظار واریز بانکی')).toBeTruthy();
    await waitFor(() => expect(fulfilButton()).toBeTruthy());
    expect(fulfilButton()!.disabled).toBe(false);
  });

  it('is offered from the first moment, with no waiting period to serve first', async () => {
    // `waitingElapsedMs` a second old — the claim has only just arrived. There
    // is no «come back in ten minutes» between the customer paying and the
    // operator being able to act.
    mockApi([[waitingClaim({ waitingElapsedMs: 1_000, waitingRemainingMs: 599_000 })]]);
    renderAt('ADMIN');

    await screen.findByTestId('review-page');
    await waitFor(() => expect(fulfilButton()).toBeTruthy());
  });

  it('is not labelled as an automatic verification, because it is not one', async () => {
    mockApi([[waitingClaim()]]);
    renderAt('ADMIN');
    await screen.findByTestId('review-page');
    await waitFor(() => expect(fulfilButton()).toBeTruthy());

    expect(screen.queryByRole('button', { name: /تأیید خودکار|تایید خودکار/ })).toBeNull();
  });

  it('never asks the server what mode the shop is in before offering it', async () => {
    // The whole complaint this answers. Continuity is a shop-wide switch that
    // makes the INGEST deliver every new claim on its own; deciding one claim
    // in front of you is a different act, and it must not be gated on throwing
    // that switch — nor on reading it.
    mockApi([[waitingClaim()]]);
    renderAt('ADMIN');
    await screen.findByTestId('review-page');
    await waitFor(() => expect(fulfilButton()).toBeTruthy());

    expect(requests.some((r) => r.url.includes('/continuity-mode'))).toBe(false);
  });

  it('a REVIEWER may press it — it is the decision that role exists for', async () => {
    mockApi([[waitingClaim()]]);
    renderAt('REVIEWER');
    await screen.findByTestId('review-page');
    await waitFor(() => expect(fulfilButton()).toBeTruthy());
    expect(fulfilButton()!.disabled).toBe(false);
  });

  it('a READ_ONLY operator is shown it disabled, with the reason on the control', async () => {
    // Not hidden: the reader is meant to understand why the shop has not acted,
    // and a control that vanishes teaches nothing. Disabled and explained, the
    // same shape every other write on this surface takes. The server refuses it
    // too — `write-roles.test.ts` proves that half.
    mockApi([[waitingClaim()]]);
    renderAt('READ_ONLY');
    await screen.findByTestId('review-page');

    await waitFor(() => expect(fulfilButton()).toBeTruthy());
    expect(fulfilButton()!.disabled).toBe(true);
    expect(fulfilButton()!.title).toContain('فقط-خواندنی');
  });

  it('a reader who forces a click sends nothing', async () => {
    mockApi([[waitingClaim()]]);
    renderAt('READ_ONLY');
    await screen.findByTestId('review-page');
    await waitFor(() => expect(fulfilButton()).toBeTruthy());

    fireEvent.click(fulfilButton()!);

    expect(screen.queryByRole('dialog', { name: 'تأیید و تحویل دستی' })).toBeNull();
    expect(requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('is gone once the claim has been delivered — there is nothing left to decide', async () => {
    mockApi([[waitingClaim({ reviewState: 'FULFILLED_UNRECONCILED', claimStatus: 'FULFILLED_UNRECONCILED' })]]);
    renderAt('ADMIN');
    await screen.findByTestId('review-page');

    await waitFor(() => expect(screen.getByText('تحویل‌شده، در انتظار تطبیق')).toBeTruthy());
    expect(fulfilButton()).toBeNull();
  });
});

describe('what the operator is told before and after', () => {
  async function openDialog(): Promise<HTMLElement> {
    renderAt('ADMIN');
    await screen.findByTestId('review-page');
    await waitFor(() => expect(fulfilButton()).toBeTruthy());
    fireEvent.click(fulfilButton()!);
    return await screen.findByRole('dialog', { name: 'تأیید و تحویل دستی' });
  }

  it('the dialog says all three things: now, unreconciled, and no way back', async () => {
    mockApi([[waitingClaim()]]);
    const dialog = await openDialog();
    const text = dialog.textContent ?? '';

    expect(text).toContain('همین حالا');
    expect(text).toContain('هنوز تطبیق نشده‌اند');
    expect(text).toContain('از این صفحه برگشت‌پذیر نیست');
    // And it does not claim the payment is confirmed, which is the one thing
    // this state exists to deny.
    expect(text).toContain('در درآمد شمرده نمی‌شود');
  });

  it('will not send without a reason, and sends the reason it was given', async () => {
    mockApi([[waitingClaim()], [waitingClaim({ reviewState: 'FULFILLED_UNRECONCILED' })]]);
    const dialog = await openDialog();
    const confirm = within(dialog).getByRole('button', { name: 'تأیید و تحویل' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'رله پیامک قطع است' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تأیید و تحویل' }));

    await waitFor(() => {
      const post = requests.find((r) => r.url.includes('/fulfil-without-payment'));
      expect(post).toBeTruthy();
      // `confirmed` is a literal in the client, so a screen that forgot to ask
      // also fails to send it. The server requires it.
      expect(post!.body).toEqual({ reason: 'رله پیامک قطع است', confirmed: true });
      expect(post!.url).toContain('claim-waiting-1');
    });
  });

  it('says «delivered» and «still awaiting reconciliation» — never «verified»', async () => {
    mockApi([[waitingClaim()], [waitingClaim({ reviewState: 'FULFILLED_UNRECONCILED' })]]);
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'مشتری منتظر است' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تأیید و تحویل' }));

    const toast = await screen.findByText(/تحویل شد/);
    expect(toast.textContent).toContain('در انتظار تطبیق');
    expect(toast.textContent).not.toContain('تایید شد');
  });

  it('a second press is reported as already delivered, not as a failure', async () => {
    mockApi(
      [[waitingClaim()], [waitingClaim({ reviewState: 'FULFILLED_UNRECONCILED' })]],
      () =>
        new Response(
          JSON.stringify({ ok: true, claimId: 'claim-waiting-1', mode: 'MANUAL', already: true }),
          { status: 200 },
        ),
    );
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'دوباره زدم' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تأیید و تحویل' }));

    const toast = await screen.findByText(/قبلاً تحویل شده بود/);
    expect(toast.textContent).toContain('در انتظار تطبیق');
  });

  it('re-reads the claim it was opened by, not only the queue behind it', async () => {
    // A review opened from a `?claim=` link resolves through a different cache
    // key from the queue's. Refetching only the queue left the delivered claim
    // on screen as «در انتظار», still offering to deliver it again.
    mockApi(
      [[waitingClaim()], [waitingClaim({ reviewState: 'FULFILLED_UNRECONCILED' })]],
      undefined,
      true,
    );
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'مشتری منتظر است' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تأیید و تحویل' }));

    // The delivered state arrives, which it can only do through a second read
    // of the `claim=` key — the queue is empty and has nothing to hand back.
    await screen.findByText('تحویل‌شده، در انتظار تطبیق');
    const reads = requests.filter(
      (r) => r.method === 'GET' && r.url.includes('claim=claim-waiting-1'),
    );
    expect(reads.length).toBeGreaterThan(1);
  });
});
