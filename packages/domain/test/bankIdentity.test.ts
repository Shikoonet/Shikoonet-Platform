/**
 * Card numbers, checked against facts that come from outside this codebase.
 *
 * A test that only shows `luhnOk` agrees with `luhnOk` proves nothing. The
 * anchors here are external: the textbook Luhn vector, published Visa/Mastercard
 * test numbers, the IIN ranges banks actually issue, and one card number from
 * production that a human proved impossible by counting digits.
 */

import { describe, expect, it } from 'vitest';
import { identifyBank, luhnOk, normalizeCardDigits } from '../src/index.js';

describe('luhnOk', () => {
  it('agrees with the canonical Luhn example', () => {
    // 79927398713 is the worked example every description of the algorithm
    // uses, together with the fact that the other nine check digits fail.
    expect(luhnOk('79927398713')).toBe(true);
    for (const wrong of ['79927398710', '79927398711', '79927398712', '79927398714']) {
      expect(luhnOk(wrong)).toBe(false);
    }
  });

  it('accepts published card test numbers', () => {
    // Test numbers published by the card networks for exactly this purpose.
    expect(luhnOk('4111111111111111')).toBe(true); // Visa
    expect(luhnOk('5555555555554444')).toBe(true); // Mastercard
    expect(luhnOk('378282246310005')).toBe(true); //  Amex
  });

  it('rejects the impossible card number found in production', () => {
    // BUGS-FOR-ADMIN.md item 4: the same physical Gardeshgari card is recorded
    // two ways across the two systems, differing by one digit. Only one of them
    // can be a real card, and Luhn says which.
    expect(luhnOk('5054161716277062')).toBe(false); // what the hub stored
    expect(luhnOk('5054161706277062')).toBe(true); //  what the bot stored
  });

  it('is not fooled by anything that is not a run of digits', () => {
    expect(luhnOk('')).toBe(false);
    expect(luhnOk('4')).toBe(false);
    expect(luhnOk('4111-1111-1111-1111')).toBe(false);
    expect(luhnOk('411111111111111x')).toBe(false);
  });

  it('composes with the normalizer the dashboard already uses', () => {
    const typed = '۵۰۵۴-۱۶۱۷-۰۶۲۷-۷۰۶۲';
    const digits = normalizeCardDigits(typed);
    expect(digits).toBe('5054161706277062');
    expect(luhnOk(digits!)).toBe(true);
  });
});

describe('identifyBank', () => {
  // A slice of the seeded table. Kept small and stated here rather than read
  // from the database, so this test fails when the LOOKUP breaks, not when
  // someone edits a row in the dashboard.
  const prefixes = [
    { prefix: '603799', bankName: 'MELLI' },
    { prefix: '505416', bankName: 'GARDESHGARI' },
    { prefix: '621986', bankName: 'SAMAN' },
    { prefix: '610433', bankName: 'MELLAT' },
  ];

  it('names the bank that really issued these numbers', () => {
    // 505416 is Gardeshgari — corroborated inside this project by the other
    // Gardeshgari cards in production, which all read 5054161706…
    expect(identifyBank('5054161706277062', prefixes)).toBe('GARDESHGARI');
    expect(identifyBank('6037997512345678', prefixes)).toBe('MELLI');
    expect(identifyBank('6219861012345678', prefixes)).toBe('SAMAN');
    expect(identifyBank('6104337612345678', prefixes)).toBe('MELLAT');
  });

  it('says nothing rather than guessing an unlisted prefix', () => {
    expect(identifyBank('9999991234567890', prefixes)).toBeNull();
  });

  it('lets a longer prefix win, which is how the table stays extensible', () => {
    // A bank carving a sub-range out of another's block needs one added row and
    // no code change. Order in the array must not matter.
    const split = [
      { prefix: '603799', bankName: 'MELLI' },
      { prefix: '6037991', bankName: 'MELLI_SPLIT' },
    ];
    expect(identifyBank('6037991012345678', split)).toBe('MELLI_SPLIT');
    expect(identifyBank('6037991012345678', [...split].reverse())).toBe('MELLI_SPLIT');
    expect(identifyBank('6037992012345678', split)).toBe('MELLI');
  });

  it('does not treat a non-numeric string as a card', () => {
    expect(identifyBank('6037-9975-1234-5678', prefixes)).toBeNull();
    expect(identifyBank('', prefixes)).toBeNull();
  });
});
