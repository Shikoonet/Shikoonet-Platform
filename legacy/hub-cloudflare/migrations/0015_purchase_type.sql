-- 0015_purchase_type.sql
-- Adds authoritative NEW_PURCHASE / RENEWAL classification columns to payment_claims.
--
-- Renamed from migrations-dev/0001_purchase_type.sql when the dev and prod
-- migration lineages were merged into this single directory. Dev already has
-- these columns; prod gets them on the next production release, at which point
-- ENABLE_PURCHASE_TYPE can be turned on in apps/dashboard-worker/wrangler.toml.
-- Source values are populated by a one-shot backfill from Mirzabot MySQL
-- (Payment_report.id_invoice ⇒ steppay prefix) and by future Mirzabot claim
-- payload extension (operationType / purchaseType).
--
-- Backfill history: see .production-backups/dashboard-before-dev-20260810T064246Z/
-- Phase-3 decision: option D — schema change for future + one-shot backfill for historical.
--
-- Why two columns:
--   operation_type = raw Mirzabot step (getconfigafterpay, getextenduser, ...)
--                    Nullable for legacy claims that pre-date the integration.
--   purchase_type  = stable business classification:
--                      NEW_PURCHASE  (getconfigafterpay)
--                      RENEWAL       (getextenduser | getextratimeuser | getextravolumeuser)
--                      UNKNOWN       (anything else, or NULL operation_type)
--                    Used by the Dashboard UI.
--
-- Reader tolerance: UNKNOWN is a closed set; existing readers never branch on
-- these new columns, so adding them is safe.

PRAGMA foreign_keys = ON;

ALTER TABLE payment_claims ADD COLUMN operation_type TEXT;
ALTER TABLE payment_claims ADD COLUMN purchase_type  TEXT
  CHECK (purchase_type IS NULL OR purchase_type IN ('NEW_PURCHASE', 'RENEWAL', 'UNKNOWN'));

CREATE INDEX IF NOT EXISTS idx_claim_purchase_type
  ON payment_claims(purchase_type);

CREATE INDEX IF NOT EXISTS idx_claim_operation_type
  ON payment_claims(operation_type);
