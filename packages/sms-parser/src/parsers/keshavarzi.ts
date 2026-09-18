/**
 * Keshavarzi Bank (بانک کشاورزی, signs off «bki.ir») transaction SMS.
 *
 * Layout (after normalization), no colon after any label:
 *   واریز1,000,000          or  واریز پل1,000,000  (a Pol transfer)  or  برداشت…
 *   مانده12,054,098
 *   050627-21:30            YYMMDD-HH:mm, Jalali, 14YY
 *   کارت4006*               or a bare account number
 *   bki. ir
 *
 * Why a named parser: `generic-credit` takes the LAST number in the body as
 * the balance, and here that is the card's «4006». Every Keshavarzi row on
 * production carried balance 4,006 IRR, so «دفتر بانک» opened the account
 * on 400 toman and every deposit showed as a gap. Seen 2026-09-19.
 */

import type { NormalizedSms, ParseResult } from '@shikoo/contracts';
import { matched } from './types.js';
import { jalaliToGregorianEpochMs } from '../jalali.js';
import { parseIrr } from '../normalize.js';
import { maskIdentifier } from '../identifier.js';

const DAY_MS = 86_400_000;
const FALLBACK_THRESHOLD_DAYS = 2;

const AMOUNT_RE = /^(واریز|برداشت)(?:\s*پل)?\s*:?\s*([\d,،]+)\s*$/;
const BALANCE_RE = /^مانده\s*:?\s*([\d,،]+)\s*$/;
const DATE_RE = /^(\d{2})(\d{2})(\d{2})-(\d{1,2}):(\d{2})$/;
const CARD_RE = /^کارت\s*:?\s*(\d{4})\*?$/;
const ACCOUNT_RE = /^\d{6,}$/;

function isKeshavarzi(input: NormalizedSms): boolean {
  return /bki\s*\.\s*ir/i.test(input.text) || /keshavarzi/i.test(input.sender);
}

export const keshavarziParser = {
  id: 'keshavarzi-v1',
  version: '1.0.0',

  supports(input: NormalizedSms): boolean {
    if (!isKeshavarzi(input)) return false;
    const lines = input.text.split('\n').map((l) => l.trim());
    return lines.some((l) => AMOUNT_RE.test(l)) && lines.some((l) => BALANCE_RE.test(l));
  },

  parse(input: NormalizedSms): ParseResult {
    const lines = input.text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const amountMatch = lines.map((l) => l.match(AMOUNT_RE)).find(Boolean);
    const balanceMatch = lines.map((l) => l.match(BALANCE_RE)).find(Boolean);
    if (!amountMatch || !balanceMatch) {
      return unsupportedWarn('keshavarzi required field missing', 'keshavarzi_missing_field');
    }
    const amountIrr = parseIrr(amountMatch[2]!);
    const balanceIrr = parseIrr(balanceMatch[1]!);
    if (amountIrr === null) return unsupportedWarn('amount malformed', 'keshavarzi_amount_malformed');
    if (balanceIrr === null) return unsupportedWarn('مانده malformed', 'keshavarzi_balance_malformed');
    const direction = amountMatch[1] === 'واریز' ? 'CREDIT' : 'DEBIT';

    // The bank's own clock, when it parses and is near the phone's; else the phone's.
    let bankTimestamp = input.timestamp;
    const warnings: string[] = [];
    const dt = lines.map((l) => l.match(DATE_RE)).find(Boolean);
    if (dt) {
      try {
        const candidate = jalaliToGregorianEpochMs(
          1400 + Number.parseInt(dt[1]!, 10),
          Number.parseInt(dt[2]!, 10),
          Number.parseInt(dt[3]!, 10),
          Number.parseInt(dt[4]!, 10),
          Number.parseInt(dt[5]!, 10),
        );
        if (Math.abs(candidate - input.timestamp) <= FALLBACK_THRESHOLD_DAYS * DAY_MS) bankTimestamp = candidate;
        else warnings.push('BANK_TIME_FALLBACK_TO_SMS_TIMESTAMP');
      } catch {
        warnings.push('BANK_TIME_FALLBACK_TO_SMS_TIMESTAMP');
      }
    }

    const card = lines.map((l) => l.match(CARD_RE)).find(Boolean)?.[1] ?? null;
    const account = card ? null : (lines.find((l) => ACCOUNT_RE.test(l)) ?? null);
    const accountHint = card ?? account;

    return matched({
      classification: 'BANK_TRANSACTION',
      direction,
      amountIrr,
      balanceIrr,
      accountHint,
      transactionReference: null,
      confidence: 0.95,
      parserId: 'keshavarzi-v1',
      parserVersion: '1.0.0',
      evidence: {
        bank: 'KESHAVARZI',
        accountHint,
        directionSource: direction === 'CREDIT' ? 'explicit_credit_phrase' : 'explicit_debit_phrase',
        amountRaw: amountMatch[2],
        balanceRaw: balanceMatch[1],
        dateRaw: dt?.[0] ?? null,
        bankTimestamp,
        detectedIdentifiers: accountHint
          ? [
              {
                type: card ? ('CARD_LAST_FOUR' as const) : ('ACCOUNT_NUMBER' as const),
                normalizedValue: accountHint,
                maskedValue: maskIdentifier(accountHint),
                confidence: 0.92,
                parserId: 'keshavarzi-v1',
              },
            ]
          : [],
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
    parserId: 'keshavarzi-v1',
    parserVersion: '1.0.0',
    evidence: { reason, code },
    warnings: [code],
  };
}
