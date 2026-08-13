import type { Classification, NormalizedSms, ParseResult } from '@shikoo/contracts';
import { type SmsParser, unmatched } from './types.js';
import { otpParser } from './otp.js';
import { promoParser } from './promo.js';
import { parsianParser } from './parsian.js';
import { gardeshgariCreditParser } from './gardeshgari.js';
import { shahrCreditParser } from './shahr.js';
import { samanCreditParser } from './saman.js';
import { melliTransferParser } from './melli.js';
import { accountTransferSignedParser } from './account-transfer.js';
import { internetTransferSignedParser } from './internet-transfer.js';
import { compactSignedParser } from './compact.js';
import { creditParser } from './credit.js';
import { debitParser } from './debit.js';
import { balanceParser } from './balance.js';
import { unknownParser } from './unknown.js';
import type { FallbackParser } from './dbPatterns.js';
import { normalizeText } from '../normalize.js';

const ORDER: SmsParser[] = [
  otpParser, // OTP MUST win — redact before any other classifier touches the body.
  promoParser,
  // Explicit bank parsers — run before the generic regex parsers so a known
  // bank's exact layout is recognised even when the generic keyword search
  // would also fire. Order: shahr → saman → melli → gardeshgari (per
  // user-supplied precedence; shahr's header "بانک شهر" is the most
  // discriminating).
  shahrCreditParser,
  samanCreditParser,
  melliTransferParser,
  gardeshgariCreditParser,
  // Internet-account transfer parser (compact 4-line): "انتقال اینترنت"
  // header line that combines keyword + signed amount in one line, plus
  // حساب: / مانده: / MMDD-HH:mm. Must run BEFORE the 5-line
  // account-transfer parser — the 5-line variant rejects 4-line bodies
  // naturally, but the 4-line variant must claim its 4-line layout first.
  internetTransferSignedParser,
  // Internet-account transfer parser (5-line): "انتقال اینترنت" header
  // line followed by a separate `مبلغ:` line. Must run before parsian
  // (which requires the account on line 1).
  accountTransferSignedParser,
  // Parsian: explicit labeled "مبلغ:" + signed amount on Parsian accounts.
  parsianParser,
  // Generic compact signed-amount layout — must run after the explicit bank
  // parsers so the same body shape is attributed to the specific bank, not
  // this generic fallback.
  compactSignedParser,
  creditParser,
  debitParser,
  balanceParser,
  unknownParser,
];

/**
 * Classifications an operator pattern may never see, whatever it matches.
 *
 * OTP above all: `otpParser` runs first precisely so a one-time password is
 * redacted before anything else touches the body, and handing that body to a
 * pattern afterwards would undo the redaction. Promotional messages are here
 * for the same reason in weaker form — they are decided, and re-reading one as
 * a transaction would invent money.
 */
const PATTERNS_MAY_NOT_TOUCH = new Set<Classification>(['OTP', 'PROMOTIONAL', 'IGNORED']);

/** A parser named the bank, so no operator pattern gets to have an opinion. */
function bankIsKnown(result: ParseResult): boolean {
  const bank = result.evidence['bank'];
  return typeof bank === 'string' && bank.length > 0 && bank !== 'UNKNOWN';
}

/**
 * A tested parser already read money out of this message.
 *
 * `matched` alone is not this test, and assuming it was is a mistake this code
 * made first: the generic balance parser returns `matched: true` for a deposit
 * SMS it does not understand, classifying it BALANCE with a null amount and no
 * direction. Treating that as "already read" would have locked patterns out of
 * exactly the messages they exist to rescue.
 */
function moneyAlreadyRead(result: ParseResult): boolean {
  return (
    result.matched &&
    result.amountIrr !== null &&
    (result.classification === 'BANK_TRANSACTION' ||
      result.classification === 'BANK_CREDIT' ||
      result.classification === 'BANK_DEBIT')
  );
}

/**
 * Parse one SMS.
 *
 * `fallbacks` are operator-editable patterns loaded from `bank_sms_patterns`
 * (see `dbPatterns.ts`). They are strictly additive: they never run where a
 * built-in named the bank, never replace an amount a built-in extracted, and
 * never see an OTP. Passing none — which every existing caller and all 135
 * parser tests do — leaves the behaviour byte-identical.
 */
export function parseSms(
  input: NormalizedSms,
  fallbacks: readonly FallbackParser[] = [],
): ParseResult {
  // Always normalize through normalizeText — it's idempotent for already-
  // normalized text and ensures NBSP/ZWNJ/CRLF are handled even when the
  // caller pre-populates text with the raw body (common in tests).
  const text = normalizeText(input.text).text;
  const normalized: NormalizedSms = text === input.text ? input : { ...input, text };
  for (const p of ORDER) {
    if (!p.supports(normalized)) continue;
    const result = p.parse(normalized);
    if (
      fallbacks.length === 0 ||
      PATTERNS_MAY_NOT_TOUCH.has(result.classification) ||
      bankIsKnown(result)
    ) {
      return result;
    }

    const fallback = fallbacks.find((f) => f.supports(normalized));
    if (!fallback) return result;
    // The money is already read. The pattern supplies the missing bank name and
    // touches nothing else — an operator's regex does not get to overwrite an
    // amount a tested parser extracted.
    if (moneyAlreadyRead(result)) {
      return {
        ...result,
        evidence: {
          ...result.evidence,
          bank: fallback.bankName,
          bankFromPattern: fallback.patternId,
        },
      };
    }
    // Nothing usable came out. The pattern is the only thing that understands
    // this message, so it parses the whole of it.
    return fallback.parse(normalized);
  }
  return unmatched('UNKNOWN' satisfies Classification);
}

export const REGISTRY: readonly SmsParser[] = ORDER;
