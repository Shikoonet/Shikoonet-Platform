/**
 * Shahr Bank credit SMS parser.
 *
 * Layout (after normalization):
 *   *بانک شهر*
 *   انتقال وجه کارتی
 *   واریز به: <account-number>
 *   مبلغ: <amount> ریال
 *   موجودی: <balance> ریال
 *   <JY>/<M(M)>/<D(D)> <HH>:<mm>[:<ss>]   full Jalali date; the bank sends
 *                                         single-digit months and days, and
 *                                         sometimes omits the seconds
 *
 * Direction: CREDIT (explicit "واریز" phrase).
 *
 * The date is read AFTER the amount and the account, and it cannot veto them.
 * This paragraph used to say «no fallback needed since the message supplies the
 * year directly», which was true about the year and wrong about everything
 * else: the pattern demanded a two-digit day, the bank sent `1405/06/7`, and a
 * real 3,990,000 IRR deposit came back UNKNOWN with no amount at all. An
 * unreadable date now costs `BANK_TIME_FALLBACK_TO_SMS_TIMESTAMP` and nothing
 * more.
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

    // Full Jalali date: "1405/05/14 08:22:17", and the shapes the bank also
    // sends: a single-digit month or day (`1405/06/7`), and no seconds.
    //
    // The month and day were `\d{2}` exactly. On 2026-08-29 the shop forwarded
    // a real 3,990,000 IRR deposit written `1405/06/7`, and one missing zero
    // took the whole message: the amount and the account are read three lines
    // above this, and a date that did not match threw all of it away.
    const dtMatch = text.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);

    let bankTimestamp: number;
    const warnings: string[] = [];
    // A date this parser cannot read is a warning, not a lost payment. The
    // fallback already existed for a Jalali conversion that throws; an
    // unrecognised layout is the same kind of problem and gets the same answer.
    // Nothing downstream matches on this value — `ingest` records the phone's
    // own timestamp — so the cost of being wrong here is an evidence field,
    // and the cost of rejecting is a customer who paid and was not credited.
    if (!dtMatch) {
      bankTimestamp = input.timestamp;
      warnings.push('BANK_TIME_FALLBACK_TO_SMS_TIMESTAMP');
    } else {
      const jy = Number.parseInt(dtMatch[1]!, 10);
      const jm = Number.parseInt(dtMatch[2]!, 10);
      const jd = Number.parseInt(dtMatch[3]!, 10);
      const hh = Number.parseInt(dtMatch[4]!, 10);
      const mi = Number.parseInt(dtMatch[5]!, 10);
      const ss = dtMatch[6] ? Number.parseInt(dtMatch[6], 10) : 0;
      try {
        bankTimestamp = jalaliToGregorianEpochMs(jy, jm, jd, hh, mi, ss);
      } catch {
        bankTimestamp = input.timestamp;
        warnings.push('BANK_TIME_FALLBACK_TO_SMS_TIMESTAMP');
      }
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
        // Nullable since the parse stopped depending on the date: the `!` here
        // was safe only while a missing date returned early, and threw the
        // moment that changed. Evidence records what was read, including
        // nothing.
        dateRaw: dtMatch?.[0] ?? null,
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
