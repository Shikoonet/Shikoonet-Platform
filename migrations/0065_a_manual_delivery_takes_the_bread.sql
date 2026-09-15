-- 0065_a_manual_delivery_takes_the_bread.sql — Sam, 2026-09-15.
--
-- «اگر دستی تایید کنم یعنی بله، باید ته صف بره.»
--
-- 0029/0064 moved a card to the back of the line when its claim reached
-- VERIFIED — the moment the bank SMS is matched. But an operator who presses
-- «تأیید و تحویل دستی», or continuity mode, delivers BEFORE that SMS arrives:
-- the claim goes to FULFILLED_UNRECONCILED and sits there for hours, and the
-- card stayed at the front of the line the whole time. Seen live on staging
-- the day 0064 shipped: card 4444 delivered by hand, still «نوبت ۱».
--
-- The operator saw the money (a receipt, a screenshot); that is the bread. So
-- the card takes its ticket on arrival at EITHER status, and only on the
-- first of them: a claim that goes FULFILLED_UNRECONCILED → VERIFIED when the
-- SMS finally reconciles has already moved, and moving it again would push
-- it behind cards that took money after it.

BEGIN;

DROP TRIGGER trg_card_to_back_of_queue ON payment_claims;
CREATE TRIGGER trg_card_to_back_of_queue
  AFTER UPDATE ON payment_claims
  FOR EACH ROW
  WHEN (OLD.status NOT IN ('VERIFIED', 'FULFILLED_UNRECONCILED')
        AND NEW.status IN ('VERIFIED', 'FULFILLED_UNRECONCILED'))
  EXECUTE FUNCTION card_to_back_of_queue();

COMMIT;
