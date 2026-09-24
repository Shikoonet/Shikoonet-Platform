import type { NormalizedSms, ParseResult } from '@shikoo/contracts';
import { type SmsParser, matched, DIRECTION_PHRASES } from './types.js';
import { extractAllAmounts, labelledBalance } from '../normalize.js';

const DEBIT_KEYWORDS = DIRECTION_PHRASES.debit;

export const debitParser: SmsParser = {
  id: 'generic-debit',
  version: '1.0.0',
  supports(input: NormalizedSms): boolean {
    return DEBIT_KEYWORDS.test(input.text);
  },
  parse(input: NormalizedSms): ParseResult {
    const amounts = extractAllAmounts(input.text);
    if (amounts.length === 0) {
      return {
        matched: false,
        classification: 'UNKNOWN',
        direction: 'DEBIT',
        amountIrr: null,
        balanceIrr: null,
        accountHint: null,
        transactionReference: null,
        confidence: 0.2,
        parserId: this.id,
        parserVersion: this.version,
        evidence: { reason: 'debit_keyword_no_amount', directionSource: 'explicit_debit_phrase' },
        warnings: ['debit_keyword_without_amount'],
      };
    }
    const primary = amounts[0]!;
    // Only a number the text labels as the balance; never «the last number».
    const balance = labelledBalance(input.text, amounts);

    if (primary.currency === 'AMBIGUOUS') {
      return {
        matched: true,
        classification: 'BANK_DEBIT',
        direction: 'DEBIT',
        amountIrr: null,
        balanceIrr: balance?.value ?? null,
        accountHint: null,
        transactionReference: extractRef(input.text),
        confidence: 0.4,
        parserId: this.id,
        parserVersion: this.version,
        evidence: {
          reason: 'ambiguous_currency',
          amount: primary.raw,
          directionSource: 'explicit_debit_phrase',
        },
        warnings: ['AMBIGUOUS_CURRENCY'],
      };
    }

    return matched({
      classification: 'BANK_DEBIT',
      direction: 'DEBIT',
      amountIrr: primary.value,
      balanceIrr: balance?.value ?? null,
      accountHint: extractAccountHint(input.text),
      transactionReference: extractRef(input.text),
      confidence: primary.currency === 'NONE' ? 0.5 : 0.8,
      parserId: this.id,
      parserVersion: this.version,
      evidence: {
        currency: primary.currency,
        amountRaw: primary.raw,
        directionSource: 'explicit_debit_phrase',
      },
      warnings: primary.currency === 'NONE' ? ['AMBIGUOUS_CURRENCY'] : [],
    });
  },
};

function extractRef(text: string): string | null {
  const m = text.match(/(?:شماره\s*(?:تراکنش|پیگیری|مرجع)|ref|trace)[:\s]*([A-Za-z0-9-]+)/i);
  return m ? (m[1] ?? null) : null;
}

/**
 * Only a card the text names. It also used to take «the last four-digit
 * number», which is the year of the date as often as not: 2026-09-24 it read
 * «1405» out of «1405/7/2» and «تیر ماه 1405», an account called 1405 was
 * minted, and withdrawals of three of our accounts went to it. No hint is an
 * honest answer; the row waits for a person or a named parser.
 */
function extractAccountHint(text: string): string | null {
  const card = text.match(/(?:کارت|card)[:\s]*\*+(\d{4})/i);
  return card ? card[1]! : null;
}
