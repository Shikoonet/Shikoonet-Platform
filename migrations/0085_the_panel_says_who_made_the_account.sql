-- «یادآوری تمدید» picks its audience by the panel admin who made the
-- account, not by our provider row.
--
-- Sam, 2026-09-20: «دسته‌بندی بر اساس یوزرنیم پنل‌ها باشه». On the
-- PasarGuard every account carries the admin that created it
-- (`UserResponse.admin.username`), and that is the line between a
-- «mirza-first-buy» customer and everybody else — a line our own
-- `provider_id` does not draw for the accounts the import brought over. The
-- sync sweep already reads every account; from this migration it writes the
-- admin down here too, so a rule can ask for it without another panel call.
--
-- Nullable: filled by the next sync, absent on providers whose panel does
-- not say (manual, shelves).
--
-- No index, on purpose. The runner wraps every file in a transaction, so a
-- CREATE INDEX here would take a SHARE lock on `subscriptions` while the
-- still-running bot writes to it — and the readers narrow on
-- `idx_subs_expiring` first and then on this column, over a table of a few
-- thousand rows. An index that saves nothing is not worth a lock that could
-- stall a sync. (CodeRabbit on #393.)
BEGIN;

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS panel_admin text;
COMMENT ON COLUMN subscriptions.panel_admin IS
  'The panel admin that owns this account, as the panel reports it on sync. NULL when it does not say.';

COMMIT;
