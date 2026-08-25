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
 * one of `NO_TRANSFER_REASONS` (`mirzabotRoutes.ts:135`), and «رسید ثبت شد»
 * beside them converts "this customer never paid" into "this customer sent
 * something" in the mind of the person about to decide about their money. The
 * claim about evidence is the one thing this screen must not invent.
 *
 * The second describe block is about the other half of the same sentence — the
 * STATE, not the reason. That queue was called «مشکوک به جعل» until
 * 2026-08-25, which is a claim about evidence too, and a worse one.
 *
 * The second half of this file is about numbers. Two windows were typed into
 * the Persian prose by hand — «۱۰ دقیقه» and «۵ دقیقه‌ای» — with nothing
 * connecting them to `WAITING_TIMEOUT_MS` and `AUTO_MATCH_MAX_TIME_DELTA_MS`.
 * Changing a constant would have left the panel quoting the old figure with
 * total confidence, and no test anywhere would have noticed.
 */

import { describe, expect, it } from 'vitest';
import { AUTO_MATCH_MAX_TIME_DELTA_MS, WAITING_TIMEOUT_MS } from '@shikoo/contracts';
import {
  ALL_TAB_STATES,
  formatRelativeFuture,
  reasonText,
  stateLabel,
} from '../../src/hub/paymentReview.js';

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

/**
 * A forgery is something an operator concludes, never something the queue
 * announces on arrival.
 *
 * `NO_TRANSFER_FOUND` was `SUSPECTED_FAKE`, labelled «مشکوک به جعل», and the
 * only two suspect reasons that reach it — `NO_TRANSACTION` and
 * `NO_TRANSACTION_AFTER_10M` — both mean the matcher found no bank credit.
 * That is the absence of evidence. The one reason in `SuspectReason` that
 * would evidence a forged receipt is `RECEIPT_REUSED`, and nothing writes it:
 * every `suspect_reason` in this system comes from `suggest()` in
 * `mirzabotMatch.ts`, whose arguments are enumerable and do not include it.
 *
 * So the bucket could not have held a forgery signal even in principle. What
 * it held on Sam's screen on 2026-08-25 was four people whose bank SMS had not
 * arrived.
 */
describe('what the queue is allowed to accuse a customer of', () => {
  /** «جعل» and everything built on it — «جعلی», «مشکوک به جعل». */
  const FORGERY = /جعل/;

  /**
   * The states a claim can be in while nobody has decided about it. These are
   * exactly the three that make up «در انتظار بررسی».
   */
  const UNDECIDED = ['NEEDS_REVIEW', 'WAITING', 'NO_TRANSFER_FOUND'] as const;

  it('never accuses a claim nobody has looked at yet', () => {
    for (const state of UNDECIDED) {
      expect(stateLabel(state), state).not.toMatch(FORGERY);
    }
  });

  it('still lets an operator say it, once they have', () => {
    // The cure is not to delete the word. `FAKE` is `payment_claims.status =
    // 'FAKE_RECEIPT'`, which only «علامت‌زدن به‌عنوان جعلی» writes — a person
    // looked at a receipt and decided. That label must keep saying so.
    expect(stateLabel('FAKE')).toMatch(FORGERY);
  });

  it('leaves exactly one state carrying the word', () => {
    // Swept, so a future state cannot quietly join `FAKE`. The failure this
    // guards against is not a typo; it is somebody adding a bucket and
    // reaching for the strongest available word to name it.
    const accusing = ALL_TAB_STATES.filter((s) => FORGERY.test(stateLabel(s)));
    expect(accusing).toEqual(['FAKE']);
  });
});

describe('how long is left, on the same screen and in the same language', () => {
  /*
   * Found in the browser, not here: the top row of «در انتظار بررسی» read
   * «About 10 minutes remaining» in a right-to-left column of Persian.
   *
   * `formatRelativeFuture` had two branches. The `min === 1` one was Persian
   * and the general one was not — a translation that stopped after the first
   * case and stopped at the case that almost never runs, so the screen looked
   * translated to anyone who did not wait for a one-minute claim.
   *
   * Swept rather than spot-checked, because the bug was a branch nobody
   * visited, and a single example would have picked the branch somebody
   * already thought about.
   */
  const MINUTE = 60_000;

  it('never answers in English, at any distance', () => {
    for (const ms of [0, 1, MINUTE, 90_000, 9 * MINUTE, 10 * MINUTE, 59 * MINUTE, 3 * 3_600_000]) {
      expect(formatRelativeFuture(ms), `${ms}ms`).not.toMatch(/[A-Za-z]/);
    }
  });

  it('writes its number the way every other number on the screen is written', () => {
    // «About 10» and «۱۰» in one table are two notations for one quantity, and
    // the operator has to notice they are the same thing.
    expect(formatRelativeFuture(10 * MINUTE)).not.toMatch(/[0-9]/);
    expect(formatRelativeFuture(10 * MINUTE)).toContain('۱۰');
  });
});
