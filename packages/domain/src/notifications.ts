/**
 * Per-actor notification state used by the dashboard notification bell.
 *
 * The bell shows aggregate counts (new / unassigned / unmatched / suggested)
 * computed live from the canonical tables. The *unread* badge is the same
 * counts minus what the actor has already seen, tracked as a cursor
 * (last_seen_transaction_at, last_seen_transaction_id) so events that
 * land between two polls are unambiguously "new" once the cursor crosses
 * them.
 */

import type { D1Database } from '@shikoo/database';
import { SQL } from '@shikoo/database';

export interface NotificationState {
  actor_email: string;
  last_seen_transaction_at: number | null;
  last_seen_transaction_id: string | null;
  updated_at: number;
}

/**
 * Read the state row for an actor, creating an empty one if it doesn't
 * exist yet. Returning a typed empty row keeps the bell happy even on
 * the actor's first visit.
 */
export async function getNotificationState(
  db: D1Database,
  actorEmail: string,
): Promise<NotificationState> {
  const row = await db
    .prepare(
      `SELECT actor_email, last_seen_transaction_at, last_seen_transaction_id, updated_at
         FROM dashboard_notification_state
        WHERE actor_email = ?1`,
    )
    .bind(actorEmail)
    .first<NotificationState>();
  if (row) return row;
  return {
    actor_email: actorEmail,
    last_seen_transaction_at: null,
    last_seen_transaction_id: null,
    updated_at: 0,
  };
}

/**
 * Persist the actor's cursor. Idempotent — re-saving the same cursor
 * is a no-op (still updates updated_at so we know the dashboard was
 * actually polled).
 */
export async function setNotificationState(
  db: D1Database,
  actorEmail: string,
  lastSeenTransactionAt: number | null,
  lastSeenTransactionId: string | null,
  now: number = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO dashboard_notification_state
        (actor_email, last_seen_transaction_at, last_seen_transaction_id, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(actor_email) DO UPDATE SET
         last_seen_transaction_at = excluded.last_seen_transaction_at,
         last_seen_transaction_id = excluded.last_seen_transaction_id,
         updated_at = excluded.updated_at`,
    )
    .bind(actorEmail, lastSeenTransactionAt, lastSeenTransactionId, now)
    .run();
}

/**
 * Snapshot counts for the bell. The dashboard reads these on the bell
 * poll cadence. Aggregations are by design bounded:
 *
 *   - new:     transactions whose (bank_timestamp, id) is strictly past
 *              the actor's cursor.
 *   - unassigned:  transaction_candidates.financial_account_id IS NULL AND
 *                  status NOT IN ('IGNORED', 'REJECTED')
 *   - unmatched:  NEEDS_REVIEW (filtered by the resolver to avoid double
 *                  counting ambiguous rows that the dashboard treats
 *                  separately).
 *   - suggested:  reconciliation_matches.status = 'SUGGESTED'.
 *
 * Ponytail: the four queries are simple index-served counts — no need
 * for a single mega-SQL. Total < 8 KB per poll.
 */
export interface NotificationCounts {
  new: number;
  unassigned: number;
  unmatched: number;
  suggested: number;
  total: number;
}

export async function getNotificationCounts(
  db: D1Database,
  cursor: { at: number | null; id: string | null },
  actorEmail?: string,
): Promise<NotificationCounts> {
  // "new" = the transaction is past the actor's global mark-all-read
  // cursor AND no row exists in dashboard_transaction_reads for this
  // (actor, tx). When actorEmail is absent we skip the per-row read
  // filter — the bell-counts callers that don't have an identity (tests,
  // maintenance jobs) still want a reasonable count.
  const sql = actorEmail
    ? `SELECT COUNT(*) AS c FROM transaction_candidates t
        LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
        LEFT JOIN dashboard_transaction_reads dtr
          ON dtr.transaction_candidate_id = t.id
         AND dtr.actor_email = ?3
        WHERE (t.bank_timestamp > ?1
            OR (t.bank_timestamp = ?1 AND t.id > ?2))
          AND dtr.actor_email IS NULL
          AND ${SQL.actionableTransactionWhereT}
          AND ${SQL.accountStatusWhere}`
    : `SELECT COUNT(*) AS c FROM transaction_candidates t
        LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
        WHERE (t.bank_timestamp > ?1
            OR (t.bank_timestamp = ?1 AND t.id > ?2))
          AND ${SQL.actionableTransactionWhereT}
          AND ${SQL.accountStatusWhere}`;
  const newCount = actorEmail
    ? await db
        .prepare(sql)
        .bind(cursor.at ?? 0, cursor.id ?? '', actorEmail)
        .first<{ c: number }>()
    : await db
        .prepare(sql)
        .bind(cursor.at ?? 0, cursor.id ?? '')
        .first<{ c: number }>();

  const unassigned = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM transaction_candidates t
        LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
        WHERE t.financial_account_id IS NULL
          AND t.status NOT IN ('IGNORED', 'REJECTED')
          AND ${SQL.actionableTransactionWhereT}
          AND ${SQL.accountStatusWhere}`,
    )
    .first<{ c: number }>();

  const unmatched = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM transaction_candidates t
        LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
        WHERE t.status = 'NEEDS_REVIEW'
          AND ${SQL.actionableTransactionWhereT}
          AND ${SQL.accountStatusWhere}`,
    )
    .first<{ c: number }>();

  const suggested = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM reconciliation_matches m
        JOIN transaction_candidates t ON t.id = m.transaction_candidate_id
        LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
        WHERE m.status = 'SUGGESTED'
          AND ${SQL.actionableTransactionWhereT}
          AND ${SQL.accountStatusWhere}`,
    )
    .first<{ c: number }>();

  const newN = newCount?.c ?? 0;
  const total = newN + (unassigned?.c ?? 0) + (unmatched?.c ?? 0) + (suggested?.c ?? 0);
  return {
    new: newN,
    unassigned: unassigned?.c ?? 0,
    unmatched: unmatched?.c ?? 0,
    suggested: suggested?.c ?? 0,
    total,
  };
}

/**
 * Pure definition of `is_new` for a single transaction row.
 *
 *   is_new = (tx.bank_timestamp, tx.id) is strictly past the actor's
 *             global mark-all-read cursor
 *        AND there is no explicit per-row read entry for this actor+tx.
 *
 * Both inputs are nullable: a missing cursor means "the actor has never
 * marked all as read" (every past the actor's first poll is new); a missing
 * seenAt means "no explicit per-row read".
 */
export function isNewForTransaction(
  txBankTimestamp: number | null,
  txId: string,
  cursor: { at: number | null; id: string | null },
  seenAt: number | null | undefined,
): boolean {
  if (seenAt != null) return false;
  const curAt = cursor.at ?? null;
  const curId = cursor.id ?? null;
  // No cursor yet — fall back to "everything new" unless we have a seenAt.
  if (curAt === null || curId === null) return true;
  if (txBankTimestamp == null) return true;
  return txBankTimestamp > curAt || (txBankTimestamp === curAt && txId > curId);
}

/**
 * Upsert a per-row read for the actor. Idempotent — re-marking the same
 * row just refreshes `seen_at` to the latest value.
 *
 * Does NOT touch `dashboard_notification_state` (the global cursor is a
 * separate concern owned by `setNotificationState`). Does NOT log the SMS
 * body or any sensitive payload.
 */
export async function markTransactionRead(
  db: D1Database,
  actorEmail: string,
  transactionId: string,
  seenAt: number = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO dashboard_transaction_reads
        (actor_email, transaction_candidate_id, seen_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(actor_email, transaction_candidate_id) DO UPDATE SET
         seen_at = excluded.seen_at`,
    )
    .bind(actorEmail, transactionId, seenAt)
    .run();
}

/**
 * Fetch every per-row read entry for the actor, keyed by transaction id.
 * Used by the client cache overlay so optimistic dismissals survive reloads.
 */
export async function getSeenIdsForActor(
  db: D1Database,
  actorEmail: string,
): Promise<Record<string, number>> {
  const rows = await db
    .prepare(
      `SELECT transaction_candidate_id AS id, seen_at
         FROM dashboard_transaction_reads
        WHERE actor_email = ?1`,
    )
    .bind(actorEmail)
    .all<{ id: string; seen_at: number }>();
  const out: Record<string, number> = {};
  for (const r of rows.results ?? []) out[r.id] = r.seen_at;
  return out;
}
