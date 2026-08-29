-- 0012_claim_card_digits.sql
-- Persist the Mirzabot card the customer was shown on the claim itself.
--
-- Without this the card→account resolution could only happen once, at claim
-- creation. A claim created before its card was mapped (UNMAPPED_CARD) could
-- never recover, because nothing remembered which card to resolve later.

ALTER TABLE payment_claims ADD COLUMN card_digits TEXT;

CREATE INDEX IF NOT EXISTS idx_claim_card_digits ON payment_claims(card_digits);
