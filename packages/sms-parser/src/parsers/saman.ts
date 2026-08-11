/**
 * Saman Bank (بانک سامان) deposit SMS parser.
 *
 * Layout (after normalization):
 *   <header keywords>             e.g. "بانك سامان" / "بانک سامان"
 *   واريز مبلغ  <amount>ریال      e.g. "واريز مبلغ  1,000,000ریال"
 *   به  <account>                 e.g. "به  901-777-2938283-1"
 *   مانده <balance>               e.g. "مانده 12,814,704"
 *   <JY>/<M>/<D>                  e.g. "1405/5/15"  (Jalali date, year explicit)
 *   <HH>:<mm>                     e.g. "20:48"      (time on a separate line)
 *
 * Direction: always CREDIT. The "واريز" / "واریز" phrase on the amount line
 * is treated as an authoritative CREDIT signal — same convention as the
 * Shahr / Gardeshgari parsers (both also bank-specific CREDIT-only).
 *
 * Account hint: kept as the raw post-`به` string with hyphens / dots /
 * leading zeros preserved. The identifier normalizer folds whitespace,
 * bidi marks, and Persian/Arabic digit runs but leaves the structural
 * separators alone, so the normalized identifier round-trips back to the
 * same canonical form.
 *
 * Date format is full Jalali YYYY/M(M)/D(D) — the year is given so no
 * sms_timestamp fallback is needed.
 *
 * classification: BANK_TRANSACTION.
 */

import type { NormalizedSms, ParseResult } from '@shikoo/contracts';
import { matched } from './types.js';
import { jalaliToGregorianEpochMs } from '../jalali.js';
import { parseIrr } from '../normalize.js';
import { detectedIdentifierFromRaw } from '../identifier.js';

const AMOUNT_RE = /^(?:واريز|واریز)\s*مبلغ\s*:?\s*([\d,،\s]+?)(?:\s*ریال|\s*ريال)?\s*$/;
const ACCOUNT_RE = /^به\s*:?\s*(.+)$/;
const BALANCE_RE = /^مانده\s*:?\s*([\d,،\s]+?)\s*$/;
// JY/M(M)/D(D)  — full Jalali date (year given explicitly)
const DATE_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
// HH:mm on a separate line.
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

function isSaman(text: string): boolean {
  return /(بانک|بانك)\s*سامان/.test(text);
}

export const samanCreditParser = {
  id: 'saman-credit-v1',
  version: '1.0.0',

  supports(input: NormalizedSms): boolean {
    if (!isSaman(input.text)) return false;
    const lines = input.text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    // Need: header + amount + account + balance + date + time = 6 lines.
    if (lines.length < 6) return false;
    const hasAmount = lines.some((l) => AMOUNT_RE.test(l));
    const hasAccount = lines.some((l) => ACCOUNT_RE.test(l));
    const hasBalance = lines.some((l) => BALANCE_RE.test(l));
    const hasDate = lines.some((l) => DATE_RE.test(l));
    const hasTime = lines.some((l) => TIME_RE.test(l));
    return hasAmount && hasAccount && hasBalance && hasDate && hasTime;
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
    const timeLine = lines.find((l) => TIME_RE.test(l));
    if (!amountLine || !accountLine || !balanceLine || !dateLine || !timeLine) {
      return unsupportedWarn('required field missing', 'saman_missing_field');
    }

    const amountMatch = amountLine.match(AMOUNT_RE);
    if (!amountMatch) {
      return unsupportedWarn('amount line malformed', 'saman_amount_malformed');
    }
    const amountIrr = parseIrr(amountMatch[1] ?? '');
    if (amountIrr === null) {
      return unsupportedWarn('amount digits malformed', 'saman_amount_malformed');
    }

    const accountMatch = accountLine.match(ACCOUNT_RE);
    const accountHint = (accountMatch?.[1] ?? '').trim();
    if (!accountHint || accountHint.length < 5) {
      return unsupportedWarn('account hint too short', 'saman_account_too_short');
    }

    const balanceMatch = balanceLine.match(BALANCE_RE);
    if (!balanceMatch) {
      return unsupportedWarn('مانده line malformed', 'saman_balance_malformed');
    }
    const balanceIrr = parseIrr(balanceMatch[1] ?? '');
    if (balanceIrr === null) {
      return unsupportedWarn('مانده digits malformed', 'saman_balance_malformed');
    }

    const dtMatch = dateLine.match(DATE_RE);
    if (!dtMatch) {
      return unsupportedWarn('date malformed', 'saman_datetime_malformed');
    }
    const jy = Number.parseInt(dtMatch[1]!, 10);
    const jm = Number.parseInt(dtMatch[2]!, 10);
    const jd = Number.parseInt(dtMatch[3]!, 10);

    const tmMatch = timeLine.match(TIME_RE);
    if (!tmMatch) {
      return unsupportedWarn('time malformed', 'saman_datetime_malformed');
    }
    const hh = Number.parseInt(tmMatch[1]!, 10);
    const mi = Number.parseInt(tmMatch[2]!, 10);

    let bankTimestamp: number;
    const warnings: string[] = [];
    try {
      bankTimestamp = jalaliToGregorianEpochMs(jy, jm, jd, hh, mi, 0);
    } catch {
      bankTimestamp = input.timestamp;
      warnings.push('BANK_TIME_FALLBACK_TO_SMS_TIMESTAMP');
    }

    const detectedIdentifiers = [
      detectedIdentifierFromRaw(accountHint, 'saman-credit-v1', 0.99),
    ].filter(Boolean);

    return matched({
      classification: 'BANK_TRANSACTION',
      direction: 'CREDIT',
      amountIrr,
      balanceIrr,
      accountHint,
      transactionReference: null,
      confidence: 0.99,
      parserId: 'saman-credit-v1',
      parserVersion: '1.0.0',
      evidence: {
        bank: 'SAMAN',
        accountHint,
        directionSource: 'explicit_credit_phrase',
        amountRaw: amountMatch[1] ?? '',
        balanceRaw: balanceMatch[1] ?? '',
        dateRaw: dateLine,
        timeRaw: timeLine,
        bankTimestamp,
        detectedIdentifiers,
        warnings,
      },
      warnings,
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
    parserId: 'saman-credit-v1',
    parserVersion: '1.0.0',
    evidence: { reason, code },
    warnings: [code],
  };
}