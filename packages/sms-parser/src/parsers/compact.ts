/**
 * Compact signed-amount SMS parser.
 *
 * Layout (4 lines, after normalization). Two variants accepted:
 *
 *   Variant A (date BEFORE balance — real-world bank SMS):
 *     <account-hint>          e.g. 10.8206380.1 or 300422286226
 *     <sign><amount>          e.g. +1,950,000   or 20,000,000+
 *     <dateTime>              e.g. 05/14_11:28  OR  1405/5/15-10:46
 *     مانده: <balance>        e.g. مانده: 18,437,338
 *
 *   Variant B (balance BEFORE date — historical 6-fixture sample 5):
 *     <account-hint>
 *     <sign><amount>
 *     مانده: <balance>
 *     <dateTime>
 *
 * Date/time formats accepted:
 *   - MM/DD_HH:mm  (Gregorian month/day, underscore separator)
 *   - JY/M(M)/D(D)-HH:mm  (Jalali year/month/day, dash separator)
 *   - JY/MM/DD HH:mm(:ss)?  (Jalali full datetime, space separator)
 *
 * Bank: UNKNOWN — the account_hint resolves to a configured
 * financial_accounts row, and that row's bank_name is used elsewhere. The
 * parser itself doesn't know which bank.
 *
 * Direction:
 *   "+" prefix/suffix → CREDIT
 *   "-" prefix/suffix → DEBIT
 *   Phrase override wins when an explicit debit/credit keyword is present.
 *   No sign and no phrase → UNKNOWN (product rule, never defaults to CREDIT).
 *
 * The compact parser runs AFTER the three explicit bank parsers
 * (parsian/gardeshgari/shahr) but BEFORE the generic credit/debit/balance
 * regex parsers. It only matches the 4-line structure described above.
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

const AMOUNT_RE = /^([+-]?)\s*([\d,،\s]+?)\s*([+-]?)\s*$/;
// MM/DD_HH:mm   (no year, Gregorian)
const DATE_GREGORIAN_RE = /^(\d{2})\/(\d{2})_(\d{1,2}):(\d{2})$/;
// JY/M(M)/D(D)-HH:mm  (with year, Jalali, dash separator)
const DATE_JALALI_DASH_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})-(\d{1,2}):(\d{2})$/;
// JY/MM/DD HH:mm(:ss)?  (with year, Jalali, space separator)
const DATE_JALALI_SPACE_RE = /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
// JY/MM/DD_HH:mm  (with year, Jalali, underscore separator — historical 6-fixture sample 5 variant)
const DATE_JALALI_UNDERSCORE_RE = /^(\d{4})\/(\d{2})\/(\d{2})_(\d{1,2}):(\d{2})$/;
const BALANCE_RE = /^(?:مانده|موجودي|موجودی)\s*:?\s*([\d,،\s]+?)\s*$/;

interface ParsedDateTime {
  jy: number | null;
  jm: number;
  jd: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Split a normalized SMS body into 4 logical lines.
 *
 * The SMS may be stored in D1 as either newline-separated or
 * space-separated (some upstream channels flatten whitespace). We prefer
 * `\n` boundaries, then fall back to whitespace-token boundaries when the
 * body has no newline.
 */
function splitLogicalLines(text: string): string[] {
  const byNewline = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (byNewline.length >= 4) return byNewline;
  const bySpace = text
    .split(/\s+/)
    .map((l) => l.trim())
    .filter(Boolean);
  return bySpace;
}

function tryParseDateTime(line: string): ParsedDateTime | null {
  const g = line.match(DATE_GREGORIAN_RE);
  if (g) {
    return {
      jy: null,
      jm: Number.parseInt(g[1]!, 10),
      jd: Number.parseInt(g[2]!, 10),
      hour: Number.parseInt(g[3]!, 10),
      minute: Number.parseInt(g[4]!, 10),
      second: 0,
    };
  }
  const jd1 = line.match(DATE_JALALI_DASH_RE);
  if (jd1) {
    return {
      jy: Number.parseInt(jd1[1]!, 10),
      jm: Number.parseInt(jd1[2]!, 10),
      jd: Number.parseInt(jd1[3]!, 10),
      hour: Number.parseInt(jd1[4]!, 10),
      minute: Number.parseInt(jd1[5]!, 10),
      second: 0,
    };
  }
  const jd2 = line.match(DATE_JALALI_SPACE_RE);
  if (jd2) {
    return {
      jy: Number.parseInt(jd2[1]!, 10),
      jm: Number.parseInt(jd2[2]!, 10),
      jd: Number.parseInt(jd2[3]!, 10),
      hour: Number.parseInt(jd2[4]!, 10),
      minute: Number.parseInt(jd2[5]!, 10),
      second: jd2[6] ? Number.parseInt(jd2[6], 10) : 0,
    };
  }
  const jd3 = line.match(DATE_JALALI_UNDERSCORE_RE);
  if (jd3) {
    return {
      jy: Number.parseInt(jd3[1]!, 10),
      jm: Number.parseInt(jd3[2]!, 10),
      jd: Number.parseInt(jd3[3]!, 10),
      hour: Number.parseInt(jd3[4]!, 10),
      minute: Number.parseInt(jd3[5]!, 10),
      second: 0,
    };
  }
  return null;
}

export const compactSignedParser = {
  id: 'compact-signed-v1',
  version: '1.0.0',

  supports(input: NormalizedSms): boolean {
    const lines = splitLogicalLines(input.text);
    if (lines.length !== 4) return false;
    // Line 1: account hint — at least 5 chars, must contain a digit.
    const acct = lines[0]!;
    if (acct.length < 5 || !/\d/.test(acct)) return false;
    // Line 2: amount (sign optional — parse() resolves direction from
    // explicit phrases when no sign is present).
    if (!AMOUNT_RE.test(lines[1]!)) return false;
    // Variant A: date@3 + balance@4
    if (tryParseDateTime(lines[2]!) && BALANCE_RE.test(lines[3]!)) return true;
    // Variant B: balance@3 + date@4 (historical Parsian-tail layout).
    if (BALANCE_RE.test(lines[2]!) && tryParseDateTime(lines[3]!)) return true;
    return false;
  },

  parse(input: NormalizedSms): ParseResult {
    const lines = splitLogicalLines(input.text);
    const accountHint = lines[0]!;
    const amountLine = lines[1]!;
    // Choose line order based on which line is the date.
    let dateTimeLine: string;
    let balanceLine: string;
    if (tryParseDateTime(lines[2]!) && BALANCE_RE.test(lines[3]!)) {
      dateTimeLine = lines[2]!;
      balanceLine = lines[3]!;
    } else if (BALANCE_RE.test(lines[2]!) && tryParseDateTime(lines[3]!)) {
      dateTimeLine = lines[3]!;
      balanceLine = lines[2]!;
    } else {
      return unsupportedWarn('date/time line missing or balance missing', 'compact_layout_unrecognized');
    }

    const amountMatch = amountLine.match(AMOUNT_RE);
    if (!amountMatch) {
      return unsupportedWarn('amount line malformed', 'compact_amount_malformed');
    }
    const [, signA, digits, signB] = amountMatch as unknown as [string, string, string, string];
    // Captured for parser-symmetry; the compact layout conveys sign through
    // the keywords "برداشت" / "واریز" rather than via this character. Kept
    // destructured so the regex groups stay the canonical 4-tuple shape.
    const _sign = (signA || signB || '+').trim();
    const amountIrr = parseIrr(digits);
    if (amountIrr === null) {
      return unsupportedWarn('amount digits malformed', 'compact_amount_malformed');
    }

    const balanceMatch = balanceLine.match(BALANCE_RE);
    if (!balanceMatch) {
      return unsupportedWarn('balance line malformed', 'compact_balance_malformed');
    }
    const balanceIrr = parseIrr(balanceMatch[1] ?? '');
    if (balanceIrr === null) {
      return unsupportedWarn('balance digits malformed', 'compact_balance_malformed');
    }

    const dt = tryParseDateTime(dateTimeLine);
    if (!dt) {
      return unsupportedWarn('date/time malformed', 'compact_datetime_malformed');
    }

    const smsJ = gregorianToJalali(input.timestamp);
    // If a Jalali year is in the date line, use it directly; otherwise
    // derive the year from sms_timestamp.
    const jy = dt.jy ?? smsJ.jy;
    let bankTimestamp: number;
    const warnings: string[] = [];
    try {
      const candidate = jalaliToGregorianEpochMs(jy, dt.jm, dt.jd, dt.hour, dt.minute, dt.second);
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
    // Phrase override wins over missing sign (same rule as parsian/melli/account-transfer).
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
      return unsupportedWarn('both CREDIT and DEBIT phrases present', 'compact_direction_conflict');
    } else {
      return unsupportedWarn(
        'no sign and no explicit direction phrase',
        'compact_direction_ambiguous',
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
      detectedIdentifierFromRaw(accountHint, 'compact-signed-v1', 0.92),
    ].filter(Boolean);

    return matched({
      classification: 'BANK_TRANSACTION',
      direction,
      amountIrr,
      balanceIrr,
      accountHint,
      transactionReference: null,
      confidence: 0.92,
      parserId: 'compact-signed-v1',
      parserVersion: '1.0.0',
      evidence: {
        bank: 'UNKNOWN',
        accountHint,
        directionSource,
        amountRaw: `${signA}${digits}${signB}`.replace(/\s+/g, ''),
        balanceRaw: balanceMatch[1] ?? '',
        dateRaw: dateTimeLine,
        timeRaw: dateTimeLine,
        bankTimestamp,
        dateFormatHint: dt.jy === null ? 'gregorian_no_year' : 'jalali_with_year',
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
    parserId: 'compact-signed-v1',
    parserVersion: '1.0.0',
    evidence: { reason, code },
    warnings: [code],
  };
}
