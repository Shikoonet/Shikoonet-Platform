/**
 * Reopen operator-initiated manual Mirzabot verification.
 *
 * Does NOT touch AUTO_VERIFIED matches or bot fulfillment webhooks.
 * Reverses only the reconciliation decision, releases transaction ownership when
 * safe, then re-runs classification — never auto-verifies on reopen.
 */

import type { D1Database } from '@shikoo/database';
import { MIRZABOT_SOURCE } from '@shikoo/contracts';
import {
  evaluateMirzabotGroup,
  type MirzabotClaimCandidate,
  type MirzabotDecision,
  type MirzabotTxCandidate,
} from './mirzabotMatch.js';

export interface ManualVerificationRevertSnapshot {
  claimStatus: 'PENDING' | 'MATCH_SUGGESTED';
  suspectReason: string | null;
  suspectMetadataJson: string;
  transactionId?: string;
  transactionStatus?: string;
  matchId?: string;
}

export type ReopenManualVerificationFailure =
  | 'CLAIM_NOT_FOUND'
  | 'NOT_MANUALLY_VERIFIED'
  | 'AUTO_VERIFIED_NOT_REVERTABLE'
  | 'NO_REVERT_SNAPSHOT'
  | 'ALREADY_REOPENED'
  | 'REASON_REQUIRED'
  | 'TRANSACTION_NOT_RELEASEABLE';

/** @deprecated Use ReopenManualVerificationFailure */
export type RevertManualVerificationFailure =
  | Exclude<
      ReopenManualVerificationFailure,
      'REASON_REQUIRED' | 'TRANSACTION_NOT_RELEASEABLE' | 'ALREADY_REOPENED'
    >
  | 'ALREADY_REVERTED';

export type ReopenReviewQueue = 'WAITING' | 'NEEDS_REVIEW' | 'SUSPECTED_FAKE';

export type ReopenManualVerificationResult =
  | {
      ok: true;
      claimId: string;
      orderId: string;
      previousState: 'MANUALLY_VERIFIED';
      reviewQueue: ReopenReviewQueue;
      suspectReason: string | null;
      transactionId: string | null;
      fulfillmentState: 'UNKNOWN';
    }
  | { ok: false; error: ReopenManualVerificationFailure };

/** @deprecated Use ReopenManualVerificationResult */
export type RevertManualVerificationResult =
  | {
      ok: true;
      claimId: string;
      restoredClaimStatus: 'PENDING' | 'MATCH_SUGGESTED';
      restoredSuspectReason: string | null;
      transactionId: string | null;
    }
  | { ok: false; error: RevertManualVerificationFailure };

const CONSUMING_MATCH_STATUSES = "('CONFIRMED','AUTO_VERIFIED')";

export function encodeRevertSnapshotForMatch(snapshot: ManualVerificationRevertSnapshot): string {
  return JSON.stringify({ revertSnapshot: snapshot });
}

export function encodeRevertSnapshotForMetadata(
  metadataJson: string,
  snapshot: ManualVerificationRevertSnapshot,
): string {
  const meta = JSON.parse(metadataJson || '{}') as Record<string, unknown>;
  meta._revertSnapshot = snapshot;
  return JSON.stringify(meta);
}

export function extractRevertSnapshot(
  mismatchReasonsJson: string | null | undefined,
  metadataJson: string | null | undefined,
): ManualVerificationRevertSnapshot | null {
  if (mismatchReasonsJson) {
    try {
      const parsed = JSON.parse(mismatchReasonsJson) as {
        revertSnapshot?: ManualVerificationRevertSnapshot;
      };
      if (parsed.revertSnapshot?.claimStatus) return parsed.revertSnapshot;
    } catch {
      /* ignore */
    }
  }
  if (metadataJson) {
    try {
      const meta = JSON.parse(metadataJson) as {
        _revertSnapshot?: ManualVerificationRevertSnapshot;
      };
      if (meta._revertSnapshot?.claimStatus) return meta._revertSnapshot;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function isManualVerificationReopenEligible(args: {
  claimStatus: string;
  matchStatus: string | null;
  mismatchReasonsJson?: string | null;
  metadataJson?: string | null;
}): boolean {
  if (args.claimStatus !== 'VERIFIED') return false;
  if (args.matchStatus === 'AUTO_VERIFIED') return false;
  return extractRevertSnapshot(args.mismatchReasonsJson ?? null, args.metadataJson ?? null) != null;
}

/** @deprecated Use isManualVerificationReopenEligible */
export const isManualVerificationRevertEligible = isManualVerificationReopenEligible;

interface ClaimRow {
  id: string;
  status: string;
  source_system: string;
  metadata_json: string;
  external_order_id: string;
}

interface MatchRow {
  id: string;
  status: string;
  transaction_candidate_id: string;
  mismatch_reasons_json: string;
}

function stripRevertSnapshotFromMetadata(metadataJson: string): string {
  const meta = JSON.parse(metadataJson || '{}') as Record<string, unknown>;
  delete meta._revertSnapshot;
  return JSON.stringify(meta);
}

function defaultTxStatus(snapshot: ManualVerificationRevertSnapshot): string {
  return snapshot.transactionStatus && snapshot.transactionStatus !== 'APPROVED'
    ? snapshot.transactionStatus
    : 'MATCH_SUGGESTED';
}

function orderId(external: string): string {
  return external.replace(/^mirzabot:test:/, '');
}

function reviewQueueFromDecision(decision: MirzabotDecision): ReopenReviewQueue {
  if (decision.decision === 'WAIT') return 'WAITING';
  if (decision.reason === 'NO_TRANSACTION_AFTER_10M' || decision.reason === 'NO_TRANSACTION') {
    return 'SUSPECTED_FAKE';
  }
  return 'NEEDS_REVIEW';
}

async function loadClaimCandidate(
  db: D1Database,
  claimId: string,
): Promise<MirzabotClaimCandidate | null> {
  const row = await db
    .prepare(
      `SELECT c.id, c.status, c.external_order_id, c.expected_amount_irr,
              c.target_financial_account_id, c.paid_clicked_at, c.receipt_submitted_at,
              c.card_digits,
              (SELECT COUNT(*) FROM payment_cards pc WHERE pc.card_digits = c.card_digits)
                AS card_mapping_count,
              (SELECT pc.financial_account_id FROM payment_cards pc
                WHERE pc.card_digits = c.card_digits LIMIT 1) AS mapped_account_id,
              (SELECT fa.status FROM payment_cards pc
                 JOIN financial_accounts fa ON fa.id = pc.financial_account_id
                WHERE pc.card_digits = c.card_digits LIMIT 1) AS mapped_account_status,
              fa.status AS target_account_status,
              EXISTS(
                SELECT 1 FROM reconciliation_matches m
                 WHERE m.payment_claim_id = c.id
                   AND m.status IN ${CONSUMING_MATCH_STATUSES}
              ) AS order_already_verified
       FROM payment_claims c
       LEFT JOIN financial_accounts fa ON fa.id = c.target_financial_account_id
       WHERE c.id = ?1 AND c.source_system = ?2`,
    )
    .bind(claimId, MIRZABOT_SOURCE)
    .first<{
      id: string;
      status: string;
      external_order_id: string;
      expected_amount_irr: number;
      target_financial_account_id: string | null;
      paid_clicked_at: number | null;
      receipt_submitted_at: number | null;
      card_digits: string | null;
      card_mapping_count: number;
      mapped_account_id: string | null;
      mapped_account_status: string | null;
      target_account_status: string | null;
      order_already_verified: number;
    }>();
  if (!row) return null;
  const accountId = row.mapped_account_id ?? row.target_financial_account_id;
  const cardMappingCount = row.card_digits
    ? row.card_mapping_count
    : row.target_financial_account_id
      ? 1
      : 0;
  const accountStatus =
    (row.mapped_account_status as MirzabotClaimCandidate['accountStatus']) ??
    (row.target_account_status as MirzabotClaimCandidate['accountStatus']) ??
    null;
  return {
    id: row.id,
    sourceSystem: MIRZABOT_SOURCE,
    status: row.status,
    externalOrderId: row.external_order_id,
    expectedAmountIrr: row.expected_amount_irr,
    targetFinancialAccountId: accountId,
    paidClickedAt: row.paid_clicked_at,
    receiptSubmittedAt: row.receipt_submitted_at,
    accountStatus,
    cardMappingCount,
    orderAlreadyVerified: row.order_already_verified === 1,
  };
}

async function loadCompetingClaims(
  db: D1Database,
  accountId: string,
  excludeClaimId: string,
): Promise<MirzabotClaimCandidate[]> {
  const rows = await db
    .prepare(
      `SELECT c.id, c.status, c.external_order_id, c.expected_amount_irr,
              c.target_financial_account_id, c.paid_clicked_at, c.receipt_submitted_at,
              c.card_digits,
              (SELECT COUNT(*) FROM payment_cards pc WHERE pc.card_digits = c.card_digits)
                AS card_mapping_count,
              (SELECT pc.financial_account_id FROM payment_cards pc
                WHERE pc.card_digits = c.card_digits LIMIT 1) AS mapped_account_id,
              (SELECT fa.status FROM payment_cards pc
                 JOIN financial_accounts fa ON fa.id = pc.financial_account_id
                WHERE pc.card_digits = c.card_digits LIMIT 1) AS mapped_account_status,
              EXISTS(
                SELECT 1 FROM reconciliation_matches m
                 WHERE m.payment_claim_id = c.id
                   AND m.status IN ${CONSUMING_MATCH_STATUSES}
              ) AS order_already_verified
       FROM payment_claims c
       WHERE c.source_system = ?1
         AND c.status IN ('PENDING','MATCH_SUGGESTED')
         AND c.id != ?2
         AND (c.target_financial_account_id = ?3
              OR EXISTS (
                SELECT 1 FROM payment_cards pc
                 WHERE pc.card_digits = c.card_digits AND pc.financial_account_id = ?3
              ))`,
    )
    .bind(MIRZABOT_SOURCE, excludeClaimId, accountId)
    .all<{
      id: string;
      status: string;
      external_order_id: string;
      expected_amount_irr: number;
      target_financial_account_id: string | null;
      paid_clicked_at: number | null;
      receipt_submitted_at: number | null;
      card_digits: string | null;
      card_mapping_count: number;
      mapped_account_id: string | null;
      mapped_account_status: string | null;
      order_already_verified: number;
    }>();

  return (rows.results ?? []).map((r) => ({
    id: r.id,
    sourceSystem: MIRZABOT_SOURCE,
    status: r.status,
    externalOrderId: r.external_order_id,
    expectedAmountIrr: r.expected_amount_irr,
    targetFinancialAccountId: r.mapped_account_id ?? r.target_financial_account_id,
    paidClickedAt: r.paid_clicked_at,
    receiptSubmittedAt: r.receipt_submitted_at,
    accountStatus: (r.mapped_account_status as MirzabotClaimCandidate['accountStatus']) ?? null,
    cardMappingCount: r.card_digits ? r.card_mapping_count : r.target_financial_account_id ? 1 : 0,
    orderAlreadyVerified: r.order_already_verified === 1,
  }));
}

async function loadAccountTransactions(
  db: D1Database,
  accountId: string,
): Promise<MirzabotTxCandidate[]> {
  const rows = await db
    .prepare(
      `SELECT t.id, t.direction, t.amount_irr, t.financial_account_id, t.bank_timestamp,
              t.processing_disposition,
              EXISTS(
                SELECT 1 FROM reconciliation_matches m
                 WHERE m.transaction_candidate_id = t.id
                   AND m.status IN ${CONSUMING_MATCH_STATUSES}
              ) AS consumed
       FROM transaction_candidates t
       WHERE t.financial_account_id = ?1
         AND t.direction = 'CREDIT'
         AND t.processing_disposition = 'ACTIONABLE'`,
    )
    .bind(accountId)
    .all<{
      id: string;
      direction: string;
      amount_irr: number | null;
      financial_account_id: string | null;
      bank_timestamp: number | null;
      processing_disposition: string;
      consumed: number;
    }>();

  return (rows.results ?? []).map((r) => ({
    id: r.id,
    direction: r.direction,
    amountIrr: r.amount_irr,
    financialAccountId: r.financial_account_id,
    bankTimestamp: r.bank_timestamp,
    consumed: r.consumed === 1,
    processingDisposition: r.processing_disposition,
  }));
}

async function persistReclassification(
  db: D1Database,
  claimId: string,
  decision: MirzabotDecision,
  now: number,
): Promise<void> {
  if (decision.decision === 'WAIT') {
    await db
      .prepare(
        `UPDATE payment_claims SET suspect_reason = NULL, suspect_metadata_json = '{}', updated_at = ?2
         WHERE id = ?1 AND status IN ('PENDING','MATCH_SUGGESTED')`,
      )
      .bind(claimId, now)
      .run();
    return;
  }

  const effectiveDecision =
    decision.decision === 'AUTO_VERIFY'
      ? {
          ...decision,
          decision: 'SUGGEST' as const,
          reason: 'AMBIGUOUS_TRANSACTIONS' as const,
        }
      : decision;

  await db
    .prepare(
      `UPDATE payment_claims
         SET suspect_reason = ?2, suspect_metadata_json = ?3, updated_at = ?4
       WHERE id = ?1 AND status IN ('PENDING','MATCH_SUGGESTED')`,
    )
    .bind(claimId, effectiveDecision.reason, JSON.stringify(effectiveDecision.diagnostics), now)
    .run();
}

async function reclassifyMirzabotClaim(
  db: D1Database,
  claimId: string,
  now: number,
): Promise<{ decision: MirzabotDecision; reviewQueue: ReopenReviewQueue }> {
  const claim = await loadClaimCandidate(db, claimId);
  if (!claim?.targetFinancialAccountId) {
    const fallback: MirzabotDecision = {
      decision: 'SUGGEST',
      claimId,
      reason: 'UNMAPPED_CARD',
      transactionId: null,
      diagnostics: {
        eligibleTransactionCount: 0,
        competingClaimCount: 0,
        timeDeltaMs: null,
        candidateTransactionIds: [],
        competingClaimIds: [],
      },
    };
    await persistReclassification(db, claimId, fallback, now);
    return { decision: fallback, reviewQueue: 'NEEDS_REVIEW' };
  }

  const competing = await loadCompetingClaims(db, claim.targetFinancialAccountId, claimId);
  const txs = await loadAccountTransactions(db, claim.targetFinancialAccountId);
  const decisions = evaluateMirzabotGroup([claim, ...competing], txs, { now });
  const decision = decisions.find((d) => d.claimId === claimId)!;
  await persistReclassification(db, claimId, decision, now);
  return { decision, reviewQueue: reviewQueueFromDecision(decision) };
}

/**
 * Reopen an operator manual verification and return the claim to Review queues.
 */
export async function reopenMirzabotManualVerification(
  db: D1Database,
  args: { claimId: string; actorEmail: string; reason: string },
): Promise<ReopenManualVerificationResult> {
  if (!args.reason.trim()) return { ok: false, error: 'REASON_REQUIRED' };

  const claim = await db
    .prepare(
      `SELECT id, status, source_system, metadata_json, external_order_id
       FROM payment_claims WHERE id = ?1`,
    )
    .bind(args.claimId)
    .first<ClaimRow>();
  if (!claim || claim.source_system !== MIRZABOT_SOURCE) {
    return { ok: false, error: 'CLAIM_NOT_FOUND' };
  }
  if (claim.status !== 'VERIFIED') {
    return { ok: false, error: 'NOT_MANUALLY_VERIFIED' };
  }

  const match = await db
    .prepare(
      `SELECT id, status, transaction_candidate_id, mismatch_reasons_json
       FROM reconciliation_matches
       WHERE payment_claim_id = ?1 AND status IN ${CONSUMING_MATCH_STATUSES}
       ORDER BY CASE status WHEN 'AUTO_VERIFIED' THEN 0 ELSE 1 END, created_at DESC
       LIMIT 1`,
    )
    .bind(args.claimId)
    .first<MatchRow>();

  if (match?.status === 'AUTO_VERIFIED') {
    return { ok: false, error: 'AUTO_VERIFIED_NOT_REVERTABLE' };
  }

  const snapshot = extractRevertSnapshot(match?.mismatch_reasons_json ?? null, claim.metadata_json);
  if (!snapshot) {
    return { ok: false, error: 'NO_REVERT_SNAPSHOT' };
  }

  if (snapshot.matchId && match && snapshot.matchId !== match.id) {
    return { ok: false, error: 'NO_REVERT_SNAPSHOT' };
  }

  const txId = snapshot.transactionId ?? match?.transaction_candidate_id ?? null;
  if (txId) {
    const reseller = await db
      .prepare(`SELECT id FROM reseller_transactions WHERE transaction_candidate_id = ?1`)
      .bind(txId)
      .first<{ id: string }>();
    if (reseller) return { ok: false, error: 'TRANSACTION_NOT_RELEASEABLE' };

    const otherConsuming = await db
      .prepare(
        `SELECT m.id FROM reconciliation_matches m
         WHERE m.transaction_candidate_id = ?1
           AND m.status IN ${CONSUMING_MATCH_STATUSES}
           AND m.payment_claim_id != ?2
         LIMIT 1`,
      )
      .bind(txId, args.claimId)
      .first<{ id: string }>();
    if (otherConsuming) return { ok: false, error: 'TRANSACTION_NOT_RELEASEABLE' };
  }

  const now = Date.now();
  const restoredMetadata = stripRevertSnapshotFromMetadata(claim.metadata_json);

  const claimUpdate = await db
    .prepare(
      `UPDATE payment_claims
         SET status = 'PENDING', suspect_reason = NULL, suspect_metadata_json = '{}',
             metadata_json = ?2, updated_at = ?3
       WHERE id = ?1 AND status = 'VERIFIED'`,
    )
    .bind(args.claimId, restoredMetadata, now)
    .run();
  if ((claimUpdate.meta?.changes ?? 0) === 0) {
    return { ok: false, error: 'ALREADY_REOPENED' };
  }

  const batch = [];

  if (match?.status === 'CONFIRMED') {
    batch.push(
      db
        .prepare(
          `UPDATE reconciliation_matches
             SET status = 'REJECTED', reviewed_by = ?2, reviewed_at = ?3, updated_at = ?3
           WHERE id = ?1 AND status = 'CONFIRMED'`,
        )
        .bind(match.id, args.actorEmail, now),
    );
  }

  if (txId) {
    batch.push(
      db
        .prepare(
          `UPDATE transaction_candidates
             SET status = ?2, updated_at = ?3
           WHERE id = ?1 AND status = 'APPROVED'`,
        )
        .bind(txId, defaultTxStatus(snapshot), now),
    );
  }

  if (batch.length > 0) {
    await db.batch(batch);
  }

  const reopened = await db
    .prepare(`SELECT status FROM payment_claims WHERE id = ?1`)
    .bind(args.claimId)
    .first<{ status: string }>();
  if (reopened?.status === 'VERIFIED') {
    return { ok: false, error: 'ALREADY_REOPENED' };
  }

  const { decision, reviewQueue } = await reclassifyMirzabotClaim(db, args.claimId, now);
  const suspectReason =
    decision.decision === 'WAIT'
      ? null
      : decision.decision === 'AUTO_VERIFY'
        ? 'AMBIGUOUS_TRANSACTIONS'
        : decision.reason;

  return {
    ok: true,
    claimId: args.claimId,
    orderId: orderId(claim.external_order_id),
    previousState: 'MANUALLY_VERIFIED',
    reviewQueue,
    suspectReason,
    transactionId: txId,
    fulfillmentState: 'UNKNOWN',
  };
}

/**
 * @deprecated Use reopenMirzabotManualVerification with a reason.
 */
export async function revertMirzabotManualVerification(
  db: D1Database,
  args: { claimId: string; actorEmail: string },
): Promise<RevertManualVerificationResult> {
  const result = await reopenMirzabotManualVerification(db, {
    ...args,
    reason: 'Legacy revert without explicit reason',
  });
  if (!result.ok) {
    const error =
      result.error === 'ALREADY_REOPENED'
        ? 'ALREADY_REVERTED'
        : result.error === 'REASON_REQUIRED' || result.error === 'TRANSACTION_NOT_RELEASEABLE'
          ? 'NO_REVERT_SNAPSHOT'
          : result.error;
    return { ok: false, error: error as RevertManualVerificationFailure };
  }
  return {
    ok: true,
    claimId: result.claimId,
    restoredClaimStatus: 'PENDING',
    restoredSuspectReason: result.suspectReason,
    transactionId: result.transactionId,
  };
}
