-- 0049 — the reports get their own topics, and the outbox learns to carry one.
--
-- Sam, 2026-09-03: one Telegram group with a topic per kind of report — «مثل
-- میرزا و فاکسیما». Both legacy bots do exactly this and neither uses separate
-- channels: there is ONE destination, `setting.Channel_Report`, and every
-- report is told apart by `message_thread_id`.
--
-- ## The ten names are not invented here
--
-- They are legacy's own `topicid.report` values, and `packages/migrate` has
-- been copying them into `settings(scope='bot', key='topic_<report>')` since
-- the importer was written — `migrate.ts:330`. On a database migrated from
-- MySQL the ten rows already exist and nothing has ever read them.
--
-- This seeds them where they are absent, which is every database that was not
-- migrated: the sim, a fresh install, CI. `ON CONFLICT DO NOTHING` so a
-- migrated database keeps the ids it already has — overwriting those with 0
-- would silently move every report back to the group's General topic.
--
-- ## `0` means «not configured», and that is legacy's own sentinel
--
-- `botapi.php:10` strips `message_thread_id` when it is `<= 0`, so an
-- unconfigured topic posts into General rather than failing. Ours does the
-- same, and it is why this can ship before anybody runs the setup: every report
-- keeps going exactly where it goes today until the topics are made.
--
-- ## Why a column and not a lookup at send time
--
-- `bot_notifications` is an outbox. The row is written by the producer, which
-- is the only thing that knows WHICH report this is; `flush` just sends what is
-- queued. Looking the topic up at send time would mean re-deriving the kind
-- from the body, and a settings change between queue and send would move a
-- message the producer had already decided the destination of.

BEGIN;

ALTER TABLE bot_notifications ADD COLUMN message_thread_id bigint;

COMMENT ON COLUMN bot_notifications.message_thread_id IS
  'Telegram forum topic. NULL for a private chat; a positive id for a report in a topic. Zero and negative are treated as unset, like legacy botapi.php.';

-- The ten legacy report kinds, all unconfigured. An operator points the bot at
-- a forum group and the setup route fills these in.
INSERT INTO settings (scope, key, value)
VALUES
  ('bot', 'topic_buyreport',     '0'::jsonb),
  ('bot', 'topic_otherservice',  '0'::jsonb),
  ('bot', 'topic_paymentreport', '0'::jsonb),
  ('bot', 'topic_otherreport',   '0'::jsonb),
  ('bot', 'topic_reporttest',    '0'::jsonb),
  ('bot', 'topic_errorreport',   '0'::jsonb),
  ('bot', 'topic_porsantreport', '0'::jsonb),
  ('bot', 'topic_reportnight',   '0'::jsonb),
  ('bot', 'topic_reportcron',    '0'::jsonb),
  ('bot', 'topic_backupfile',    '0'::jsonb)
ON CONFLICT (scope, key) DO NOTHING;

-- `Channel_Report` is where all ten live. Seeded empty rather than left absent
-- because `settingsRoutes` cannot INSERT a settings key — an unknown key is a
-- 404 — so without a row here the group could never be set from the panel.
INSERT INTO settings (scope, key, value)
VALUES ('bot', 'Channel_Report', '""'::jsonb)
ON CONFLICT (scope, key) DO NOTHING;

COMMIT;
