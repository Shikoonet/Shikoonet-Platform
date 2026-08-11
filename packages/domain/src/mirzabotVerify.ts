/**
 * Single write path for verifying a Mirzabot payment claim.
 *
 * Both the automatic matcher and the dashboard's manual approval go through
 * here so the same hard facts are re-checked immediately before the write,
 * and so the database's partial unique indexes are the final arbiter when an
 * automatic and a manual approval race for the same transaction.
 */

import type { D1Database } from '@shikoo/database';
import { MIRZABOT_SOURCE } from '@shikoo/contracts';
import {
  encodeRevertSnapshotForMatch,
  encodeRevertSnapshotForMetadata,
  type ManualVerificationRevertSnapshot,
} from './revertMirzabotManualVerification.js';

export type VerifyMode = 'AUTO_VERIFIED' | 'ADMIN_APPROVED';

export type VerifyFailure =
  | 'CLAIM_NOT_FOUND'
  | 'CLAIM_NOT_ELIGIBLE'
  | 'TRANSACTION_NOT_FOUND'
  | 'TRANSACTION_NOT_ACTIONABLE'
  | 'ACCOUNT_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'TRANSACTION_ALREADY_CONSUMED'
  | 'CLAIM_ALREADY_VERIFIED';

export type ManualVerifyWithoutTxFailure = 'CLAIM_NOT_FOUND' | 'CLAIM_NOT_ELIGIBLE';

export type VerifyResult =
  | { ok: true; matchId: string; transactionId: string; claimId: string; expectedAmountIrr: number; externalOrderId: string }
  | { ok: false; error: VerifyFailure };

interface ClaimRow {
  id: string;
  status: string;
  source_system: string;
  external_order_id: string;
  expected_amount_irr: number;
  target_financial_account_id: string | null;
  suspect_reason: string | null;
  suspect_metadata_json: string;
  metadata_json: string;
}

interface TxRow {
  id: string;
  status: string;
  direction: string;
  processing_disposition: string;
  amount_irr: number | null;
  financial_account_id: string | null;
}

const ELIGIBLE_CLAIM_STATUSES = new Set(['PENDING', 'MATCH_SUGGESTED']);
const CONSUMING_MATCH_STATUSES = "('CONFIRMED','AUTO_VERIFIED')";

/**
 * Verify `claimId` against `transactionId`.
 *
 * Hard facts re-checked here (never relaxed, for auto or manual):
 * claim is a live Mirzabot claim, transaction is an actionable CREDIT on the
 * claim's account, amounts are exactly equal, and neither side is already
 * part of a successful match. The ±5m window and uniqueness rules are the
 * matcher's job — a human approving from Suspects is explicitly resolving
 * those, so they are not re-imposed here.
 */
export async function verifyMirzabotClaim(
  db: D1Database,
  args: { claimId: string; transactionId: string; mode: VerifyMode; actorEmail?: string | null },
): Promise<VerifyResult> {
  const claim = await db
    .prepare(
      `SELECT id, status, source_system, external_order_id, expected_amount_irr,
              target_financial_account_id, suspect_reason, suspect_metadata_json, metadata_json
       FROM payment_claims WHERE id = ?1`,
    )
    .bind(args.claimId)
    .first<ClaimRow>();
  if (!claim || claim.source_system !== MIRZABOT_SOURCE) return { ok: false, error: 'CLAIM_NOT_FOUND' };
  if (claim.status === 'VERIFIED') return { ok: false, error: 'CLAIM_ALREADY_VERIFIED' };
  if (!ELIGIBLE_CLAIM_STATUSES.has(claim.status)) return { ok: false, error: 'CLAIM_NOT_ELIGIBLE' };

  const tx = await db
    .prepare(
      `SELECT id, status, direction, processing_disposition, amount_irr, financial_account_id
       FROM transaction_candidates WHERE id = ?1`,
    )
    .bind(args.transactionId)
    .first<TxRow>();
  if (!tx) return { ok: false, error: 'TRANSACTION_NOT_FOUND' };
  if (tx.direction !== 'CREDIT' || tx.processing_disposition !== 'ACTIONABLE') {
    return { ok: false, error: 'TRANSACTION_NOT_ACTIONABLE' };
  }
  if (tx.financial_account_id !== claim.target_financial_account_id) {
    return { ok: false, error: 'ACCOUNT_MISMATCH' };
  }
  if (tx.amount_irr !== claim.expected_amount_irr) return { ok: false, error: 'AMOUNT_MISMATCH' };

  const reseller = await db
    .prepare(`SELECT id FROM reseller_transactions WHERE transaction_candidate_id = ?1`)
    .bind(tx.id)
    .first<{ id: string }>();
  if (reseller) return { ok: false, error: 'TRANSACTION_ALREADY_CONSUMED' };

  const consumed = await db
    .prepare(
      `SELECT id FROM reconciliation_matches
       WHERE status IN ${CONSUMING_MATCH_STATUSES}
         AND (transaction_candidate_id = ?1 OR payment_claim_id = ?2)`,
    )
    .bind(tx.id, claim.id)
    .first<{ id: string }>();
  if (consumed) return { ok: false, error: 'TRANSACTION_ALREADY_CONSUMED' };

  const now = Date.now();
  const matchId = crypto.randomUUID();
  const matchStatus = args.mode === 'AUTO_VERIFIED' ? 'AUTO_VERIFIED' : 'CONFIRMED';
  const reasons = args.mode === 'AUTO_VERIFIED' ? '["UNIQUE_EXACT_MATCH"]' : '["ADMIN_MANUAL"]';
  const reviewer = args.actorEmail ?? null;
  let mismatchReasons = '[]';
  if (args.mode === 'ADMIN_APPROVED') {
    const snapshot: ManualVerificationRevertSnapshot = {
      claimStatus: claim.status as 'PENDING' | 'MATCH_SUGGESTED',
      suspectReason: claim.suspect_reason,
      suspectMetadataJson: claim.suspect_metadata_json || '{}',
      transactionId: tx.id,
      transactionStatus: tx.status,
      matchId,
    };
    mismatchReasons = encodeRevertSnapshotForMatch(snapshot);
  }

  try {
    // No INSERT OR IGNORE: the partial unique indexes on CONFIRMED /
    // AUTO_VERIFIED rows must be able to abort a racing approval.
    await db.batch([
      db
        .prepare(
          `INSERT INTO reconciliation_matches
             (id, transaction_candidate_id, payment_claim_id, score,
              matching_reasons_json, mismatch_reasons_json, status,
              reviewed_by, reviewed_at, created_at, updated_at)
           VALUES (?1, ?2, ?3, 1.0, ?4, ?5, ?6, ?7, ?8, ?8, ?8)
           ON CONFLICT(transaction_candidate_id, payment_claim_id) DO UPDATE SET
             status = excluded.status,
             score = excluded.score,
             matching_reasons_json = excluded.matching_reasons_json,
             mismatch_reasons_json = excluded.mismatch_reasons_json,
             reviewed_by = excluded.reviewed_by,
             reviewed_at = excluded.reviewed_at,
             updated_at = excluded.updated_at
           WHERE reconciliation_matches.status NOT IN ${CONSUMING_MATCH_STATUSES}`,
        )
        .bind(matchId, tx.id, claim.id, reasons, mismatchReasons, matchStatus, reviewer, now),
      db
        .prepare(
          `UPDATE transaction_candidates SET status = 'APPROVED', updated_at = ?2
           WHERE id = ?1 AND status NOT IN ('APPROVED','REJECTED','IGNORED')`,
        )
        .bind(tx.id, now),
      db
        .prepare(
          `UPDATE payment_claims
             SET status = 'VERIFIED', suspect_reason = NULL, updated_at = ?2
           WHERE id = ?1 AND status IN ('PENDING','MATCH_SUGGESTED')`,
        )
        .bind(claim.id, now),
    ]);
  } catch {
    return { ok: false, error: 'TRANSACTION_ALREADY_CONSUMED' };
  }

  // The upsert's WHERE guard silently skips when another approval already
  // consumed this pair; confirm the row really reached a consuming state.
  const persisted = await db
    .prepare(
      `SELECT id FROM reconciliation_matches
       WHERE transaction_candidate_id = ?1 AND payment_claim_id = ?2
         AND status IN ${CONSUMING_MATCH_STATUSES}`,
    )
    .bind(tx.id, claim.id)
    .first<{ id: string }>();
  if (!persisted) return { ok: false, error: 'TRANSACTION_ALREADY_CONSUMED' };

  return {
    ok: true,
    matchId: persisted.id,
    transactionId: tx.id,
    claimId: claim.id,
    expectedAmountIrr: claim.expected_amount_irr,
    externalOrderId: claim.external_order_id,
  };
}

/** Record a non-verifying decision so the dashboard can surface the reason. */
export async function recordMirzabotSuspect(
  db: D1Database,
  args: { claimId: string; reason: string; metadata: unknown },
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `UPDATE payment_claims
         SET suspect_reason = ?2, suspect_metadata_json = ?3, updated_at = ?4
       WHERE id = ?1 AND status IN ('PENDING','MATCH_SUGGESTED')`,
    )
    .bind(args.claimId, args.reason, JSON.stringify(args.metadata ?? {}), now)
    .run();
}

/**
 * Operator verified payment externally; no bank transaction exists in the Hub.
 * Sets claim VERIFIED without a reconciliation match (MANUALLY_VERIFIED projection).
 */
export async function verifyMirzabotClaimWithoutTransaction(
  db: D1Database,
  args: { claimId: string; actorEmail?: string | null },
): Promise<{ ok: true; claimId: string } | { ok: false; error: ManualVerifyWithoutTxFailure }> {
  const claim = await db
    .prepare(
      `SELECT id, status, source_system, suspect_reason, suspect_metadata_json, metadata_json
       FROM payment_claims WHERE id = ?1`,
    )
    .bind(args.claimId)
    .first<{
      id: string;
      status: string;
      source_system: string;
      suspect_reason: string | null;
      suspect_metadata_json: string;
      metadata_json: string;
    }>();
  if (!claim || claim.source_system !== MIRZABOT_SOURCE) return { ok: false, error: 'CLAIM_NOT_FOUND' };
  if (!ELIGIBLE_CLAIM_STATUSES.has(claim.status)) return { ok: false, error: 'CLAIM_NOT_ELIGIBLE' };

  const snapshot: ManualVerificationRevertSnapshot = {
    claimStatus: claim.status as 'PENDING' | 'MATCH_SUGGESTED',
    suspectReason: claim.suspect_reason,
    suspectMetadataJson: claim.suspect_metadata_json || '{}',
  };
  const metadataJson = encodeRevertSnapshotForMetadata(claim.metadata_json || '{}', snapshot);

  const now = Date.now();
  await db
    .prepare(
      `UPDATE payment_claims
         SET status = 'VERIFIED', suspect_reason = NULL, suspect_metadata_json = '{}',
             metadata_json = ?3, updated_at = ?2
       WHERE id = ?1 AND status IN ('PENDING','MATCH_SUGGESTED')`,
    )
    .bind(args.claimId, now, metadataJson)
    .run();
  return { ok: true, claimId: args.claimId };
}

/** Clear a stale suspect reason while a claim is legitimately still waiting. */
export async function clearMirzabotSuspect(db: D1Database, claimId: string): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `UPDATE payment_claims SET suspect_reason = NULL, suspect_metadata_json = '{}', updated_at = ?2
       WHERE id = ?1 AND status IN ('PENDING','MATCH_SUGGESTED')`,
    )
    .bind(claimId, now)
    .run();
}
