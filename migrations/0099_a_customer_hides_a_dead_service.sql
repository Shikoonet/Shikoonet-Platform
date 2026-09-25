-- 0099_a_customer_hides_a_dead_service.sql — 2026-09-25.
--
-- «سرویس‌های من» lists every service a customer ever had, dead ones included:
-- expired, used up, removed from the panel, failed. A reseller has dozens, and
-- the live ones drown. Sam, 2026-09-25: the customer may take a dead one off
-- their own list.
--
-- A timestamp on the row, not a status. The service is still what it was —
-- EXPIRED or REMOVED stays true — and every sweep that reads `status`
-- (remove.ts, sync.ts, the dashboard) must keep seeing it exactly as before.
-- Only the customer's own screens read this column (apps/bot/src/owned.ts,
-- and the retention audience, so a dismissed service is not nudged).
--
-- NOTHING ON THE PANEL IS TOUCHED. NULL on every existing row.
-- Undo for one row: UPDATE subscriptions SET hidden_at = NULL WHERE id = …;
-- Undo entirely:    ALTER TABLE subscriptions DROP COLUMN hidden_at;

BEGIN;

ALTER TABLE subscriptions ADD COLUMN hidden_at timestamptz;

COMMENT ON COLUMN subscriptions.hidden_at IS
  'When the customer took this dead service off «سرویس‌های من» (bot «🗑 حذف از فهرست»). NULL = listed. The panel is not touched.';

COMMIT;
