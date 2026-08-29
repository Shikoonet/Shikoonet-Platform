-- 0013_resellers.sql
-- Reseller income classification (Payment Hub only; Mirzabot untouched).
--
-- Classified CREDIT transactions are marked processing_disposition = 'ADMIN_EXCLUDED'
-- so ingest matching (ACTIONABLE-only queries) excludes them without an ingest deploy.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS resellers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reseller_transactions (
  id TEXT PRIMARY KEY,
  transaction_candidate_id TEXT NOT NULL UNIQUE
    REFERENCES transaction_candidates(id) ON DELETE CASCADE,
  reseller_id TEXT NOT NULL REFERENCES resellers(id),
  classified_by TEXT NOT NULL,
  classified_at INTEGER NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reseller_tx_reseller
  ON reseller_transactions(reseller_id, classified_at DESC);

CREATE INDEX IF NOT EXISTS idx_reseller_tx_classified
  ON reseller_transactions(classified_at DESC);
