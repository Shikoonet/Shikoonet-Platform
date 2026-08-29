/**
 * Bank Mellat (بانک ملت) deposit SMS parser.
 *
 * Layout (after normalization):
 *   حساب<account>          e.g. "حساب4436995648"   — no colon, digits touch the word
 *   واریز                  the credit phrase, on its own line
 *   <amount>               e.g. "1,000,000"        — a bare number, no currency word
 *   مانده <balance>        e.g. "مانده 56,773,273"
 *   <YY>/<MM>/<DD>-<HH>:<mm>
 *
 * ## Why this parser exists at all
 *
 * Until 2026-08-29 Mellat had none, so its messages fell through to
 * `generic-credit`, which takes the FIRST number in the body. In this layout
 * the first number is the account, so a real 1,000,000 IRR deposit was recorded
 * as **4,436,995,648 IRR** — the account digits, read as money.
 *
 * That is worse than not parsing at all. An unparsed message is visible on
 * «رویدادها» and costs one payment; a wrong amount writes a deposit into the
 * ledger that never happened, moves the day's totals, and still loses the real
 * payment because nothing will ever match it.
 *
 * ## The two numbers this parser must never confuse
 *
 * The account and the amount are both bare digit runs, and the only thing that
 * tells them apart is the word in front of them. So the account is read FIRST,
 * by its own anchor, and removed from the text before any amount is looked for.
 * Reading them in the other order is precisely the bug above.
 */

import type { NormalizedSms, ParseResult } from '@shikoo/contracts';
import { matched } from './types.js';
import { jalaliToGregorianEpochMs } from '../jalali.js';
import { parseIrr } from '../normalize.js';
import { detectedIdentifierFromRaw } from '../identifier.js';

/**
 * `[^\S\n]` throughout — every whitespace character EXCEPT the line break.
 *
 * Both halves of that matter, and each was wrong once. A plain `\s` crosses the
 * line break: it took `56,773,273` from the balance line plus the `05` that
 * begins the date line and read the balance as 5,677,327,305. A plain `[ \t]`
 * is the opposite mistake — `normalizeText` leaves a non-breaking space as
 * U+00A0, so a body whose spaces are NBSP stopped matching at all and fell
 * through to `generic-credit`, which is the bug this file exists to fix.
 */
const ACCOUNT_RE = /حساب[^\S\n]*[:：]?[^\S\n]*(\d[\d-]{4,})/;
const CREDIT_RE = /(?:واریز|واريز)/;
const BALANCE_RE = /مانده[^\S\n]*(?:حساب)?[^\S\n]*[:：]?[^\S\n]*([\d,،](?:[\d,،]|[^\S\n])*)/;
/** `YY/MM/DD-HH:mm`, the two-digit-year form Mellat sends. */
const DATE_RE = /(\d{2})\/(\d{1,2})\/(\d{1,2})[-\s_]+(\d{1,2}):(\d{2})/;
/** A thousands-separated number — what an amount looks like when nothing labels it. */
const AMOUNT_RE = /(\d{1,3}(?:[,،]\d{3})+)/;

/**
 * A Mellat message, told apart from the seven other banks by the shape only it
 * has: the word `حساب` carrying its digits AND a bare `واریز` AND a `مانده`.
 *
 * Deliberately narrow. Maskan writes `حساب:` too, but on an
 * `انتقال اینترنت` line and with no `واریز`; Saman has `واریز` and `مانده` but
 * no `حساب`; Shahr says `موجودی` rather than `مانده`. Each of those has its own
 * parser and runs before this one anyway — the point of the conjunction is that
 * a future bank cannot fall in here by accident.
 */
function isMellat(text: string): boolean {
  return ACCOUNT_RE.test(text) && CREDIT_RE.test(text) && BALANCE_RE.test(text);
}

export const mellatCreditParser = {
  id: 'mellat-credit-v1',
  version: '1.0.0',

  supports(input: NormalizedSms): boolean {
    return isMellat(input.text);
  },

  parse(input: NormalizedSms): ParseResult {
    const text = input.text;

    const accountMatch = text.match(ACCOUNT_RE);
    if (!accountMatch) return unsupportedWarn('no account', 'mellat_missing_field');
    const accountHint = (accountMatch[1] ?? '').replace(/\s+/g, '').trim();
    if (accountHint.length < 5) {
      return unsupportedWarn('account hint too short', 'mellat_account_too_short');
    }

    const balanceMatch = text.match(BALANCE_RE);
    if (!balanceMatch) return unsupportedWarn('no balance', 'mellat_missing_field');
    const balanceIrr = parseIrr(balanceMatch[1] ?? '');
    if (balanceIrr === null) {
      return unsupportedWarn('balance digits malformed', 'mellat_balance_malformed');
    }

    // The account and the balance are taken OUT before the amount is looked
    // for, so neither can be mistaken for it. This is the whole parser.
    const remainder = text.replace(accountMatch[0], ' ').replace(balanceMatch[0], ' ');
    const amountMatch = remainder.match(AMOUNT_RE);
    if (!amountMatch) return unsupportedWarn('no amount', 'mellat_amount_missing');
    const amountIrr = parseIrr(amountMatch[1] ?? '');
    if (amountIrr === null) {
      return unsupportedWarn('amount digits malformed', 'mellat_amount_malformed');
    }

    let bankTimestamp: number;
    const warnings: string[] = [];
    const dtMatch = text.match(DATE_RE);
    if (!dtMatch) {
      bankTimestamp = input.timestamp;
      warnings.push('BANK_TIME_FALLBACK_TO_SMS_TIMESTAMP');
    } else {
      // Two-digit Jalali year: `05` is 1405. The century comes from the message
      // having just arrived, not from a constant — a hardcoded `1400 +` would
      // be a bomb with a seventy-five year fuse.
      const century = Math.floor(jalaliYearOf(input.timestamp) / 100) * 100;
      const jy = century + Number.parseInt(dtMatch[1]!, 10);
      const jm = Number.parseInt(dtMatch[2]!, 10);
      const jd = Number.parseInt(dtMatch[3]!, 10);
      const hh = Number.parseInt(dtMatch[4]!, 10);
      const mi = Number.parseInt(dtMatch[5]!, 10);
      try {
        bankTimestamp = jalaliToGregorianEpochMs(jy, jm, jd, hh, mi, 0);
      } catch {
        bankTimestamp = input.timestamp;
        warnings.push('BANK_TIME_FALLBACK_TO_SMS_TIMESTAMP');
      }
    }

    const detectedIdentifiers = [
      detectedIdentifierFromRaw(accountHint, 'mellat-credit-v1', 0.99),
    ].filter(Boolean);

    return matched({
      classification: 'BANK_TRANSACTION',
      direction: 'CREDIT',
      amountIrr,
      balanceIrr,
      accountHint,
      transactionReference: null,
      confidence: 0.95,
      parserId: 'mellat-credit-v1',
      parserVersion: '1.0.0',
      evidence: {
        bank: 'MELLAT',
        accountHint,
        directionSource: 'explicit_credit_phrase',
        amountRaw: amountMatch[1] ?? '',
        balanceRaw: balanceMatch[1] ?? '',
        bankTimestamp,
        detectedIdentifiers,
        warnings,
      },
      warnings,
    });
  },
} as const;

/** The Jalali year the given instant falls in — 621 or 622 behind Gregorian. */
function jalaliYearOf(epochMs: number): number {
  const g = new Date(epochMs);
  // Jalali new year is around 21 March. Before it, the Jalali year is the
  // Gregorian year minus 622; after it, minus 621.
  const beforeNowruz = g.getUTCMonth() < 2 || (g.getUTCMonth() === 2 && g.getUTCDate() < 21);
  return g.getUTCFullYear() - (beforeNowruz ? 622 : 621);
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
    parserId: 'mellat-credit-v1',
    parserVersion: '1.0.0',
    evidence: { reason, code },
    warnings: [code],
  };
}
