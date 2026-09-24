import type { NormalizedSms, ParseResult } from '@shikoo/contracts';
import { type SmsParser, matched, DIRECTION_PHRASES } from './types.js';
import { extractAllAmounts, labelledBalance, normalizeText } from '../normalize.js';

const CREDIT_KEYWORDS = DIRECTION_PHRASES.credit;

export const creditParser: SmsParser = {
  id: 'generic-credit',
  version: '1.0.0',
  supports(input: NormalizedSms): boolean {
    return CREDIT_KEYWORDS.test(input.text);
  },
  parse(input: NormalizedSms): ParseResult {
    const amounts = extractAllAmounts(input.text);
    if (amounts.length === 0) {
      // CREDIT phrase matched but no amount — the product rule says we
      // never default to CREDIT. Return UNKNOWN with a warning so the
      // raw event is still persisted but never enters matching.
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
        evidence: { reason: 'credit_keyword_no_amount', directionSource: 'ambiguous' },
        warnings: ['CREDIT_KEYWORD_WITHOUT_AMOUNT', 'DIRECTION_AMBIGUOUS'],
      };
    }
    const primary = amounts[0]!;
    // Only a number the text labels as the balance; never «the last number».
    const balance = labelledBalance(input.text, amounts);

    if (primary.currency === 'AMBIGUOUS') {
      return {
        matched: true,
        classification: 'BANK_CREDIT',
        direction: 'CREDIT',
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
          directionSource: 'explicit_credit_phrase',
        },
        warnings: ['AMBIGUOUS_CURRENCY'],
      };
    }

    const confidence =
      primary.currency === 'IRR' ? 0.85 : primary.currency === 'TOMAN' ? 0.85 : 0.5;

    const result: Omit<ParseResult, 'matched'> = {
      classification: 'BANK_CREDIT',
      direction: 'CREDIT',
      amountIrr: primary.value,
      balanceIrr: balance?.value ?? null,
      accountHint: extractAccountHint(input.text),
      transactionReference: extractRef(input.text),
      confidence,
      parserId: this.id,
      parserVersion: this.version,
      evidence: {
        currency: primary.currency,
        amountRaw: primary.raw,
        directionSource: 'explicit_credit_phrase',
      },
      warnings: [],
    };
    if (result.confidence < 0.6) {
      result.warnings.push('LOW_CONFIDENCE');
    }
    return matched(result);
  },
};

function extractRef(text: string): string | null {
  const m = text.match(/(?:شماره\s*(?:تراکنش|پیگیری|مرجع)|ref|trace)[:\s]*([A-Za-z0-9-]+)/i);
  return m ? (m[1] ?? null) : null;
}

function extractAccountHint(text: string): string | null {
  // A card the text names, and nothing else: «the last four-digit number» was
  // the year of the date as often as not (see debit.ts, 2026-09-24).
  const card = text.match(/(?:کارت|card)[:\s]*\*+(\d{4})/i);
  return card ? card[1]! : null;
}

// keep normalize referenced (the parser pipeline may rely on it elsewhere)
void normalizeText;
