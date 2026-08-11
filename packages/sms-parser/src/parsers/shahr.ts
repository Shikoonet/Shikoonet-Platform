/**
 * Shahr Bank credit SMS parser.
 *
 * Layout (after normalization):
 *   *بانک شهر*
 *   انتقال وجه کارتی
 *   واریز به: <account-number>
 *   مبلغ: <amount> ریال
 *   موجودی: <balance> ریال
 *   <JY>/<MM>/<DD> <HH>:<mm>:<ss>     full Jalali date
 *
 * Direction: CREDIT (explicit "واریز" phrase).
 *
 * Date format is the FULL Jalali 4-digit year — no fallback needed since the
 * message supplies the year directly.
 *
 * classification: BANK_TRANSACTION.
 */

import type { NormalizedSms, ParseResult } from '@shikoo/contracts';
import { matched } from './types.js';
import { jalaliToGregorianEpochMs } from '../jalali.js';
import { parseIrr } from '../normalize.js';
import { detectedIdentifierFromRaw } from '../identifier.js';

function isShahr(text: string): boolean {
  return /(بانک|بانك)\s*شهر/.test(text);
}

export const shahrCreditParser = {
  id: 'shahr-credit-v1',
  version: '1.0.0',

  supports(input: NormalizedSms): boolean {
    return isShahr(input.text);
  },

  parse(input: NormalizedSms): ParseResult {
    const text = input.text;
    const accountHint = extractValueAfter(text, /(?:واريز|واریز)\s*به\s*:?\s*/);
    const amountRaw = extractValueAfter(text, /مبلغ\s*:?\s*/);
    const balanceRaw = extractValueAfter(text, /(?:موجودي|موجودی)\s*:?\s*/);
    if (!accountHint || !amountRaw || !balanceRaw) {
      return unsupportedWarn('missing required field', 'shahr_missing_field');
    }

    const amountIrr = parseIrr(amountRaw);
    const balanceIrr = parseIrr(balanceRaw);
    if (amountIrr === null || balanceIrr === null) {
      return unsupportedWarn('amount/balance malformed', 'shahr_amount_malformed');
    }

    // Full Jalali date: "1405/05/14 08:22:17"
    const dtMatch = text.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})/);
    if (!dtMatch) {
      return unsupportedWarn('date/time malformed', 'shahr_datetime_malformed');
    }
    const jy = Number.parseInt(dtMatch[1]!, 10);
    const jm = Number.parseInt(dtMatch[2]!, 10);
    const jd = Number.parseInt(dtMatch[3]!, 10);
    const hh = Number.parseInt(dtMatch[4]!, 10);
    const mi = Number.parseInt(dtMatch[5]!, 10);
    const ss = Number.parseInt(dtMatch[6]!, 10);

    let bankTimestamp: number;
    const warnings: string[] = [];
    try {
      bankTimestamp = jalaliToGregorianEpochMs(jy, jm, jd, hh, mi, ss);
    } catch {
      bankTimestamp = input.timestamp;
      warnings.push('BANK_TIME_FALLBACK_TO_SMS_TIMESTAMP');
    }

    const detectedIdentifiers = [
      detectedIdentifierFromRaw(accountHint, 'shahr-credit-v1', 0.99),
    ].filter(Boolean);

    return matched({
      classification: 'BANK_TRANSACTION',
      direction: 'CREDIT',
      amountIrr,
      balanceIrr,
      accountHint,
      transactionReference: null,
      confidence: 0.99,
      parserId: 'shahr-credit-v1',
      parserVersion: '1.0.0',
      evidence: {
        bank: 'SHAHR',
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
    parserId: 'shahr-credit-v1',
    parserVersion: '1.0.0',
    evidence: { reason, code },
    warnings: [code],
  };
}
