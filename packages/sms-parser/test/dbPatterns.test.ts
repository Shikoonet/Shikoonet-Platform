/**
 * Operator-editable bank patterns, and the boundary that keeps them safe.
 *
 * The point of these tests is not that a pattern works — it is that a pattern
 * CANNOT reach a message a built-in parser already understood. Every claim
 * about "additive only" in `dbPatterns.ts` is checked here against the real
 * registry, using the same Saman and OTP fixtures the built-in suite uses.
 */

import { describe, expect, it } from 'vitest';
import { compilePatterns, parseSms, validatePattern } from '../src/index.js';
import type { BankSmsPatternRow } from '../src/index.js';
import type { NormalizedSms } from '@shikoo/contracts';

const SMS_TIMESTAMP = Date.UTC(2026, 7, 5, 9, 0, 0);

function n(raw: string): NormalizedSms {
  return { raw, text: raw, sender: 'BANK', timestamp: SMS_TIMESTAMP, deviceId: 'phone-a' };
}

function row(over: Partial<BankSmsPatternRow> = {}): BankSmsPatternRow {
  return {
    id: 'ayandeh-v1',
    bankName: 'AYANDEH',
    priority: 100,
    detectRe: 'بانک\\s*آینده',
    amountRe: '^مبلغ\\s*:\\s*([\\d,]+)',
    amountUnit: 'IRR',
    direction: 'CREDIT',
    balanceRe: '^مانده\\s*:\\s*([\\d,]+)',
    accountRe: '^حساب\\s*:\\s*(.+)$',
    ...over,
  };
}

function parsersOf(...rows: BankSmsPatternRow[]) {
  const { parsers, skipped } = compilePatterns(rows);
  expect(skipped).toEqual([]);
  return parsers;
}

/** A real Saman deposit, the exact shape the built-in parser is written for. */
const SAMAN = [
  'بانک سامان',
  'واریز مبلغ  1,000,000ریال',
  'به  901-777-2938283-1',
  'مانده 12,814,704',
  '1405/5/15',
  '20:48',
].join('\n');

/** A bank the built-in chain has never heard of. */
const AYANDEH = ['بانک آینده', 'مبلغ: 2,500,000', 'حساب: 0201234567001', 'مانده: 9,000,000'].join(
  '\n',
);

describe('a pattern never overrides a built-in parser', () => {
  it('leaves a Saman deposit exactly as the built-in read it', () => {
    // A pattern that would happily claim this message if it were ever asked.
    const greedy = parsersOf(row({ id: 'greedy', bankName: 'WRONG', detectRe: 'مبلغ' }));

    const withPatterns = parseSms(n(SAMAN), greedy);
    const without = parseSms(n(SAMAN));

    expect(withPatterns).toEqual(without);
    expect(withPatterns.parserId).toBe('saman-credit-v1');
    expect(withPatterns.evidence['bank']).toBe('SAMAN');
    expect(withPatterns.amountIrr).toBe(1_000_000);
  });

  it('cannot touch an OTP, which must stay redacted whatever else is loaded', () => {
    const greedy = parsersOf(row({ id: 'greedy', bankName: 'WRONG', detectRe: '.' }));
    const otp = n('رمز پویا: 84213 بانک ملی');

    expect(parseSms(otp, greedy)).toEqual(parseSms(otp));
    expect(parseSms(otp, greedy).classification).toBe('OTP');
  });

  it('passing no patterns is byte-identical to the old single-argument call', () => {
    for (const body of [SAMAN, AYANDEH, 'رمز پویا: 84213', 'فروش ویژه! کد تخفیف بگیرید']) {
      expect(parseSms(n(body), [])).toEqual(parseSms(n(body)));
    }
  });
});

describe('a pattern fills in what the built-ins could not', () => {
  it('parses a bank the chain does not know', () => {
    const result = parseSms(n(AYANDEH), parsersOf(row()));

    expect(result.matched).toBe(true);
    expect(result.classification).toBe('BANK_TRANSACTION');
    expect(result.parserId).toBe('db:ayandeh-v1');
    expect(result.evidence['bank']).toBe('AYANDEH');
    expect(result.evidence['bankFromPattern']).toBe('ayandeh-v1');
    expect(result.amountIrr).toBe(2_500_000);
    expect(result.balanceIrr).toBe(9_000_000);
    expect(result.accountHint).toBe('0201234567001');
    expect(result.direction).toBe('CREDIT');
    // Without the same message unparsed, there is nothing to compare against.
    expect(parseSms(n(AYANDEH)).evidence['bank']).not.toBe('AYANDEH');
  });

  it('converts Toman to IRR, because everything downstream is integer rial', () => {
    const toman = parsersOf(row({ amountUnit: 'TOMAN' }));

    const result = parseSms(n(AYANDEH), toman);

    // The message says 2,500,000 — in Toman that is ten times as much money.
    expect(result.amountIrr).toBe(25_000_000);
    expect(result.balanceIrr).toBe(90_000_000);
    expect(result.evidence['amountUnit']).toBe('TOMAN');
  });

  it('names the bank on a generic match without disturbing the amount', () => {
    // A layout the generic compact parser reads the money out of, from a bank
    // it cannot name. The pattern supplies the name and nothing else.
    const body = ['0201234567001', '+3,000,000', 'مانده: 4,000,000', '1405/05/15 10:20'].join('\n');
    const bare = parseSms(n(body));
    // State the precondition rather than assume it — if the registry stops
    // producing an unnamed transaction here, this test proves nothing.
    expect(bare.classification).toBe('BANK_TRANSACTION');
    expect(bare.amountIrr).toBe(3_000_000);
    expect(bare.evidence['bank']).toBe('UNKNOWN');

    // The pattern must claim the message before it can name it, so its own
    // amount regex has to match this layout too — even though the graft path
    // then ignores the number it would have read.
    const grafted = parseSms(
      n(body),
      parsersOf(row({ detectRe: 'مانده', amountRe: '^\\+([\\d,]+)$' })),
    );

    expect(grafted.evidence['bank']).toBe('AYANDEH');
    expect(grafted.evidence['bankFromPattern']).toBe('ayandeh-v1');
    // Everything the tested parser produced survives untouched.
    expect(grafted.parserId).toBe(bare.parserId);
    expect(grafted.amountIrr).toBe(bare.amountIrr);
    expect(grafted.balanceIrr).toBe(bare.balanceIrr);
    expect(grafted.direction).toBe(bare.direction);
  });

  it('rescues a deposit the generic chain misfiled as a balance notice', () => {
    // The case that corrected this design. `generic-balance` returns
    // `matched: true` for the Ayandeh body — classified BALANCE, amount null,
    // direction UNKNOWN. It read no money, so a pattern is allowed to take it,
    // and gating on `matched` alone would have locked patterns out of precisely
    // the messages they exist for.
    const bare = parseSms(n(AYANDEH));
    expect(bare.matched).toBe(true);
    expect(bare.classification).toBe('BALANCE');
    expect(bare.amountIrr).toBeNull();

    const rescued = parseSms(n(AYANDEH), parsersOf(row()));

    expect(rescued.classification).toBe('BANK_TRANSACTION');
    expect(rescued.amountIrr).toBe(2_500_000);
  });

  it('takes the lowest priority first', () => {
    const parsers = parsersOf(
      row({ id: 'second', bankName: 'SECOND', priority: 200 }),
      row({ id: 'first', bankName: 'FIRST', priority: 10 }),
    );
    expect(parsers.map((p) => p.id)).toEqual(['db:first', 'db:second']);
    expect(parseSms(n(AYANDEH), parsers).evidence['bank']).toBe('FIRST');
  });
});

describe('validation, which is what stops a bad row reaching a real payment', () => {
  it('rejects a pattern that does not compile', () => {
    expect(validatePattern(row({ detectRe: '([unclosed' }))).toContain(
      'detect pattern does not compile',
    );
    expect(validatePattern(row({ amountRe: '(?<' }))).toContain('amount pattern does not compile');
  });

  it('rejects an amount pattern with nothing to capture', () => {
    expect(validatePattern(row({ amountRe: 'مبلغ' }))).toContain(
      'amount pattern has no capture group — group 1 must be the amount digits',
    );
  });

  it('rejects a pattern longer than the column allows', () => {
    expect(validatePattern(row({ detectRe: 'a'.repeat(501) }))).toHaveLength(1);
  });

  it('accepts a good row', () => {
    expect(validatePattern(row())).toEqual([]);
  });

  it('skips a broken row instead of taking every bank down with it', () => {
    const { parsers, skipped } = compilePatterns([
      row({ id: 'broken', detectRe: '([unclosed' }),
      row({ id: 'fine' }),
    ]);
    expect(skipped.map((s) => s.id)).toEqual(['broken']);
    expect(parsers.map((p) => p.id)).toEqual(['db:fine']);
  });
});
