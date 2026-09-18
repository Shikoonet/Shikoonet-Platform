-- 0074_the_line_moves_when_the_sms_lands.sql — issue #304, 2026-09-18.
--
-- Five deposits in twelve minutes on one card, three in ten on another, while
-- five other cards stood free. Production, 2026-09-18 morning.
--
-- 0064 says «a card leaves the front of the line only when money lands on
-- it». What it built was «when a CLAIM is verified» — and between the two lie
-- the relay phone (three of those SMS reached the server eleven minutes
-- late), the customer's «پرداخت کردم» press, and the matcher's cron. Every
-- checkout opened in that gap was handed the same front card, and a deposit
-- nobody ever claimed never moved the card at all.
--
-- Money lands as a CREDIT row in `transaction_candidates`. That is the
-- bread, so that is where the ticket is drawn now: an actionable credit on
-- an account sends every card of that account to the back of the line the
-- instant ingest writes it. The claim trigger stays for the two cases with
-- no SMS behind them — a hand delivery (0065) and a verification the
-- operator typed in with no transaction — and steps aside when a consuming
-- match shows the SMS already moved the card, so one deposit is one ticket.
--
-- A hand delivery whose SMS arrives hours later now moves twice: once at
-- delivery, once at the SMS. 0065 avoided that second ticket on purpose;
-- here it is accepted, because the alternative is a trigger that guesses
-- which claim an SMS belongs to, which is the matcher's job. In continuity
-- mode the late batch reshuffles the line in deposit order — a permutation,
-- not a pile-up.
--
-- ON INSERT, unlike the claim trigger 0029 kept ON UPDATE so that
-- `packages/migrate` writing history as VERIFIED would not reorder every
-- card. A transaction import would reorder the line once, in deposit order —
-- a shuffle, not a loss — and the D1 import already ran on production
-- (2026-09-08). A deposit that was already in the table when this ran and
-- is matched afterwards draws no ticket: the SMS trigger never saw it and
-- the claim trigger defers to the match. A handful of rows, once.

BEGIN;

CREATE OR REPLACE FUNCTION account_cards_to_back_of_queue() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- `UPDATE OF financial_account_id` also fires when the column is written
  -- with the value it already had; only a real reassignment is a deposit.
  IF TG_OP = 'UPDATE' AND OLD.financial_account_id IS NOT DISTINCT FROM NEW.financial_account_id THEN
    RETURN NULL;
  END IF;
  UPDATE payment_cards
     SET rotation_cursor = nextval('payment_card_queue_seq')
   WHERE financial_account_id = NEW.financial_account_id;
  RETURN NULL;
END;
$$;

-- The SMS names the account, not the card, and ingest resolves it on insert
-- (or the operator does later, on the transaction screen — the UPDATE half).
CREATE TRIGGER trg_account_cards_to_back_of_queue
  AFTER INSERT OR UPDATE OF financial_account_id ON transaction_candidates
  FOR EACH ROW
  WHEN (NEW.direction = 'CREDIT'
        AND NEW.financial_account_id IS NOT NULL
        AND NEW.processing_disposition = 'ACTIONABLE')
  EXECUTE FUNCTION account_cards_to_back_of_queue();

-- Same trigger as 0065 (ON UPDATE, first arrival at VERIFIED or
-- FULFILLED_UNRECONCILED); the function now asks whether the SMS trigger
-- already drew this deposit's ticket. `mirzabotVerify` and the approve route
-- both write the match before the claim, so the row is there to see.
CREATE OR REPLACE FUNCTION card_to_back_of_queue() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM reconciliation_matches m
      JOIN transaction_candidates t ON t.id = m.transaction_candidate_id
     WHERE m.payment_claim_id = NEW.id
       AND m.status IN ('CONFIRMED', 'AUTO_VERIFIED')
       AND t.direction = 'CREDIT'
       AND t.financial_account_id IS NOT NULL
       AND t.processing_disposition = 'ACTIONABLE'
  ) THEN
    RETURN NULL;
  END IF;
  UPDATE payment_cards
     SET rotation_cursor = nextval('payment_card_queue_seq')
   WHERE card_digits = NEW.card_digits;
  RETURN NULL;
END;
$$;

COMMIT;
