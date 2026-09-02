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

/**
 * Claim lifecycle.
 *
 *   PENDING ─┬─► MATCH_SUGGESTED ─┬─► VERIFIED
 *            │                    │
 *            └────────────────────┴─► FULFILLED_UNRECONCILED ──► VERIFIED
 *
 * `FULFILLED_UNRECONCILED` is the only non-terminal state below `VERIFIED`, and
 * it has exactly one exit. Delivery already happened when the claim entered it,
 * so the move to `VERIFIED` is reconciliation — the bank finally agreeing — and
 * must never be read as a reason to deliver again. It cannot be rejected or
 * expired: the customer is holding the product, and pretending otherwise would
 * let a later sweep withdraw a state the world has already seen.
 */
const CLAIM_TRANSITIONS: Record<ClaimStatus, readonly ClaimStatus[]> = {
  PENDING: [
    'MATCH_SUGGESTED',
    'VERIFIED',
    'FULFILLED_UNRECONCILED',
    'REJECTED',
    'FAKE_RECEIPT',
    'EXPIRED',
  ],
  MATCH_SUGGESTED: [
    'VERIFIED',
    'FULFILLED_UNRECONCILED',
    'REJECTED',
    'FAKE_RECEIPT',
    'PENDING',
    'EXPIRED',
  ],
  FULFILLED_UNRECONCILED: ['VERIFIED'],
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
