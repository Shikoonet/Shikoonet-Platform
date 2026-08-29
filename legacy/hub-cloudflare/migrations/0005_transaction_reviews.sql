-- 0005_transaction_reviews.sql
--
-- Standalone review decisions for transaction_candidates.
--
-- Distinct from `reconciliation_matches`: matches resolve a tx against a
-- payment claim; reviews are about whether the transaction itself is
-- accepted or rejected (a user assertion about validity, not a match).
--
-- Idempotency: UNIQUE(transaction_candidate_id) — at most one reviewed
-- decision per transaction. The UI lets the user change their mind by
-- calling the endpoint again (which updates the row in place).
--
-- Reject transition also flips transaction_candidates.status to IGNORED
-- and removes the transaction from future matching runs (handled in the
-- endpoint, not at the DB layer; matches already-removed by the matcher
-- service skip IGNORED rows).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS transaction_reviews (
  id TEXT PRIMARY KEY,
  transaction_candidate_id TEXT NOT NULL UNIQUE
    REFERENCES transaction_candidates(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('ACCEPTED','REJECTED')),
  reviewed_by TEXT NOT NULL,
  reviewer_role TEXT NOT NULL CHECK (reviewer_role IN ('ADMIN','REVIEWER')),
  reason TEXT CHECK (reason IS NULL OR reason IN (
    'false_parse','duplicate','irrelevant','wrong_amount','other'
  )),
  comment TEXT,
  reviewed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trx_decision
  ON transaction_reviews(decision, reviewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trx_reviewed_by
  ON transaction_reviews(reviewed_by, reviewed_at DESC);
