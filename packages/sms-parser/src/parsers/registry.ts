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

export function parseSms(input: NormalizedSms): ParseResult {
  // Always normalize through normalizeText — it's idempotent for already-
  // normalized text and ensures NBSP/ZWNJ/CRLF are handled even when the
  // caller pre-populates text with the raw body (common in tests).
  const text = normalizeText(input.text).text;
  const normalized: NormalizedSms = text === input.text ? input : { ...input, text };
  for (const p of ORDER) {
    if (p.supports(normalized)) {
      return p.parse(normalized);
    }
  }
  return unmatched('UNKNOWN' satisfies Classification);
}

export const REGISTRY: readonly SmsParser[] = ORDER;
