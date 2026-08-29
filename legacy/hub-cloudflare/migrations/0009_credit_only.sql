-- 0009_credit_only.sql
--
-- Convert the product to CREDIT-only.
--
-- Rule:
--   Only transactions with `direction = 'CREDIT' AND processing_disposition =
--   'ACTIONABLE'` are actionable. `raw_sms_events` is preserved for all
--   directions; the rest of the product (Today, Unmatched, Suggested,
--   Unassigned, Reviewed, account totals, account references, notifications,
--   Re-run matching, Re-run account assignment, backfill, manual assign
--   lists, reconciliation matching) must filter on the canonical predicate.
--
-- `processing_disposition`:
--   ACTIONABLE         — current state for new CREDIT rows. Eligible for
--                        every product workflow.
--   OUTGOING_IGNORED   — incoming SMS that parsed as DEBIT (outgoing
--                        withdrawal / fee / purchase) and was excluded by
--                        ingest. Also the day-1 backfill target for any
--                        pre-existing DEBIT or UNKNOWN row.
--   ADMIN_EXCLUDED     — set by the cleanup tool for DEBIT rows that have a
--                        confirmed match, open suggested match, or payment
--                        claim relationship. Never auto-deletes the
--                        underlying data — only marks the disposition so the
--                        UI hides it and a human can review.
--
-- This migration is idempotent. The test harness catches
-- "duplicate column name" so the second column-add is a no-op for tests;
-- D1 only applies this file once in production.

PRAGMA foreign_keys = ON;

-- 1. Add the column. Re-running this migration on a database that already
--    has the column raises `duplicate column name`, which is tolerated at
--    the application layer (scripts/apply-0009-if-missing.ts) — D1 does not
--    support `ADD COLUMN IF NOT EXISTS`. The check below is a no-op once
--    the column is present.
ALTER TABLE transaction_candidates
  ADD COLUMN processing_disposition TEXT NOT NULL DEFAULT 'ACTIONABLE'
    CHECK (processing_disposition IN ('ACTIONABLE','OUTGOING_IGNORED','ADMIN_EXCLUDED'));

-- 2. Partial index for the canonical predicate. `IF NOT EXISTS` makes the
--    CREATE idempotent for re-runs on a partially-applied DB.
CREATE INDEX IF NOT EXISTS idx_tx_actionable
  ON transaction_candidates(processing_disposition, direction, bank_timestamp DESC)
  WHERE processing_disposition = 'ACTIONABLE';

-- 3. Backfill: every non-CREDIT row that is currently ACTIONABLE becomes
--    OUTGOING_IGNORED. Idempotent — the WHERE filters on the source value.
UPDATE transaction_candidates
   SET processing_disposition = 'OUTGOING_IGNORED'
 WHERE direction <> 'CREDIT'
   AND processing_disposition = 'ACTIONABLE';