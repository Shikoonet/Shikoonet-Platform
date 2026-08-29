/**
 * Account operational lifecycle.
 *
 * Source of truth for whether a financial_accounts row participates in
 * Today, matching, totals, reports, and exports. The existing `active`
 * column is a binary soft-delete flag (orthogonal to lifecycle); the
 * `status` column is the day-to-day operational state.
 *
 *   PENDING    Discovered/created but not reviewed. Shown only in the
 *              Accounts review queue. No Today / All Matches / reports /
 *              totals / exports. Accept → ACTIVE, Decline → DECLINED.
 *
 *   ACTIVE     Full inclusion. Eligible for matching, in Today, in
 *              reports, exports, and dashboard aggregates.
 *
 *   MUTED      Valid but temporarily excluded. Continue ingesting +
 *              parsing SMS (raw events + tx candidate rows are still
 *              written). No matching, Today, All Matches, reports,
 *              exports, totals, charts, KPIs. Allow Unmute → ACTIVE.
 *
 *   DECLINED   Not relevant. Preserve SMS + transactions for audit. No
 *              matching, no operational views. Allow Restore → PENDING.
 *
 * This module is the single source of truth for status transitions and
 * the operational-eligibility predicate. The dashboard-worker SQL joins
 * should call `SQL.accountStatusWhere` (= `COALESCE(fa.status,'ACTIVE')
 * = 'ACTIVE'`) so unassigned transactions still appear in Today.
 */

export type AccountStatus = 'PENDING' | 'ACTIVE' | 'MUTED' | 'DECLINED';

export const ACCOUNT_STATUSES: readonly AccountStatus[] = [
  'PENDING',
  'ACTIVE',
  'MUTED',
  'DECLINED',
] as const;

/**
 * Allowed transitions. Any other from→to pair returns 409 IllegalStatusTransition.
 *
 *   PENDING  → ACTIVE         review accepted
 *   PENDING  → DECLINED       review declined
 *   ACTIVE   → MUTED          admin muted
 *   ACTIVE   → DECLINED       admin declined (skip review)
 *   MUTED    → ACTIVE         admin unmuted
 *   MUTED    → DECLINED       admin declined (skip review)
 *   DECLINED → PENDING        admin restored (back to review queue)
 */
const ALLOWED: Record<AccountStatus, ReadonlySet<AccountStatus>> = {
  PENDING: new Set(['ACTIVE', 'DECLINED']),
  ACTIVE: new Set(['MUTED', 'DECLINED']),
  MUTED: new Set(['ACTIVE', 'DECLINED']),
  DECLINED: new Set(['PENDING']),
};

export type IllegalTransitionResult =
  | { ok: true; next: AccountStatus }
  | { ok: false; reason: 'same_status'; current: AccountStatus }
  | { ok: false; reason: 'illegal_transition'; from: AccountStatus; to: AccountStatus };

/**
 * Validate a requested transition. Returns an `ok: true` arm unless the
 * transition is illegal (in which case the worker returns 409) or a
 * no-op (in which case the worker returns 200 with `noop: true`).
 */
export function assertTransitionStatus(
  current: AccountStatus,
  next: AccountStatus,
): IllegalTransitionResult {
  if (current === next) return { ok: false, reason: 'same_status', current };
  if (!ALLOWED[current].has(next)) {
    return { ok: false, reason: 'illegal_transition', from: current, to: next };
  }
  return { ok: true, next };
}

/**
 * The only status that is operationally eligible — i.e. eligible for
 * matching, included in Today, All Matches, totals, reports, exports,
 * and dashboard aggregates. PENDING / MUTED / DECLINED accounts all
 * stay on the database but are excluded from every product view.
 *
 * Tx rows whose `financial_account_id` is NULL (no account assigned)
 * are still eligible — they're treated as "discovered, awaiting
 * assignment". The dashboard-worker SQL uses `COALESCE(fa.status,
 * 'ACTIVE') = 'ACTIVE'` so the unassigned case keeps the historical
 * behavior.
 */
export function isAccountOperable(status: AccountStatus | null | undefined): boolean {
  return status === 'ACTIVE';
}

/**
 * Review-queue eligible. The dashboard's Accounts review queue only
 * lists accounts in PENDING (newly auto-discovered) plus DECLINED (an
 * admin can Restore), so admins can take action on them.
 */
export function isReviewQueueMember(status: AccountStatus | null | undefined): boolean {
  return status === 'PENDING' || status === 'DECLINED';
}

/**
 * Friendly UI label for the status pill. Kept here so the dashboard and
 * the worker agree on the display wording.
 */
export function statusLabel(status: AccountStatus): string {
  switch (status) {
    case 'PENDING':
      return 'Pending review';
    case 'ACTIVE':
      return 'Active';
    case 'MUTED':
      return 'Muted';
    case 'DECLINED':
      return 'Declined';
  }
}

/**
 * Audit-log action tag for each transition. These are the values used in
 * `audit_logs.action` (column is a free TEXT — the enum is enforced by
 * the application, not the schema).
 */
export const STATUS_TRANSITION_ACTIONS = {
  accept: 'account.accepted', // PENDING → ACTIVE
  decline: 'account.declined', // PENDING|ACTIVE|MUTED → DECLINED
  mute: 'account.muted', // ACTIVE → MUTED
  unmute: 'account.unmuted', // MUTED → ACTIVE
  restore: 'account.restored', // DECLINED → PENDING
} as const;

export type StatusTransitionAction =
  (typeof STATUS_TRANSITION_ACTIONS)[keyof typeof STATUS_TRANSITION_ACTIONS];

/**
 * Pick the audit action that performs `from → to`. Returns null for
 * illegal transitions (defense in depth — assertTransitionStatus should
 * have already rejected them).
 */
export function auditActionForTransition(
  from: AccountStatus,
  to: AccountStatus,
): StatusTransitionAction | null {
  if (from === 'PENDING' && to === 'ACTIVE') return STATUS_TRANSITION_ACTIONS.accept;
  if (to === 'DECLINED') return STATUS_TRANSITION_ACTIONS.decline;
  if (from === 'ACTIVE' && to === 'MUTED') return STATUS_TRANSITION_ACTIONS.mute;
  if (from === 'MUTED' && to === 'ACTIVE') return STATUS_TRANSITION_ACTIONS.unmute;
  if (from === 'DECLINED' && to === 'PENDING') return STATUS_TRANSITION_ACTIONS.restore;
  return null;
}
