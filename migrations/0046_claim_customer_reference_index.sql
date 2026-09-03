-- «این آی‌دی تلگرام چند بار و به کدام کارت‌ها واریز داشته» — Sam, 2026-09-02.
--
-- `payment_claims.card_digits` has had `idx_claim_card_digits` since the card
-- filter was first needed. `customer_reference` — which is where the claim
-- keeps the Telegram id — has never had one, because until now nothing
-- filtered on it: it was projected onto the screen and read, never searched.
--
-- Not covering, deliberately. The payments list orders by
-- `COALESCE(paid_clicked_at, created_at)` and that expression is not a column,
-- so an index carrying it would have to be an expression index that every
-- other query pays to maintain and none of them uses. A customer's claims are
-- tens of rows, not thousands; the sort is cheap once the scan is not.
CREATE INDEX IF NOT EXISTS idx_claim_customer_reference
  ON payment_claims (customer_reference);
