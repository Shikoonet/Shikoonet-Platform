/**
 * Parsian Bank signed-amount SMS parser.
 *
 * Layout A (4-5 lines, after normalization):
 *   <account-number>          e.g. 30101883751600
 *   مبلغ:<sign><amount>       e.g. مبلغ:1,950,000+  OR  مبلغ:+1,950,000
 *   مانده:<balance>           e.g. مانده:40,913,550
 *   <MM/DD>
 *   <HH:mm>
 *
 * Layout B (5-6 lines, Parsian variant):
 *   <account-number>          e.g. 300432401476
 *   <sign><amount>            e.g. 2,800,000+  (NO مبلغ label)
 *   مانده:<balance>           e.g. مانده:16,234,550
 *   <Jalali date+time>        e.g. 1405/5/14-18:01  OR  1405/05/14 18:01
 *
 * The amount line is either prefixed by `مبلغ:` or a bare signed digits
 * line directly below the account (variant B).
 *
 * Direction:
 *   "+" prefix or suffix on the amount → CREDIT
 *   "-" prefix or suffix on the amount → DEBIT
 *
 * bank_timestamp:
 *   The message supplies MM/DD and HH:mm (layout A) OR a full Jalali
 *   YYYY/M(M)/D(D)-HH:mm line (layout B). For A we derive the year from
 *   sms_timestamp; for B the year is given. If the resulting Jalali date
 *   is more than 2 days away from sms_timestamp (year-boundary ambiguity),
 *   we fall back to sms_timestamp and add BANK_TIME_FALLBACK_TO_SMS_TIMESTAMP.
 *
 * classification: BANK_TRANSACTION.
 */

import type { NormalizedSms, ParseResult } from '@hub/contracts';
import { directionByPhrase, matched } from './types.js';
import { gregorianToJalali, jalaliToGregorianEpochMs } from '../jalali.js';
import { parseIrr } from '../normalize.js';
import { detectedIdentifierFromRaw } from '../identifier.js';

const AMOUNT_LABELED_RE = /^مبلغ\s*:?\s*([+-]?)\s*([\d,،\s]+?)\s*([+-]?)\s*$/;
// Bare signed digits line — accept when there's at least one sign character.
//   "2,800,000+"  → trailing sign  → matches with signA='', signB='+'
//   "+2,800,000"  → leading sign  → matches with signA='+', signB=''
//   "2,800,000"   → neither        → does NOT match (sign is required for variant B)
const AMOUNT_BARE_RE = /^([+-])\s*([\d,،\s]+?)\s*$|^([\d,،\s]+?)\s*([+-])\s*$/;
const BALANCE_RE = /^مانده\s*:?\s*([\d,،\s]+?)\s*$/;
const DATE_RE = /^(\d{2})\/(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;
// Full Jalali YYYY/M(M)/D(D)-HH:mm
const JALALI_DASH_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})-(\d{1,2}):(\d{2})$/;
// Full Jalali YYYY/MM/DD HH:mm
const JALALI_SPACE_RE = /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2})$/;
// Full Jalali YYYY/MM/DD_HH:mm (underscore)
const JALALI_UNDERSCORE_RE = /^(\d{4})\/(\d{2})\/(\d{2})_(\d{1,2}):(\d{2})$/;
const ACCOUNT_HINT_RE = /^\d{8,}$/;

const DAY_MS = 86_400_000;
const FALLBACK_THRESHOLD_DAYS = 2;

export const parsianParser = {
  id: 'parsian-signed-v1',
  version: '1.0.0',

  supports(input: NormalizedSms): boolean {
    const lines = input.text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 4) return false;
    // First line is a long digit run — account number.
    if (!ACCOUNT_HINT_RE.test(lines[0]!)) return false;
    // Body must contain a مانده line.
    if (!lines.some((l) => /^مانده\s*:/.test(l))) return false;
    // Amount: REQUIRES a labeled `مبلغ:` line. Bare-signed-amount layouts
    // (account, signed digits, date, balance) belong to the compact parser;
    // accepting them here would shadow compact and pin those messages to the
    // Parsian parser ID, which is wrong for non-Parsian banks.
    const hasLabeledAmount = lines.some((l) => /^مبلغ\s*:/.test(l));
    if (!hasLabeledAmount) return false;
    // Date / time: either MM/DD + HH:mm after balance (layout A) OR a full
    // Jalali line anywhere after balance (layout B).
    const tail = lines.slice(1);
    const hasLayoutADate = tail.some((l) => DATE_RE.test(l)) && tail.some((l) => TIME_RE.test(l));
    const hasLayoutBDate =
      tail.some((l) => JALALI_DASH_RE.test(l)) ||
      tail.some((l) => JALALI_SPACE_RE.test(l)) ||
      tail.some((l) => JALALI_UNDERSCORE_RE.test(l));
    return hasLayoutADate || hasLayoutBDate;
  },

  parse(input: NormalizedSms): ParseResult {
    const lines = input.text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const accountHint = lines[0]!;
    const balanceLine = lines.find((l) => /^مانده\s*:/.test(l));
    if (!balanceLine) {
      return unsupportedWarn('مانده line missing', 'parsian_missing_field');
    }

    // Amount: prefer the labeled line; fall back to a bare signed digits
    // line on the row immediately below the account.
    let amountLine = lines.find((l) => /^مبلغ\s*:/.test(l));
    let amountLabeled = true;
    if (!amountLine) {
      const candidate = lines[1] ?? '';
      if (AMOUNT_BARE_RE.test(candidate)) {
        amountLine = candidate;
        amountLabeled = false;
      }
    }
    if (!amountLine) {
      return unsupportedWarn('مبلغ or bare-signed line missing', 'parsian_missing_field');
    }

    // Scan the whole body, not just the post-balance tail: real-world
    // bank SMS sometimes puts the date line BEFORE the balance line
    // (the compact 4-line layout: account, amount, date, balance).
    // The compact parser will claim that layout; this fallback only
    // fires when there's no other competent parser in the registry.
    const tail = lines.slice(lines.indexOf(balanceLine) + 1);
    const bankDateTime = pickBankDateTime(tail, input.timestamp);
    if (!bankDateTime) {
      return unsupportedWarn('date/time line missing', 'parsian_datetime_missing');
    }

    const regex = amountLabeled ? AMOUNT_LABELED_RE : AMOUNT_BARE_RE;
    const amountMatch = amountLine.match(regex);
    if (!amountMatch) {
      return unsupportedWarn('مبلغ line malformed', 'parsian_amount_malformed');
    }
    let signA: string;
    let digits: string;
    let signB: string;
    let amountStr: string;
    if (amountLabeled) {
      [, signA, digits, signB] = amountMatch as unknown as [string, string, string, string];
      amountStr = `${signA}${digits}${signB}`.replace(/\s+/g, '');
    } else {
      // AMOUNT_BARE_RE alternation: group 1+2 = leading sign; group 3+4 = digits+trailing sign.
      const m = amountMatch as unknown as [string, string, string, string, string];
      if (m[1] !== undefined && m[1] !== '') {
        signA = m[1];
        digits = m[2]!;
        signB = '+';
      } else {
        signA = '+';
        digits = m[3]!;
        signB = m[4]!;
      }
      amountStr = `${signA}${digits}${signB}`.replace(/\s+/g, '');
    }
    const amountIrr = parseIrr(digits);
    if (amountIrr === null) {
      return unsupportedWarn('مبلغ digits malformed', 'parsian_amount_malformed');
    }

    const balanceMatch = balanceLine.match(BALANCE_RE);
    if (!balanceMatch) {
      return unsupportedWarn('مانده line malformed', 'parsian_balance_malformed');
    }
    const balanceIrr = parseIrr(balanceMatch[1] ?? '');
    if (balanceIrr === null) {
      return unsupportedWarn('مانده digits malformed', 'parsian_balance_malformed');
    }

    let bankTimestamp: number;
    const warnings: string[] = [];
    try {
      bankTimestamp = jalaliToGregorianEpochMs(
        bankDateTime.jy,
        bankDateTime.jm,
        bankDateTime.jd,
        bankDateTime.hh,
        bankDateTime.mi,
      );
      // Drift check is meaningful only for layout A (year derived from sms_timestamp).
      if (bankDateTime.kind === 'gregorian_no_year') {
        const drift = Math.abs(bankTimestamp - input.timestamp);
        if (drift > FALLBACK_THRESHOLD_DAYS * DAY_MS) {
          bankTimestamp = input.timestamp;
          warnings.push('BANK_TIME_FALLBACK_TO_SMS_TIMESTAMP');
        }
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
    // Phrase override wins over missing sign: if the body has a DEBIT phrase
    // and no CREDIT phrase, force DEBIT. If no phrase AND no explicit sign,
    // return UNKNOWN so the product never defaults to CREDIT.
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
      return unsupportedWarn('both CREDIT and DEBIT phrases present', 'parsian_direction_conflict');
    } else {
      // No phrase, no sign → never default to CREDIT. The product rule is
      // "if direction cannot be determined confidently, do NOT default to
      // CREDIT". Return UNKNOWN so ingest skips this row.
      return unsupportedWarn(
        'no sign and no explicit direction phrase',
        'parsian_direction_ambiguous',
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
      detectedIdentifierFromRaw(lines[0] ?? '', 'parsian-signed-v1', 0.97),
    ].filter(Boolean);

    return matched({
      classification: 'BANK_TRANSACTION',
      direction,
      amountIrr,
      balanceIrr,
      accountHint,
      transactionReference: null,
      confidence: 0.97,
      parserId: 'parsian-signed-v1',
      parserVersion: '1.0.0',
      evidence: {
        bank: 'PARSIAN',
        accountHint,
        directionSource,
        amountRaw: amountStr,
        balanceRaw: balanceMatch[1] ?? '',
        dateRaw: bankDateTime.raw,
        timeRaw: bankDateTime.raw,
        bankTimestamp,
        detectedIdentifiers,
        warnings: [...warnings, ...extraWarnings],
      },
      warnings: [...warnings, ...extraWarnings],
    });
  },
} as const;

type BankDateTime =
  | {
      kind: 'gregorian_no_year';
      jy: number;
      jm: number;
      jd: number;
      hh: number;
      mi: number;
      raw: string;
    }
  | {
      kind: 'jalali_full';
      jy: number;
      jm: number;
      jd: number;
      hh: number;
      mi: number;
      raw: string;
    };

/**
 * Pick the bank date+time from the tail of the SMS body.
 *
 * Tries (in order):
 *   - full Jalali `YYYY/M(M)/D(D)-HH:mm`
 *   - full Jalali `YYYY/MM/DD HH:mm`
 *   - full Jalali `YYYY/MM/DD_HH:mm`
 *   - separate Gregorian `MM/DD` + `HH:mm`
 *
 * Returns null when none of these match.
 */
function pickBankDateTime(tail: string[], smsTimestamp: number): BankDateTime | null {
  for (const l of tail) {
    const m = l.match(JALALI_DASH_RE);
    if (m) {
      return {
        kind: 'jalali_full',
        jy: Number.parseInt(m[1]!, 10),
        jm: Number.parseInt(m[2]!, 10),
        jd: Number.parseInt(m[3]!, 10),
        hh: Number.parseInt(m[4]!, 10),
        mi: Number.parseInt(m[5]!, 10),
        raw: l,
      };
    }
  }
  for (const l of tail) {
    const m = l.match(JALALI_SPACE_RE);
    if (m) {
      return {
        kind: 'jalali_full',
        jy: Number.parseInt(m[1]!, 10),
        jm: Number.parseInt(m[2]!, 10),
        jd: Number.parseInt(m[3]!, 10),
        hh: Number.parseInt(m[4]!, 10),
        mi: Number.parseInt(m[5]!, 10),
        raw: l,
      };
    }
  }
  for (const l of tail) {
    const m = l.match(JALALI_UNDERSCORE_RE);
    if (m) {
      return {
        kind: 'jalali_full',
        jy: Number.parseInt(m[1]!, 10),
        jm: Number.parseInt(m[2]!, 10),
        jd: Number.parseInt(m[3]!, 10),
        hh: Number.parseInt(m[4]!, 10),
        mi: Number.parseInt(m[5]!, 10),
        raw: l,
      };
    }
  }
  const dateLine = tail.find((l) => DATE_RE.test(l));
  const timeLine = tail.find((l) => TIME_RE.test(l));
  if (dateLine && timeLine) {
    const d = dateLine.match(DATE_RE)!;
    const t = timeLine.match(TIME_RE)!;
    const smsJ = gregorianToJalali(smsTimestamp);
    return {
      kind: 'gregorian_no_year',
      jy: smsJ.jy,
      jm: Number.parseInt(d[1]!, 10),
      jd: Number.parseInt(d[2]!, 10),
      hh: Number.parseInt(t[1]!, 10),
      mi: Number.parseInt(t[2]!, 10),
      raw: `${dateLine} ${timeLine}`,
    };
  }
  return null;
}

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
    parserId: 'parsian-signed-v1',
    parserVersion: '1.0.0',
    evidence: { reason, code },
    warnings: [code],
  };
}
