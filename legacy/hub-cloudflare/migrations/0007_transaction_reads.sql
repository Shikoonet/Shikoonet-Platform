-- 0007_transaction_reads.sql
--
-- Per-row read state for the dashboard's "NEW" indicator. The bell uses
-- `dashboard_notification_state` (a global cursor) to decide the aggregate
-- "new" count, but a user can also mark a single transaction as seen
-- without advancing the cursor for everything past it. This table holds
-- those explicit per-row reads.
--
-- Definition of `is_new` for a transaction row:
--   is_new = (tx.bank_timestamp, tx.id) is past the actor's global cursor
--        AND no row exists in this table for (actor_email, tx.id)
--
-- A row is removed from "new" by EITHER a per-row mark-seen OR a global
-- mark-all-read. The two layers are additive.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS dashboard_transaction_reads (
  actor_email TEXT NOT NULL,
  transaction_candidate_id TEXT NOT NULL
    REFERENCES transaction_candidates(id) ON DELETE CASCADE,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (actor_email, transaction_candidate_id)
);

-- Used by GET /api/v1/notifications/seen-ids — list everything an actor
-- has ever marked seen, newest first. Bounded in practice by the actor's
-- active sessions, but the index keeps the lookup cheap.
CREATE INDEX IF NOT EXISTS idx_dtr_actor_time
  ON dashboard_transaction_reads(actor_email, seen_at DESC);