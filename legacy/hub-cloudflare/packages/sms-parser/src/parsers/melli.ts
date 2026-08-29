/**
 * Melli Bank (بانک ملی ایران) transfer SMS parser.
 *
 * Layout (after normalization):
 *   <header keywords>   e.g. "بانك ملي" / "بانک ملی ایران"
 *   انتقال:<sign><amount>   e.g. "انتقال:+1,500,000"
 *   حساب:<account-hint>    e.g. "حساب:17000"
 *   مانده:<balance>        e.g. "مانده:78,159,809"
 *   <MM/DD>-<HH:mm>        e.g. "05/14-16:30"
 *
 * Direction: sign-driven (+/−).
 * Bank: MELLI.
 *
 * The header check tolerates Arabic/Persian spelling variants
 * (بانك / بانک / ملی / ملي / ایران omitted).
 *
 * classification: BANK_TRANSACTION.
 */

import type { NormalizedSms, ParseResult } from '@hub/contracts';
import { directionByPhrase, matched } from './types.js';
import { gregorianToJalali, jalaliToGregorianEpochMs } from '../jalali.js';
import { parseIrr } from '../normalize.js';
import { maskIdentifier } from '../identifier.js';

const DAY_MS = 86_400_000;
const FALLBACK_THRESHOLD_DAYS = 2;

const AMOUNT_RE = /^انتقال\s*:?\s*([+-]?)\s*([\d,،\s]+?)\s*([+-]?)\s*$/;
const ACCOUNT_RE = /^حساب\s*:?\s*(.+)$/;
const BALANCE_RE = /^مانده\s*:?\s*([\d,،\s]+?)\s*$/;
// Accept both MM/DD-HH:mm (slash-separated) and MMDD-HH:mm (concatenated).
// The slash is optional; the captures (MM, DD, HH, mm) work for both.
const DATE_RE = /^(\d{2})\/?(\d{2})-(\d{1,2}):(\d{2})$/;

// "بانک ملی" or "بانك ملي ایران" with optional trailing country. Either spelling works.
function isMelli(text: string): boolean {
  return /(بانک|بانك)\s*(ملي|ملی)/.test(text);
}

export const melliTransferParser = {
  id: 'melli-transfer-v1',
  version: '1.0.0',

  supports(input: NormalizedSms): boolean {
    if (!isMelli(input.text)) return false;
    const lines = input.text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    return (
      lines.some((l) => AMOUNT_RE.test(l)) &&
      lines.some((l) => ACCOUNT_RE.test(l)) &&
      lines.some((l) => BALANCE_RE.test(l)) &&
      lines.some((l) => DATE_RE.test(l))
    );
  },

  parse(input: NormalizedSms): ParseResult {
    const text = input.text;
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const amountLine = lines.find((l) => AMOUNT_RE.test(l));
    const accountLine = lines.find((l) => ACCOUNT_RE.test(l));
    const balanceLine = lines.find((l) => BALANCE_RE.test(l));
    const dateLine = lines.find((l) => DATE_RE.test(l));
    if (!amountLine || !accountLine || !balanceLine || !dateLine) {
      return unsupportedWarn('melli required field missing', 'melli_missing_field');
    }

    const amountMatch = amountLine.match(AMOUNT_RE);
    if (!amountMatch) {
      return unsupportedWarn('انتقال line malformed', 'melli_amount_malformed');
    }
    const [, signA, digits, signB] = amountMatch as unknown as [string, string, string, string];
    const amountStr = `${signA}${digits}${signB}`.replace(/\s+/g, '');
    const amountIrr = parseIrr(digits);
    if (amountIrr === null) {
      return unsupportedWarn('انتقال digits malformed', 'melli_amount_malformed');
    }

    const accountMatch = accountLine.match(ACCOUNT_RE);
    const accountHint = (accountMatch?.[1] ?? '').trim();
    if (!accountHint) {
      return unsupportedWarn('حساب hint missing', 'melli_account_missing');
    }

    const balanceMatch = balanceLine.match(BALANCE_RE);
    if (!balanceMatch) {
      return unsupportedWarn('مانده line malformed', 'melli_balance_malformed');
    }
    const balanceIrr = parseIrr(balanceMatch[1] ?? '');
    if (balanceIrr === null) {
      return unsupportedWarn('مانده digits malformed', 'melli_balance_malformed');
    }

    const dtMatch = dateLine.match(DATE_RE);
    if (!dtMatch) {
      return unsupportedWarn('date/time malformed', 'melli_datetime_malformed');
    }
    const mm = Number.parseInt(dtMatch[1]!, 10);
    const dd = Number.parseInt(dtMatch[2]!, 10);
    const hh = Number.parseInt(dtMatch[3]!, 10);
    const mi = Number.parseInt(dtMatch[4]!, 10);

    const smsJ = gregorianToJalali(input.timestamp);
    const jy = smsJ.jy;
    let bankTimestamp: number;
    const warnings: string[] = [];
    try {
      const candidate = jalaliToGregorianEpochMs(jy, mm, dd, hh, mi);
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
    // Phrase override wins over missing sign (same rule as parsian).
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
      return unsupportedWarn('both CREDIT and DEBIT phrases present', 'melli_direction_conflict');
    } else {
      return unsupportedWarn(
        'no sign and no explicit direction phrase',
        'melli_direction_ambiguous',
      );
    }
    if (
      phraseDirection !== null &&
      phraseDirection !== 'CONFLICT' &&
      phraseDirection !== direction
    ) {
      extraWarnings.push('DIRECTION_PHRASE_OVERRIDES_SIGN');
    }

    // Melli's account_hint here is a short numeric ("17000" or "06006")
    // that the identifier normalizer rejects as too-short for
    // ACCOUNT_NUMBER. Emit it explicitly as ACCOUNT_HINT, preserving
    // leading zeros (e.g. "06006") rather than stripping non-digits
    // — the user spec requires leading zeros and hyphens preserved.
    const digitsOnly = accountHint.replace(/\D/g, '');
    const detectedIdentifiers =
      digitsOnly.length >= 1
        ? [
            {
              type: 'ACCOUNT_HINT' as const,
              normalizedValue: digitsOnly,
              maskedValue: maskIdentifier(digitsOnly),
              confidence: 0.92,
              parserId: 'melli-transfer-v1',
            },
          ]
        : [];

    return matched({
      classification: 'BANK_TRANSACTION',
      direction,
      amountIrr,
      balanceIrr,
      accountHint,
      transactionReference: null,
      confidence: 0.95,
      parserId: 'melli-transfer-v1',
      parserVersion: '1.0.0',
      evidence: {
        bank: 'MELLI',
        accountHint,
        directionSource,
        amountRaw: amountStr,
        balanceRaw: balanceMatch[1] ?? '',
        dateRaw: dateLine,
        timeRaw: dateLine,
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
    parserId: 'melli-transfer-v1',
    parserVersion: '1.0.0',
    evidence: { reason, code },
    warnings: [code],
  };
}
