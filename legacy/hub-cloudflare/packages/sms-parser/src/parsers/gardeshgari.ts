/**
 * Gardeshgari Bank (Tourism Bank) credit SMS parser.
 *
 * Layout (after normalization):
 *   *بانک گردشگری*
 *   کارت
 *   واریز به: <account-number>      e.g. 110.9992.2377306.1
 *   مبلغ: <amount> ریال
 *   <MM/DD>/<YY>_<HH>:<mm>          e.g. 05/05/14_09:45
 *   موجودی: <balance> ریال
 *
 * Direction: CREDIT (explicit "واریز" phrase).
 *
 * The bank name is prefixed with optional asterisks; we accept either form.
 * Recognized variants of each Persian keyword after normalization:
 *   بانك / بانک
 *   واريز / واریز
 *   موجودی / موجودی
 *   ریال / ریال
 *
 * Date format is Jalali YY/MM/DD in 2-digit form (interpreted as 14YY).
 * If the resulting Jalali date is more than 2 days from sms_timestamp, fall
 * back to sms_timestamp with BANK_TIME_FALLBACK_TO_SMS_TIMESTAMP warning.
 *
 * classification: BANK_TRANSACTION.
 */

import type { NormalizedSms, ParseResult } from '@hub/contracts';
import { matched } from './types.js';
import { gregorianToJalali, jalaliToGregorianEpochMs } from '../jalali.js';
import { parseIrr } from '../normalize.js';
import { detectedIdentifierFromRaw } from '../identifier.js';

const DAY_MS = 86_400_000;
const FALLBACK_THRESHOLD_DAYS = 2;

// Header check: must mention گردشگری and either بانک or بانك.
function isGardeshgari(text: string): boolean {
  return /گردشگری/.test(text) && /(بانک|بانك)/.test(text);
}

export const gardeshgariCreditParser = {
  id: 'gardeshgari-credit-v1',
  version: '1.0.0',

  supports(input: NormalizedSms): boolean {
    return isGardeshgari(input.text);
  },

  parse(input: NormalizedSms): ParseResult {
    const text = input.text;
    const accountHint = extractValueAfter(text, /(?:واريز|واریز)\s*به\s*:?\s*/);
    const amountRaw = extractValueAfter(text, /مبلغ\s*:?\s*/);
    const balanceRaw = extractValueAfter(text, /(?:موجودي|موجودی)\s*:?\s*/);
    if (!accountHint || !amountRaw || !balanceRaw) {
      return unsupportedWarn('missing required field', 'gardeshgari_missing_field');
    }

    const amountIrr = parseIrr(amountRaw);
    const balanceIrr = parseIrr(balanceRaw);
    if (amountIrr === null || balanceIrr === null) {
      return unsupportedWarn('amount/balance malformed', 'gardeshgari_amount_malformed');
    }

    // Date/time line: "MM/DD/YY_HH:mm"
    const dtMatch = text.match(/(\d{2})\/(\d{2})\/(\d{2})_(\d{1,2}):(\d{2})/);
    if (!dtMatch) {
      return unsupportedWarn('date/time malformed', 'gardeshgari_datetime_malformed');
    }
    const mm = Number.parseInt(dtMatch[1]!, 10);
    const dd = Number.parseInt(dtMatch[2]!, 10);
    const yy = Number.parseInt(dtMatch[3]!, 10);
    const hh = Number.parseInt(dtMatch[4]!, 10);
    const mi = Number.parseInt(dtMatch[5]!, 10);
    // Map 14YY Jalali.
    const jy = 1400 + yy;

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

    // Sanity: ensure the Jalali year agrees with sms_timestamp, otherwise warn.
    const smsJ = gregorianToJalali(input.timestamp);
    if (Math.abs(smsJ.jy - jy) > 0) {
      warnings.push('JALALI_YEAR_MISMATCH');
    }

    const detectedIdentifiers = [
      detectedIdentifierFromRaw(accountHint, 'gardeshgari-credit-v1', 0.99),
    ].filter(Boolean);

    return matched({
      classification: 'BANK_TRANSACTION',
      direction: 'CREDIT',
      amountIrr,
      balanceIrr,
      accountHint,
      transactionReference: null,
      confidence: 0.99,
      parserId: 'gardeshgari-credit-v1',
      parserVersion: '1.0.0',
      evidence: {
        bank: 'GARDESHGARI',
        accountHint,
        directionSource: 'explicit_credit_phrase',
        amountRaw,
        balanceRaw,
        dateRaw: dtMatch[0]!,
        bankTimestamp,
        detectedIdentifiers,
        warnings,
      },
      warnings,
    });
  },
} as const;

function extractValueAfter(text: string, pattern: RegExp): string | null {
  const m = text.match(pattern);
  if (!m) return null;
  const start = (m.index ?? 0) + m[0].length;
  // Read until the next newline or 60 chars.
  const tail = text.slice(start);
  const nl = tail.indexOf('\n');
  const end = nl >= 0 ? nl : Math.min(tail.length, 80);
  return tail.slice(0, end).trim();
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
    parserId: 'gardeshgari-credit-v1',
    parserVersion: '1.0.0',
    evidence: { reason, code },
    warnings: [code],
  };
}
