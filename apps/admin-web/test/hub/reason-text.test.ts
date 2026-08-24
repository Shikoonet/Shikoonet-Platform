/**
 * What the review screen tells an operator about a payment must be something
 * the row can actually support.
 *
 * `NO_TRANSACTION_AFTER_10M` used to render «رسید ثبت شد، ولی تا ۱۰ دقیقه هیچ
 * واریزی پیدا نشد». The reason is stamped off
 * `COALESCE(receipt_submitted_at, paid_clicked_at)`
 * (`apps/ingest-worker/src/integrations/mirzabot.ts:279`), so it fires exactly
 * the same way for a claim with no receipt at all — and on 2026-08-24 three
 * such rows sat on Sam's screen each announcing a receipt that did not exist.
 *
 * It is not a wording slip, because of where the sentence lands. This reason is
 * one of `SUSPECTED_FAKE_REASONS` (`mirzabotRoutes.ts:124`), so it appears on
 * the fake-suspicion queue — and «رسید ثبت شد» there converts "this customer
 * never paid" into "this customer forged a receipt" in the mind of the person
 * about to decide about their money. The claim about evidence is the one thing
 * a suspicion screen must not invent.
 *
 * The second half of this file is about numbers. Two windows were typed into
 * the Persian prose by hand — «۱۰ دقیقه» and «۵ دقیقه‌ای» — with nothing
 * connecting them to `WAITING_TIMEOUT_MS` and `AUTO_MATCH_MAX_TIME_DELTA_MS`.
 * Changing a constant would have left the panel quoting the old figure with
 * total confidence, and no test anywhere would have noticed.
 */

import { describe, expect, it } from 'vitest';
import { AUTO_MATCH_MAX_TIME_DELTA_MS, WAITING_TIMEOUT_MS } from '@shikoo/contracts';
import { reasonText } from '../../src/hub/paymentReview.js';

/** Every suspect reason the engine can stamp, from the contract, not a copy. */
const REASONS = [
  'AMBIGUOUS_TRANSACTIONS',
  'AMBIGUOUS_CLAIMS',
  'NO_TRANSACTION',
  'NO_TRANSACTION_AFTER_10M',
  'OUTSIDE_AUTO_MATCH_WINDOW',
  'UNMAPPED_CARD',
  'AMBIGUOUS_CARD_MAPPING',
  'ACCOUNT_NOT_ACTIVE',
  'AMOUNT_MISMATCH',
  'TRANSACTION_ALREADY_CONSUMED',
  'PARSER_FAILURE_NEARBY',
  'DUPLICATE_ORDER',
  'DUPLICATE_EVENT',
  'RECEIPT_REUSED',
  'INTEGRATION_ERROR',
] as const;

/**
 * The reasons a claim can carry **without** anyone having sent a receipt.
 *
 * Both are stamped by the same matcher pass, off an anchor that falls back to
 * the «پرداخت کردم» press. Neither may assert that a receipt exists.
 */
const RECEIPT_IS_NOT_IMPLIED = ['NO_TRANSACTION', 'NO_TRANSACTION_AFTER_10M'] as const;

const PERSIAN_DIGITS = /[۰-۹]+/g;

function minutes(ms: number): string {
  return new Intl.NumberFormat('fa-IR').format(Math.round(ms / 60_000));
}

describe('the reason a payment is on the review screen', () => {
  it('never claims a receipt exists for a reason that fires without one', () => {
    for (const code of RECEIPT_IS_NOT_IMPLIED) {
      // «رسید» in any form. The sentence may say a payment was *recorded* — the
      // button press is a fact — but not that a document arrived.
      expect(reasonText(code), code).not.toMatch(/رسید/);
    }
  });

  it('still says what actually happened, rather than going quiet', () => {
    // The cure for a false sentence is a true one, not an empty one. Removing
    // the claim about a receipt must not leave the operator with less than
    // before: the window and the outcome both survive.
    const text = reasonText('NO_TRANSACTION_AFTER_10M');
    expect(text).toMatch(/واریزی/);
    expect(text).toContain(minutes(WAITING_TIMEOUT_MS));
  });

  it('quotes only windows that come from the constants the engine uses', () => {
    // The external truth is `packages/contracts`, not this file. Every Persian
    // number printed anywhere in the map has to be one of the two real windows,
    // so a fresh hard-coded figure fails here wherever somebody types it.
    const allowed = new Set([minutes(WAITING_TIMEOUT_MS), minutes(AUTO_MATCH_MAX_TIME_DELTA_MS)]);

    for (const code of REASONS) {
      for (const found of reasonText(code).match(PERSIAN_DIGITS) ?? []) {
        expect(allowed, `${code} prints «${found}», which is not a known window`).toContain(found);
      }
    }
  });

  it('answers an unknown reason without inventing one', () => {
    expect(reasonText('SOMETHING_NEW')).toBe('به‌صورت خودکار تایید نشد');
    expect(reasonText(null)).toBe('در انتظار واریز بانکی');
  });
});
