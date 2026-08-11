/**
 * Internet-account transfer signed-amount SMS parser (compact 4-line variant).
 *
 * Layout (after normalization):
 *   انتقال اینترنت:<sign><amount>   e.g. "انتقال اینترنت:+550,000"   or trailing "550,000+"
 *   حساب:<account>                   e.g. "حساب:310057795083"
 *   مانده:<balance>                  e.g. "مانده:83,341,067"
 *   <MMDD>-<HH:mm>                   e.g. "0515-10:06"  (Jalali M/D no-slash form)
 *
 * Direction is sign-driven (+/- on the amount). Phrase override (DEBIT
 * keywords override "+") follows the same rule as the parsian / melli /
 * account-transfer / compact parsers — see `directionByPhrase`.
 *
 * This is the compact 4-line variant; the 5-line variant with a separate
 * `مبلغ:` line is handled by `account-transfer-signed-v1`. Both must
 * coexist.
 *
 * Bank: UNKNOWN — the account_hint resolves to a configured
 * financial_accounts row whose bank_name is used downstream.
 *
 * classification: BANK_TRANSACTION.
 */

import type { NormalizedSms, ParseResult } from '@shikoo/contracts';
import { directionByPhrase, matched } from './types.js';
import { gregorianToJalali, jalaliToGregorianEpochMs } from '../jalali.js';
import { parseIrr } from '../normalize.js';
import { detectedIdentifierFromRaw } from '../identifier.js';

const DAY_MS = 86_400_000;
const FALLBACK_THRESHOLD_DAYS = 2;

// Header + amount on a single line. Tolerates optional colon and whitespace.
const AMOUNT_HEADER_RE = /^انتقال\s+اینترنت\s*:?\s*([+-]?)\s*([\d,،\s]+?)\s*([+-]?)\s*$/;
const ACCOUNT_RE = /^حساب\s*:?\s*(.+)$/;
const BALANCE_RE = /^مانده\s*:?\s*([\d,،\s]+?)\s*$/;
// MMDD-HH:mm  (Jalali M/D with no slash separator)
const DATE_RE = /^(\d{2})(\d{2})-(\d{1,2}):(\d{2})$/;

export const internetTransferSignedParser = {
  id: 'internet-transfer-signed-v1',
  version: '1.0.0',

  supports(input: NormalizedSms): boolean {
    const lines = input.text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    // Exactly 4 lines: header+amount / حساب / مانده / datetime.
    if (lines.length !== 4) return false;
    if (!AMOUNT_HEADER_RE.test(lines[0]!)) return false;
    if (!ACCOUNT_RE.test(lines[1]!)) return false;
    if (!BALANCE_RE.test(lines[2]!)) return false;
    return DATE_RE.test(lines[3]!);
  },

  parse(input: NormalizedSms): ParseResult {
    const lines = input.text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const amountMatch = lines[0]!.match(AMOUNT_HEADER_RE);
    if (!amountMatch) {
      return unsupportedWarn('header line malformed', 'internet_transfer_amount_malformed');
    }
    const [, signA, digits, signB] = amountMatch as unknown as [string, string, string, string];
    const amountStr = `${signA}${digits}${signB}`.replace(/\s+/g, '');
    const amountIrr = parseIrr(digits);
    if (amountIrr === null) {
      return unsupportedWarn('amount digits malformed', 'internet_transfer_amount_malformed');
    }

    const accountMatch = lines[1]!.match(ACCOUNT_RE);
    const accountHint = (accountMatch?.[1] ?? '').trim();
    if (!accountHint || accountHint.length < 5) {
      return unsupportedWarn('account hint too short', 'internet_transfer_account_too_short');
    }

    const balanceMatch = lines[2]!.match(BALANCE_RE);
    if (!balanceMatch) {
      return unsupportedWarn('مانده line malformed', 'internet_transfer_balance_malformed');
    }
    const balanceIrr = parseIrr(balanceMatch[1] ?? '');
    if (balanceIrr === null) {
      return unsupportedWarn('مانده digits malformed', 'internet_transfer_balance_malformed');
    }

    const dtMatch = lines[3]!.match(DATE_RE);
    if (!dtMatch) {
      return unsupportedWarn('date/time malformed', 'internet_transfer_datetime_malformed');
    }
    const jm = Number.parseInt(dtMatch[1]!, 10);
    const jd = Number.parseInt(dtMatch[2]!, 10);
    const hh = Number.parseInt(dtMatch[3]!, 10);
    const mi = Number.parseInt(dtMatch[4]!, 10);

    const smsJ = gregorianToJalali(input.timestamp);
    const jy = smsJ.jy;
    let bankTimestamp: number;
    const warnings: string[] = [];
    try {
      const candidate = jalaliToGregorianEpochMs(jy, jm, jd, hh, mi);
      const drift = Math.abs(candidate - input.timestamp);
      if (drift > FALLBACK_THRESHOLD_DAYS * DAY_MS) {
        bankTimestamp = input.timestamp;
        warnings.push('BANK_TIME_FALLBACK_TO_SMS_TIMESTAMP');
      } else {
        bankTimestamp = candidate;
      }
    } catch {
      bankTimestamp = input.timestamp;
      warnings.push('BANK_TIME_FALLBACK_TO_SMS_TIMESTAMP');
    }

    const explicitSign =
      signA === '+' || signA === '-' || signB === '+' || signB === '-'
        ? signA === '+' || signA === '-'
          ? signA
          : signB
        : null;
    const phraseDirection = directionByPhrase(input.text);
    let direction: 'CREDIT' | 'DEBIT';
    let directionSource: 'explicit_credit_phrase' | 'explicit_debit_phrase' | 'signed_amount';
    const extraWarnings: string[] = [];
    if (phraseDirection === 'CREDIT' && explicitSign !== '-') {
      direction = 'CREDIT';
      directionSource = 'explicit_credit_phrase';
    } else if (phraseDirection === 'DEBIT' && explicitSign !== '+') {
      direction = 'DEBIT';
      directionSource = 'explicit_debit_phrase';
    } else if (explicitSign === '-') {
      direction = 'DEBIT';
      directionSource = 'signed_amount';
    } else if (explicitSign === '+') {
      direction = 'CREDIT';
      directionSource = 'signed_amount';
    } else if (phraseDirection === 'CONFLICT') {
      return unsupportedWarn(
        'both CREDIT and DEBIT phrases present',
        'internet_transfer_direction_conflict',
      );
    } else {
      return unsupportedWarn(
        'no sign and no explicit direction phrase',
        'internet_transfer_direction_ambiguous',
      );
    }
    if (
      phraseDirection !== null &&
      phraseDirection !== 'CONFLICT' &&
      phraseDirection !== direction
    ) {
      extraWarnings.push('DIRECTION_PHRASE_OVERRIDES_SIGN');
    }

    const detectedIdentifiers = [
      detectedIdentifierFromRaw(accountHint, 'internet-transfer-signed-v1', 0.93),
    ].filter(Boolean);

    return matched({
      classification: 'BANK_TRANSACTION',
      direction,
      amountIrr,
      balanceIrr,
      accountHint,
      transactionReference: null,
      confidence: 0.93,
      parserId: 'internet-transfer-signed-v1',
      parserVersion: '1.0.0',
      evidence: {
        bank: 'UNKNOWN',
        accountHint,
        directionSource,
        amountRaw: amountStr,
        balanceRaw: balanceMatch[1] ?? '',
        dateRaw: lines[3]!,
        timeRaw: lines[3]!,
        bankTimestamp,
        detectedIdentifiers,
        warnings: [...warnings, ...extraWarnings],
      },
      warnings: [...warnings, ...extraWarnings],
    });
  },
} as const;

function unsupportedWarn(reason: string, code: string): ParseResult {
  return {
    matched: false,
    classification: 'UNKNOWN',
    direction: 'UNKNOWN',
    amountIrr: null,
    balanceIrr: null,
    accountHint: null,
    transactionReference: null,
    confidence: 0,
    parserId: 'internet-transfer-signed-v1',
    parserVersion: '1.0.0',
    evidence: { reason, code },
    warnings: [code],
  };
}