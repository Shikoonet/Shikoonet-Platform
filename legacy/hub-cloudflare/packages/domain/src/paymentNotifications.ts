/**
 * Payment-event unread counts for the notification bell and tab NEW badges.
 */

import type { D1Database } from '@hub/database';
import { MIRZABOT_SOURCE } from '@hub/contracts';
import { INCOME_TX_WHERE } from './incomeEligibility.js';

const PENDING_CLAIM = `c.status IN ('PENDING','MATCH_SUGGESTED')`;
const SUSPECTED_FAKE_REASONS = `('NO_TRANSACTION_AFTER_10M','NO_TRANSACTION')`;

const SETTLED_MATCH = `
  SELECT m2.id FROM reconciliation_matches m2
   WHERE m2.payment_claim_id = c.id AND m2.status IN ('AUTO_VERIFIED','CONFIRMED')
   ORDER BY CASE m2.status WHEN 'AUTO_VERIFIED' THEN 0 ELSE 1 END, m2.created_at DESC
   LIMIT 1`;

function unreadClaimSql(stateWhere: string): string {
  return `
    SELECT COUNT(*) AS c FROM payment_claims c
     LEFT JOIN reconciliation_matches m ON m.id = (${SETTLED_MATCH})
     WHERE c.source_system = '${MIRZABOT_SOURCE}'
       AND ${stateWhere}
       AND NOT EXISTS (
         SELECT 1 FROM dashboard_payment_event_reads r
          WHERE r.actor_email = ?1 AND r.event_key = 'claim:' || c.id
       )`;
}

export interface PaymentEventUnreadCounts {
  needsReview: number;
  suspectedFake: number;
  botAutoVerified: number;
  reseller: number;
  total: number;
}

/** Bell badge scope: Income queue + Bot Auto Verified only. */
export interface BellUnreadCounts {
  income: number;
  botAutoVerified: number;
  total: number;
}

export async function getPaymentEventUnreadCounts(
  db: D1Database,
  actorEmail: string,
): Promise<PaymentEventUnreadCounts> {
  const needsReview = await db
    .prepare(
      unreadClaimSql(
        `${PENDING_CLAIM} AND c.suspect_reason IS NOT NULL AND c.suspect_reason NOT IN ${SUSPECTED_FAKE_REASONS}`,
      ),
    )
    .bind(actorEmail)
    .first<{ c: number }>();

  const suspectedFake = await db
    .prepare(
      unreadClaimSql(`${PENDING_CLAIM} AND c.suspect_reason IN ${SUSPECTED_FAKE_REASONS}`),
    )
    .bind(actorEmail)
    .first<{ c: number }>();

  const botAutoVerified = await db
    .prepare(unreadClaimSql(`c.status = 'VERIFIED' AND m.status = 'AUTO_VERIFIED'`))
    .bind(actorEmail)
    .first<{ c: number }>();

  const reseller = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM reseller_transactions rt
       WHERE NOT EXISTS (
         SELECT 1 FROM dashboard_payment_event_reads r
          WHERE r.actor_email = ?1 AND r.event_key = 'reseller:' || rt.id
       )`,
    )
    .bind(actorEmail)
    .first<{ c: number }>();

  const counts = {
    needsReview: needsReview?.c ?? 0,
    suspectedFake: suspectedFake?.c ?? 0,
    botAutoVerified: botAutoVerified?.c ?? 0,
    reseller: reseller?.c ?? 0,
  };
  return {
    ...counts,
    total: counts.needsReview + counts.suspectedFake + counts.botAutoVerified + counts.reseller,
  };
}

export async function getIncomeUnreadCount(
  db: D1Database,
  actorEmail: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM transaction_candidates t
       WHERE ${INCOME_TX_WHERE}
         AND NOT EXISTS (
           SELECT 1 FROM dashboard_payment_event_reads r
            WHERE r.actor_email = ?1 AND r.event_key = 'income:' || t.id
         )`,
    )
    .bind(actorEmail)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export async function getBellUnreadCounts(
  db: D1Database,
  actorEmail: string,
): Promise<BellUnreadCounts> {
  const [income, botRow] = await Promise.all([
    getIncomeUnreadCount(db, actorEmail),
    db
      .prepare(unreadClaimSql(`c.status = 'VERIFIED' AND m.status = 'AUTO_VERIFIED'`))
      .bind(actorEmail)
      .first<{ c: number }>(),
  ]);
  const botAutoVerified = botRow?.c ?? 0;
  return { income, botAutoVerified, total: income + botAutoVerified };
}

export async function markPaymentEventRead(
  db: D1Database,
  actorEmail: string,
  eventKey: string,
  seenAt = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO dashboard_payment_event_reads (actor_email, event_key, seen_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(actor_email, event_key) DO UPDATE SET seen_at = excluded.seen_at`,
    )
    .bind(actorEmail, eventKey, seenAt)
    .run();
}

export async function markPaymentEventsReadAll(
  db: D1Database,
  actorEmail: string,
  tab: 'needs_review' | 'suspected_fake' | 'bot_auto_verified' | 'reseller' | 'income',
): Promise<number> {
  const now = Date.now();
  let keys: string[] = [];

  if (tab === 'income') {
    const rows = await db
      .prepare(`SELECT t.id FROM transaction_candidates t WHERE ${INCOME_TX_WHERE}`)
      .all<{ id: string }>();
    keys = (rows.results ?? []).map((r) => incomeEventKey(r.id));
  } else if (tab === 'reseller') {
    const rows = await db.prepare(`SELECT id FROM reseller_transactions`).all<{ id: string }>();
    keys = (rows.results ?? []).map((r) => `reseller:${r.id}`);
  } else {
    let stateWhere = '';
    if (tab === 'needs_review') {
      stateWhere = `${PENDING_CLAIM} AND c.suspect_reason IS NOT NULL AND c.suspect_reason NOT IN ${SUSPECTED_FAKE_REASONS}`;
    } else if (tab === 'suspected_fake') {
      stateWhere = `${PENDING_CLAIM} AND c.suspect_reason IN ${SUSPECTED_FAKE_REASONS}`;
    } else {
      stateWhere = `c.status = 'VERIFIED' AND m.status = 'AUTO_VERIFIED'`;
    }
    const rows = await db
      .prepare(
        `SELECT c.id FROM payment_claims c
         LEFT JOIN reconciliation_matches m ON m.id = (${SETTLED_MATCH})
         WHERE c.source_system = '${MIRZABOT_SOURCE}' AND ${stateWhere}`,
      )
      .all<{ id: string }>();
    keys = (rows.results ?? []).map((r) => `claim:${r.id}`);
  }

  for (const key of keys) {
    await markPaymentEventRead(db, actorEmail, key, now);
  }
  return keys.length;
}

export function claimEventKey(claimId: string): string {
  return `claim:${claimId}`;
}

export function resellerEventKey(resellerTransactionId: string): string {
  return `reseller:${resellerTransactionId}`;
}

export function incomeEventKey(transactionId: string): string {
  return `income:${transactionId}`;
}

export async function isPaymentEventUnread(
  db: D1Database,
  actorEmail: string,
  eventKey: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM dashboard_payment_event_reads
       WHERE actor_email = ?1 AND event_key = ?2`,
    )
    .bind(actorEmail, eventKey)
    .first<{ ok: number }>();
  return row?.ok !== 1;
}
