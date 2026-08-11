/**
 * Assignment history for `transaction_candidates` → `financial_accounts`.
 *
 * The active assignment row is the source of truth for *who* set the
 * account and *why*. The current account id still lives on
 * `transaction_candidates.financial_account_id` for fast joins; reads are
 * expected to join via that column. This table is the audit / replace
 * chain.
 *
 * Invariants enforced here (and asserted by the worker tests):
 *
 *   1. AUTO_IDENTIFIER writes never overwrite a MANUAL assignment.
 *   2. There is exactly one active row per transaction
 *      (enforced by `idx_taa_one_active_per_tx` partial unique index).
 *   3. A new assignment supersedes the previous active row by setting
 *      the predecessor's `active = 0` and pointing `replaced_assignment_id`
 *      at the new row. The chain is append-only.
 *   4. `assignAccountForTx` is idempotent on identical AUTO_IDENTIFIER
 *      calls (same identifier → same account): it does NOT create a new
 *      row if the current active row already has the same source, account,
 *      identifier triple.
 */

import type { D1Database } from '@shikoo/database';
import { SQL } from '@shikoo/database';

export type AssignmentSource =
  | 'AUTO_IDENTIFIER'
  | 'MANUAL'
  | 'HISTORICAL_BACKFILL'
  | 'ACCOUNT_MERGE';

export type AssignmentIdentifierType =
  | 'ACCOUNT_NUMBER'
  | 'CARD_LAST_FOUR'
  | 'IBAN'
  | 'ACCOUNT_HINT'
  | null;

export interface CurrentAssignment {
  id: string;
  transaction_candidate_id: string;
  financial_account_id: string | null;
  assignment_source: AssignmentSource;
  identifier_type: AssignmentIdentifierType;
  normalized_identifier: string | null;
  assigned_by: string;
  assigned_at: number;
  replaced_assignment_id: string | null;
  active: number;
}

export interface AssignAccountInput {
  transactionCandidateId: string;
  financialAccountId: string | null;
  source: AssignmentSource;
  identifierType?: AssignmentIdentifierType;
  normalizedIdentifier?: string | null;
  assignedBy: string;
  /** Optional reason / metadata that goes verbatim into metadata_json. */
  metadata?: Record<string, unknown>;
}

export interface AssignAccountResult {
  status: 'inserted' | 'noop' | 'preserved_manual';
  assignmentId: string;
  accountId: string | null;
  previousAssignmentId: string | null;
}

/**
 * Assign `transactionCandidateId` to `financialAccountId` and record the
 * change. Safe to call repeatedly:
 *   - If the current active row is MANUAL and the new write is
 *     AUTO_IDENTIFIER, returns `preserved_manual` and writes nothing.
 *   - If the proposed triple equals the current triple, returns `noop`.
 *   - Otherwise supersedes the previous active row and inserts a new one.
 *
 * IMPORTANT: also updates `transaction_candidates.financial_account_id`
 * to keep the canonical column in sync. The D1 transaction is a small
 * batch run inside the same connection — D1 batches are atomic per batch.
 */
export async function assignAccountForTx(
  db: D1Database,
  input: AssignAccountInput,
  now: number = Date.now(),
): Promise<AssignAccountResult> {
  const current = await getActiveAssignment(db, input.transactionCandidateId);

  // 1. AUTO cannot overwrite MANUAL.
  if (current && current.assignment_source === 'MANUAL' && input.source === 'AUTO_IDENTIFIER') {
    return {
      status: 'preserved_manual',
      assignmentId: current.id,
      accountId: current.financial_account_id,
      previousAssignmentId: null,
    };
  }

  // 2. Idempotent on identical (source, account, identifier) triples.
  if (
    current &&
    current.assignment_source === input.source &&
    current.financial_account_id === input.financialAccountId &&
    (current.identifier_type ?? null) === (input.identifierType ?? null) &&
    (current.normalized_identifier ?? null) === (input.normalizedIdentifier ?? null)
  ) {
    return {
      status: 'noop',
      assignmentId: current.id,
      accountId: current.financial_account_id,
      previousAssignmentId: null,
    };
  }

  const newId = crypto.randomUUID();
  const metadata = JSON.stringify(input.metadata ?? {});
  const statements = [];

  // 3. Mark the previous active row inactive (if any) and link the chain.
  if (current) {
    statements.push(
      db
        .prepare(
          `UPDATE transaction_account_assignments
              SET active = 0
            WHERE id = ?1`,
        )
        .bind(current.id),
    );
  }

  // 4. Insert the new active row.
  statements.push(
    db
      .prepare(
        `INSERT INTO transaction_account_assignments
          (id, transaction_candidate_id, financial_account_id, assignment_source,
           identifier_type, normalized_identifier, assigned_by, assigned_at,
           replaced_assignment_id, active, metadata_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10)`,
      )
      .bind(
        newId,
        input.transactionCandidateId,
        input.financialAccountId,
        input.source,
        input.identifierType ?? null,
        input.normalizedIdentifier ?? null,
        input.assignedBy,
        now,
        current ? current.id : null,
        metadata,
      ),
  );

  // 5. Keep the canonical column in sync.
  statements.push(
    db
      .prepare(
        `UPDATE transaction_candidates
            SET financial_account_id = ?2, updated_at = ?3
          WHERE id = ?1`,
      )
      .bind(input.transactionCandidateId, input.financialAccountId, now),
  );

  await db.batch(statements);

  return {
    status: 'inserted',
    assignmentId: newId,
    accountId: input.financialAccountId,
    previousAssignmentId: current?.id ?? null,
  };
}

/**
 * Look up the currently-active assignment row for a transaction, if any.
 */
export async function getActiveAssignment(
  db: D1Database,
  txId: string,
): Promise<CurrentAssignment | null> {
  const row = await db
    .prepare(
      `SELECT id, transaction_candidate_id, financial_account_id, assignment_source,
              identifier_type, normalized_identifier, assigned_by, assigned_at,
              replaced_assignment_id, active
         FROM transaction_account_assignments
        WHERE transaction_candidate_id = ?1 AND active = 1
        LIMIT 1`,
    )
    .bind(txId)
    .first<CurrentAssignment>();
  return row ?? null;
}

/**
 * Full chain for a transaction, ordered oldest → newest. Useful for the
 * "Show history" tooltip inside the Change Account modal.
 */
export async function listAssignmentHistory(
  db: D1Database,
  txId: string,
  limit = 50,
): Promise<CurrentAssignment[]> {
  const rows = await db
    .prepare(
      `SELECT id, transaction_candidate_id, financial_account_id, assignment_source,
              identifier_type, normalized_identifier, assigned_by, assigned_at,
              replaced_assignment_id, active
         FROM transaction_account_assignments
        WHERE transaction_candidate_id = ?1
        ORDER BY assigned_at ASC, id ASC
        LIMIT ?2`,
    )
    .bind(txId, limit)
    .all<CurrentAssignment>();
  return rows.results;
}

/**
 * Bulk backfill: every unassigned transaction whose detected identifier
 * matches an active account gets an AUTO_IDENTIFIER assignment row.
 * Skips transactions that already have any active assignment.
 *
 * Returns counts. Caller decides whether to commit-then-read or
 * dry-run-then-commit.
 */
export interface BackfillAssignmentsResult {
  scanned: number;
  assigned: number;
  skippedAlreadyAssigned: number;
  skippedNoActiveAssignment: number;
  errors: number;
}

/**
 * Ponytail: the SQL is a single bounded UNION that joins
 * transaction_detected_identifiers → financial_accounts via the resolver
 * view. < 5 detected identifiers per call, so a single statement is
 * cheaper than a per-row loop and stays inside the D1 row limit.
 */
export async function backfillAssignmentsForIdentifier(
  db: D1Database,
  type: AssignmentIdentifierType,
  normalizedValue: string,
  accountId: string,
  assignedBy: string = 'SYSTEM',
  now: number = Date.now(),
): Promise<{ assigned: number }> {
  // Destination account must be ACTIVE. PENDING / MUTED / DECLINED
  // accounts are excluded from auto-assignment so an SMS arriving for
  // a not-yet-reviewed account lands as `financial_account_id IS NULL`
  // rather than getting silently assigned to a row the admin hasn't
  // signed off on yet.
  const dstStatus = await db
    .prepare(`SELECT status FROM financial_accounts WHERE id = ?1`)
    .bind(accountId)
    .first<{ status: string }>();
  if (!dstStatus || dstStatus.status !== 'ACTIVE') {
    return { assigned: 0 };
  }
  // Pick the target rows: unassigned transactions with a matching identifier.
  const targets = await db
    .prepare(
      `SELECT DISTINCT tdi.transaction_candidate_id AS tx_id
         FROM transaction_detected_identifiers tdi
         JOIN transaction_candidates tc ON tc.id = tdi.transaction_candidate_id
        WHERE tdi.identifier_type = ?1
          AND tdi.normalized_value = ?2
          AND tc.financial_account_id IS NULL
          AND ${SQL.actionableTransactionWhereTc}`,
    )
    .bind(type, normalizedValue)
    .all<{ tx_id: string }>();

  const stmts = [];
  for (const t of targets.results) {
    const current = await getActiveAssignment(db, t.tx_id);
    if (current) continue; // skip already-assigned
    const newId = crypto.randomUUID();
    stmts.push(
      db
        .prepare(
          `INSERT INTO transaction_account_assignments
            (id, transaction_candidate_id, financial_account_id, assignment_source,
             identifier_type, normalized_identifier, assigned_by, assigned_at,
             replaced_assignment_id, active, metadata_json)
           VALUES (?1, ?2, ?3, 'HISTORICAL_BACKFILL', ?4, ?5, ?6, ?7, NULL, 1, '{}')`,
        )
        .bind(newId, t.tx_id, accountId, type, normalizedValue, assignedBy, now),
      db
        .prepare(
          `UPDATE transaction_candidates
              SET financial_account_id = ?2, updated_at = ?3
            WHERE id = ?1`,
        )
        .bind(t.tx_id, accountId, now),
    );
  }
  if (stmts.length === 0) return { assigned: 0 };
  await db.batch(stmts);
  return { assigned: targets.results.length };
}
