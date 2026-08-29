import { describe, expect, it } from 'vitest';
import {
  IllegalTransitionError,
  assertTransitionMatch,
  assertTransitionTransaction,
  canTransitionClaim,
  canTransitionMatch,
  canTransitionTransaction,
} from '../src/state.js';

describe('transaction transitions', () => {
  it('allows PARSED → MATCH_SUGGESTED', () => {
    expect(canTransitionTransaction('PARSED', 'MATCH_SUGGESTED')).toBe(true);
  });

  it('rejects APPROVED → REJECTED', () => {
    expect(canTransitionTransaction('APPROVED', 'REJECTED')).toBe(false);
  });

  it('throws IllegalTransitionError on bad move', () => {
    expect(() => assertTransitionTransaction('APPROVED', 'REJECTED')).toThrow(
      IllegalTransitionError,
    );
  });
});

describe('claim transitions', () => {
  it('VERIFIED is terminal', () => {
    expect(canTransitionClaim('VERIFIED', 'REJECTED')).toBe(false);
  });

  it('PENDING → MATCH_SUGGESTED allowed', () => {
    expect(canTransitionClaim('PENDING', 'MATCH_SUGGESTED')).toBe(true);
  });
});

describe('match transitions', () => {
  it('SUGGESTED → CONFIRMED allowed', () => {
    expect(canTransitionMatch('SUGGESTED', 'CONFIRMED')).toBe(true);
  });

  it('CONFIRMED is terminal', () => {
    expect(canTransitionMatch('CONFIRMED', 'REJECTED')).toBe(false);
    expect(() => assertTransitionMatch('CONFIRMED', 'REJECTED')).toThrow();
  });
});
