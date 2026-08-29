import { describe, expect, it } from 'vitest';
import { decideSuggestion, scoreMatch } from '../src/score.js';

const baseTx = {
  amount_irr: 50_000,
  direction: 'CREDIT' as const,
  financial_account_id: 'acct-1',
  transaction_reference: 'REF-1',
  bank_timestamp: 1_700_000_000_000,
};

const baseClaim = {
  expected_amount_irr: 50_000,
  target_financial_account_id: 'acct-1',
  submitted_at: 1_700_000_000_000,
  external_order_id: 'order-1',
  customer_reference: 'REF-1',
};

describe('scoreMatch', () => {
  it('exact amount + same account + same ref + recent time → high score', () => {
    const r = scoreMatch(baseTx, baseClaim, {
      id: 'acct-1',
      card_last_four: '1234',
      account_last_four: null,
    });
    expect(r.score).toBeGreaterThan(0.85);
    expect(r.matching).toContain('amount_exact');
    expect(r.matching).toContain('target_account_exact');
    expect(r.matching).toContain('reference_match');
  });

  it('amount-only ambiguous match stays NEEDS_REVIEW', () => {
    const r = scoreMatch(
      { ...baseTx, financial_account_id: null, transaction_reference: null },
      { ...baseClaim, target_financial_account_id: null, customer_reference: null },
      null,
    );
    // score < 0.85, no second candidate, falls into NEEDS_REVIEW branch.
    expect(r.score).toBeLessThan(0.85);
  });

  it('wrong direction is penalised', () => {
    const r = scoreMatch({ ...baseTx, direction: 'DEBIT' }, baseClaim, {
      id: 'acct-1',
      card_last_four: null,
      account_last_four: null,
    });
    expect(r.mismatching).toContain('direction_debit_unusual_for_claim');
  });

  it('time too far penalised', () => {
    const r = scoreMatch(
      { ...baseTx, bank_timestamp: baseTx.bank_timestamp! - 7 * 24 * 3600 * 1000 },
      baseClaim,
      { id: 'acct-1', card_last_four: null, account_last_four: null },
    );
    expect(r.mismatching).toContain('time_too_far');
  });
});

describe('decideSuggestion', () => {
  it('single high score → MATCH_SUGGESTED', () => {
    const r = decideSuggestion([{ score: 0.9, matching: [], mismatching: [] }]);
    expect(r.status).toBe('MATCH_SUGGESTED');
  });

  it('zero candidates → NEEDS_REVIEW', () => {
    const r = decideSuggestion([]);
    expect(r.status).toBe('NEEDS_REVIEW');
  });
});
