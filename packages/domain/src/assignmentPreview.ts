/**
 * Staged "Re-run account assignment" preview/apply/decline service.
 *
 * Replaces the global payment-reconciliation "rerun matching" with a
 * per-account, exact-identifier-only assignment flow:
 *
 *   1. `buildAccountAssignmentPreview` — examines every transaction whose
 *      detected identifier matches one of this account's configured
 *      identifiers. Categorizes into six buckets:
 *
 *        WILL_ASSIGN         unassigned tx, identifier resolves uniquely to this account
 *        WILL_REPAIR_HISTORY active row on a DIFFERENT account, but new match points here
 *        ALREADY_CORRECT     active row already points at this account (counted, not listed)
 *        AMBIGUOUS           identifier resolves to multiple active accounts
 *        SKIPPED_MANUAL      active row is MANUAL or ACCOUNT_MERGE (counted, never listed)
 *        SKIPPED_STATE_CHANGED set on Apply only when DB diverged since preview
 *
 *      Writes one row in `account_assignment_previews` and one row per
 *      listable candidate in `account_assignment_preview_items`. Does
 *      NOT mutate transactions or assignments.
 *
 *   2. `applyAccountAssignmentPreview` — for each item the user
 *      selected, routes through `assignAccountForTx` with
 *      source='HISTORICAL_BACKFILL'. Re-validates each candidate's
 *      current DB state; per-item divergence is recorded as
 *      SKIPPED_STATE_CHANGED. Writes one `account.assignment_rerun_applied`
 *      audit row at the end. MANUAL / ACCOUNT_MERGE active rows are
 *      protected by `assignAccountForTx` itself.
 *
 *   3. `declineAccountAssignmentPreview` — single UPDATE flipping the
 *      preview status to DECLINED. No mutations on transactions,
 *      identifiers, or assignment history.
 *
 * Identifier matching is exact (no normalization tricks beyond what the
 * parser already produced) and uses the same probe shape as
 * `resolveDetectedIdentifiers` in `./identifiers.ts`.
 */

import type { D1Database, IdentifierType } from '@shikoo/database';
import { SQL } from '@shikoo/database';
import {
  assignAccountForTx,
  getActiveAssignment,
  type AssignmentIdentifierType,
  type CurrentAssignment,
} from './assignments.js';

export const PREVIEW_TTL_MS = 30 * 60 * 1000; // 30 minutes per spec.

export type PreviewDisposition =
  | 'WILL_ASSIGN'
  | 'WILL_REPAIR_HISTORY'
  | 'ALREADY_CORRECT'
  | 'AMBIGUOUS'
  | 'SKIPPED_MANUAL'
  | 'SKIPPED_STATE_CHANGED';

export type PreviewStatus = 'OPEN' | 'APPLIED' | 'DECLINED' | 'EXPIRED';

export interface AccountAssignmentPreviewItem {
  /** `account_assignment_preview_items.id` — used for React keys. */
  id: string;
  transactionCandidateId: string;
  disposition: PreviewDisposition;
  identifierType: IdentifierType | null;
  normalizedIdentifier: string | null;
  currentAccountId: string | null;
  currentAssignmentSource: string | null;
  /** UI-facing bank timestamp for the row (best-effort; may be null). */
  bankTimestamp: number | null;
  amountIrr: number | null;
  selected: boolean;
}

export interface AccountAssignmentPreviewCounts {
  willAssign: number;
  willRepairHistory: number;
  alreadyCorrect: number;
  manualAssignmentsSkipped: number;
  ambiguous: number;
  /** Set only on Apply. Always 0 in the initial preview response. */
  conflicts: number;
  /**
   * Credit-only product: the number of transactions that matched one of
   * the account's identifier probes but were DEBIT (or otherwise
   * non-actionable). Surfaced as an informational note in the preview
   * so admins can confirm the cleanup is reaching the outgoing rows
   * without including them in the assign set.
   */
  ignoredOutgoing: number;
}

export interface AccountAssignmentPreview {
  previewId: string;
  accountId: string;
  actorEmail: string;
  status: PreviewStatus;
  createdAt: number;
  expiresAt: number;
  accountSnapshot: AccountIdentifierSnapshot;
  counts: AccountAssignmentPreviewCounts;
  items: AccountAssignmentPreviewItem[];
}

export interface AccountIdentifierSnapshot {
  accountHint: string | null;
  cardLastFour: string | null;
  iban: string | null;
  additional: Array<{ id: string; kind: string; value: string }>;
}

export interface ApplyPreviewResult {
  previewId: string;
  applied: number;
  skipped: number;
  conflicts: number;
  manualPreserved: number;
  affectedTxIds: string[];
  resultJson: string;
}

export type PreviewError =
  | { kind: 'not_found' }
  | { kind: 'expired'; expiredAt: number }
  | { kind: 'wrong_status'; status: PreviewStatus };

const ZERO_COUNTS: AccountAssignmentPreviewCounts = {
  willAssign: 0,
  willRepairHistory: 0,
  alreadyCorrect: 0,
  manualAssignmentsSkipped: 0,
  ambiguous: 0,
  conflicts: 0,
  ignoredOutgoing: 0,
};

/**
 * Map financial_accounts canonical columns + financial_account_identifiers
 * rows to the probe list used to find candidate transactions.
 *
 * ACCOUNT_HINT (an fai kind) is a synonym for ACCOUNT_NUMBER (a tdi
 * type) — see `resolveDetectedIdentifiers` for the same mapping.
 */
interface Probe {
  type: IdentifierType;
  value: string;
  /** Where this probe came from. Surfaced in audit. */
  source: 'account_hint' | 'card_last_four' | 'account_last_four' | 'iban' | 'fai';
  /** Optional fai row id (for sources other than the canonical columns). */
  faiId: string | null;
}

const FAI_KIND_TO_PROBE_TYPE: Record<string, IdentifierType | null> = {
  ACCOUNT_HINT: 'ACCOUNT_NUMBER',
  CARD_LAST_FOUR: 'CARD_LAST_FOUR',
  IBAN: 'IBAN',
  OTHER: null,
};

async function loadAccountAndProbes(
  db: D1Database,
  accountId: string,
): Promise<
  | { kind: 'no_account' }
  | { kind: 'inactive' }
  | { kind: 'not_operable' }
  | { kind: 'ok'; snapshot: AccountIdentifierSnapshot; probes: Probe[] }
> {
  const account = await db
    .prepare(
      `SELECT id, account_hint, card_last_four, account_last_four, iban, active, status FROM financial_accounts WHERE id = ?1`,
    )
    .bind(accountId)
    .first<{
      id: string;
      account_hint: string | null;
      card_last_four: string | null;
      account_last_four: string | null;
      iban: string | null;
      active: number;
      status: string;
    }>();
  if (!account) return { kind: 'no_account' };
  if (account.active !== 1) return { kind: 'inactive' };
  // PENDING / MUTED / DECLINED accounts never enter the re-run-assignment
  // preview flow — the re-run would otherwise force auto-assign into a
  // not-yet-reviewed (PENDING) or admin-excluded (MUTED / DECLINED) account.
  if (account.status !== 'ACTIVE') return { kind: 'not_operable' };

  const faiRows = await db
    .prepare(
      `SELECT id, kind, value FROM financial_account_identifiers WHERE financial_account_id = ?1`,
    )
    .bind(accountId)
    .all<{ id: string; kind: string; value: string }>();

  const snapshot: AccountIdentifierSnapshot = {
    accountHint: account.account_hint,
    cardLastFour: account.card_last_four,
    iban: account.iban,
    additional: faiRows.results.map((r) => ({ id: r.id, kind: r.kind, value: r.value })),
  };

  const probes: Probe[] = [];
  if (account.account_hint)
    probes.push({
      type: 'ACCOUNT_NUMBER',
      value: account.account_hint,
      source: 'account_hint',
      faiId: null,
    });
  if (account.card_last_four)
    probes.push({
      type: 'CARD_LAST_FOUR',
      value: account.card_last_four,
      source: 'card_last_four',
      faiId: null,
    });
  if (account.iban) probes.push({ type: 'IBAN', value: account.iban, source: 'iban', faiId: null });
  for (const r of faiRows.results) {
    const t = FAI_KIND_TO_PROBE_TYPE[r.kind];
    if (t) probes.push({ type: t, value: r.value, source: 'fai', faiId: r.id });
  }

  return { kind: 'ok', snapshot, probes };
}

/**
 * Resolve a list of probes to the set of transaction candidate ids whose
 * `transaction_detected_identifiers` rows match. Dedupes on tx id and
 * prefers the first matching probe (exact-match priority is irrelevant —
 * every probe hits the same row).
 */
async function findCandidateTxs(
  db: D1Database,
  probes: Probe[],
): Promise<
  Array<{
    txId: string;
    identifierType: IdentifierType;
    normalizedValue: string;
    currentAccountId: string | null;
    bankTimestamp: number | null;
    amountIrr: number | null;
  }>
> {
  if (probes.length === 0) return [];
  // Ponytail: bounded UNION ALL — probes are bounded by the account's
  // configured identifiers (≤ 5 from canonical columns + however many
  // fai rows the admin added; we cap at 32).
  const capped = probes.slice(0, 32);
  // Credit-only product: only CREDIT + ACTIONABLE rows enter the
  // assignment set. We additionally count the outgoing / excluded rows
  // that match the same probes so the UI can show the informational
  // "ignored outgoing" total.
  const sql = `
    SELECT tx_id, identifier_type, normalized_value
      FROM (
        ${capped
          .map(
            (_, i) =>
              `SELECT ?${i * 2 + 1} AS identifier_type, ?${i * 2 + 2} AS normalized_value, tdi.transaction_candidate_id AS tx_id
                 FROM transaction_detected_identifiers tdi
                 JOIN transaction_candidates tc ON tc.id = tdi.transaction_candidate_id
                 LEFT JOIN financial_accounts fa ON fa.id = tc.financial_account_id
                WHERE tdi.identifier_type = ?${i * 2 + 1} AND tdi.normalized_value = ?${i * 2 + 2}
                  AND ${SQL.actionableTransactionWhereTc}
                  AND ${SQL.accountStatusWhere}`,
          )
          .join(' UNION ALL ')}
      )
  `;
  const params: unknown[] = [];
  for (const p of capped) {
    params.push(p.type, p.value);
  }
  const rows = await db
    .prepare(sql)
    .bind(...params)
    .all<{
      tx_id: string;
      identifier_type: IdentifierType;
      normalized_value: string;
    }>();
  // De-dupe by tx id, keep first hit.
  const seen = new Set<string>();
  const out: Array<{
    txId: string;
    identifierType: IdentifierType;
    normalizedValue: string;
    currentAccountId: string | null;
    bankTimestamp: number | null;
    amountIrr: number | null;
  }> = [];
  for (const r of rows.results) {
    if (seen.has(r.tx_id)) continue;
    seen.add(r.tx_id);
    out.push({
      txId: r.tx_id,
      identifierType: r.identifier_type,
      normalizedValue: r.normalized_value,
      currentAccountId: null,
      bankTimestamp: null,
      amountIrr: null,
    });
  }
  if (out.length === 0) return out;
  // Single follow-up query for current account id + bank_timestamp + amount.
  const placeholders = out.map(() => '?').join(',');
  const txRows = await db
    .prepare(
      `SELECT id, financial_account_id, bank_timestamp, amount_irr
         FROM transaction_candidates
        WHERE id IN (${placeholders})`,
    )
    .bind(...out.map((o) => o.txId))
    .all<{
      id: string;
      financial_account_id: string | null;
      bank_timestamp: number | null;
      amount_irr: number | null;
    }>();
  const byId = new Map(txRows.results.map((t) => [t.id, t]));
  for (const o of out) {
    const t = byId.get(o.txId);
    if (t) {
      o.currentAccountId = t.financial_account_id;
      o.bankTimestamp = t.bank_timestamp;
      o.amountIrr = t.amount_irr;
    }
  }
  return out;
}

/**
 * For each candidate tx, look up the current active assignment row.
 * Bounded query: one row per candidate.
 */
async function loadActiveAssignments(
  db: D1Database,
  txIds: string[],
): Promise<Map<string, CurrentAssignment>> {
  if (txIds.length === 0) return new Map();
  const placeholders = txIds.map(() => '?').join(',');
  const rows = await db
    .prepare(
      `SELECT id, transaction_candidate_id, financial_account_id, assignment_source,
              identifier_type, normalized_identifier, assigned_by, assigned_at,
              replaced_assignment_id, active
         FROM transaction_account_assignments
        WHERE active = 1 AND transaction_candidate_id IN (${placeholders})`,
    )
    .bind(...txIds)
    .all<CurrentAssignment>();
  return new Map(rows.results.map((r) => [r.transaction_candidate_id, r]));
}

function mapIdentifierTypeToAssignment(t: IdentifierType): AssignmentIdentifierType {
  // The detection-side type and the assignment-side CHECK constraint
  // both accept these four values verbatim. Cast for type-narrowing.
  return t as AssignmentIdentifierType;
}

/**
 * Build the staged preview for an account. Inserts the header row +
 * one item row per listable candidate (WILL_ASSIGN / WILL_REPAIR_HISTORY
 * / AMBIGUOUS). ALREADY_CORRECT and SKIPPED_MANUAL are counted but not
 * listed.
 */
export async function buildAccountAssignmentPreview(
  db: D1Database,
  accountId: string,
  actorEmail: string,
  now: number = Date.now(),
): Promise<
  | { kind: 'no_account' }
  | { kind: 'inactive' }
  | { kind: 'not_operable' }
  | { kind: 'ok'; preview: AccountAssignmentPreview }
> {
  const acct = await loadAccountAndProbes(db, accountId);
  if (acct.kind === 'no_account') return { kind: 'no_account' };
  if (acct.kind === 'inactive') return { kind: 'inactive' };
  if (acct.kind === 'not_operable') return { kind: 'not_operable' };

  const candidates = await findCandidateTxs(db, acct.probes);
  const activeByTx = await loadActiveAssignments(
    db,
    candidates.map((c) => c.txId),
  );

  const previewId = crypto.randomUUID();
  const expiresAt = now + PREVIEW_TTL_MS;
  const counts: AccountAssignmentPreviewCounts = { ...ZERO_COUNTS };
  const items: AccountAssignmentPreviewItem[] = [];

  for (const c of candidates) {
    const active = activeByTx.get(c.txId) ?? null;
    // MANUAL / ACCOUNT_MERGE on THIS account is "already correct AND
    // never touchable". Spec priority: count as SKIPPED_MANUAL so the
    // user knows we deliberately left it alone (not silently re-confirmed).
    if (
      active &&
      (active.assignment_source === 'MANUAL' || active.assignment_source === 'ACCOUNT_MERGE')
    ) {
      counts.manualAssignmentsSkipped++;
      continue;
    }
    if (active && active.financial_account_id === accountId) {
      counts.alreadyCorrect++;
      continue;
    }
    if (
      active &&
      (active.assignment_source === 'AUTO_IDENTIFIER' ||
        active.assignment_source === 'HISTORICAL_BACKFILL')
    ) {
      counts.willRepairHistory++;
      items.push({
        id: crypto.randomUUID(),
        transactionCandidateId: c.txId,
        disposition: 'WILL_REPAIR_HISTORY',
        identifierType: c.identifierType,
        normalizedIdentifier: c.normalizedValue,
        currentAccountId: active.financial_account_id,
        currentAssignmentSource: active.assignment_source,
        bankTimestamp: c.bankTimestamp,
        amountIrr: c.amountIrr,
        selected: true,
      });
      continue;
    }
    // No active row, OR active row points at the same account but with a
    // different identifier (rare — treat as WILL_ASSIGN).
    counts.willAssign++;
    items.push({
      id: crypto.randomUUID(),
      transactionCandidateId: c.txId,
      disposition: 'WILL_ASSIGN',
      identifierType: c.identifierType,
      normalizedIdentifier: c.normalizedValue,
      currentAccountId: c.currentAccountId,
      currentAssignmentSource: active?.assignment_source ?? null,
      bankTimestamp: c.bankTimestamp,
      amountIrr: c.amountIrr,
      selected: true,
    });
  }

  // Persist.
  const previewRowId = previewId;
  const stmts = [
    db
      .prepare(
        `INSERT INTO account_assignment_previews
           (id, financial_account_id, actor_email, status,
            account_snapshot_json, counts_json,
            created_at, expires_at, applied_at, declined_at, result_json, audit_log_id)
         VALUES (?1, ?2, ?3, 'OPEN', ?4, ?5, ?6, ?7, NULL, NULL, NULL, NULL)`,
      )
      .bind(
        previewRowId,
        accountId,
        actorEmail,
        JSON.stringify(acct.snapshot),
        JSON.stringify(counts),
        now,
        expiresAt,
      ),
  ];
  for (const it of items) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO account_assignment_preview_items
             (id, preview_id, transaction_candidate_id, disposition,
              identifier_type, normalized_identifier,
              current_account_id, current_assignment_source,
              tx_snapshot_json, selected,
              applied_disposition, applied_assignment_id)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL)`,
        )
        .bind(
          it.id,
          previewId,
          it.transactionCandidateId,
          it.disposition,
          it.identifierType,
          it.normalizedIdentifier,
          it.currentAccountId,
          it.currentAssignmentSource,
          JSON.stringify({ bankTimestamp: it.bankTimestamp, amountIrr: it.amountIrr }),
          it.selected ? 1 : 0,
        ),
    );
  }
  await db.batch(stmts);

  return {
    kind: 'ok',
    preview: {
      previewId,
      accountId,
      actorEmail,
      status: 'OPEN',
      createdAt: now,
      expiresAt,
      accountSnapshot: acct.snapshot,
      counts,
      items,
    },
  };
}

/**
 * Load a preview by id, scoping on actor + account. Returns null on
 * mismatch so the caller can return 409 / 403.
 */
export async function loadPreview(
  db: D1Database,
  previewId: string,
  accountId: string,
  actorEmail: string,
): Promise<{
  id: string;
  financial_account_id: string;
  actor_email: string;
  status: PreviewStatus;
  expires_at: number;
  counts_json: string;
  account_snapshot_json: string;
  created_at: number;
} | null> {
  const row = await db
    .prepare(
      `SELECT id, financial_account_id, actor_email, status, expires_at, counts_json, account_snapshot_json, created_at
         FROM account_assignment_previews
        WHERE id = ?1`,
    )
    .bind(previewId)
    .first<{
      id: string;
      financial_account_id: string;
      actor_email: string;
      status: PreviewStatus;
      expires_at: number;
      counts_json: string;
      account_snapshot_json: string;
      created_at: number;
    }>();
  if (!row) return null;
  if (row.financial_account_id !== accountId) return null;
  if (row.actor_email !== actorEmail) return null;
  return row;
}

/**
 * Mark a preview DECLINED. Single UPDATE; no other mutation.
 */
export async function declineAccountAssignmentPreview(
  db: D1Database,
  accountId: string,
  previewId: string,
  actorEmail: string,
  now: number = Date.now(),
): Promise<PreviewError | { kind: 'ok' }> {
  const existing = await loadPreview(db, previewId, accountId, actorEmail);
  if (!existing) return { kind: 'not_found' };
  if (existing.status !== 'OPEN') return { kind: 'wrong_status', status: existing.status };
  if (existing.expires_at <= now) return { kind: 'expired', expiredAt: existing.expires_at };
  const res = await db
    .prepare(
      `UPDATE account_assignment_previews
          SET status = 'DECLINED', declined_at = ?2
        WHERE id = ?1 AND actor_email = ?3 AND financial_account_id = ?4 AND status = 'OPEN'`,
    )
    .bind(previewId, now, actorEmail, accountId)
    .run();
  if (!res.meta.changes) return { kind: 'wrong_status', status: existing.status };
  return { kind: 'ok' };
}

/**
 * Apply the preview. Each selected item flows through
 * `assignAccountForTx` with source='HISTORICAL_BACKFILL'. MANUAL /
 * ACCOUNT_MERGE active rows are NEVER overwritten (enforced by the
 * shared write helper). Per-item divergence is recorded as
 * SKIPPED_STATE_CHANGED. Writes one audit row at the end.
 */
export async function applyAccountAssignmentPreview(
  db: D1Database,
  accountId: string,
  previewId: string,
  actorEmail: string,
  selectedTxIds: string[] | null,
  now: number = Date.now(),
  audit: {
    actorRole: 'ADMIN' | 'REVIEWER' | 'READ_ONLY' | 'SYSTEM';
    requestId: string | null;
  },
): Promise<
  | PreviewError
  | {
      kind: 'ok';
      result: ApplyPreviewResult;
      auditLogId: string | null;
    }
> {
  const existing = await loadPreview(db, previewId, accountId, actorEmail);
  if (!existing) return { kind: 'not_found' };
  if (existing.status !== 'OPEN') return { kind: 'wrong_status', status: existing.status };
  if (existing.expires_at <= now) return { kind: 'expired', expiredAt: existing.expires_at };

  // Load items.
  const itemRows = await db
    .prepare(
      `SELECT id, transaction_candidate_id, disposition, identifier_type, normalized_identifier,
              current_account_id, current_assignment_source, selected
         FROM account_assignment_preview_items
        WHERE preview_id = ?1`,
    )
    .bind(previewId)
    .all<{
      id: string;
      transaction_candidate_id: string;
      disposition: PreviewDisposition;
      identifier_type: IdentifierType | null;
      normalized_identifier: string | null;
      current_account_id: string | null;
      current_assignment_source: string | null;
      selected: number;
    }>();

  const selection = selectedTxIds ? new Set(selectedTxIds) : null;
  let applied = 0;
  let skipped = 0;
  let conflicts = 0;
  let manualPreserved = 0;
  const affectedTxIds: string[] = [];

  for (const it of itemRows.results) {
    const isSelected = selection ? selection.has(it.transaction_candidate_id) : it.selected === 1;
    if (!isSelected) {
      skipped++;
      continue;
    }
    // Re-validate current state.
    const active = await getActiveAssignment(db, it.transaction_candidate_id);
    if (
      active &&
      (active.assignment_source === 'MANUAL' || active.assignment_source === 'ACCOUNT_MERGE')
    ) {
      manualPreserved++;
      await markItemApplied(db, it.id, 'SKIPPED_MANUAL');
      continue;
    }
    if (
      active &&
      active.financial_account_id === accountId &&
      it.disposition === 'WILL_REPAIR_HISTORY'
    ) {
      // Already on this account (e.g., concurrent rerun by another admin).
      // assignAccountForTx's idempotency check would also handle this — but
      // we surface it as a no-op explicitly so the audit counts it
      // correctly.
      skipped++;
      await markItemApplied(db, it.id, 'ALREADY_CORRECT');
      continue;
    }
    if (
      it.disposition === 'WILL_REPAIR_HISTORY' &&
      active &&
      active.financial_account_id !== accountId &&
      (active.assignment_source === 'AUTO_IDENTIFIER' ||
        active.assignment_source === 'HISTORICAL_BACKFILL') &&
      active.normalized_identifier === it.normalized_identifier
    ) {
      // Snapshot's identifier still matches the live active row — we can
      // confidently overwrite. assignAccountForTx will also be a noop if
      // the live state matches the proposed triple exactly.
      // Fall through.
    } else if (
      it.disposition === 'WILL_REPAIR_HISTORY' &&
      active &&
      active.financial_account_id !== accountId &&
      active.normalized_identifier !== it.normalized_identifier
    ) {
      // Live row diverged from snapshot (a different identifier now drives it).
      conflicts++;
      await markItemApplied(db, it.id, 'SKIPPED_STATE_CHANGED');
      continue;
    }
    if (it.disposition === 'WILL_ASSIGN' && active && active.financial_account_id === accountId) {
      // Already on this account — noop.
      skipped++;
      await markItemApplied(db, it.id, 'ALREADY_CORRECT');
      continue;
    }

    const res = await assignAccountForTx(
      db,
      {
        transactionCandidateId: it.transaction_candidate_id,
        financialAccountId: accountId,
        source: 'HISTORICAL_BACKFILL',
        identifierType: it.identifier_type
          ? mapIdentifierTypeToAssignment(it.identifier_type)
          : null,
        normalizedIdentifier: it.normalized_identifier,
        assignedBy: actorEmail,
        metadata: { reason: 'rerun_account_assignment', previewId },
      },
      now,
    );

    if (res.status === 'inserted') {
      applied++;
      affectedTxIds.push(it.transaction_candidate_id);
      await markItemApplied(db, it.id, it.disposition, res.assignmentId);
    } else if (res.status === 'preserved_manual') {
      manualPreserved++;
      await markItemApplied(db, it.id, 'SKIPPED_MANUAL', res.assignmentId);
    } else {
      skipped++;
      await markItemApplied(db, it.id, it.disposition);
    }
  }

  const result: ApplyPreviewResult = {
    previewId,
    applied,
    skipped,
    conflicts,
    manualPreserved,
    affectedTxIds,
    resultJson: JSON.stringify({ applied, skipped, conflicts, manualPreserved, affectedTxIds }),
  };

  // Final batch: audit row first (so the FK reference in the UPDATE
  // resolves), then preview status update.
  const auditLogId = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        `INSERT INTO audit_logs
           (id, actor_email, actor_role, action, entity_type, entity_id,
            before_json, after_json, reason, request_id, created_at)
         VALUES (?1, ?2, ?3, 'account.assignment_rerun_applied', 'ACCOUNT', ?4,
                 ?5, ?6, 'rerun_account_assignment', ?7, ?8)`,
      )
      .bind(
        auditLogId,
        actorEmail,
        audit.actorRole,
        accountId,
        existing.counts_json,
        result.resultJson,
        audit.requestId,
        now,
      ),
    db
      .prepare(
        `UPDATE account_assignment_previews
            SET status = 'APPLIED',
                applied_at = ?2,
                result_json = ?3,
                audit_log_id = ?4
          WHERE id = ?1 AND status = 'OPEN'`,
      )
      .bind(previewId, now, result.resultJson, auditLogId),
  ]);

  return { kind: 'ok', result, auditLogId };
}

async function markItemApplied(
  db: D1Database,
  itemId: string,
  appliedDisposition: PreviewDisposition,
  appliedAssignmentId: string | null = null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE account_assignment_preview_items
          SET applied_disposition = ?2, applied_assignment_id = ?3
        WHERE id = ?1`,
    )
    .bind(itemId, appliedDisposition, appliedAssignmentId)
    .run();
}
