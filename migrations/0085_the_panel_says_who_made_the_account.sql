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
BEGIN;

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS panel_admin text;
COMMENT ON COLUMN subscriptions.panel_admin IS
  'The panel admin that owns this account, as the panel reports it on sync. NULL when it does not say.';

CREATE INDEX IF NOT EXISTS idx_subs_panel_admin ON subscriptions(panel_admin)
  WHERE panel_admin IS NOT NULL;

COMMIT;
