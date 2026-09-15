/**
 * The bakery queue — Sam, 2026-09-15: «هر کی نان گرفت بره انتهای صف».
 *
 * A card handed to an invoice is out of the line while that invoice is open.
 * Nothing records the hold separately: the open `payments` row is the lease,
 * written when the card is shown and closed by PAID, REJECTED or EXPIRED. The
 * fragment below reads it, and both the bot's picker and the dashboard's card
 * list use the same one so they cannot disagree about who is busy.
 *
 * Two lengths, because «I paid» changes what waiting means:
 *
 *   - PENDING (shown, nothing pressed): ten minutes from being shown. After
 *     that the customer is treated as gone and the card is free again — its
 *     place in the line does not move, it never took money.
 *   - AWAITING_REVIEW (customer pressed «پرداخت کردم»): money is probably in
 *     flight, so the card stays out until somebody settles the claim. Bounded
 *     by the widest window anything here waits for a bank SMS, the 24h of
 *     `FULFILLED_RECONCILE_MAX_TIME_DELTA_MS`, so a claim nobody ever looks at
 *     cannot park a card for good.
 */

import { FULFILLED_RECONCILE_MAX_TIME_DELTA_MS } from '@shikoo/contracts';

export const CARD_HOLD_MS = 10 * 60_000;
export const CLAIMED_CARD_HOLD_MS = FULFILLED_RECONCILE_MAX_TIME_DELTA_MS;

/**
 * Scalar subquery, correlated on an outer `pc` (a `payment_cards` row): the
 * epoch-ms until which the card is held, or NULL when no invoice holds it.
 * Compare against the caller's own `now` — nothing in here reads the clock.
 */
export const CARD_HELD_UNTIL_SQL = `(
  SELECT MAX(CASE WHEN p.status = 'AWAITING_REVIEW'
                  THEN (EXTRACT(EPOCH FROM COALESCE(p.updated_at, p.created_at)) * 1000)::bigint
                       + ${CLAIMED_CARD_HOLD_MS}
                  ELSE (EXTRACT(EPOCH FROM p.created_at) * 1000)::bigint + ${CARD_HOLD_MS}
             END)
    FROM payments p
   WHERE p.assigned_card_number = pc.card_digits
     AND p.status IN ('PENDING', 'AWAITING_REVIEW'))`;
