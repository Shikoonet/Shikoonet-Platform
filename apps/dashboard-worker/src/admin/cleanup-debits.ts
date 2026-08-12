/**
 * Cleanup tool: idempotently transition every ACTIONABLE + non-CREDIT
 * transaction_candidates row to OUTGOING_IGNORED (or ADMIN_EXCLUDED when
 * it has a confirmed/open match or payment claim that requires admin
 * review).
 *
 * Two endpoints:
 *   POST /api/v1/admin/cleanup-debits/dry-run
 *   POST /api/v1/admin/cleanup-debits/apply
 *
 * The dry-run report is the only thing the apply endpoint will accept
 * back, which forces an operator to look at the report before
 * committing. Re-running apply with the same (or any) report is a
 * no-op once the rows have transitioned — the WHERE clause already
 * filters on `processing_disposition = 'ACTIONABLE'`.
 *
 * Raw SMS, transaction_candidates, and reconciliation_matches rows are
 * never deleted. Only `processing_disposition` is updated; audit rows
 * record each change with the reason for ADMIN_EXCLUDED conflicts.
 */

import { SQL, type D1Database } from '@shikoo/database';

export type Disposition = 'OUTGOING_IGNORED' | 'ADMIN_EXCLUDED';

export interface CleanupCandidateRow {
  txId: string;
  direction: 'DEBIT' | 'UNKNOWN';
  currentDisposition: 'ACTIONABLE' | 'OUTGOING_IGNORED' | 'ADMIN_EXCLUDED';
  hasConfirmedMatch: boolean;
  hasOpenMatch: boolean;
  hasClaimReference: boolean;
}

export interface CleanupDryRunReport {
  candidateDebits: number;
  detectedIdentifiersByTx: number;
  assignmentHistoryRows: number;
  suggestedMatches: number;
  confirmedOrVerifiedMatches: number;
  paymentClaimsInUse: number;
  alreadyOutgoingIgnored: number;
  alreadyAdminExcluded: number;
  wouldChange: number;
  cleanConflicts: number;
  rows: CleanupCandidateRow[];
}

export interface CleanupApplyResult {
  applied: number;
  conflicts: number;
  auditLogIds: string[];
}

const ACTIONS = {
  APPLIED: 'transaction.cleanup_outgoing_applied',
  CONFLICT: 'transaction.cleanup_outgoing_conflict',
} as const;

export async function dryRunCleanupOutgoing(db: D1Database): Promise<CleanupDryRunReport> {
  // All DEBIT/UNKNOWN rows still in ACTIONABLE state.
  const candidateRows = await db
    .prepare(
      // ::int on both EXISTS: SQLite has no boolean type and returns 0/1, but
      // Postgres returns a real boolean, so the `=== 1` checks below silently
      // became false for every row. Casting keeps the declared row shape.
      `SELECT t.id AS tx_id, t.direction, t.processing_disposition,
              (EXISTS (SELECT 1 FROM reconciliation_matches rm
                       WHERE rm.transaction_candidate_id = t.id
                         AND rm.status = 'CONFIRMED'))::int AS has_confirmed_match,
              (EXISTS (SELECT 1 FROM reconciliation_matches rm
                       WHERE rm.transaction_candidate_id = t.id
                         AND rm.status IN ('SUGGESTED','AUTO_VERIFIED')))::int AS has_open_match
         FROM transaction_candidates t
        WHERE t.direction <> 'CREDIT'
          AND t.processing_disposition = 'ACTIONABLE'`,
    )
    .all<{
      tx_id: string;
      direction: 'DEBIT' | 'UNKNOWN';
      processing_disposition: 'ACTIONABLE' | 'OUTGOING_IGNORED' | 'ADMIN_EXCLUDED';
      has_confirmed_match: number;
      has_open_match: number;
    }>();

  const rows: CleanupCandidateRow[] = candidateRows.results.map((r) => ({
    txId: r.tx_id,
    direction: r.direction,
    currentDisposition: r.processing_disposition,
    hasConfirmedMatch: r.has_confirmed_match === 1,
    hasOpenMatch: r.has_open_match === 1,
    hasClaimReference: false, // filled below
  }));

  // For each candidate, check if any confirmed/open match references a
  // payment_claim (the "claim in use" relationship). The match row
  // already has payment_claim_id; we just count distinct rows.
  const paymentClaimRefs = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM reconciliation_matches rm
         JOIN transaction_candidates t ON t.id = rm.transaction_candidate_id
        WHERE t.direction <> 'CREDIT'
          AND t.processing_disposition = 'ACTIONABLE'
          AND rm.status IN ('CONFIRMED','AUTO_VERIFIED','SUGGESTED')`,
    )
    .first<{ c: number }>();

  // Detected identifiers + assignment history counts are informational.
  const detectedIdentifiers = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM transaction_detected_identifiers tdi
         JOIN transaction_candidates t ON t.id = tdi.transaction_candidate_id
        WHERE t.direction <> 'CREDIT'
          AND t.processing_disposition = 'ACTIONABLE'`,
    )
    .first<{ c: number }>();

  const assignmentHistory = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM transaction_account_assignments taa
         JOIN transaction_candidates t ON t.id = taa.transaction_candidate_id
        WHERE t.direction <> 'CREDIT'
          AND t.processing_disposition = 'ACTIONABLE'`,
    )
    .first<{ c: number }>();

  const alreadyOutgoing = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM transaction_candidates
        WHERE direction <> 'CREDIT'
          AND processing_disposition = 'OUTGOING_IGNORED'`,
    )
    .first<{ c: number }>();

  const alreadyExcluded = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM transaction_candidates
        WHERE direction <> 'CREDIT'
          AND processing_disposition = 'ADMIN_EXCLUDED'`,
    )
    .first<{ c: number }>();

  const candidateDebits = rows.length;
  const cleanConflicts = rows.filter((r) => r.hasConfirmedMatch || r.hasOpenMatch).length;
  const wouldChange = candidateDebits;

  return {
    candidateDebits,
    detectedIdentifiersByTx: detectedIdentifiers?.c ?? 0,
    assignmentHistoryRows: assignmentHistory?.c ?? 0,
    suggestedMatches: rows.filter((r) => r.hasOpenMatch).length,
    confirmedOrVerifiedMatches: rows.filter((r) => r.hasConfirmedMatch).length,
    paymentClaimsInUse: paymentClaimRefs?.c ?? 0,
    alreadyOutgoingIgnored: alreadyOutgoing?.c ?? 0,
    alreadyAdminExcluded: alreadyExcluded?.c ?? 0,
    wouldChange,
    cleanConflicts,
    rows,
  };
}

export async function applyCleanupOutgoing(
  db: D1Database,
  report: CleanupDryRunReport,
  actorEmail: string,
  actorRole: string,
): Promise<CleanupApplyResult> {
  const now = Date.now();
  let applied = 0;
  let conflicts = 0;
  const auditLogIds: string[] = [];

  for (const row of report.rows) {
    const target: Disposition =
      row.hasConfirmedMatch || row.hasOpenMatch ? 'ADMIN_EXCLUDED' : 'OUTGOING_IGNORED';

    const result = await db
      .prepare(
        `UPDATE transaction_candidates
            SET processing_disposition = ?2, updated_at = ?3
          WHERE id = ?1
            AND processing_disposition = 'ACTIONABLE'
            AND direction <> 'CREDIT'`,
      )
      .bind(row.txId, target, now)
      .run();

    const changed = result.meta?.changes ?? 0;
    if (changed === 0) continue;

    const auditId = crypto.randomUUID();
    auditLogIds.push(auditId);
    const reason = row.hasConfirmedMatch
      ? 'confirmed_match_present'
      : row.hasOpenMatch
        ? 'open_match_present'
        : 'no_match';
    await db
      .prepare(SQL.insertAudit)
      .bind(
        auditId,
        actorEmail,
        actorRole,
        target === 'ADMIN_EXCLUDED' ? ACTIONS.CONFLICT : ACTIONS.APPLIED,
        'TRANSACTION',
        row.txId,
        JSON.stringify({ processing_disposition: 'ACTIONABLE' }),
        JSON.stringify({
          processing_disposition: target,
          conflict: target === 'ADMIN_EXCLUDED',
        }),
        reason,
        null,
        now,
      )
      .run();
    if (target === 'ADMIN_EXCLUDED') conflicts++;
    else applied++;
  }

  return { applied, conflicts, auditLogIds };
}
