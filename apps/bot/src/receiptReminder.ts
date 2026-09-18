/**
 * One reminder to a customer who pressed «پرداخت کردم» and sent no receipt.
 *
 * Sam, 2026-09-18 (#308). Since 09-17 nothing ships without a picture: the
 * matcher holds a found transfer until the receipt is in. So a claim with no
 * receipt is a claim going nowhere, and the customer usually does not know —
 * they paid, they pressed the button, they are waiting. Five minutes after
 * the press, and five minutes BEFORE the matcher gives up on the receipt
 * (`WAITING_TIMEOUT_MS`), the bot asks once more. Once: the row in
 * `bot_notifications` under `receipt-nudge:<claimId>` is the record that it
 * did, the same way `nudge.ts` remembers who it has already asked.
 *
 * The reminder is also what re-opens the door: `recordReceipt` takes a
 * picture for a claim that has no receipt yet, or one this reminder was
 * queued for — and for nothing else.
 */

import type { D1Database } from '@shikoo/database';
import { createLogger } from '@shikoo/domain';
import { enqueue } from './notify.js';
import * as menu from './menu.js';

const log = createLogger('bot');

/** How long after «پرداخت کردم» the bot asks again. Fixed on purpose. */
export const RECEIPT_REMINDER_AFTER_MS = 5 * 60 * 1000;

/**
 * Nothing older than this is reminded. The sweep starts on a live shop with a
 * backlog of receipt-less claims from before it existed — parked ones,
 * abandoned ones — and a reminder about a payment from last week reads as a
 * bot that has lost track, not as help. A claim whose reminder was missed by
 * an outage longer than this simply gets none.
 */
const RECEIPT_REMINDER_WINDOW_MS = 60 * 60 * 1000;

const BATCH = 50;

export function receiptReminderKey(claimId: string): string {
  return `receipt-nudge:${claimId}`;
}

export async function remindMissingReceipt(
  db: D1Database,
  now: number = Date.now(),
): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT c.id, u.telegram_id
         FROM payment_claims c
         JOIN payments p ON c.external_order_id = 'shikoo:' || p.public_id
         JOIN users u ON u.id = p.user_id
        WHERE c.status IN ('PENDING', 'MATCH_SUGGESTED')
          AND c.receipt_url_or_r2_key IS NULL
          AND c.paid_clicked_at <= ?1
          AND c.paid_clicked_at >= ?2
          AND u.telegram_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM bot_notifications n
             WHERE n.dedupe_key = 'receipt-nudge:' || c.id)
        ORDER BY c.paid_clicked_at
        LIMIT ?3`,
    )
    .bind(now - RECEIPT_REMINDER_AFTER_MS, now - RECEIPT_REMINDER_WINDOW_MS, BATCH)
    .all<{ id: string; telegram_id: number }>();

  let sent = 0;
  for (const row of results ?? []) {
    // The insert is the claim: two overlapping sweeps cannot both write it.
    const queued = await db.withSession((tx) =>
      enqueue(tx, {
        dedupeKey: receiptReminderKey(row.id),
        chatId: row.telegram_id,
        text: menu.RECEIPT_REMINDER,
      }),
    );
    if (queued) sent += 1;
  }

  if (sent > 0) log.info('sweep.acted', { job: 'receipt_reminder', count: sent });
  return sent;
}
