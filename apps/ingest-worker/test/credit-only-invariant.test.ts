/**
 * Which SMS becomes a `transaction_candidates` row, and with what disposition.
 *
 * Until 2026-09-17 only CREDIT did («credit-only product rule»): a withdrawal
 * was stored raw and forgotten, so «موجودی فعلی» — read from the last SMS
 * that carried a balance — froze after every expense until the next deposit.
 * Since 0072 a DEBIT is written too, as `OUTGOING_IGNORED`: every matching
 * and income query asks for `ACTIONABLE`, so the row can carry the bank's
 * balance and feed the monthly statement without ever paying a claim.
 * UNKNOWN stays out — a row whose direction nobody knows is a row nobody can
 * put in a column.
 *
 * Lives in apps/ingest-worker because the functions under test live in
 * apps/ingest-worker/src/transaction-create.ts.
 */

import { describe, expect, it } from 'vitest';
import { processingDispositionFor, shouldCreateTransaction } from '../src/transaction-create.js';

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

describe('shouldCreateTransaction', () => {
  it('returns true for CREDIT', () => {
    expect(shouldCreateTransaction({ ...baseTx, direction: 'CREDIT' })).toBe(true);
  });

  it('returns true for DEBIT — the balance on a withdrawal SMS is the point', () => {
    expect(shouldCreateTransaction({ ...baseTx, direction: 'DEBIT' })).toBe(true);
  });

  it('returns false for UNKNOWN even when an amount is present', () => {
    expect(
      shouldCreateTransaction({ ...baseTx, direction: 'UNKNOWN', amountIrr: 5_000_000 }),
    ).toBe(false);
  });

  it('returns false for UNKNOWN even when an accountHint is present', () => {
    expect(
      shouldCreateTransaction({ ...baseTx, direction: 'UNKNOWN', accountHint: '1234' }),
    ).toBe(false);
  });
});

describe('processingDispositionFor', () => {
  it('a credit is ACTIONABLE — the matcher may spend it', () => {
    expect(processingDispositionFor({ ...baseTx, direction: 'CREDIT' })).toBe('ACTIONABLE');
  });

  it('a debit is OUTGOING_IGNORED — recorded, never matched', () => {
    expect(processingDispositionFor({ ...baseTx, direction: 'DEBIT' })).toBe('OUTGOING_IGNORED');
  });
});
