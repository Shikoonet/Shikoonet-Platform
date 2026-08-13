/**
 * Bank patterns an operator can edit without a deploy.
 *
 * The head admin's request on 2026-08-13: when a bank changes the wording of
 * its SMS, we should be able to fix it in the dashboard instead of shipping
 * code.
 *
 * The registry these join is an ORDERED chain of fourteen hand-written parsers
 * carrying 135 tests, with documented precedence between them. Putting a text
 * box into that order would put every one of those green paths at the mercy of
 * whatever someone typed. So a pattern from the database is strictly additive:
 *
 *   - It never runs when a built-in parser already named the bank.
 *   - When a built-in matched but produced no bank, the pattern may add the
 *     bank name and NOTHING else. The amount a tested parser extracted is not
 *     replaced by an operator's regex.
 *   - Only when no built-in matched at all does a pattern parse the whole SMS.
 *
 * That covers the failure the admin described. A bank rewrites its layout, the
 * named parser's `supports()` stops matching, the SMS falls through to a generic
 * parser or to none, and the bank identity is lost — a row here restores it. It
 * cannot take anything away, because it never sees an SMS a named parser
 * claimed.
 *
 * ponytail: additive only, no override. Overriding a built-in safely needs a
 * shadow run against real message bodies before enabling, and raw SMS bodies
 * are deliberately not stored. If a built-in itself goes wrong, that is a code
 * change — the right answer for something carrying 135 tests.
 */

import type { NormalizedSms, ParseResult } from '@shikoo/contracts';
import { matched, type SmsParser } from './types.js';
import { parseIrr } from '../normalize.js';
import { detectedIdentifierFromRaw } from '../identifier.js';

export interface BankSmsPatternRow {
  id: string;
  bankName: string;
  priority: number;
  detectRe: string;
  amountRe: string;
  /** Banks that quote Toman must say so, or the money lands at a tenth. */
  amountUnit: 'IRR' | 'TOMAN';
  direction: 'CREDIT' | 'DEBIT';
  balanceRe: string | null;
  accountRe: string | null;
}

export interface FallbackParser extends SmsParser {
  readonly bankName: string;
  /** The `bank_sms_patterns` row id, without the `db:` prefix `id` carries. */
  readonly patternId: string;
}

/** Longest pattern we will compile. Mirrors the CHECK on the columns. */
const MAX_PATTERN_LENGTH = 500;

/**
 * `m` so `^` and `$` mean line boundaries — a bank SMS is a stack of labelled
 * lines and that is how anyone writing one of these will think. No `g`: a
 * global regex carries `lastIndex` between calls and would match every other
 * message.
 */
export function compilePatternSource(source: string): RegExp | null {
  return compile(source);
}

function compile(source: string): RegExp | null {
  if (typeof source !== 'string' || source.length === 0 || source.length > MAX_PATTERN_LENGTH) {
    return null;
  }
  try {
    return new RegExp(source, 'm');
  } catch {
    return null;
  }
}

/**
 * Everything wrong with a row, as plain sentences. Empty means it compiles and
 * has an amount capture group.
 *
 * Exported because the dashboard runs it before saving. A row that cannot be
 * described here is a row that would fail silently at 3am on a real payment.
 */
export function validatePattern(row: BankSmsPatternRow): string[] {
  const problems: string[] = [];
  if (!compile(row.detectRe)) problems.push('detect pattern does not compile');
  const amount = compile(row.amountRe);
  if (!amount) {
    problems.push('amount pattern does not compile');
  } else if (!/\(/.test(row.amountRe)) {
    problems.push('amount pattern has no capture group — group 1 must be the amount digits');
  }
  if (row.balanceRe !== null && !compile(row.balanceRe)) {
    problems.push('balance pattern does not compile');
  }
  if (row.accountRe !== null && !compile(row.accountRe)) {
    problems.push('account pattern does not compile');
  }
  return problems;
}

/**
 * Turn rows into parsers, dropping any that will not compile.
 *
 * A row that fails here is skipped rather than thrown, so one bad pattern
 * cannot stop every bank SMS in the system from being parsed. The dashboard
 * refuses to enable a row that does not validate, so reaching this path means
 * something changed underneath — which is exactly when silently continuing is
 * the right behaviour and the caller wants to know.
 */
export function compilePatterns(rows: readonly BankSmsPatternRow[]): {
  parsers: FallbackParser[];
  skipped: Array<{ id: string; problems: string[] }>;
} {
  const parsers: FallbackParser[] = [];
  const skipped: Array<{ id: string; problems: string[] }> = [];
  const ordered = [...rows].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  for (const row of ordered) {
    const problems = validatePattern(row);
    if (problems.length > 0) {
      skipped.push({ id: row.id, problems });
      continue;
    }
    const detect = compile(row.detectRe)!;
    const amountRe = compile(row.amountRe)!;
    const balanceRe = row.balanceRe === null ? null : compile(row.balanceRe);
    const accountRe = row.accountRe === null ? null : compile(row.accountRe);
    const parserId = `db:${row.id}`;

    parsers.push({
      id: parserId,
      version: '1.0.0',
      bankName: row.bankName,
      patternId: row.id,
      supports(input: NormalizedSms): boolean {
        return detect.test(input.text) && amountRe.test(input.text);
      },
      parse(input: NormalizedSms): ParseResult {
        const amountMatch = input.text.match(amountRe);
        const amountRaw = amountMatch?.[1] ?? '';
        const parsed = parseIrr(amountRaw);
        if (parsed === null) {
          return unusable(parserId, 'amount digits malformed');
        }
        // Money is integer IRR everywhere past this point. A Toman bank whose
        // row forgot to say so would file every transaction at a tenth of its
        // value and never match a claim, so the conversion is explicit and the
        // unit is recorded in the evidence.
        const amountIrr = row.amountUnit === 'TOMAN' ? parsed * 10 : parsed;

        const balanceRaw = balanceRe ? (input.text.match(balanceRe)?.[1] ?? null) : null;
        const balanceIrr =
          balanceRaw === null
            ? null
            : (() => {
                const b = parseIrr(balanceRaw);
                if (b === null) return null;
                return row.amountUnit === 'TOMAN' ? b * 10 : b;
              })();

        const accountHint = accountRe ? (input.text.match(accountRe)?.[1]?.trim() ?? null) : null;
        const detectedIdentifiers = accountHint
          ? [detectedIdentifierFromRaw(accountHint, parserId, 0.9)].filter(Boolean)
          : [];

        // No date column on purpose. The SMS timestamp is what every built-in
        // parser falls back to when its own date line fails, and Jalali parsing
        // driven by an operator-supplied regex is not worth the surface.
        const warnings = ['BANK_TIME_FALLBACK_TO_SMS_TIMESTAMP'];

        return matched({
          classification: 'BANK_TRANSACTION',
          direction: row.direction,
          amountIrr,
          balanceIrr,
          accountHint,
          transactionReference: null,
          // Below every built-in bank parser (0.99). These are operator-authored
          // and unproven; the number is recorded on the transaction so a review
          // can tell where a reading came from.
          confidence: 0.9,
          parserId,
          parserVersion: '1.0.0',
          evidence: {
            bank: row.bankName,
            bankFromPattern: row.id,
            accountHint,
            directionSource: 'parser_convention',
            amountRaw,
            amountUnit: row.amountUnit,
            balanceRaw,
            bankTimestamp: input.timestamp,
            detectedIdentifiers,
            warnings,
          },
          warnings,
        });
      },
    });
  }

  return { parsers, skipped };
}

function unusable(parserId: string, reason: string): ParseResult {
  return {
    matched: false,
    classification: 'UNKNOWN',
    direction: 'UNKNOWN',
    amountIrr: null,
    balanceIrr: null,
    accountHint: null,
    transactionReference: null,
    confidence: 0,
    parserId,
    parserVersion: '1.0.0',
    evidence: { reason },
    warnings: ['db_pattern_unusable'],
  };
}
