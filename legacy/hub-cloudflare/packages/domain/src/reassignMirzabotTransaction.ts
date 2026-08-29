/**
 * Atomic reassignment of a bank transaction between Mirzabot payment claims.
 *
 * Handles unassigned transactions, suggested-only links on other claims, and
 * blocks transactions already consumed by a confirmed or auto-verified match.
 */

import type { D1Database, D1PreparedStatement } from '@hub/database';
import { MIRZABOT_SOURCE } from '@hub/contracts';
import { verifyMirzabotClaim } from './mirzabotVerify.js';

export type ReassignFailure =
  | 'REASON_REQUIRED'
  | 'TRANSACTION_NOT_FOUND'
  | 'CLAIM_NOT_FOUND'
  | 'CLAIM_NOT_ELIGIBLE'
  | 'TRANSACTION_NOT_ACTIONABLE'
  | 'TRANSACTION_ALREADY_CONSUMED'
  | 'VERIFY_FAILED';

export type ConsumedBy = {
  claimId: string;
  orderId: string;
  telegramUserId: string | null;
  telegramUsername: string | null;
  matchStatus: string;
};

export type ReassignResult =
  | {
      ok: true;
      transactionId: string;
      targetClaimId: string;
      verified: boolean;
      matchId?: string;
      detachedClaimIds: string[];
    }
  | { ok: false; error: ReassignFailure; consumedBy?: ConsumedBy; verifyError?: string };

const ELIGIBLE_CLAIM_STATUSES = new Set(['PENDING', 'MATCH_SUGGESTED']);
const CONSUMING_MATCH_STATUSES = "('CONFIRMED','AUTO_VERIFIED')";

interface TxRow {
  id: string;
  direction: string;
  processing_disposition: string;
}

interface ClaimRow {
  id: string;
  status: string;
  source_system: string;
  external_order_id: string;
  metadata_json: string;
  customer_reference: string | null;
}

interface MatchRow {
  id: string;
  payment_claim_id: string;
  status: string;
}

function orderId(external: string): string {
  return external.replace(/^mirzabot:test:/, '');
}

function parseTelegram(metaJson: string, customerRef: string | null) {
  const meta = JSON.parse(metaJson || '{}') as {
    telegramUserId?: string;
    telegramUsername?: string | null;
  };
  return {
    telegramUserId: meta.telegramUserId ?? customerRef,
    telegramUsername: meta.telegramUsername ?? null,
  };
}

/**
 * Reassign `transactionId` to `targetClaimId`.
 *
 * When `verifyAfterAssign` is true the write continues through
 * `verifyMirzabotClaim` (manual CONFIRMED). Otherwise a SUGGESTED link is
 * created so the operator can verify explicitly afterward.
 */
export async function reassignMirzabotTransaction(
  db: D1Database,
  args: {
    transactionId: string;
    targetClaimId: string;
    actorEmail: string;
    reason: string;
    verifyAfterAssign: boolean;
  },
): Promise<ReassignResult> {
  if (!args.reason.trim()) return { ok: false, error: 'REASON_REQUIRED' };

  const tx = await db
    .prepare(
      `SELECT id, direction, processing_disposition FROM transaction_candidates WHERE id = ?1`,
    )
    .bind(args.transactionId)
    .first<TxRow>();
  if (!tx) return { ok: false, error: 'TRANSACTION_NOT_FOUND' };
  if (tx.direction !== 'CREDIT' || tx.processing_disposition !== 'ACTIONABLE') {
    return { ok: false, error: 'TRANSACTION_NOT_ACTIONABLE' };
  }

  const reseller = await db
    .prepare(`SELECT id FROM reseller_transactions WHERE transaction_candidate_id = ?1`)
    .bind(args.transactionId)
    .first<{ id: string }>();
  if (reseller) return { ok: false, error: 'TRANSACTION_ALREADY_CONSUMED' };

  const target = await db
    .prepare(
      `SELECT id, status, source_system, external_order_id, metadata_json, customer_reference
       FROM payment_claims WHERE id = ?1`,
    )
    .bind(args.targetClaimId)
    .first<ClaimRow>();
  if (!target || target.source_system !== MIRZABOT_SOURCE) {
    return { ok: false, error: 'CLAIM_NOT_FOUND' };
  }
  if (!ELIGIBLE_CLAIM_STATUSES.has(target.status)) {
    return { ok: false, error: 'CLAIM_NOT_ELIGIBLE' };
  }

  const consuming = await db
    .prepare(
      `SELECT m.id, m.payment_claim_id, m.status, c.external_order_id, c.metadata_json, c.customer_reference
       FROM reconciliation_matches m
       JOIN payment_claims c ON c.id = m.payment_claim_id
       WHERE m.transaction_candidate_id = ?1
         AND m.status IN ${CONSUMING_MATCH_STATUSES}
       LIMIT 1`,
    )
    .bind(args.transactionId)
    .first<{
      id: string;
      payment_claim_id: string;
      status: string;
      external_order_id: string;
      metadata_json: string;
      customer_reference: string | null;
    }>();
  if (consuming && consuming.payment_claim_id !== args.targetClaimId) {
    const tg = parseTelegram(consuming.metadata_json, consuming.customer_reference);
    return {
      ok: false,
      error: 'TRANSACTION_ALREADY_CONSUMED',
      consumedBy: {
        claimId: consuming.payment_claim_id,
        orderId: orderId(consuming.external_order_id),
        telegramUserId: tg.telegramUserId ?? null,
        telegramUsername: tg.telegramUsername,
        matchStatus: consuming.status,
      },
    };
  }

  const suggested = await db
    .prepare(
      `SELECT id, payment_claim_id, status FROM reconciliation_matches
       WHERE transaction_candidate_id = ?1 AND status = 'SUGGESTED'`,
    )
    .bind(args.transactionId)
    .all<MatchRow>();

  const detachIds = (suggested.results ?? [])
    .map((m) => m.payment_claim_id)
    .filter((id) => id !== args.targetClaimId);

  const now = Date.now();
  const matchId = crypto.randomUUID();
  const batch: D1PreparedStatement[] = [];

  for (const m of suggested.results ?? []) {
    if (m.payment_claim_id === args.targetClaimId) continue;
    batch.push(
      db
        .prepare(
          `UPDATE reconciliation_matches
             SET status = 'REJECTED', reviewed_by = ?2, reviewed_at = ?3, updated_at = ?3
           WHERE id = ?1 AND status = 'SUGGESTED'`,
        )
        .bind(m.id, args.actorEmail, now),
    );
  }

  for (const oldClaimId of detachIds) {
    batch.push(
      db
        .prepare(
          `UPDATE payment_claims SET status = 'PENDING', updated_at = ?2
           WHERE id = ?1 AND status = 'MATCH_SUGGESTED'`,
        )
        .bind(oldClaimId, now),
    );
  }

  if (args.verifyAfterAssign) {
    if (batch.length > 0) await db.batch(batch);
    const verified = await verifyMirzabotClaim(db, {
      claimId: args.targetClaimId,
      transactionId: args.transactionId,
      mode: 'ADMIN_APPROVED',
      actorEmail: args.actorEmail,
    });
    if (!verified.ok) {
      return { ok: false, error: 'VERIFY_FAILED', verifyError: verified.error };
    }
    return {
      ok: true,
      transactionId: args.transactionId,
      targetClaimId: args.targetClaimId,
      verified: true,
      matchId: verified.matchId,
      detachedClaimIds: detachIds,
    };
  }

  batch.push(
    db
      .prepare(
        `INSERT INTO reconciliation_matches
           (id, transaction_candidate_id, payment_claim_id, score,
            matching_reasons_json, mismatch_reasons_json, status,
            reviewed_by, reviewed_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 1.0, '["ADMIN_REASSIGN"]', '[]', 'SUGGESTED',
                 ?4, ?5, ?5, ?5)
         ON CONFLICT(transaction_candidate_id, payment_claim_id) DO UPDATE SET
           status = 'SUGGESTED',
           matching_reasons_json = '["ADMIN_REASSIGN"]',
           reviewed_by = excluded.reviewed_by,
           reviewed_at = excluded.reviewed_at,
           updated_at = excluded.updated_at
         WHERE reconciliation_matches.status NOT IN ${CONSUMING_MATCH_STATUSES}`,
      )
      .bind(matchId, args.transactionId, args.targetClaimId, args.actorEmail, now),
  );
  batch.push(
    db
      .prepare(
        `UPDATE payment_claims SET status = 'MATCH_SUGGESTED', updated_at = ?2
         WHERE id = ?1 AND status IN ('PENDING','MATCH_SUGGESTED')`,
      )
      .bind(args.targetClaimId, now),
  );

  await db.batch(batch);

  return {
    ok: true,
    transactionId: args.transactionId,
    targetClaimId: args.targetClaimId,
    verified: false,
    detachedClaimIds: detachIds,
  };
}
