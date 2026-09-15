-- 0064_cards_queue_like_a_bakery.sql — Sam, 2026-09-15.
--
-- «یک صف درست کنیم مثل نانوایی، هر کی نان گرفت بره انتهای صف.»
--
-- Three rules, and this migration is the schema half of them; the picker in
-- `apps/bot/src/payment.ts` (`rotateCard`) is the other half.
--
--   1. Only a live card is in the line — card ACTIVE, account on. Unchanged.
--   2. A card that took money goes to the BACK of the line. Not "a lap further
--      along a weighted clock", as 0029 had it: the back. `display_weight` is
--      gone with that — in a plain queue there is nothing for a weight to
--      divide, and a knob that no longer does anything is a lie on the screen.
--   3. A card handed to an invoice is out of the line for a while — ten
--      minutes unless the operator sets `pay/card_hold_minutes` on the
--      settings screen — and for as long as the customer says they paid and
--      nobody has settled it. That needs no column: the open `payments` row IS
--      the lease (created when the card is shown, closed by PAID / REJECTED /
--      EXPIRED), and the picker reads it. What it needs is an index to read
--      it by card, and a settings row to read the length from.
--
-- The queue position is still `rotation_cursor`, now a ticket number from a
-- sequence rather than an accumulated clock. `nextval` is one token, cannot
-- collide when two deposits commit in the same instant, and needs no
-- `MAX(...)` subquery in the create and re-enable routes, which is where the
-- old design kept tripping (a card seeded at zero took every checkout). The
-- sequence starts above every cursor already written, so the line existing
-- cards are standing in today is kept as it is.

BEGIN;

CREATE SEQUENCE payment_card_queue_seq AS bigint;
SELECT setval(
  'payment_card_queue_seq',
  GREATEST(COALESCE((SELECT MAX(rotation_cursor) FROM payment_cards), 0), 1)
);

ALTER TABLE payment_cards DROP COLUMN display_weight;

-- Same trigger as 0029 (ON UPDATE only, fires on arrival at VERIFIED, matched
-- by digits because a claim outlives its card); only the move changed.
CREATE OR REPLACE FUNCTION card_to_back_of_queue() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE payment_cards
     SET rotation_cursor = nextval('payment_card_queue_seq')
   WHERE card_digits = NEW.card_digits;
  RETURN NULL;
END;
$$;

-- «Is this card in somebody's hands right now» — one lookup per card in the
-- picker, on a table that is mostly closed rows.
CREATE INDEX idx_payments_open_by_card
  ON payments(assigned_card_number)
  WHERE status IN ('PENDING', 'AWAITING_REVIEW');

-- Seeded, not left absent: the settings route updates rows and never inserts
-- one, so without this the screen would have nothing to edit. The same reason
-- 0043 seeded `continuity_mode`.
INSERT INTO settings (scope, key, value, updated_at, updated_by)
VALUES ('pay', 'card_hold_minutes', '10'::jsonb, now(), NULL)
ON CONFLICT (scope, key) DO NOTHING;

COMMIT;
