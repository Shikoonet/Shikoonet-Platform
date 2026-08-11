/**
 * Tests for the shared matching service. Uses a fake D1 to verify the
 * eligibility filter (amount equality required, CREDIT direction only,
 * time window) and idempotent insert semantics.
 */
import { describe, expect, it } from 'vitest';
import type { D1Database, D1PreparedStatement, D1Result } from '@shikoo/database';
import type { TransactionCandidateRow, PaymentClaimRow, FinancialAccountRow } from '@shikoo/database';
import { suggestMatchesForTransaction } from '../src/matching.js';

// ---------------------------------------------------------------------------
// Fake D1 with per-statement canned responses. The matching service runs:
//   1. SELECT claims
//   2. SELECT account
//   3. SELECT existing match
//   4. INSERT OR IGNORE match
//   5. UPDATE tx status
//   6. UPDATE claim status
// ---------------------------------------------------------------------------

interface Call {
  sql: string;
  bound: unknown[];
  responder: () => Promise<D1Result<unknown>>;
}

function makeFakeDb(responses: Array<() => { results: unknown[] }>): {
  db: D1Database;
  calls: Call[];
} {
  const calls: Call[] = [];
  let cursor = 0;
  function nextResponder() {
    const r = responses[cursor++] ?? (() => ({ results: [] }));
    return async () =>
      ({
        results: r().results,
        success: true,
        meta: { duration: 0, changes: 0, last_row_id: 0 },
      }) as D1Result<unknown>;
  }
  const db: D1Database = {
    prepare(sql: string) {
      const call: Call = { sql, bound: [], responder: nextResponder() };
      calls.push(call);
      const stmt: D1PreparedStatement = {
        bind(...values: unknown[]) {
          call.bound = values;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          const r = await call.responder();
          return (r.results[0] as T) ?? null;
        },
        async all<T>(): Promise<D1Result<T>> {
          return (await call.responder()) as D1Result<T>;
        },
        async run() {
          await call.responder();
          return { results: [], success: true, meta: { duration: 0, changes: 0, last_row_id: 0 } };
        },
      };
      return stmt;
    },
    batch() {
      return Promise.resolve([]);
    },
    exec() {
      return Promise.resolve({ duration: 0, count: 0 });
    },
    dump() {
      return Promise.resolve(new ArrayBuffer(0));
    },
    withSession() {
      return Promise.resolve(undefined as never);
    },
  };
  return { db, calls };
}

const txBase: Pick<
  TransactionCandidateRow,
  | 'id'
  | 'amount_irr'
  | 'direction'
  | 'financial_account_id'
  | 'transaction_reference'
  | 'bank_timestamp'
> = {
  id: 'tx-1',
  amount_irr: 1_000_000,
  direction: 'CREDIT',
  financial_account_id: 'account-1',
  transaction_reference: null,
  bank_timestamp: 1_700_000_000_000,
};

describe('suggestMatchesForTransaction', () => {
  it('returns no suggestion when direction is DEBIT', async () => {
    const { db } = makeFakeDb([]);
    const r = await suggestMatchesForTransaction(db, {
      tx: { ...txBase, direction: 'DEBIT' },
    });
    expect(r).toEqual({ suggested: 0, updated: 0, topScore: 0, topClaimId: null });
  });

  it('returns no suggestion when no open claims exist', async () => {
    const { db } = makeFakeDb([() => ({ results: [] })]);
    const r = await suggestMatchesForTransaction(db, { tx: txBase });
    expect(r.suggested).toBe(0);
  });

  it('returns no suggestion when amount does not match (eligibility filter)', async () => {
    const claim: Pick<
      PaymentClaimRow,
      | 'id'
      | 'expected_amount_irr'
      | 'target_financial_account_id'
      | 'submitted_at'
      | 'external_order_id'
      | 'customer_reference'
    > = {
      id: 'claim-1',
      expected_amount_irr: 999_999, // differs from tx amount
      target_financial_account_id: 'account-1',
      submitted_at: txBase.bank_timestamp ?? 0,
      external_order_id: 'o-1',
      customer_reference: null,
    };
    const { db } = makeFakeDb([
      () => ({ results: [claim] }), // claim query
      () => ({ results: [] }), // account query (won't be reached)
    ]);
    const r = await suggestMatchesForTransaction(db, { tx: txBase });
    expect(r.suggested).toBe(0);
  });

  it('requires CREDIT direction (DEBIT must not produce a suggestion)', async () => {
    const { db } = makeFakeDb([]);
    const r = await suggestMatchesForTransaction(db, {
      tx: { ...txBase, direction: 'DEBIT' },
    });
    expect(r.topClaimId).toBeNull();
  });

  it('suggests when amount matches and time is within window', async () => {
    const claim: Pick<
      PaymentClaimRow,
      | 'id'
      | 'expected_amount_irr'
      | 'target_financial_account_id'
      | 'submitted_at'
      | 'external_order_id'
      | 'customer_reference'
    > = {
      id: 'claim-A',
      expected_amount_irr: 1_000_000,
      target_financial_account_id: 'account-1',
      submitted_at: txBase.bank_timestamp ?? 0,
      external_order_id: 'order-A',
      customer_reference: null,
    };
    const account: Pick<FinancialAccountRow, 'id' | 'card_last_four' | 'account_last_four' | 'status'> = {
      id: 'account-1',
      card_last_four: null,
      account_last_four: null,
      status: 'ACTIVE',
    };
    const { db, calls } = makeFakeDb([
      () => ({ results: [claim] }), // claims
      () => ({ results: [account] }), // account
      () => ({ results: [] }), // existing match
      () => ({ results: [] }), // INSERT match (returns rows.length=0)
      () => ({ results: [] }), // UPDATE tx
      () => ({ results: [] }), // UPDATE claim
    ]);
    const r = await suggestMatchesForTransaction(db, { tx: txBase });
    expect(r.suggested).toBe(1);
    expect(r.topClaimId).toBe('claim-A');
    // Sanity: 6 statements were issued in the right order.
    const kinds = calls.map((c) =>
      c.sql.includes('payment_claims') && c.sql.includes('SELECT')
        ? 'claims'
        : c.sql.includes('financial_accounts') && c.sql.includes('SELECT')
          ? 'account'
          : c.sql.includes('reconciliation_matches') && c.sql.includes('SELECT')
            ? 'existing'
            : c.sql.includes('INSERT OR IGNORE INTO reconciliation_matches')
              ? 'insert_match'
              : c.sql.includes('UPDATE transaction_candidates')
                ? 'update_tx'
                : c.sql.includes('UPDATE payment_claims')
                  ? 'update_claim'
                  : 'other',
    );
    expect(kinds).toEqual([
      'claims',
      'account',
      'existing',
      'insert_match',
      'update_tx',
      'update_claim',
    ]);
  });

  it('skips when an existing CONFIRMED match already covers this tx/claim pair', async () => {
    const claim: Pick<
      PaymentClaimRow,
      | 'id'
      | 'expected_amount_irr'
      | 'target_financial_account_id'
      | 'submitted_at'
      | 'external_order_id'
      | 'customer_reference'
    > = {
      id: 'claim-B',
      expected_amount_irr: 1_000_000,
      target_financial_account_id: 'account-1',
      submitted_at: txBase.bank_timestamp ?? 0,
      external_order_id: 'order-B',
      customer_reference: null,
    };
    const account: Pick<FinancialAccountRow, 'id' | 'card_last_four' | 'account_last_four' | 'status'> = {
      id: 'account-1',
      card_last_four: null,
      account_last_four: null,
      status: 'ACTIVE',
    };
    const { db } = makeFakeDb([
      () => ({ results: [claim] }), // claims
      () => ({ results: [account] }), // account
      () => ({ results: [{ id: 'm-existing', status: 'CONFIRMED' }] }), // existing match is CONFIRMED
    ]);
    const r = await suggestMatchesForTransaction(db, { tx: txBase });
    expect(r.suggested).toBe(0);
    expect(r.topClaimId).toBe('claim-B'); // top claim still identified
  });

  it('does NOT auto-approve — only suggests; caller must call /match/approve', async () => {
    // Even with a single perfectly-matched claim, we only INSERT a SUGGESTED
    // match — never flip the transaction to APPROVED.
    const claim: Pick<
      PaymentClaimRow,
      | 'id'
      | 'expected_amount_irr'
      | 'target_financial_account_id'
      | 'submitted_at'
      | 'external_order_id'
      | 'customer_reference'
    > = {
      id: 'claim-X',
      expected_amount_irr: 1_000_000,
      target_financial_account_id: 'account-1',
      submitted_at: txBase.bank_timestamp ?? 0,
      external_order_id: 'order-X',
      customer_reference: null,
    };
    const account: Pick<FinancialAccountRow, 'id' | 'card_last_four' | 'account_last_four' | 'status'> = {
      id: 'account-1',
      card_last_four: null,
      account_last_four: null,
      status: 'ACTIVE',
    };
    const { db, calls } = makeFakeDb([
      () => ({ results: [claim] }),
      () => ({ results: [account] }),
      () => ({ results: [] }),
      () => ({ results: [] }),
      () => ({ results: [] }),
      () => ({ results: [] }),
    ]);
    await suggestMatchesForTransaction(db, { tx: txBase });
    const insertSql = calls.find((c) =>
      c.sql.includes('INSERT OR IGNORE INTO reconciliation_matches'),
    );
    expect(insertSql).toBeDefined();
    // Match status is the literal 'SUGGESTED' — never AUTO_VERIFIED, never CONFIRMED.
    expect(insertSql!.sql).toMatch(/'SUGGESTED'/);
    expect(insertSql!.sql).not.toMatch(/'CONFIRMED'/);
    expect(insertSql!.sql).not.toMatch(/'AUTO_VERIFIED'/);
    const updateTx = calls.find((c) => c.sql.includes('UPDATE transaction_candidates'));
    expect(updateTx!.sql).toMatch(/'MATCH_SUGGESTED'/);
    expect(updateTx!.sql).not.toMatch(/'APPROVED'/);
  });
});
