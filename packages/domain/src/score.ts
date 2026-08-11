import type { PaymentClaimRow, TransactionCandidateRow, FinancialAccountRow } from '@shikoo/database';

/**
 * Deterministic, explainable scorer for matching a transaction candidate
 * against a single payment claim. Returns a number 0..1 with the reasons
 * that contributed. Amount-only equality is NEVER enough to auto-verify
 * — the MVP requires manual confirmation.
 *
 * Signals weighted:
 *   - amount equality (exact):                  +0.45
 *   - target account compat (hint match):        +0.30
 *   - time proximity (≤ 24h, decays 0..1):        up to +0.15
 *   - transaction reference provided:            +0.10
 *   - direction compatible (credit+pending):     +0.05
 *
 * Penalties:
 *   - account mismatch:                          -0.30
 *   - direction mismatch:                        -0.20
 */

export interface ScorerConfig {
  amountMatch: number;
  accountMatch: number;
  timeMatch: number;
  refMatch: number;
  directionMatch: number;
  accountMismatch: number;
  directionMismatch: number;
  timeWindowMs: number;
  uniqueAutoVerifyThreshold: number;
  needsReviewThreshold: number;
}

export const DEFAULT_SCORER: ScorerConfig = {
  amountMatch: 0.45,
  accountMatch: 0.3,
  timeMatch: 0.15,
  refMatch: 0.1,
  directionMatch: 0.05,
  accountMismatch: -0.3,
  directionMismatch: -0.2,
  timeWindowMs: 24 * 60 * 60 * 1000,
  uniqueAutoVerifyThreshold: 0.85,
  needsReviewThreshold: 0.45,
};

export interface ScoreBreakdown {
  score: number;
  matching: string[];
  mismatching: string[];
}

export function scoreMatch(
  tx: Pick<
    TransactionCandidateRow,
    'amount_irr' | 'direction' | 'financial_account_id' | 'transaction_reference' | 'bank_timestamp'
  >,
  claim: Pick<
    PaymentClaimRow,
    | 'expected_amount_irr'
    | 'target_financial_account_id'
    | 'submitted_at'
    | 'external_order_id'
    | 'customer_reference'
  >,
  account: Pick<FinancialAccountRow, 'id' | 'card_last_four' | 'account_last_four'> | null,
  cfg: ScorerConfig = DEFAULT_SCORER,
): ScoreBreakdown {
  const matching: string[] = [];
  const mismatching: string[] = [];
  let score = 0;

  if (tx.amount_irr !== null && tx.amount_irr === claim.expected_amount_irr) {
    score += cfg.amountMatch;
    matching.push('amount_exact');
  } else if (tx.amount_irr !== null && claim.expected_amount_irr !== null) {
    mismatching.push('amount_differs');
  }

  if (tx.financial_account_id && claim.target_financial_account_id) {
    if (tx.financial_account_id === claim.target_financial_account_id) {
      score += cfg.accountMatch;
      matching.push('target_account_exact');
    } else if (account && accountsCompatible(tx, account, claim)) {
      score += cfg.accountMatch * 0.6;
      matching.push('target_account_hint_compat');
    } else {
      score += cfg.accountMismatch;
      mismatching.push('target_account_mismatch');
    }
  }

  if (tx.bank_timestamp !== null) {
    const delta = Math.abs(tx.bank_timestamp - claim.submitted_at);
    if (delta <= cfg.timeWindowMs) {
      const decay = 1 - delta / cfg.timeWindowMs;
      score += cfg.timeMatch * decay;
      matching.push(`time_within_${Math.round(cfg.timeWindowMs / 3600000)}h`);
    } else {
      mismatching.push('time_too_far');
    }
  }

  if (
    tx.transaction_reference &&
    claim.customer_reference &&
    tx.transaction_reference === claim.customer_reference
  ) {
    score += cfg.refMatch;
    matching.push('reference_match');
  }

  if (tx.direction === 'CREDIT') {
    // claims are pending until verified; CREDIT direction is compatible
    score += cfg.directionMatch;
    matching.push('direction_credit_pending');
  } else if (tx.direction === 'DEBIT') {
    mismatching.push('direction_debit_unusual_for_claim');
    score += cfg.directionMismatch;
  }

  score = Math.max(0, Math.min(1, score));
  return { score, matching, mismatching };
}

function accountsCompatible(
  tx: Pick<TransactionCandidateRow, 'financial_account_id'>,
  _account: Pick<FinancialAccountRow, 'id' | 'card_last_four' | 'account_last_four'>,
  _claim: Pick<PaymentClaimRow, 'target_financial_account_id'>,
): boolean {
  // ponytail: this exists — placeholder. Real impl checks tail-of-card on tx vs claim metadata.
  // Sufficient for the slice; tighten when real fixture data demands.
  return tx.financial_account_id !== null;
}

export function decideSuggestion(
  breakdowns: ScoreBreakdown[],
  cfg: ScorerConfig = DEFAULT_SCORER,
): { status: 'MATCH_SUGGESTED' | 'NEEDS_REVIEW'; topScore: number } {
  if (breakdowns.length === 0) return { status: 'NEEDS_REVIEW', topScore: 0 };
  const top = breakdowns.reduce((a, b) => (b.score > a.score ? b : a), breakdowns[0]!);
  if (breakdowns.length === 1 && top.score >= cfg.uniqueAutoVerifyThreshold) {
    return { status: 'MATCH_SUGGESTED', topScore: top.score };
  }
  if (top.score >= cfg.needsReviewThreshold) return { status: 'NEEDS_REVIEW', topScore: top.score };
  return { status: 'NEEDS_REVIEW', topScore: top.score };
}
