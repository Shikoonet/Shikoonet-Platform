/**
 * Authoritative Mirzabot auto-verification decision engine.
 *
 * This module is the ONLY place allowed to decide whether a Mirzabot payment
 * claim may be automatically verified against a bank transaction. API
 * handlers, SQL queries, workers and UI must consume the decision, never
 * re-derive it.
 *
 * Product rule: AUTO_VERIFY only an isolated 1↔1 relationship between exactly
 * one claim and exactly one bank transaction. Everything else is SUGGEST
 * (manual review). Uncertainty is never auto-rejected and never marked fake.
 */

import {
  AUTO_MATCH_MAX_TIME_DELTA_MS,
  MIRZABOT_SOURCE,
  WAITING_TIMEOUT_MS,
} from '@shikoo/contracts';
import type { SuspectReason } from '@shikoo/contracts';

export type MirzabotDecisionKind = 'AUTO_VERIFY' | 'SUGGEST' | 'WAIT';

/** Reason attached to a decision. AUTO_VERIFY/WAIT use their own literals. */
export type MirzabotDecisionReason = SuspectReason | 'UNIQUE_EXACT_MATCH' | 'AWAITING_BANK_SMS';

export interface MirzabotClaimCandidate {
  id: string;
  sourceSystem: string;
  status: string;
  externalOrderId: string | null;
  expectedAmountIrr: number;
  targetFinancialAccountId: string | null;
  paidClickedAt: number | null;
  /** When the receipt was submitted; anchors the 10-minute waiting period. */
  receiptSubmittedAt?: number | null;
  accountStatus: 'PENDING' | 'ACTIVE' | 'MUTED' | 'DECLINED' | null;
  /** Number of payment_cards rows the Mirzabot card resolved to. */
  cardMappingCount: number;
  /** True when this external order already has a successful verification. */
  orderAlreadyVerified?: boolean;
}

export interface MirzabotTxCandidate {
  id: string;
  direction: string;
  amountIrr: number | null;
  financialAccountId: string | null;
  bankTimestamp: number | null;
  /** Already part of a CONFIRMED / AUTO_VERIFIED match. */
  consumed: boolean;
  processingDisposition?: string;
}

export interface MirzabotDecisionDiagnostics {
  eligibleTransactionCount: number;
  /** Eligible claims contending for the candidate transaction, including self. */
  competingClaimCount: number;
  timeDeltaMs: number | null;
  candidateTransactionIds: string[];
  competingClaimIds: string[];
}

export interface MirzabotDecision {
  decision: MirzabotDecisionKind;
  claimId: string;
  reason: MirzabotDecisionReason;
  transactionId: string | null;
  diagnostics: MirzabotDecisionDiagnostics;
}

export interface MirzabotEvaluationOptions {
  /** Wall clock used to decide WAIT vs «no transfer found». */
  now?: number;
  maxDeltaMs?: number;
  waitingTimeoutMs?: number;
}

function waitingAnchorMs(claim: MirzabotClaimCandidate): number {
  return claim.receiptSubmittedAt ?? claim.paidClickedAt ?? 0;
}

const TERMINAL_CLAIM_STATUSES = new Set(['VERIFIED', 'REJECTED', 'FAKE_RECEIPT', 'EXPIRED']);

function isEligibleClaimStatus(status: string): boolean {
  // A Continuity/manual fulfilment is deliberately still live: the product
  // moved, but the bank evidence has not arrived yet. Letting the exact-match
  // engine see it is what eventually closes the reconciliation queue. The
  // verifier knows this status is reconciliation and does not deliver twice.
  return (
    status === 'PENDING' ||
    status === 'MATCH_SUGGESTED' ||
    status === 'FULFILLED_UNRECONCILED'
  );
}

/**
 * Claim-level gates that do not depend on any transaction.
 * Returns the blocking reason, or null when the claim may be considered.
 */
function claimPreconditionFailure(claim: MirzabotClaimCandidate): SuspectReason | null {
  if (claim.sourceSystem !== MIRZABOT_SOURCE) return 'INTEGRATION_ERROR';
  if (claim.orderAlreadyVerified === true) return 'DUPLICATE_ORDER';
  if (claim.status === 'VERIFIED') return 'DUPLICATE_ORDER';
  if (TERMINAL_CLAIM_STATUSES.has(claim.status)) return 'INTEGRATION_ERROR';
  if (!isEligibleClaimStatus(claim.status)) return 'INTEGRATION_ERROR';
  if (!claim.externalOrderId) return 'INTEGRATION_ERROR';
  if (!Number.isInteger(claim.expectedAmountIrr) || claim.expectedAmountIrr <= 0) {
    return 'INTEGRATION_ERROR';
  }
  if (claim.paidClickedAt == null) return 'INTEGRATION_ERROR';
  if (claim.cardMappingCount <= 0) return 'UNMAPPED_CARD';
  if (claim.cardMappingCount > 1) return 'AMBIGUOUS_CARD_MAPPING';
  if (!claim.targetFinancialAccountId) return 'UNMAPPED_CARD';
  if (claim.accountStatus !== 'ACTIVE') return 'ACCOUNT_NOT_ACTIVE';
  return null;
}

type EdgeRejection =
  | 'NOT_A_CANDIDATE'
  | 'TRANSACTION_ALREADY_CONSUMED'
  | 'AMOUNT_MISMATCH'
  | 'OUTSIDE_AUTO_MATCH_WINDOW';

/** Rejections worth explaining to a reviewer (NOT_A_CANDIDATE is just noise). */
type EdgeSuspectRejection = Exclude<EdgeRejection, 'NOT_A_CANDIDATE'>;

type EdgeResult =
  | { eligible: true; timeDeltaMs: number }
  | { eligible: false; rejection: EdgeRejection; timeDeltaMs: number | null };

/**
 * Hard filters for a single (claim, transaction) pair. Every condition is
 * exact — no tolerance, no rounding, no scoring.
 */
function evaluateEdge(
  claim: MirzabotClaimCandidate,
  tx: MirzabotTxCandidate,
  maxDeltaMs: number,
): EdgeResult {
  if (tx.direction !== 'CREDIT')
    return { eligible: false, rejection: 'NOT_A_CANDIDATE', timeDeltaMs: null };
  if (tx.processingDisposition && tx.processingDisposition !== 'ACTIONABLE') {
    return { eligible: false, rejection: 'NOT_A_CANDIDATE', timeDeltaMs: null };
  }
  if (tx.financialAccountId == null || tx.financialAccountId !== claim.targetFinancialAccountId) {
    return { eligible: false, rejection: 'NOT_A_CANDIDATE', timeDeltaMs: null };
  }
  if (tx.bankTimestamp == null)
    return { eligible: false, rejection: 'NOT_A_CANDIDATE', timeDeltaMs: null };

  const timeDeltaMs = Math.abs(tx.bankTimestamp - (claim.paidClickedAt as number));

  if (tx.amountIrr !== claim.expectedAmountIrr) {
    return { eligible: false, rejection: 'AMOUNT_MISMATCH', timeDeltaMs };
  }
  if (timeDeltaMs > maxDeltaMs) {
    return { eligible: false, rejection: 'OUTSIDE_AUTO_MATCH_WINDOW', timeDeltaMs };
  }
  if (tx.consumed) {
    return { eligible: false, rejection: 'TRANSACTION_ALREADY_CONSUMED', timeDeltaMs };
  }
  return { eligible: true, timeDeltaMs };
}

interface ClaimEdges {
  claim: MirzabotClaimCandidate;
  precondition: SuspectReason | null;
  eligible: { tx: MirzabotTxCandidate; timeDeltaMs: number }[];
  rejections: {
    tx: MirzabotTxCandidate;
    rejection: EdgeSuspectRejection;
    timeDeltaMs: number | null;
  }[];
}

function buildClaimEdges(
  claim: MirzabotClaimCandidate,
  transactions: MirzabotTxCandidate[],
  maxDeltaMs: number,
): ClaimEdges {
  const precondition = claimPreconditionFailure(claim);
  const edges: ClaimEdges = { claim, precondition, eligible: [], rejections: [] };
  if (precondition) return edges;
  for (const tx of transactions) {
    const r = evaluateEdge(claim, tx, maxDeltaMs);
    if (r.eligible) {
      edges.eligible.push({ tx, timeDeltaMs: r.timeDeltaMs });
    } else if (r.rejection !== 'NOT_A_CANDIDATE') {
      edges.rejections.push({ tx, rejection: r.rejection, timeDeltaMs: r.timeDeltaMs });
    }
  }
  return edges;
}

/**
 * Explanation when a claim has zero eligible transactions. Ordered by how
 * specific / actionable the reason is for a human reviewer.
 */
function explainNoEligibleTransaction(edges: ClaimEdges): {
  reason: SuspectReason;
  txId: string | null;
  timeDeltaMs: number | null;
} {
  const priority: EdgeSuspectRejection[] = [
    'TRANSACTION_ALREADY_CONSUMED',
    'OUTSIDE_AUTO_MATCH_WINDOW',
    'AMOUNT_MISMATCH',
  ];
  for (const rejection of priority) {
    const hits = edges.rejections.filter((r) => r.rejection === rejection);
    if (hits.length === 0) continue;
    const best = hits.reduce((a, b) =>
      (a.timeDeltaMs ?? Number.MAX_SAFE_INTEGER) <= (b.timeDeltaMs ?? Number.MAX_SAFE_INTEGER)
        ? a
        : b,
    );
    return { reason: rejection, txId: best.tx.id, timeDeltaMs: best.timeDeltaMs };
  }
  return { reason: 'NO_TRANSACTION', txId: null, timeDeltaMs: null };
}

function suggest(
  claimId: string,
  reason: SuspectReason,
  diagnostics: Partial<MirzabotDecisionDiagnostics> = {},
): MirzabotDecision {
  return {
    decision: 'SUGGEST',
    claimId,
    reason,
    transactionId: null,
    diagnostics: {
      eligibleTransactionCount: diagnostics.eligibleTransactionCount ?? 0,
      competingClaimCount: diagnostics.competingClaimCount ?? 0,
      timeDeltaMs: diagnostics.timeDeltaMs ?? null,
      candidateTransactionIds: diagnostics.candidateTransactionIds ?? [],
      competingClaimIds: diagnostics.competingClaimIds ?? [],
    },
  };
}

/**
 * Group evaluation over a bipartite claim↔transaction graph.
 *
 * A claim may AUTO_VERIFY only when its connected component is exactly one
 * claim joined to one transaction. Time distance is never a tiebreaker, and
 * the result does not depend on claim ordering.
 */
export function evaluateMirzabotGroup(
  claims: MirzabotClaimCandidate[],
  transactions: MirzabotTxCandidate[],
  opts: MirzabotEvaluationOptions = {},
): MirzabotDecision[] {
  const maxDeltaMs = opts.maxDeltaMs ?? AUTO_MATCH_MAX_TIME_DELTA_MS;
  const now = opts.now ?? Date.now();

  const seen = new Set<string>();
  const uniqueClaims = claims.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });

  const allEdges = uniqueClaims.map((c) => buildClaimEdges(c, transactions, maxDeltaMs));

  // Claims contending for each transaction, across the whole group.
  const claimsPerTx = new Map<string, string[]>();
  for (const e of allEdges) {
    if (e.precondition) continue;
    for (const { tx } of e.eligible) {
      const list = claimsPerTx.get(tx.id) ?? [];
      list.push(e.claim.id);
      claimsPerTx.set(tx.id, list);
    }
  }

  return allEdges.map((edges): MirzabotDecision => {
    const claimId = edges.claim.id;

    if (edges.precondition) {
      return suggest(claimId, edges.precondition);
    }

    if (edges.eligible.length > 1) {
      return suggest(claimId, 'AMBIGUOUS_TRANSACTIONS', {
        eligibleTransactionCount: edges.eligible.length,
        candidateTransactionIds: edges.eligible.map((e) => e.tx.id),
        competingClaimCount: 1,
      });
    }

    if (edges.eligible.length === 0) {
      const explained = explainNoEligibleTransaction(edges);
      const diagnostics = {
        eligibleTransactionCount: 0,
        competingClaimCount: 0,
        timeDeltaMs: explained.timeDeltaMs,
        candidateTransactionIds: explained.txId ? [explained.txId] : [],
        competingClaimIds: [],
      };
      // No bank evidence yet — hold through the 10-minute waiting period
      // (from receipt submission). This is separate from the ±5m auto-match
      // window; evidence-bearing rejections above already suggested immediately.
      if (explained.reason === 'NO_TRANSACTION') {
        const waitingTimeoutMs = opts.waitingTimeoutMs ?? WAITING_TIMEOUT_MS;
        const waitingEndsAt = waitingAnchorMs(edges.claim) + waitingTimeoutMs;
        if (now < waitingEndsAt) {
          return {
            decision: 'WAIT',
            claimId,
            reason: 'AWAITING_BANK_SMS',
            transactionId: null,
            diagnostics,
          };
        }
        return suggest(claimId, 'NO_TRANSACTION_AFTER_10M', diagnostics);
      }
      return suggest(claimId, explained.reason, diagnostics);
    }

    const only = edges.eligible[0]!;
    const contenders = claimsPerTx.get(only.tx.id) ?? [claimId];
    if (contenders.length > 1) {
      return suggest(claimId, 'AMBIGUOUS_CLAIMS', {
        eligibleTransactionCount: 1,
        competingClaimCount: contenders.length,
        timeDeltaMs: only.timeDeltaMs,
        candidateTransactionIds: [only.tx.id],
        competingClaimIds: contenders.filter((id) => id !== claimId),
      });
    }

    return {
      decision: 'AUTO_VERIFY',
      claimId,
      reason: 'UNIQUE_EXACT_MATCH',
      transactionId: only.tx.id,
      diagnostics: {
        eligibleTransactionCount: 1,
        competingClaimCount: 1,
        timeDeltaMs: only.timeDeltaMs,
        candidateTransactionIds: [only.tx.id],
        competingClaimIds: [],
      },
    };
  });
}

/**
 * Single-claim entry point. `competingClaims` must contain every other
 * pending Mirzabot claim that could contend for the same transactions.
 */
export function evaluateClaimForAutoVerification(
  claim: MirzabotClaimCandidate,
  transactions: MirzabotTxCandidate[],
  competingClaims: MirzabotClaimCandidate[] = [],
  opts: MirzabotEvaluationOptions = {},
): MirzabotDecision {
  const decisions = evaluateMirzabotGroup([claim, ...competingClaims], transactions, opts);
  return decisions.find((d) => d.claimId === claim.id)!;
}
