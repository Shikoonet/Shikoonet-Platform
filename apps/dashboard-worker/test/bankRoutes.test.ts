/**
 * The gate that decides whether an operator-written regex may go live.
 *
 * This exists because the gate silently failed the first two times it was
 * written. Version one used 2000-character probes and hung the server outright
 * — the request never came back. Version two shortened them to 20 characters
 * and waved `^(a+)+$` straight through, because 2^20 finishes in about ten
 * milliseconds. Neither failure showed up as an error; both looked like success.
 *
 * A regex out of a text box runs against every bank SMS the system receives, so
 * this is a money path and a trust boundary at once. It gets a test.
 */

import { describe, expect, it } from 'vitest';
import { overBudget } from '../src/bankRoutes.js';
import type { BankSmsPatternRow } from '@shikoo/sms-parser';

function row(over: Partial<BankSmsPatternRow> = {}): BankSmsPatternRow {
  return {
    id: 'test-v1',
    bankName: 'TEST',
    priority: 100,
    detectRe: 'بانک\\s*نمونه',
    amountRe: '^مبلغ\\s*:\\s*([\\d,]+)',
    amountUnit: 'IRR',
    direction: 'CREDIT',
    balanceRe: null,
    accountRe: null,
    ...over,
  };
}

describe('the ReDoS gate', () => {
  it('rejects the classic catastrophic shapes', () => {
    for (const evil of ['^(a+)+$', '^(a|a)+$', '^(a*)*b', '^(\\d+)+$']) {
      expect(overBudget(row({ detectRe: evil })), evil).toBe(true);
    }
  });

  it('catches a catastrophic pattern in the amount field too', () => {
    // Every compiled field runs on every message, not just the detector.
    expect(overBudget(row({ amountRe: '^(a+)+$' }))).toBe(true);
  });

  it('lets ordinary bank patterns through', () => {
    expect(overBudget(row())).toBe(false);
    expect(overBudget(row({ detectRe: '(بانک|بانك)\\s*سامان' }))).toBe(false);
    expect(overBudget(row({ amountRe: '^(?:واریز|واريز)\\s*مبلغ\\s*:?\\s*([\\d,،\\s]+)' }))).toBe(
      false,
    );
    expect(overBudget(row({ detectRe: '.', amountRe: '([0-9]+)' }))).toBe(false);
  });

  it('returns quickly even for the patterns it rejects', () => {
    // The failure that started this file was a check that never returned, so
    // the only distinction worth asserting is "returned" against "hung" — the
    // bait is 2^26 backtracking steps and a JS regex cannot be interrupted
    // partway, so how long that takes is a property of the machine, not of the
    // code. ~600ms here, 1034ms on a loaded CI runner, which failed a 1000ms
    // ceiling for no reason anyone should act on. Five seconds still catches
    // the regression this test exists for.
    const started = performance.now();
    overBudget(row({ detectRe: '^(a|a)+$' }));
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('says nothing about a pattern that does not compile', () => {
    // That is validatePattern's job; this one must not throw over it.
    expect(overBudget(row({ detectRe: '([unclosed' }))).toBe(false);
  });
});
