-- Account operational lifecycle (PENDING / ACTIVE / MUTED / DECLINED).
--
-- Source of truth for whether an account participates in Today, matching,
-- totals, reports, and exports. The existing `active` column stays as the
-- binary soft-delete flag (orthogonal to lifecycle): an `active = 0` row
-- is "removed from the system entirely" while a `status = MUTED` row is
-- "still tracked, just temporarily excluded from operational views".
--
-- DEFAULT 'ACTIVE' makes the existing rows ACTIVE on day-1 without a
-- separate UPDATE — D1 respects column defaults when ALTER TABLE adds
-- a NOT NULL column with a DEFAULT.
--
-- PENDING is the lifecycle for newly auto-discovered accounts. The
-- partial unique index on account_hint (idx_fa_unique_active_account_hint)
-- keeps working because all four statuses have `active = 1`.

ALTER TABLE financial_accounts
  ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('PENDING','ACTIVE','MUTED','DECLINED'));

-- Generic lookup index for the dashboard's status filter. Most production
-- queries will JOIN from transaction_candidates and filter on
-- fa.status = 'ACTIVE' — covered by the existing join — but the Accounts
-- review queue (PENDING only) and the Decimals view (each status) need
-- a fast status-only filter.
CREATE INDEX IF NOT EXISTS idx_fa_status ON financial_accounts(status);
