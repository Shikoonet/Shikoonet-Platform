/**
 * A bank's re-send of one text, so it never becomes a second transaction.
 * Shared by ingest (as the text arrives) and «بازخوانی» (reading old texts
 * again): the rule is the same, and so must be the code.
 */

import type { D1Database } from '@shikoo/database';

export const REDELIVERY_WINDOW_MS = 6 * 3_600_000;

/** What the text said, which is what a re-send repeats. */
export interface Movement {
  direction: string;
  amountIrr: number;
  balanceIrr: number;
}

/**
 * Another text on the same phone that already became a transaction saying the
 * same thing: same direction, same amount, and the same balance after it,
 * inside six hours. A bank does not land two movements on one identical
 * balance — that is the whole rule, and the balance is why the caller checks
 * the parser read one before asking.
 *
 * Six hours **either side**, not only before. The rule is about one movement,
 * and a movement has no direction in time. 2026-09-22 proved why: Maskan's
 * `انتقال خودپرداز` copy arrived at 11:19 and nobody could read it; its twin
 * arrived at 12:22 and made the row. When «بازخوانی» finally read the 11:19
 * text, a backwards-only window could not see the 12:22 row and made a second
 * 250,000-toman deposit, which the books caught as a −250,000 gap on
 * مسکن-سارا. Ingest can hit the same thing whenever the relay delivers a
 * backlog out of order.
 *
 * Not the sender and not the bytes. On 2026-09-20 Melli sent one 1,200,000
 * deposit twice, four minutes apart, from two different numbers
 * (`+989192030800`, then its own `+98700717`) with one blank line fewer in
 * the second — and the first version of this rule, keyed on sender and
 * identical body, let it through as a second deposit that then sat open in
 * «پرداخت‌ها». Same phone, because a re-send reaches the SIM it was sent to.
 */
export async function findRedelivery(
  db: D1Database,
  deviceId: string,
  m: Movement,
  eventId: string,
  smsTimestamp: number,
): Promise<{ id: string } | null> {
  return (
    (await db
      .prepare(
        `SELECT r.id
           FROM raw_sms_events r
           JOIN transaction_candidates t ON t.raw_sms_event_id = r.id
          WHERE r.device_id = ?1 AND r.id <> ?2
            AND t.direction = ?3 AND t.amount_irr = ?4 AND t.balance_irr = ?5
            AND r.sms_timestamp BETWEEN ?6 AND ?7
          ORDER BY r.sms_timestamp DESC
          LIMIT 1`,
      )
      .bind(
        deviceId,
        eventId,
        m.direction,
        m.amountIrr,
        m.balanceIrr,
        smsTimestamp - REDELIVERY_WINDOW_MS,
        smsTimestamp + REDELIVERY_WINDOW_MS,
      )
      .first<{ id: string }>()) ?? null
  );
}
