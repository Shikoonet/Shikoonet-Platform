import { describe, expect, it } from 'vitest';
import { cardBalancingDistribution, pickLeastUsedCard, type CardBalancingCandidate } from '../src/cardBalancing.js';

function card(
  cardNumber: string,
  over: Partial<Omit<CardBalancingCandidate, 'cardNumber'>> = {},
): CardBalancingCandidate {
  return {
    cardNumber,
    successfulToday: 0,
    successful7d: 0,
    successfulLifetime: 0,
    assignmentsToday: 0,
    lastAssignedAt: 0,
    ...over,
  };
}

describe('pickLeastUsedCard', () => {
  it('TEST 8 picks lowest successfulToday', () => {
    const picked = pickLeastUsedCard([
      card('1111111111111111', { successfulToday: 5, successful7d: 5, successfulLifetime: 5, assignmentsToday: 5, lastAssignedAt: 100 }),
      card('3333333333333333', { successfulToday: 4, successful7d: 4, successfulLifetime: 4, assignmentsToday: 4, lastAssignedAt: 200 }),
      card('4444444444444444', { successfulToday: 5, successful7d: 5, successfulLifetime: 5, assignmentsToday: 5, lastAssignedAt: 50 }),
    ]);
    expect(picked?.cardNumber).toBe('3333333333333333');
  });

  it('TEST 9 breaks ties on lastAssignedAt ASC', () => {
    const picked = pickLeastUsedCard([
      card('2222222222222222', { successfulToday: 4, lastAssignedAt: 200 }),
      card('1111111111111111', { successfulToday: 4, lastAssignedAt: 100 }),
    ]);
    expect(picked?.cardNumber).toBe('1111111111111111');
  });

  it('TEST 10 does not prefer higher assignments when successful counts equal', () => {
    const picked = pickLeastUsedCard([
      card('1111111111111111', { successfulToday: 1, successful7d: 1, successfulLifetime: 1, assignmentsToday: 5, lastAssignedAt: 1 }),
      card('2222222222222222', { successfulToday: 1, successful7d: 1, successfulLifetime: 1, assignmentsToday: 1, lastAssignedAt: 99 }),
    ]);
    expect(picked?.cardNumber).toBe('2222222222222222');
  });

  it('prefers zero-use eligible card (TEST 12 behavior)', () => {
    const picked = pickLeastUsedCard([
      card('1111111111111111', { successfulToday: 10, successful7d: 10, successfulLifetime: 10, assignmentsToday: 10 }),
      card('3333333333333333', { successfulToday: 0, successful7d: 0, successfulLifetime: 0, assignmentsToday: 0, lastAssignedAt: 999 }),
    ]);
    expect(picked?.cardNumber).toBe('3333333333333333');
  });

  it('uses stable cardNumber tie-breaker', () => {
    const picked = pickLeastUsedCard([
      card('2222222222222222'),
      card('1111111111111111'),
    ]);
    expect(picked?.cardNumber).toBe('1111111111111111');
  });
});

describe('cardBalancingDistribution', () => {
  it('computes max-min gap', () => {
    expect(cardBalancingDistribution([7, 7, 5, 3, 0])).toEqual({ min: 0, max: 7, gap: 7 });
  });
});
