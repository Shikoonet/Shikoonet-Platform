-- «یادآوری تمدید» — the retention rules get their row.
--
-- Sam, 2026-09-20: first buyers paid for a starter; the real service costs
-- three or four times that, and the week around their first expiry is when
-- they decide. The rules that message them — which panel, how many days
-- before or after, only-one-service, which discount code, what text — are one
-- JSON array here, the same shape as ('shop','review_messages') in 0076: a
-- small list, edited whole on one screen, read once a cycle by the bot.
--
-- Inserted empty, because the settings route refuses to invent rows (0057)
-- and an absent row must read as «migration not run», not as «no rules».
BEGIN;

INSERT INTO settings (scope, key, value, updated_at, updated_by)
VALUES ('bot', 'retention_rules', '[]'::jsonb, now(), NULL)
ON CONFLICT (scope, key) DO NOTHING;

COMMIT;
