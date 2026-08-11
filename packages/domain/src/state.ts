import type { ClaimStatus, MatchStatus, TransactionStatus } from '@shikoo/contracts';

/**
 * Transaction candidate lifecycle.
 *
 *   PARSED ──► NEEDS_REVIEW ──► MATCH_SUGGESTED ──► MATCHED ──► APPROVED
 *      │            │                  │                │
 *      └────────────┴──────────────────┴────────────────┴──► REJECTED | IGNORED
 *
 * Transitions not listed throw — the domain refuses illegal moves.
 */
const TX_TRANSITIONS: Record<TransactionStatus, readonly TransactionStatus[]> = {
  PARSED: ['NEEDS_REVIEW', 'MATCH_SUGGESTED', 'MATCHED', 'IGNORED', 'ERROR'],
  NEEDS_REVIEW: ['MATCH_SUGGESTED', 'IGNORED', 'MATCHED', 'ERROR'],
  MATCH_SUGGESTED: ['MATCHED', 'NEEDS_REVIEW', 'IGNORED'],
  MATCHED: ['APPROVED', 'REJECTED', 'NEEDS_REVIEW'],
  APPROVED: [], // terminal
  REJECTED: [], // terminal
  IGNORED: [], // terminal
  ERROR: ['NEEDS_REVIEW', 'IGNORED'],
};

export function canTransitionTransaction(from: TransactionStatus, to: TransactionStatus): boolean {
  return TX_TRANSITIONS[from].includes(to);
}

export function assertTransitionTransaction(from: TransactionStatus, to: TransactionStatus): void {
  if (!canTransitionTransaction(from, to)) {
    throw new IllegalTransitionError('transaction', from, to);
  }
}

const CLAIM_TRANSITIONS: Record<ClaimStatus, readonly ClaimStatus[]> = {
  PENDING: ['MATCH_SUGGESTED', 'VERIFIED', 'REJECTED', 'FAKE_RECEIPT', 'EXPIRED'],
  MATCH_SUGGESTED: ['VERIFIED', 'REJECTED', 'FAKE_RECEIPT', 'PENDING', 'EXPIRED'],
  VERIFIED: [], // terminal
  REJECTED: [], // terminal
  FAKE_RECEIPT: [], // terminal
  EXPIRED: [], // terminal
};

export function canTransitionClaim(from: ClaimStatus, to: ClaimStatus): boolean {
  return CLAIM_TRANSITIONS[from].includes(to);
}

export function assertTransitionClaim(from: ClaimStatus, to: ClaimStatus): void {
  if (!canTransitionClaim(from, to)) {
    throw new IllegalTransitionError('claim', from, to);
  }
}

const MATCH_TRANSITIONS: Record<MatchStatus, readonly MatchStatus[]> = {
  SUGGESTED: ['CONFIRMED', 'REJECTED', 'AUTO_VERIFIED'],
  AUTO_VERIFIED: ['CONFIRMED', 'REJECTED'],
  CONFIRMED: [], // terminal
  REJECTED: [], // terminal
};

export function canTransitionMatch(from: MatchStatus, to: MatchStatus): boolean {
  return MATCH_TRANSITIONS[from].includes(to);
}

export function assertTransitionMatch(from: MatchStatus, to: MatchStatus): void {
  if (!canTransitionMatch(from, to)) {
    throw new IllegalTransitionError('match', from, to);
  }
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly entity: 'transaction' | 'claim' | 'match',
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Illegal ${entity} transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}
