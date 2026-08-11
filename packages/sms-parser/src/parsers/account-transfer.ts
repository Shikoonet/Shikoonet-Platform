/**
 * Internet-account transfer signed-amount SMS parser.
 *
 * Layout (after normalization):
 *   <keyword line>      e.g. "انتقال اینترنت" or "انتقال وجه"
 *   حساب:<account>      e.g. "حساب:310057795083"
 *   مبلغ:<sign><amount>
 *   مانده:<balance>
 *   <MM/DD>-<HH:mm>     e.g. "05/14-11:30"
 *
 * Direction is sign-driven (+/- on the amount).
 * Bank: UNKNOWN — the account_hint resolves to a configured
 * financial_accounts row whose bank_name is used downstream.
 *
 * The accountTransferSignedParser runs AFTER explicit-bank parsers
 * (shahr, melli, gardeshgari) but BEFORE parsian (which requires the
 * account on line 1). Falls through to compact / generic when the body
 * doesn't carry the `حساب:` keyword.
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

const AMOUNT_RE = /^مبلغ\s*:?\s*([+-]?)\s*([\d,،\s]+?)\s*([+-]?)\s*$/;
const ACCOUNT_RE = /^حساب\s*:?\s*(.+)$/;
const BALANCE_RE = /^مانده\s*:?\s*([\d,،\s]+?)\s*$/;
const DATE_RE = /^(\d{2})\/(\d{2})-(\d{1,2}):(\d{2})$/;

export const accountTransferSignedParser = {
  id: 'account-transfer-signed-v1',
  version: '1.0.0',

  supports(input: NormalizedSms): boolean {
    const lines = input.text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    // Need at least: keyword / حساب: / مبلغ: / مانده: / MM/DD-HH:mm.
    if (lines.length < 5) return false;
    // Must NOT be Parsian (line 1 is a long digit run, not a keyword).
    if (/^\d{8,}$/.test(lines[0]!)) return false;
    if (!lines.some((l) => ACCOUNT_RE.test(l))) return false;
    if (!lines.some((l) => AMOUNT_RE.test(l))) return false;
    if (!lines.some((l) => BALANCE_RE.test(l))) return false;
    return lines.some((l) => DATE_RE.test(l));
  },

  parse(input: NormalizedSms): ParseResult {
    const lines = input.text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const accountLine = lines.find((l) => ACCOUNT_RE.test(l));
    const amountLine = lines.find((l) => AMOUNT_RE.test(l));
    const balanceLine = lines.find((l) => BALANCE_RE.test(l));
    const dateLine = lines.find((l) => DATE_RE.test(l));
    if (!accountLine || !amountLine || !balanceLine || !dateLine) {
      return unsupportedWarn(
        'account/transfer required field missing',
        'account_transfer_missing_field',
      );
    }

    const accountMatch = accountLine.match(ACCOUNT_RE);
    const accountHint = (accountMatch?.[1] ?? '').trim();
    if (!accountHint || accountHint.length < 5) {
      return unsupportedWarn('account hint too short', 'account_transfer_account_too_short');
    }

    const amountMatch = amountLine.match(AMOUNT_RE);
    if (!amountMatch) {
      return unsupportedWarn('مبلغ line malformed', 'account_transfer_amount_malformed');
    }
    const [, signA, digits, signB] = amountMatch as unknown as [string, string, string, string];
    const amountStr = `${signA}${digits}${signB}`.replace(/\s+/g, '');
    const amountIrr = parseIrr(digits);
    if (amountIrr === null) {
      return unsupportedWarn('مبلغ digits malformed', 'account_transfer_amount_malformed');
    }

    const balanceMatch = balanceLine.match(BALANCE_RE);
    if (!balanceMatch) {
      return unsupportedWarn('مانده line malformed', 'account_transfer_balance_malformed');
    }
    const balanceIrr = parseIrr(balanceMatch[1] ?? '');
    if (balanceIrr === null) {
      return unsupportedWarn('مانده digits malformed', 'account_transfer_balance_malformed');
    }

    const dtMatch = dateLine.match(DATE_RE);
    if (!dtMatch) {
      return unsupportedWarn('date/time malformed', 'account_transfer_datetime_malformed');
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
    // Phrase override wins over missing sign (same rule as parsian/melli).
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
        'account_transfer_direction_conflict',
      );
    } else {
      return unsupportedWarn(
        'no sign and no explicit direction phrase',
        'account_transfer_direction_ambiguous',
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
      detectedIdentifierFromRaw(accountHint, 'account-transfer-signed-v1', 0.93),
    ].filter(Boolean);

    return matched({
      classification: 'BANK_TRANSACTION',
      direction,
      amountIrr,
      balanceIrr,
      accountHint,
      transactionReference: null,
      confidence: 0.93,
      parserId: 'account-transfer-signed-v1',
      parserVersion: '1.0.0',
      evidence: {
        bank: 'UNKNOWN',
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
    parserId: 'account-transfer-signed-v1',
    parserVersion: '1.0.0',
    evidence: { reason, code },
    warnings: [code],
  };
}
