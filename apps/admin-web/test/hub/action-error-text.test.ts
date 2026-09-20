/**
 * A refused action, as a sentence the operator can act on.
 *
 * 2026-09-20, production: a customer placed two orders and paid once. The
 * credit auto-verified against the second; approving it on the first showed
 * `transaction_already_consumed`, and nothing on the screen said the money
 * was this same customer's, already spent on a service they had received.
 * The reply carries the consumer now; the sentence has to use it.
 */

import { describe, expect, it } from 'vitest';
import { actionErrorText } from '../../src/hub/paymentReview.js';

const me = { telegramUserId: '1006156845' };

describe('actionErrorText', () => {
  it('names the duplicate when the consumer is this same customer', () => {
    const text = actionErrorText(
      {
        error: 'transaction_already_consumed',
        consumedBy: { orderId: 'c5e4e79fc1', telegramUserId: '1006156845' },
      },
      me,
    );
    expect(text).toContain('c5e4e79fc1');
    expect(text).toContain('همین مشتری');
    expect(text).toContain('بدون واریز بانکی');
  });

  it('points at the other customer’s order when the money is a stranger’s', () => {
    const text = actionErrorText(
      {
        error: 'transaction_already_consumed',
        consumedBy: { orderId: 'e659f19064', telegramUserId: '100673982' },
      },
      me,
    );
    expect(text).toContain('e659f19064');
    expect(text).toContain('100673982');
    expect(text).toContain('برگردان');
    expect(text).not.toContain('همین مشتری');
  });

  it('still says what happened when no consumer came back', () => {
    expect(actionErrorText({ error: 'transaction_already_consumed' }, me)).toContain(
      'خرج سفارش دیگری',
    );
  });

  it('passes any other code through unchanged', () => {
    expect(actionErrorText({ error: 'illegal_claim_transition' }, me)).toBe(
      'illegal_claim_transition',
    );
  });
});
