/**
 * One-time passwords: recognising them, and scrubbing them when we did not.
 *
 * ## Why this parser runs first
 *
 * `registry.ts` puts `otpParser` at the head of `ORDER` so an OTP is decided
 * before any money parser reads the body. That ordering is what makes
 * `ingest.ts`'s `isRedactable` work: an OTP classification stores
 * `[redacted]` and a NULL `normalized_body`, so the code never reaches the
 * database.
 *
 * ## The gap this file was rewritten to close
 *
 * The vocabulary paired «یکبار» with «رمز» and paired «کد» only with
 * تایید/تأیید/فعالسازی/ورود/احراز. So «کد یکبار مصرف» — one of the commonest
 * Iranian phrasings — matched nothing, fell through to `fallback-unknown`,
 * and `isRedactable` was false for UNKNOWN. The full body, OTP included,
 * was written to `raw_sms_events.normalized_body`.
 *
 * No money was ever at risk: UNKNOWN creates no transaction candidate. What
 * was at risk is the guarantee `docs/threat-model.md:106` makes — that an OTP
 * is never stored.
 *
 * ## Two layers, deliberately different in temperament
 *
 * **Classification** (`otpParser.supports`) decides what a message IS, and it
 * is precise. A false positive here reclassifies a real bank SMS as an OTP,
 * which redacts its body and loses a payment — so it requires a marker phrase
 * and refuses when the message is selling something.
 *
 * **Redaction** (`redactOtp`) decides what may be WRITTEN DOWN, and it is
 * eager. It runs at the persistence boundary for messages that were NOT
 * classified as OTP. Its false positive costs one scrubbed number in a body
 * nothing reads for money; its false negative is a password in a database.
 * The two costs are not comparable, so the two checks are not the same check.
 *
 * That asymmetry is the whole design. Sharing one predicate between them
 * would force a single tolerance onto two questions with opposite risks.
 */

import type { NormalizedSms } from '@shikoo/contracts';
import { type SmsParser, unmatched } from './types.js';

/**
 * The words that make a code an AUTHENTICATION code.
 *
 * `یک\s*بار` rather than `یکبار` throughout: Persian writes «یکبار» and «یک
 * بار» interchangeably, and `normalizeText` folds the zero-width non-joiner
 * but not an ordinary space. A vocabulary that spelled it one way would miss
 * every message that spelled it the other.
 */
const OTP_MARKERS: readonly RegExp[] = [
  // رمز یکبار مصرف · رمز یک بار مصرف · کد یکبار مصرف · کد یک بار مصرف
  // رمز پویا · رمز موقت · رمز دوم · رمز دومرحله‌ای
  /(?:رمز|کد)\s*(?:یک\s*بار\s*مصرف|یک\s*بار|پویا|موقت|دوم|دومرحله)/,
  // کد تایید · کد تأیید · کد فعالسازی · کد فعال سازی · کد ورود · کد احراز
  /کد\s*(?:تایید|تأیید|فعال\s*سازی|فعالسازی|ورود|احراز|امنیتی)/,
  // English, and only in its authentication senses. A bare «code» is NOT
  // here: marketing messages are full of it.
  /\b(?:otp|one[-\s]?time\s+(?:password|code|pin|passcode)|verification\s+code|security\s+code|auth(?:entication)?\s+code|2fa)\b/i,
];

/**
 * `کد: 123456` — a labelled code with nothing else to identify it.
 *
 * Kept from the original vocabulary and kept SEPARATE, because it is the
 * weakest signal here: it says «a thing called a code has a number», which is
 * also true of a discount code. It only counts as an OTP when nothing in the
 * message is selling anything.
 */
const BARE_LABELLED_CODE = /(?:رمز|کد)\s*:\s*\d{4,8}(?!\d)/;

/**
 * Language that makes the same words NOT an authentication code.
 *
 * Narrow on purpose. «تخفیف» and «کوپن» are unambiguous marketing; «هدیه» and
 * «جایزه» are deliberately absent, because a bank's own OTP message can
 * legitimately mention a gift and misreading one as promotional would leave a
 * real OTP unredacted — the failure that costs more.
 */
const SELLING_SOMETHING = /تخفیف|کوپن|\b(?:discount|coupon|promo(?:tion(?:al)?)?|off)\b/i;

/** A code-shaped run of digits: four to eight, not part of a longer number. */
const CODE_DIGITS = /(?<!\d)\d{4,8}(?!\d)/g;

/**
 * Does this message present itself as an authentication OTP?
 *
 * The precise question, used for CLASSIFICATION. A marker phrase, or a bare
 * labelled code — and in either case, nothing selling anything.
 */
export function isAuthenticationOtp(text: string): boolean {
  if (SELLING_SOMETHING.test(text)) return false;
  if (OTP_MARKERS.some((re) => re.test(text))) return true;
  return BARE_LABELLED_CODE.test(text);
}

/**
 * Might this message be carrying an authentication OTP?
 *
 * The eager question, used only to decide what may be WRITTEN DOWN. It drops
 * the promotional exclusion on purpose: «کد یکبار مصرف تخفیف» is not an OTP
 * and must not be classified as one, but if the shop's bank ever sends a
 * genuine OTP that happens to mention a discount, storing it would still be
 * the wrong outcome. Redacting a promotional code costs nothing.
 *
 * Requires an actual code-shaped number as well as a marker, so a message
 * that merely discusses passwords is left intact for an operator to read.
 */
export function mightCarryOtp(text: string): boolean {
  if (!CODE_DIGITS.test(text)) {
    CODE_DIGITS.lastIndex = 0;
    return false;
  }
  CODE_DIGITS.lastIndex = 0;
  return OTP_MARKERS.some((re) => re.test(text)) || BARE_LABELLED_CODE.test(text);
}

/** What `redactOtp` did, so a caller can log that it happened without logging what. */
export interface OtpRedaction {
  /** The text as it is safe to store. */
  text: string;
  /** How many code-shaped runs were replaced. Zero means the text is unchanged. */
  redacted: number;
}

/** What replaces the digits. Fixed width, so it cannot hint at the length. */
const OTP_PLACEHOLDER = '[otp-redacted]';

/**
 * Remove the code from a message we are about to store, keeping the rest.
 *
 * The alternative — dropping the whole body — was rejected for a reason that
 * is operational rather than theoretical. `raw_sms_events.normalized_body` is
 * what an operator reads on «رویدادها» when a bank SMS did not parse, and it
 * is how the next `bank_sms_patterns` row gets written. Blanking it would
 * make every unrecognised message that mentions a code permanently
 * unparseable, and the shop would lose payments to protect a number.
 *
 * So the digits go and the sentence stays. The operator can still see the
 * shape of the message; the secret is not in the database.
 *
 * Every code-shaped run is replaced, not only the one beside the marker: a
 * message carrying two numbers, one of them the OTP, must not depend on this
 * function guessing which.
 */
export function redactOtp(text: string): OtpRedaction {
  if (!mightCarryOtp(text)) return { text, redacted: 0 };
  let redacted = 0;
  const out = text.replace(CODE_DIGITS, () => {
    redacted += 1;
    return OTP_PLACEHOLDER;
  });
  return { text: out, redacted };
}

export const otpParser: SmsParser = {
  id: 'generic-otp',
  version: '2.0.0',
  supports(input: NormalizedSms): boolean {
    return isAuthenticationOtp(input.text);
  },
  parse(_input: NormalizedSms) {
    // `unmatched` on purpose: nothing about the message is returned. Not the
    // code, not an amount, not an account hint — this is the one classifier
    // whose correct output is silence.
    return unmatched('OTP', { parserId: this.id, parserVersion: this.version });
  },
};