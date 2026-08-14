-- ---------------------------------------------------------------------------
-- 0013 — an audit row can name a Telegram admin
--
-- `audit_logs` was written for the dashboard, where an actor is an email out of
-- Cloudflare Access. The bot's admins are Telegram accounts and have no email,
-- and writing one in would be a lie in a table whose whole purpose is being
-- believed later. So they get their own column.
--
-- The table stays append-only: `trg_audit_logs_append_only` (0005) already
-- refuses UPDATE and DELETE, and adding a column does not weaken that.
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE audit_logs ADD COLUMN actor_telegram_id bigint;

COMMENT ON COLUMN audit_logs.actor_telegram_id IS
  'Set instead of actor_email when the action came from the bot''s admin panel';

CREATE INDEX idx_audit_logs_actor_telegram
  ON audit_logs (actor_telegram_id, created_at DESC)
  WHERE actor_telegram_id IS NOT NULL;

COMMIT;
