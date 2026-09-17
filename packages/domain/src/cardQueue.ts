/**
 * The bakery queue — Sam, 2026-09-15: «هر کی نان گرفت بره انتهای صف».
 *
 * A card handed to an invoice is out of the line while that invoice is open.
 * Nothing records the hold separately: the open `payments` row is the lease,
 * written when the card is shown and closed by PAID, REJECTED or EXPIRED. The
 * fragment below reads it, and both the bot's picker and the dashboard's card
 * list use the same one so they cannot disagree about who is busy.
 *
 * Out of the line FOR THAT AMOUNT. What the auto-matcher cannot untangle is
 * two customers told to pay the same amount into the same card inside one
 * window — the exact-amount rule then has nothing to choose by. A customer
 * paying a different amount into the same card is no such problem: their
 * SMS cannot match the other claim and the other's late SMS cannot match
 * theirs. So the picker asks «is this card holding an invoice for MY
 * amount», and the dashboard, which has no order in hand, asks «is it
 * holding any». Production 2026-09-17 is why: six of seven live cards stood
 * behind 24h holds from unsettled «پرداخت کردم» presses, and the shop sold
 * four invoices in a row on the one free card, while Mirzabot before it
 * never held a card beyond its ten-minute lease.
 *
 * Two lengths, because «I paid» changes what waiting means:
 *
 *   - PENDING (shown, nothing pressed): `pay/card_hold_minutes` from being
 *     shown — ten unless the operator changed it on the settings screen (Sam,
 *     2026-09-15: «۵ دقیقه یا ۲ دقیقه یا هر چقدر که دوست داره»). After that
 *     the customer is treated as gone and the card is free again — its place
 *     in the line does not move, it never took money. The INVOICE dies at the
 *     same moment: `order.ts` writes `orders.expires_at` from this same
 *     setting (0070), so a customer can never hold a live invoice naming a
 *     card that is already in somebody else's hands. Until 2026-09-17 the
 *     invoice outlived the hold by twenty-three hours, and a deposit made in
 *     that window was the one thing the matcher could not untangle.
 *   - AWAITING_REVIEW (customer pressed «پرداخت کردم»): money is probably in
 *     flight, so the card stays out until somebody settles the claim. Bounded
 *     by the widest window anything here waits for a bank SMS, the 24h of
 *     `FULFILLED_RECONCILE_MAX_TIME_DELTA_MS`, so a claim nobody ever looks at
 *     cannot park a card for good.
 */

import { FULFILLED_RECONCILE_MAX_TIME_DELTA_MS } from '@shikoo/contracts';

export const DEFAULT_CARD_HOLD_MINUTES = 10;
/** The hold at the default setting — what a fresh database gives. */
export const CARD_HOLD_MS = DEFAULT_CARD_HOLD_MINUTES * 60_000;
export const CLAIMED_CARD_HOLD_MS = FULFILLED_RECONCILE_MAX_TIME_DELTA_MS;

/**
 * The operator's number, read inside the statement so the bot and the
 * dashboard cannot hold different copies of it. The settings screen saves
 * numbers as JSON strings and 0064 seeds a JSON number; `#>> '{}'` reads both
 * as text. Anything that is not a positive number — a cleared field, a stray
 * minus, a zero — falls back to the default rather than to «no hold»: since
 * this number is also the invoice's lifetime, zero would mean an invoice that
 * is dead the moment it is printed.
 *
 * Exported for `order.ts`, which writes the invoice deadline from it. One
 * fragment, two readers, so the hold and the deadline cannot drift apart.
 */
export const CARD_HOLD_MINUTES_SQL = `COALESCE(
  (SELECT CASE WHEN s.value #>> '{}' ~ '^[1-9][0-9]{0,3}$' THEN (s.value #>> '{}')::int END
     FROM settings s WHERE s.scope = 'pay' AND s.key = 'card_hold_minutes'),
  ${DEFAULT_CARD_HOLD_MINUTES})`;

/**
 * Scalar subquery, correlated on an outer `pc` (a `payment_cards` row): the
 * epoch-ms until which the card is held, or NULL when no invoice holds it.
 * Compare against the caller's own `now` — nothing in here reads the clock.
 *
 * `amountParam` names the bound parameter carrying the order's amount
 * (`?2`); only invoices for that amount count. Without it every open invoice
 * counts — the dashboard's «در دست مشتری تا …», which is about the card, not
 * about an order.
 */
export function cardHeldUntilSql(amountParam?: string): string {
  return `(
  SELECT MAX(CASE WHEN p.status = 'AWAITING_REVIEW'
                  THEN (EXTRACT(EPOCH FROM COALESCE(p.updated_at, p.created_at)) * 1000)::bigint
                       + ${CLAIMED_CARD_HOLD_MS}
                  ELSE (EXTRACT(EPOCH FROM p.created_at) * 1000)::bigint
                       + ${CARD_HOLD_MINUTES_SQL} * 60000
             END)
    FROM payments p
   WHERE p.assigned_card_number = pc.card_digits
     AND p.status IN ('PENDING', 'AWAITING_REVIEW')${amountParam ? `
     AND p.amount_irr = ${amountParam}` : ''})`;
}

export const CARD_HELD_UNTIL_SQL = cardHeldUntilSql();

/**
 * Where the outer `pc` stands in the line, 1-based, among every card in
 * service — across accounts, which is why nothing here is scoped. The order is
 * the picker's own last tie-break, `(rotation_cursor, id)`; the hold is not
 * folded in because the dashboard shows it as its own badge beside this one.
 */
export const CARD_QUEUE_POSITION_SQL = `(
  SELECT COUNT(*)::int + 1 FROM payment_cards o
    JOIN financial_accounts ofa ON ofa.id = o.financial_account_id
   WHERE o.status = 'ACTIVE' AND ofa.active = 1 AND ofa.status = 'ACTIVE'
     AND (o.rotation_cursor, o.id) < (pc.rotation_cursor, pc.id))`;
