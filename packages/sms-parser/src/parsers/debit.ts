import type { NormalizedSms, ParseResult } from '@shikoo/contracts';
import { type SmsParser, matched, DIRECTION_PHRASES } from './types.js';
import { extractAllAmounts } from '../normalize.js';

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
    const balance = amounts.length >= 2 ? amounts[amounts.length - 1]! : null;

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
      balanceIrr: balance && balance !== primary ? balance.value : null,
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

function extractAccountHint(text: string): string | null {
  const card = text.match(/(?:کارت|card)[:\s]*\*+(\d{4})/i);
  if (card) return card[1]!;
  const digits = text.match(/\b(\d{4})\b(?!.*\b\d{4}\b)/);
  return digits ? digits[1]! : null;
}
