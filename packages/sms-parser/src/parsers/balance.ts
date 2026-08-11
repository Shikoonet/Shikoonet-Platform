import type { NormalizedSms, ParseResult } from '@shikoo/contracts';
import { type SmsParser, matched } from './types.js';
import { extractAllAmounts } from '../normalize.js';

const BALANCE_KEYWORDS = /(?:مانده|موجودی|balance)/i;

export const balanceParser: SmsParser = {
  id: 'generic-balance',
  version: '1.0.0',
  supports(input: NormalizedSms): boolean {
    return BALANCE_KEYWORDS.test(input.text) && !/واریز|برداشت/.test(input.text);
  },
  parse(input: NormalizedSms): ParseResult {
    const amounts = extractAllAmounts(input.text);
    if (amounts.length === 0) {
      return {
        matched: false,
        classification: 'UNKNOWN',
        direction: 'UNKNOWN',
        amountIrr: null,
        balanceIrr: null,
        accountHint: null,
        transactionReference: null,
        confidence: 0.2,
        parserId: this.id,
        parserVersion: this.version,
        evidence: { reason: 'balance_keyword_no_amount' },
        warnings: ['balance_keyword_without_amount'],
      };
    }
    const last = amounts[amounts.length - 1]!;
    return matched({
      classification: 'BALANCE',
      direction: 'UNKNOWN',
      amountIrr: null,
      balanceIrr: last.value,
      accountHint: null,
      transactionReference: null,
      confidence: last.currency === 'NONE' ? 0.5 : 0.7,
      parserId: this.id,
      parserVersion: this.version,
      evidence: { currency: last.currency, raw: last.raw },
      warnings: last.currency === 'NONE' ? ['AMBIGUOUS_CURRENCY'] : [],
    });
  },
};
