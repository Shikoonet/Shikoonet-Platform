-- 0092 — a referrer is paid on the first purchase AND on every renewal.
--
-- Sam, 2026-09-22: «زیرمجموعه‌هاشون هر زمان خرید اول کردن 30 % به کیف پولشون
-- بریزه، و هر زمان تمدید کردن 10 %. این اعداد رو بشه در تنظیمات داشبورد
-- مشخص کرد». Until today one rate paid, `bot/affiliatespercentage`, on the
-- first purchase only — 10, carried over from the PHP bot.
--
-- Both rows are upserted rather than updated: the settings route edits rows
-- and never inserts one (settingsRoutes.ts), and a database that was never
-- imported from Mirzabot has no `affiliatespercentage` row at all — its
-- screen would have nothing to edit. The value is a JSON string, the shape
-- the settings route itself writes.

BEGIN;

INSERT INTO settings (scope, key, value, updated_at, updated_by)
VALUES ('bot', 'affiliatespercentage', '"30"'::jsonb, now(), NULL),
       ('bot', 'affiliatespercentage_renewal', '"10"'::jsonb, now(), NULL)
ON CONFLICT (scope, key)
  DO UPDATE SET value = EXCLUDED.value, updated_at = now();

COMMIT;
