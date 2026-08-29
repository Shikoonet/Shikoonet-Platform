-- 0014_income_declined.sql
-- Reversible operator disposition for Income queue items.
-- Does NOT delete transaction_candidates or raw_sms_events.
-- Does NOT change processing_disposition (matching semantics unchanged).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS income_declined_transactions (
  id TEXT PRIMARY KEY,
  transaction_candidate_id TEXT NOT NULL UNIQUE
    REFERENCES transaction_candidates(id) ON DELETE CASCADE,
  declined_by TEXT NOT NULL,
  declined_at INTEGER NOT NULL,
  reason TEXT,
  restored_by TEXT,
  restored_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_income_declined_active
  ON income_declined_transactions(declined_at DESC)
  WHERE restored_at IS NULL;

CREATE TABLE IF NOT EXISTS dashboard_payment_event_reads (
  actor_email TEXT NOT NULL,
  event_key TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (actor_email, event_key)
);

CREATE INDEX IF NOT EXISTS idx_payment_event_reads_actor
  ON dashboard_payment_event_reads(actor_email, seen_at DESC);
