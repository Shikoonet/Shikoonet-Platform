/**
 * Credit-only product invariant tests — implementation-level guard.
 *
 * Asserts that ONLY direction === 'CREDIT' creates a transaction_candidate
 * row. Both DEBIT and UNKNOWN must be rejected at the
 * `shouldCreateTransaction` gate.
 *
 * Lives in apps/ingest-worker because the function under test
 * (shouldCreateTransaction) lives in apps/ingest-worker/src/transaction-create.ts
 * and is not exported via a shared package.
 */

import { describe, expect, it } from 'vitest';
import { shouldCreateTransaction } from '../src/transaction-create.js';

const baseTx = {
  matched: true,
  classification: 'BANK_TRANSACTION' as const,
  amountIrr: 1_000_000,
  balanceIrr: null,
  accountHint: 'x',
  transactionReference: null,
  confidence: 0.9,
  parserId: 'p',
  parserVersion: '1',
  evidence: {},
  warnings: [],
};

describe('shouldCreateTransaction — credit-only invariant', () => {
  it('returns true for CREDIT', () => {
    expect(shouldCreateTransaction({ ...baseTx, direction: 'CREDIT' })).toBe(true);
  });

  it('returns false for DEBIT', () => {
    expect(shouldCreateTransaction({ ...baseTx, direction: 'DEBIT' })).toBe(false);
  });

  it('returns false for UNKNOWN even when an amount is present', () => {
    // The product rule is "only CREDIT is actionable". A parser that
    // returned UNKNOWN with an amount — e.g. ambiguous currency —
    // must still be rejected at the gate.
    expect(
      shouldCreateTransaction({
        ...baseTx,
        direction: 'UNKNOWN',
        amountIrr: 999_999_999,
        confidence: 0.99,
      }),
    ).toBe(false);
  });

  it('returns false for UNKNOWN even when an accountHint is present', () => {
    // Even if the parser recovered an accountHint, UNKNOWN direction
    // must not produce a candidate. The product invariant is on direction.
    expect(
      shouldCreateTransaction({
        ...baseTx,
        direction: 'UNKNOWN',
        accountHint: '1234',
      }),
    ).toBe(false);
  });
});
