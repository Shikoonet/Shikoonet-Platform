-- «یادآوری تمدید» — the retention rules get their row.
--
-- Sam, 2026-09-20: first buyers paid for a starter; the real service costs
-- three or four times that, and the week around their first expiry is when
-- they decide. The rules that message them — which panel, how many days
-- before or after, only-one-service, which discount code, what text — are one
-- JSON array here, the same shape as ('shop','review_messages') in 0076: a
-- small list, edited whole on one screen, read once a cycle by the bot.
--
-- Inserted empty so a fresh database shows the screen with its row in
-- place. The route upserts rather than refusing an absent row (unlike the
-- cron switches in 0057): the bot reads absent and empty the same way, and
-- `seed:sim` truncates `settings` to three keys, so a refusal would put an
-- error box on the screen in every CI browser walk.
BEGIN;

INSERT INTO settings (scope, key, value, updated_at, updated_by)
VALUES ('bot', 'retention_rules', '[]'::jsonb, now(), NULL)
ON CONFLICT (scope, key) DO NOTHING;

COMMIT;
