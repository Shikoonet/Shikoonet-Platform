-- 0008_account_assignment_previews.sql
--
-- Staged "Re-run account assignment" flow.
--
-- Two tables power the per-account, staged preview/apply/decline workflow
-- that replaces the old global "Rerun matching" button. The flow:
--
--   1. POST /api/v1/accounts/:accountId/rerun-assignment-preview
--      -> Build a proposal of candidate transactions against this
--         account's configured identifiers. Bucket each candidate into
--         WILL_ASSIGN, WILL_REPAIR_HISTORY, ALREADY_CORRECT,
--         AMBIGUOUS, or SKIPPED_MANUAL. Insert one row per candidate
--         plus a header row that holds counts + 30-minute expiry.
--      -> NO mutation on transaction_account_assignments yet.
--
--   2. POST /api/v1/accounts/:accountId/rerun-assignment/:previewId/apply
--      -> For each item the user selected, route through
--         assignAccountForTx with source='HISTORICAL_BACKFILL'. Re-validates
--         each candidate's current DB state; per-item divergence is
--         recorded as SKIPPED_STATE_CHANGED. Writes one audit_logs row
--         at the end. Sets preview status='APPLIED'.
--      -> MANUAL/ACCOUNT_MERGE active rows are NEVER touched by
--         assignAccountForTx (enforced by the shared write helper, not
--         this migration).
--
--   3. POST /api/v1/accounts/:accountId/rerun-assignment/:previewId/decline
--      -> Single UPDATE flipping status to 'DECLINED'. NO mutations on
--         transactions, identifiers, or assignment history.
--
-- Both tables are idempotent (CREATE TABLE IF NOT EXISTS) so the migration
-- can be re-applied without error.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1. account_assignment_previews
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_assignment_previews (
  id TEXT PRIMARY KEY,
  financial_account_id TEXT NOT NULL
    REFERENCES financial_accounts(id) ON DELETE CASCADE,
  -- RBAC: the actor_email who created the preview. Apply/Decline both
  -- scope on actor_email to prevent cross-user preview collisions.
  actor_email TEXT NOT NULL,
  -- OPEN until the user clicks Apply/Decline or the 30-minute timer
  -- elapses (background sweep not required; expiry is enforced at Apply
  -- time by comparing expires_at < now).
  status TEXT NOT NULL CHECK (status IN ('OPEN','APPLIED','DECLINED','EXPIRED')),
  -- Snapshot of the account's configured identifiers at preview time.
  -- Used to detect "another admin edited this account between preview
  -- and apply" — diverging snapshots invalidate Apply with 409.
  account_snapshot_json TEXT NOT NULL,
  -- Aggregated counts surfaced in the modal. Written on build, never
  -- mutated thereafter.
  counts_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  -- Result counts after Apply. NULL while OPEN. Set when status flips
  -- to APPLIED. The audit row's after_json mirrors this object.
  result_json TEXT,
  applied_at INTEGER,
  declined_at INTEGER,
  -- Audit linkage: if a preview reaches APPLIED, this is the audit_logs
  -- row id we wrote. Optional (Apply may complete without audit if the
  -- audit insert itself fails, which is surfaced as a warning).
  audit_log_id TEXT
    REFERENCES audit_logs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_aap_account
  ON account_assignment_previews(financial_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aap_actor_status
  ON account_assignment_previews(actor_email, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aap_expires
  ON account_assignment_previews(expires_at)
  WHERE status = 'OPEN';

-- ---------------------------------------------------------------------------
-- 2. account_assignment_preview_items
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_assignment_preview_items (
  id TEXT PRIMARY KEY,
  preview_id TEXT NOT NULL
    REFERENCES account_assignment_previews(id) ON DELETE CASCADE,
  transaction_candidate_id TEXT NOT NULL
    REFERENCES transaction_candidates(id) ON DELETE CASCADE,
  -- Disposition bucket (see packages/domain/src/assignmentPreview.ts):
  --   WILL_ASSIGN           -> NULL-account tx; will get HISTORICAL_BACKFILL row
  --   WILL_REPAIR_HISTORY   -> active row on a DIFFERENT account; will swap to this account
  --   ALREADY_CORRECT       -> active row already points at this account
  --   AMBIGUOUS             -> identifier resolves to multiple active accounts
  --   SKIPPED_MANUAL        -> active row is MANUAL or ACCOUNT_MERGE; NEVER touched
  --   SKIPPED_STATE_CHANGED -> set on Apply when the DB state diverged since preview
  disposition TEXT NOT NULL CHECK (disposition IN (
    'WILL_ASSIGN','WILL_REPAIR_HISTORY','ALREADY_CORRECT',
    'AMBIGUOUS','SKIPPED_MANUAL','SKIPPED_STATE_CHANGED'
  )),
  -- Identifier that drove the match (NULL for AMBIGUOUS / ALREADY_CORRECT / SKIPPED_MANUAL / SKIPPED_STATE_CHANGED).
  identifier_type TEXT,
  normalized_identifier TEXT,
  -- Snapshot of the row's state at preview time. Captured so Apply can
  -- detect divergence without trusting the live DB blindly.
  current_account_id TEXT,
  current_assignment_source TEXT,
  tx_snapshot_json TEXT NOT NULL,
  -- Whether the user selected this item. Default 0; the build helper
  -- sets 1 for WILL_ASSIGN / WILL_REPAIR_HISTORY and 0 for AMBIGUOUS.
  -- ALREADY_CORRECT / SKIPPED_MANUAL are not stored as items.
  selected INTEGER NOT NULL DEFAULT 0,
  -- Outcome after Apply. NULL until Apply completes.
  applied_disposition TEXT,
  applied_assignment_id TEXT
    REFERENCES transaction_account_assignments(id) ON DELETE SET NULL,
  -- One item row per (preview, transaction). The preview is rebuilt
  -- fresh on every click, so duplicates across previews are allowed.
  UNIQUE (preview_id, transaction_candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_aapi_preview_disposition
  ON account_assignment_preview_items(preview_id, disposition);
CREATE INDEX IF NOT EXISTS idx_aapi_tx
  ON account_assignment_preview_items(transaction_candidate_id);