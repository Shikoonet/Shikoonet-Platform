/**
 * The hole finder on «دفتر بانک»: the bank's «موجودی بعد» on each SMS is the
 * outside truth, and a row is inserted wherever the previous balance plus
 * everything between does not reach it. Numbers here are the bank's, never
 * the code's.
 */
import { describe, expect, it } from 'vitest';
import { findHoles } from '../src/pages/BooksPage.js';
import type { BankMovement } from '../src/api.js';

const sms = (id: string, at: number, direction: 'CREDIT' | 'DEBIT', amountIrr: number, balanceIrr: number | null): BankMovement => ({
  id,
  kind: 'sms',
  direction,
  amountIrr,
  balanceIrr,
  bankTimestamp: at,
  matched: false,
  offBooks: null,
  expense: null,
});
const manual = (id: string, at: number, direction: 'CREDIT' | 'DEBIT', amountIrr: number): BankMovement => ({
  ...sms(id, at, direction, amountIrr, null),
  kind: 'manual',
  offBooks: { category: 'PERSONAL', categoryFa: 'شخصی', note: null },
});

describe('findHoles', () => {
  it('sees money the bank subtracted between two SMS, and where', () => {
    // 1,000,000 → +200,000 should be 1,200,000; the bank says 700,000.
    const items = [sms('a', 1000, 'CREDIT', 100, 1_000_000), sms('b', 2000, 'CREDIT', 200_000, 700_000)];
    expect(findHoles('acct', items)).toEqual([
      { accountId: 'acct', direction: 'DEBIT', amountIrr: 500_000, at: 1000, beforeId: 'b' },
    ]);
  });

  it('sees money the bank added, too', () => {
    const items = [sms('a', 1000, 'CREDIT', 100, 1_000_000), sms('b', 2000, 'DEBIT', 50_000, 1_250_000)];
    expect(findHoles('acct', items)).toEqual([
      { accountId: 'acct', direction: 'CREDIT', amountIrr: 300_000, at: 1000, beforeId: 'b' },
    ]);
  });

  it('is closed by a hand-written movement between the two, and stays open when the amount is wrong', () => {
    const items = [sms('a', 1000, 'CREDIT', 100, 1_000_000), sms('b', 3000, 'CREDIT', 200_000, 700_000)];
    expect(findHoles('acct', [...items, manual('m', 2000, 'DEBIT', 500_000)])).toEqual([]);
    expect(findHoles('acct', [...items, manual('m', 2000, 'DEBIT', 400_000)])).toEqual([
      { accountId: 'acct', direction: 'DEBIT', amountIrr: 100_000, at: 2000, beforeId: 'b' },
    ]);
  });

  it('reads the list in any order and skips an SMS the parser found no balance in', () => {
    const items = [
      sms('c', 3000, 'CREDIT', 100_000, 1_300_000),
      sms('b', 2000, 'CREDIT', 200_000, null),
      sms('a', 1000, 'CREDIT', 100, 1_000_000),
    ];
    expect(findHoles('acct', items)).toEqual([]);
  });

  it('says nothing about the first SMS — there is nothing before it to hold it against', () => {
    expect(findHoles('acct', [sms('a', 1000, 'DEBIT', 5, 10)])).toEqual([]);
  });
});
