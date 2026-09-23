/**
 * «تخصیص» on a deposit — the orders it may go to.
 *
 * Sam, 2026-09-23: «وقتی تایید میشه یعنی پول به حساب اومده». An order closed
 * by hand without its bank row (a hand delivery, or «تایید دستی») is offered
 * too, but only on the deposit's own account, only within a day of the
 * deposit, only while it has no deposit, and only as evidence: the request
 * always verifies, never suggests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FULFILLED_RECONCILE_MAX_TIME_DELTA_MS } from '@shikoo/contracts';
import { AssignToPaymentModal } from '../../src/hub/financialHub.js';
import type { PaymentItem } from '../../src/hub/paymentReview.js';

function claim(id: string, over: Partial<PaymentItem>): PaymentItem {
  return {
    id,
    orderId: id,
    expectedAmountToman: 120_000,
    reviewState: 'NEEDS_REVIEW',
    claimStatus: 'PENDING',
    telegramUsername: null,
    telegramUserId: '1',
    matchedTransaction: null,
    ...over,
  } as PaymentItem;
}

const asked: string[] = [];
const posts: Array<{ url: string; body: { verifyAfterAssign: boolean } }> = [];

beforeEach(() => {
  asked.length = 0;
  posts.length = 0;
  globalThis.fetch = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    asked.push(url);
    const q = new URL(url, 'http://local').searchParams;
    const tab = q.get('tab');
    const items =
      tab === 'open'
        ? [claim('ORD-OPEN', {})]
        : tab === 'all' && q.get('status') === 'FULFILLED_UNRECONCILED'
          ? [claim('ORD-HAND-DELIVERED', { claimStatus: 'FULFILLED_UNRECONCILED' })]
          : tab === 'manually_verified'
            ? [
                claim('ORD-HAND-VERIFIED', { claimStatus: 'VERIFIED', reviewState: 'MANUALLY_VERIFIED' }),
                claim('ORD-HAS-DEPOSIT', {
                  claimStatus: 'VERIFIED',
                  reviewState: 'MANUALLY_VERIFIED',
                  matchedTransaction: {
                    id: 'tx-other',
                    amountIrr: 1_200_000,
                    bankTimestamp: 0,
                    timeDeltaSeconds: 0,
                    verifiedAt: 0,
                    verifiedBy: 'op',
                  },
                }),
              ]
            : [];
    return new Response(JSON.stringify({ ok: true, items }), { status: 200 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const DEPOSIT_AT = 1_790_000_000_000;

function renderModal(transactionAt: number | null = DEPOSIT_AT) {
  render(
    <AssignToPaymentModal
      transactionId="tx-late"
      transactionAmountIrr={1_200_000}
      transactionAccountId="acc-1"
      transactionAt={transactionAt}
      onClose={() => {}}
      onError={() => {}}
    />,
  );
}

describe('assigning a deposit to an order', () => {
  it('offers the orders closed by hand without their deposit, on this account and near it only', async () => {
    renderModal();
    await screen.findByRole('option', { name: /ORD-HAND-VERIFIED/ });
    expect(screen.getByRole('option', { name: /ORD-OPEN/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /ORD-HAND-DELIVERED · .*تحویل دستی/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /ORD-HAND-VERIFIED · .*تایید دستی/ })).toBeTruthy();
    // Already has its bank row: not a place for a second deposit.
    expect(screen.queryByRole('option', { name: /ORD-HAS-DEPOSIT/ })).toBeNull();
    // Closed orders are asked for on the deposit's account, within a day of
    // it either way, and nowhere else.
    const closedAsks = asked.filter((u) => /FULFILLED_UNRECONCILED|manually_verified/.test(u));
    expect(closedAsks).toHaveLength(2);
    for (const url of closedAsks) {
      const q = new URL(url, 'http://local').searchParams;
      expect(q.get('accountId')).toBe('acc-1');
      expect(Number(q.get('from'))).toBe(DEPOSIT_AT - FULFILLED_RECONCILE_MAX_TIME_DELTA_MS);
      expect(Number(q.get('to'))).toBe(DEPOSIT_AT + FULFILLED_RECONCILE_MAX_TIME_DELTA_MS);
    }
  });

  it('offers no closed order for a deposit with no bank time', async () => {
    renderModal(null);
    await screen.findByRole('option', { name: /ORD-OPEN/ });
    expect(asked.filter((u) => /FULFILLED_UNRECONCILED|manually_verified/.test(u))).toEqual([]);
    expect(screen.queryByRole('option', { name: /بی‌واریزی/ })).toBeNull();
  });

  it('always verifies a closed order, even with «تایید بعد از تخصیص» off beforehand', async () => {
    renderModal();
    await screen.findByRole('option', { name: /ORD-HAND-VERIFIED/ });
    fireEvent.click(screen.getByRole('checkbox', { name: /تایید بعد از تخصیص/ }));
    const select = screen.getByRole('combobox', { name: /ادعای پرداخت/ });
    const handVerified = screen.getByRole('option', { name: /ORD-HAND-VERIFIED/ }) as HTMLOptionElement;
    fireEvent.change(select, { target: { value: handVerified.value } });
    fireEvent.change(screen.getByRole('textbox', { name: /دلیل/ }), { target: { value: 'its deposit' } });
    fireEvent.click(screen.getByRole('button', { name: 'تخصیص' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toContain('/payment-claims/ORD-HAND-VERIFIED/reassign-transaction');
    expect(posts[0]!.body.verifyAfterAssign).toBe(true);
  });
});
