-- 0029_card_queue_moves_on_money.sql — Sam, 2026-08-21.
--
-- "Put all thirty cards in a queue, and whichever card money is deposited into
-- goes to the back until its turn comes round again."
--
-- What was here before moved a card when it was SHOWN. The two are not the same
-- thing, because most checkouts are abandoned: the customer opens the payment
-- screen, sees the card, and never transfers. Under the old rule that cost the
-- card its turn anyway, so the cards that actually RECEIVED money were whichever
-- ones happened to land on a paying customer — and with a steady rate of
-- abandonment that is a fixed subset, not a rotation. Counted on a pool of 30
-- with two abandoned checkouts per payment, the money landed on 10 cards, three
-- times each, and the other 20 never saw a rial. That count is now a test
-- (`rotation.test.ts`, "spreads thirty payments over thirty cards").
--
-- ---------------------------------------------------------------------------
-- The queue is still `rotation_cursor`; it now has two speeds
-- ---------------------------------------------------------------------------
-- Assignment advances a card by ROTATION_STEP = 1,000,000 / weight, unchanged
-- and still in `apps/bot/src/payment.ts`. A deposit advances it by a thousand
-- times that. So being shown nudges a card, and being paid sends it a full lap
-- back — which is the queue Sam described, with an abandoned checkout costing
-- a card a thousandth of its turn instead of all of it.
--
-- Written as an increment rather than as "jump behind the current maximum",
-- which is what this was first drafted as. Jumping to the back of the line
-- makes `display_weight` meaningless: once a card is behind EVERY other card,
-- how far behind no longer changes the order, and the whole pool degenerates to
-- plain round-robin regardless of weight. Incrementing keeps the head admin's
-- 2026-08-13 ratio intact — a weight of 2 advances half as far per deposit and
-- so comes back around twice as often — and it needs no subquery, so two
-- deposits committing at the same instant cannot read the same maximum and land
-- on top of each other.
--
-- ---------------------------------------------------------------------------
-- Why a trigger and not five call sites
-- ---------------------------------------------------------------------------
-- A claim reaches VERIFIED from three places today — `mirzabotVerify.ts` twice
-- (auto-verification, and re-verification after a revert) and
-- `dashboard-worker/src/index.ts` once (an admin confirming a match) — and the
-- live PHP bot writes this same table from outside this repo entirely, against
-- the same physical cards. Holding the rule in application code means the day a
-- fourth path is added it silently does not rotate, and the symptom would be
-- exactly the imbalance above: slow, invisible, and only measurable after weeks
-- of takings. Postgres sees all of them.
--
-- ON UPDATE only, never ON INSERT. `packages/migrate` imports historical claims
-- straight in as VERIFIED, and firing for those would advance every card by one
-- lap per row of history — thousands of laps in whatever order the import
-- happened to run, which is no order at all.
--
-- A revert does NOT rewind the cursor: the WHEN clause fires on arrival at
-- VERIFIED, not on departure. Rewinding correctly would mean storing what the
-- cursor was before, and a reverted approval does not un-receive the money. The
-- card keeps its lap. Asserted in `rotation.test.ts` so it reads as a decision.
--
-- ponytail: no daily/monthly ceiling per card. Still the open question to the
-- head admin from 2026-08-13 (docs/STATUS.md). When it is answered it belongs
-- in the SELECT inside `rotateCard`, not here — a ceiling excludes a card from
-- being handed out, which is a different thing from where it sits in the queue.

BEGIN;

CREATE OR REPLACE FUNCTION card_to_back_of_queue() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- A claim carries the card as digits, not as a key: the record of where a
  -- customer was told to pay has to survive the card being removed. So this
  -- matches on `card_digits`, which is UNIQUE, and a claim naming a card that
  -- no longer exists — or naming none at all — updates nothing and is not an
  -- error. Losing the rotation on a deleted card is the correct outcome; there
  -- is no queue position to give back.
  UPDATE payment_cards
     SET rotation_cursor = rotation_cursor + 1000000000::bigint / display_weight
   WHERE card_digits = NEW.card_digits;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_card_to_back_of_queue
  AFTER UPDATE ON payment_claims
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM 'VERIFIED' AND NEW.status = 'VERIFIED')
  EXECUTE FUNCTION card_to_back_of_queue();

COMMIT;
