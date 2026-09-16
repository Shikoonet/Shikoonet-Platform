-- 0066_spam_limit_is_a_setting.sql — Sam, 2026-09-16.
--
-- «اسپم کردن دکمه در ربات تلگرام، این رو براش یک فکری بکن.»
--
-- The flood guard's limit (35 updates a minute, `index.php:317`) becomes
-- `setting.spam_limit_per_minute`. Seeded because the settings screen edits
-- rows and never creates them (0043, 0064 for the same reason): without this
-- row «حداکثر پیام یک مشتری در دقیقه» would have nothing to edit. The value
-- is the number the bot used until today, so nothing changes on deploy.

BEGIN;

INSERT INTO settings (scope, key, value, updated_at, updated_by)
VALUES ('bot', 'spam_limit_per_minute', '35'::jsonb, now(), NULL)
ON CONFLICT (scope, key) DO NOTHING;

COMMIT;
