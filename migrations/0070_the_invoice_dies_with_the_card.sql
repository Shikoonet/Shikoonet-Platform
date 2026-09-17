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

COMMIT;
