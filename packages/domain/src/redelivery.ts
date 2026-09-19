/**
 * A bank's re-send of one text, so it never becomes a second transaction.
 * Shared by ingest (as the text arrives) and «بازخوانی» (reading old texts
 * again): the rule is the same, and so must be the code.
 */
import type { D1Database } from '@shikoo/database';

export const REDELIVERY_WINDOW_MS = 6 * 3_600_000;

/**
 * An earlier delivery of the very same text, to the same phone from the same
 * sender, that already became a transaction. Same body — which, since the
 * caller checked the parser read a balance out of it, includes that balance —
 * inside six hours: a bank does not land two movements on one identical
 * balance. Same phone, because a re-send reaches the SIM it was sent to; the
 * fingerprint is scoped the same way.
 */
export async function findRedelivery(
  db: D1Database,
  deviceId: string,
  sender: string,
  normalizedBody: string | null,
  eventId: string,
  smsTimestamp: number,
): Promise<{ id: string } | null> {
  if (normalizedBody === null) return null;
  return (
    (await db
      .prepare(
        `SELECT r.id
           FROM raw_sms_events r
           JOIN transaction_candidates t ON t.raw_sms_event_id = r.id
          WHERE r.device_id = ?1 AND r.sender = ?2 AND r.normalized_body = ?3 AND r.id <> ?4
            AND r.sms_timestamp BETWEEN ?5 AND ?6
          ORDER BY r.sms_timestamp DESC
          LIMIT 1`,
      )
      .bind(deviceId, sender, normalizedBody, eventId, smsTimestamp - REDELIVERY_WINDOW_MS, smsTimestamp)
      .first<{ id: string }>()) ?? null
  );
}
