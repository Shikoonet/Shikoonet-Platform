-- 0070_the_invoice_dies_with_the_card.sql — 2026-09-17.
--
-- Two clocks that did not know about each other.
--
-- `pay/card_hold_minutes` (0064) frees a card ten minutes after it is shown;
-- `bot/order_ttl_hours` (0057) kept the invoice that printed the card alive
-- for twenty-four. Between minute ten and hour twenty-four a customer held an
-- invoice naming a card that was already in somebody else's hands — or
-- disabled — and a deposit made in that window either collided with the next
-- customer's (AMBIGUOUS, manual review) or landed on a card nobody watched.
--
-- One clock from here on: the invoice lives exactly as long as the card is
-- held, and `orders.expires_at` is written from `card_hold_minutes`. The
-- hours setting has no reader left, so its row goes; leaving it would put a
-- knob on the settings screen that turns nothing.
--
-- The two columns are for closing the invoice where the customer sees it.
-- The expiry sweep used to send a new message and leave the invoice — and
-- its card number — standing in the chat above it. Now the bot remembers
-- which message the invoice is (`payments.invoice_message_id`) and the
-- outbox can be asked to EDIT that message instead of sending a fresh one
-- (`bot_notifications.edit_message_id`). Both nullable: an invoice whose
-- message id was never learned still gets the new-message fallback.

BEGIN;

ALTER TABLE payments ADD COLUMN invoice_message_id bigint;

ALTER TABLE bot_notifications ADD COLUMN edit_message_id bigint;

DELETE FROM settings WHERE scope = 'bot' AND key = 'order_ttl_hours';

-- The invoices already open were printed with the old day-long deadline, and
-- their cards have been free for the next customer since their hold lapsed.
-- Their deadline is pulled in to what it would have been under the new rule —
-- the hold from the moment they were issued, read from the operator's own
-- setting the way `cardQueue.ts` reads it — and never pushed out. The next
-- sweep closes the ones already past it and tells each customer, as a new
-- message: nothing recorded which message these invoices are. A claimed
-- invoice (AWAITING_REVIEW) is untouched by the sweep regardless, so nobody
-- who has said «پرداخت کردم» loses their order to this.
UPDATE orders
   SET expires_at = LEAST(
         expires_at,
         created_at + make_interval(mins => COALESCE(
           (SELECT CASE WHEN s.value #>> '{}' ~ '^[1-9][0-9]{0,3}$' THEN (s.value #>> '{}')::int END
              FROM settings s WHERE s.scope = 'pay' AND s.key = 'card_hold_minutes'),
           10)))
 WHERE status = 'AWAITING_PAYMENT'
   AND expires_at IS NOT NULL;

COMMIT;
