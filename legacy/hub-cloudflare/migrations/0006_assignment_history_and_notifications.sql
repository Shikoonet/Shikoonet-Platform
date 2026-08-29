-- 0006_assignment_history_and_notifications.sql
--
-- Two tables for the auto-assignment + notification-bell work:
--
-- 1. transaction_account_assignments
--    Append-only history of which account a transaction was assigned to,
--    and *why*. The current assignment is the latest row with `active = 1`
--    for a given transaction_candidate_id. Manual assignments are NEVER
--    overwritten by AUTO_IDENTIFIER writes — the write path enforces that.
--
--    Replaces the implicit "what's in transaction_candidates.financial_account_id"
--    with a first-class source-of-truth. Reads (Today / Matches / Unmatched)
--    still join via financial_account_id for the display name + display
--    formatting, but the *origin* of the assignment comes from this table.
--
-- 2. dashboard_notification_state
--    Per-actor read state for the notification bell. The bell shows total
--    counts (new / unassigned / unmatched / suggested) and which counts the
--    user has already seen.
--
-- Both tables are idempotent (CREATE TABLE IF NOT EXISTS) so the migration
-- can be re-applied without error.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1. transaction_account_assignments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transaction_account_assignments (
  id TEXT PRIMARY KEY,
  transaction_candidate_id TEXT NOT NULL
    REFERENCES transaction_candidates(id) ON DELETE CASCADE,
  financial_account_id TEXT
    REFERENCES financial_accounts(id) ON DELETE SET NULL,
  -- Provenance. Determines whether the next auto-assignment run can
  -- overwrite this row.
  assignment_source TEXT NOT NULL CHECK (assignment_source IN (
    'AUTO_IDENTIFIER',     -- resolved from detected SMS identifier
    'MANUAL',              -- set by an admin via the Change Account modal
    'HISTORICAL_BACKFILL', -- bulk link from a known (type, value) pair
    'ACCOUNT_MERGE'        -- moved when a source account was merged into this target
  )),
  -- Identifier that drove the assignment (NULL for MANUAL / ACCOUNT_MERGE).
  identifier_type TEXT CHECK (identifier_type IS NULL OR identifier_type IN (
    'ACCOUNT_NUMBER', 'CARD_LAST_FOUR', 'IBAN', 'ACCOUNT_HINT'
  )),
  normalized_identifier TEXT,
  -- Who is responsible for this assignment row.
  assigned_by TEXT NOT NULL,            -- email or 'SYSTEM' for AUTO_IDENTIFIER / MERGE
  assigned_at INTEGER NOT NULL,
  -- Replace chain: when a MANUAL row is replaced by merge, this points to
  -- the previous active row so we can reconstruct the history.
  replaced_assignment_id TEXT
    REFERENCES transaction_account_assignments(id) ON DELETE SET NULL,
  -- 1 for the currently-active assignment; 0 for historical rows that
  -- have been superseded. Partial unique index ensures exactly one active
  -- row per transaction.
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_taa_tx
  ON transaction_account_assignments(transaction_candidate_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS idx_taa_account
  ON transaction_account_assignments(financial_account_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS idx_taa_source
  ON transaction_account_assignments(assignment_source, assigned_at DESC);
CREATE INDEX IF NOT EXISTS idx_taa_identifier
  ON transaction_account_assignments(identifier_type, normalized_identifier);

-- One active assignment per transaction. Historical (replaced) rows are
-- allowed to coexist at active = 0.
CREATE UNIQUE INDEX IF NOT EXISTS idx_taa_one_active_per_tx
  ON transaction_account_assignments(transaction_candidate_id)
  WHERE active = 1;

-- ---------------------------------------------------------------------------
-- 2. dashboard_notification_state
-- ---------------------------------------------------------------------------
-- Per-actor cursor so the notification bell can show "what's new".
-- Used to compute the "unread" badge: total counts minus what the user
-- has already seen. Tracked as a pair (timestamp, id) so an event landing
-- between two polls is unambiguously "new" once it crosses the cursor.
CREATE TABLE IF NOT EXISTS dashboard_notification_state (
  actor_email TEXT PRIMARY KEY,
  last_seen_transaction_at INTEGER,
  last_seen_transaction_id TEXT,
  updated_at INTEGER NOT NULL
);
