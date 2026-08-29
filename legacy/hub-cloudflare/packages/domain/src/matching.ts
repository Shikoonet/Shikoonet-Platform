/**
 * Shared matching service.
 *
 * One entry point — `suggestMatchesForTransaction` — is called by every
 * trigger that may need to recompute suggestions:
 *   - ingest (after creating a tx candidate)
 *   - claim create / update
 *   - account assign / backfill (when financial_account_id changes)
 *   - reparse (when the parser extracts a new amount or account)
 *
 * Criteria for an *eligible* suggestion (all must hold):
 *   - claim status is PENDING or MATCH_SUGGESTED (not terminal).
 *   - tx.direction === 'CREDIT' (debits do not pay claims).
 *   - tx.amount_irr is not null and === claim.expected_amount_irr.
 *   - time proximity: |tx.bank_timestamp - claim.submitted_at| <= window.
 *   - account compatibility: either both null (unattributed both sides),
 *     both equal, or hint-compat (tx has hint, claim account_id is null).
 *   - **account.status === 'ACTIVE'** — PENDING / MUTED / DECLINED
 *     accounts are excluded from matching. Their tx rows are still
 *     written (so auto-discovery on a PENDING account remains auditable)
 *     but they never enter a SUGGESTED / AUTO_VERIFIED state.
 *
 * The deterministic `scoreMatch` from `./score.ts` produces the score; we
 * only suggest when score >= `needsReviewThreshold`. We do NOT auto-verify:
 * a human must confirm. Suggestions are INSERT OR IGNORE so re-running
 * the service is idempotent.
 */

import type {
  D1Database,
  PaymentClaimRow,
  TransactionCandidateRow,
  FinancialAccountRow,
} from '@hub/database';
import { SQL } from '@hub/database';
import { scoreMatch, DEFAULT_SCORER, type ScorerConfig } from './score.js';

export interface SuggestInput {
  tx: Pick<
    TransactionCandidateRow,
    | 'id'
    | 'amount_irr'
    | 'direction'
    | 'financial_account_id'
    | 'transaction_reference'
    | 'bank_timestamp'
  >;
  cfg?: Partial<ScorerConfig>;
}

export interface SuggestResult {
  suggested: number;
  updated: number;
  topScore: number;
  topClaimId: string | null;
}

const DEFAULT_CFG: ScorerConfig = {
  ...DEFAULT_SCORER,
  // Tighter default for the shared service: only strong matches surface.
  needsReviewThreshold: 0.45,
};

/**
 * Suggest matches for a single transaction candidate.
 *
 * Strategy:
 *   1. Load candidate open claims: those whose account matches the tx's
 *      financial_account_id (or which target NO account, for unattributed
 *      claims) and whose status is non-terminal.
 *   2. Filter by direction (CREDIT only) and amount equality.
 *   3. Score the survivors; pick the top.
 *   4. INSERT OR IGNORE a SUGGESTED match row; mirror statuses.
 */
export async function suggestMatchesForTransaction(
  db: D1Database,
  input: SuggestInput,
): Promise<SuggestResult> {
  const cfg: ScorerConfig = { ...DEFAULT_CFG, ...(input.cfg ?? {}) };
  const tx = input.tx;
  if (tx.direction !== 'CREDIT') {
    return { suggested: 0, updated: 0, topScore: 0, topClaimId: null };
  }
  if (tx.amount_irr === null || tx.amount_irr === undefined) {
    return { suggested: 0, updated: 0, topScore: 0, topClaimId: null };
  }
  if (tx.bank_timestamp === null || tx.bank_timestamp === undefined) {
    return { suggested: 0, updated: 0, topScore: 0, topClaimId: null };
  }

  // Open claims: same account (or null) and non-terminal.
  //
  // MIRZABOT claims are excluded: their eligibility is decided solely by
  // mirzabotMatch.ts against paid_clicked_at, not by this scorer's
  // submitted_at proximity. Letting both run produced suggestions that
  // ignored the card→account mapping and the ±5m payment window.
  const claims = await db
    .prepare(
      `SELECT * FROM payment_claims
        WHERE status IN ('PENDING','MATCH_SUGGESTED')
          AND source_system != 'MIRZABOT'
          AND (target_financial_account_id IS NULL
               OR target_financial_account_id = ?1)
          AND ABS(submitted_at - ?2) <= ?3
        ORDER BY submitted_at DESC
        LIMIT 50`,
    )
    .bind(tx.financial_account_id ?? '', tx.bank_timestamp, cfg.timeWindowMs)
    .all<PaymentClaimRow>();
  if (claims.results.length === 0) {
    return { suggested: 0, updated: 0, topScore: 0, topClaimId: null };
  }

  // Amount pre-filter — required by "do not auto-approve based only on
  // amount" + "must require eligible amount criteria".
  const amountMatch = claims.results.filter((c) => c.expected_amount_irr === tx.amount_irr);
  if (amountMatch.length === 0) {
    return { suggested: 0, updated: 0, topScore: 0, topClaimId: null };
  }

  let account: FinancialAccountRow | null = null;
  if (tx.financial_account_id) {
    account = await db
      .prepare(`SELECT * FROM financial_accounts WHERE id = ?1`)
      .bind(tx.financial_account_id)
      .first<FinancialAccountRow>();
    // PENDING / MUTED / DECLINED accounts never enter matching. The
    // tx row is preserved (so the audit chain is intact) but no
    // SUGGESTED match row is created. Centralised here so every
    // code path that calls suggestMatchesForTransaction gets the
    // same behaviour.
    if (account && account.status !== 'ACTIVE') {
      return { suggested: 0, updated: 0, topScore: 0, topClaimId: null };
    }
  }

  // Score all amount-matched claims; pick the top.
  let topScore = 0;
  let topClaim: PaymentClaimRow | null = null;
  let topBreakdown: { matching: string[]; mismatching: string[] } | null = null;
  for (const claim of amountMatch) {
    const b = scoreMatch(tx, claim, account, cfg);
    if (b.score > topScore) {
      topScore = b.score;
      topClaim = claim;
      topBreakdown = { matching: b.matching, mismatching: b.mismatching };
    }
  }
  if (!topClaim || !topBreakdown || topScore < cfg.needsReviewThreshold) {
    return { suggested: 0, updated: 0, topScore, topClaimId: null };
  }

  // Skip if this tx is already CONFIRMED — partial unique index would
  // also enforce this, but checking up-front is clearer.
  const existing = await db
    .prepare(
      `SELECT id, status FROM reconciliation_matches
        WHERE transaction_candidate_id = ?1 AND payment_claim_id = ?2`,
    )
    .bind(tx.id, topClaim.id)
    .first<{ id: string; status: string }>();
  if (existing && existing.status === 'CONFIRMED') {
    return { suggested: 0, updated: 0, topScore, topClaimId: topClaim.id };
  }

  const now = Date.now();
  const matchId = existing?.id ?? crypto.randomUUID();
  if (existing) {
    await db
      .prepare(
        `UPDATE reconciliation_matches
            SET score = ?2, matching_reasons_json = ?3, mismatch_reasons_json = ?4,
                status = 'SUGGESTED', updated_at = ?5
          WHERE id = ?1 AND status IN ('SUGGESTED','AUTO_VERIFIED')`,
      )
      .bind(
        matchId,
        topScore,
        JSON.stringify(topBreakdown.matching),
        JSON.stringify(topBreakdown.mismatching),
        now,
      )
      .run();
  } else {
    await db
      .prepare(
        `INSERT OR IGNORE INTO reconciliation_matches
           (id, transaction_candidate_id, payment_claim_id, score,
            matching_reasons_json, mismatch_reasons_json, status,
            created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'SUGGESTED', ?7, ?7)`,
      )
      .bind(
        matchId,
        tx.id,
        topClaim.id,
        topScore,
        JSON.stringify(topBreakdown.matching),
        JSON.stringify(topBreakdown.mismatching),
        now,
      )
      .run();
  }

  // Mirror statuses onto the tx + claim so the dashboard reflects the
  // match. Claim was PENDING → MATCH_SUGGESTED; tx was PARSED → MATCH_SUGGESTED.
  await db
    .prepare(
      `UPDATE transaction_candidates
          SET status = 'MATCH_SUGGESTED', updated_at = ?2
        WHERE id = ?1 AND status IN ('PARSED','NEEDS_REVIEW')`,
    )
    .bind(tx.id, now)
    .run();
  await db
    .prepare(
      `UPDATE payment_claims
          SET status = 'MATCH_SUGGESTED', updated_at = ?2
        WHERE id = ?1 AND status = 'PENDING'`,
    )
    .bind(topClaim.id, now)
    .run();

  return { suggested: 1, updated: existing ? 1 : 0, topScore, topClaimId: topClaim.id };
}

/**
 * Suggest matches for every transaction whose status is PARSED or
 * NEEDS_REVIEW. Used by the "rerun matching for newly assigned" trigger
 * after an account identifier is added.
 */
export async function rerunMatchingForUnassigned(
  db: D1Database,
  opts: { limit?: number } = {},
): Promise<{ suggested: number; processed: number }> {
  const limit = opts.limit ?? 500;
  const rows = await db
    .prepare(
      `SELECT id, amount_irr, direction, financial_account_id, transaction_reference, bank_timestamp
         FROM transaction_candidates t
         LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
        WHERE t.status IN ('PARSED','NEEDS_REVIEW')
          AND t.amount_irr IS NOT NULL
          AND t.bank_timestamp IS NOT NULL
          AND ${SQL.actionableTransactionWhereT}
          AND ${SQL.accountStatusWhere}
        ORDER BY t.created_at DESC
        LIMIT ?1`,
    )
    .bind(limit)
    .all<
      Pick<
        TransactionCandidateRow,
        | 'id'
        | 'amount_irr'
        | 'direction'
        | 'financial_account_id'
        | 'transaction_reference'
        | 'bank_timestamp'
      >
    >();
  let suggested = 0;
  for (const tx of rows.results) {
    const r = await suggestMatchesForTransaction(db, { tx });
    suggested += r.suggested;
  }
  return { suggested, processed: rows.results.length };
}
