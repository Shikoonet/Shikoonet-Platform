import type { Classification, Direction, NormalizedSms, ParseResult } from '@hub/contracts';

export interface SmsParser {
  readonly id: string;
  readonly version: string;
  supports(input: NormalizedSms): boolean;
  parse(input: NormalizedSms): ParseResult;
}

export function unmatched(
  classification: Classification,
  options: {
    parserId?: string | null;
    parserVersion?: string | null;
    direction?: Direction;
    warnings?: string[];
    confidence?: number;
  } = {},
): ParseResult {
  return {
    matched: false,
    classification,
    direction: options.direction ?? 'UNKNOWN',
    amountIrr: null,
    balanceIrr: null,
    accountHint: null,
    transactionReference: null,
    confidence: options.confidence ?? 0,
    parserId: options.parserId ?? null,
    parserVersion: options.parserVersion ?? null,
    evidence: {},
    warnings: options.warnings ?? [],
  };
}

export function matched(partial: Omit<ParseResult, 'matched'>): ParseResult {
  return { matched: true, ...partial };
}

/**
 * Phrase-based direction detection. Bank SMS in this product often contain
 * a reliable explicit direction word ("واریز" / "deposit" → CREDIT;
 * "برداشت" / "withdrawal" → DEBIT) BEFORE the amount sign, and that
 * phrase is the safest signal.
 *
 * Sign-based parsers MUST consult these phrases first: if a DEBIT phrase
 * is present and no CREDIT phrase is present, the SMS is DEBIT regardless
 * of sign. Symmetrically for CREDIT.
 *
 * The user spec also requires the following DEBIT phrases be covered
 * (withdrawal, purchase, transfer sent, fee, deducted, outgoing payment).
 */
export const DIRECTION_PHRASES = {
  /**
   * CREDIT keywords. Matched text → direction is CREDIT (provided an
   * amount is present; without an amount, the parser returns UNKNOWN
   * and never auto-defaults to CREDIT).
   */
  credit:
    /(?:واریز|دریافت|افزایش\s*موجودی|واریز\s*شد|deposit|credited|received|واریز\s*از\s*بانک|incoming\s*payment|credit)/i,
  /**
   * DEBIT keywords. Matched text → direction is DEBIT.
   * Covers the user's full set: withdrawal / purchase / transfer sent /
   * fee / deducted / outgoing payment.
   */
  debit:
    /(?:کارمزد|کسر\s*شد|کسر\s*گردید|برداشت|خرید|پرداخت|پرداخت\s*بابت|انتقال\s*از|انتقال\s*ارسال|خرید\s*از|debit|withdrawal|withdraw|purchase|purchase\s*at|purchase\s*from|paid|outgoing\s*payment|deducted)/i,
};

/**
 * Source of direction for the evidence trail. Set on every matched
 * ParseResult so audit logs can prove the direction inference.
 */
export type DirectionSource =
  | 'explicit_credit_phrase'
  | 'explicit_debit_phrase'
  | 'signed_amount'
  | 'ambiguous'
  | 'parser_convention'
  | null;

/**
 * Classify direction by phrase. Returns:
 *   - 'CREDIT' if the body has a CREDIT phrase and no DEBIT phrase
 *   - 'DEBIT'  if the body has a DEBIT phrase and no CREDIT phrase
 *   - 'CONFLICT' if both phrases are present (the parser decides
 *                per its own precedence rules; this helper just
 *                flags the conflict)
 *   - null     if neither phrase is present
 */
export function directionByPhrase(text: string): 'CREDIT' | 'DEBIT' | 'CONFLICT' | null {
  const hasCredit = DIRECTION_PHRASES.credit.test(text);
  const hasDebit = DIRECTION_PHRASES.debit.test(text);
  if (hasCredit && hasDebit) return 'CONFLICT';
  if (hasCredit) return 'CREDIT';
  if (hasDebit) return 'DEBIT';
  return null;
}
