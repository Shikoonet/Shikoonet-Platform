-- 0067_trial_limit_has_a_row.sql — 2026-09-16.
--
-- «هر مشتری چند بار اکانت تست بگیرد» (#254) edits `setting.limit_usertest_all`
-- — and the settings screen edits rows, it never creates them. A shop that
-- was imported from Mirzabot has the row; the staging box restored from a
-- snapshot on 2026-09-16 did not, and the setting Sam asked for was nowhere
-- on the screen. Seeded at 1, which is the bot's own default
-- (`DEFAULT_SHOP_SETTINGS.trialQuotaPerUser`), so nothing changes on deploy.

BEGIN;

INSERT INTO settings (scope, key, value, updated_at, updated_by)
VALUES ('bot', 'limit_usertest_all', '1'::jsonb, now(), NULL)
ON CONFLICT (scope, key) DO NOTHING;

COMMIT;
