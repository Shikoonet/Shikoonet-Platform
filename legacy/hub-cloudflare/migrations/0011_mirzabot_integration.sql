-- 0011_mirzabot_integration.sql
-- Mirzabot TEST integration: payment card mapping, claim timing, suspects, idempotency.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS payment_cards (
  id TEXT PRIMARY KEY,
  financial_account_id TEXT NOT NULL REFERENCES financial_accounts(id) ON DELETE CASCADE,
  card_digits TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (card_digits)
);
CREATE INDEX IF NOT EXISTS idx_payment_cards_account ON payment_cards(financial_account_id);

CREATE TABLE IF NOT EXISTS integration_events (
  event_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_order_id TEXT,
  processed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_integration_events_order ON integration_events(external_order_id);

ALTER TABLE payment_claims ADD COLUMN paid_clicked_at INTEGER;
ALTER TABLE payment_claims ADD COLUMN receipt_submitted_at INTEGER;
ALTER TABLE payment_claims ADD COLUMN suspect_reason TEXT;
ALTER TABLE payment_claims ADD COLUMN suspect_metadata_json TEXT NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX IF NOT EXISTS idx_match_one_auto_per_tx
  ON reconciliation_matches(transaction_candidate_id)
  WHERE status IN ('CONFIRMED', 'AUTO_VERIFIED');

CREATE UNIQUE INDEX IF NOT EXISTS idx_match_one_auto_per_claim
  ON reconciliation_matches(payment_claim_id)
  WHERE status IN ('CONFIRMED', 'AUTO_VERIFIED');
