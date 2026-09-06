-- The sweeps had no switches, and two of them did not exist.
--
-- Every automatic thing this bot does runs inside the poll loop with its
-- cadence and its thresholds compiled in. Three numbers were readable from
-- `settings` (`daywarn`, `volumewarn`, `on_hold_day`); nothing else was, and
-- no sweep had an off switch at all. An admin could not stop the shop warning
-- customers, could not change how long an unpaid invoice is held, and had
-- nowhere to see what was running.
--
-- This inserts the rows the panel edits. No new table: a switch is a boolean
-- and a threshold is a number, and `settings` already holds both, keyed by
-- (scope, key), with an audit trail on every write.
--
-- ## Why an INSERT is needed at all
--
-- `settingsRoutes.ts` deliberately refuses to create a row that does not
-- exist — `if (!before) return 404 unknown_setting`. That refusal is right:
-- the bot reads a fixed set of keys and an invented one is a row nothing
-- reads. It does mean every new key has to arrive by migration, which is this
-- file.
--
-- ## Where the values come from — the legacy's own answers, not defaults
--
-- Mirzabot keeps all six switches in ONE column, `setting.cron_status`, as a
-- JSON object:
--
--     {"day":true,"volume":true,"remove":true,"remove_volume":true,
--      "test":false,"on_hold":true,"uptime_node":false,"uptime_panel":false}
--
-- The importer already carries that column across verbatim, so on a migrated
-- shop it is sitting in `settings` as scope `bot`, key `cron_status`. This
-- migration READS it and splits it into one row per switch, so an admin who
-- had warnings on keeps warnings on. A shop with no such row — the practice
-- box, a fresh install — gets the defaults below instead.
--
-- Split into rows rather than kept as a blob because the panel writes one key
-- at a time. An admin flipping «هشدار حجم» must not rewrite an object that
-- carries five other switches; that is how one careless save turns six
-- settings into whatever the page happened to be holding.
--
-- ## The two removal switches are forced OFF regardless of what legacy says
--
-- This is the only deliberate divergence in the file, and it is not an
-- oversight.
--
-- Production's `cron_status` today says `remove:true, remove_volume:true`. The
-- honest parity import would turn both on here. It does not, because these are
-- the only two jobs in this entire project that DELETE a paying customer's
-- account from a panel, and there is no undo. Reading a value out of a JSON
-- blob is not the event that should start that happening on a shop's first
-- deploy of a new bot.
--
-- So they arrive off, the panel shows them off, and Sam turns them on when he
-- means to — with `cron_remove_dry_run` still true, which makes the first week
-- a report of what WOULD have been deleted rather than deletions.
--
-- ## `cron_remove_dry_run`, which the legacy does not have
--
-- Mirzabot deletes the moment its switch is on. We cannot restore an account
-- we removed by mistake, and «the sweep was right» is not something anybody
-- can know before watching it be right. So the removal jobs run in a mode that
-- selects exactly what they would remove, writes it to `app_events`, and stops.
-- Turning this off is the second decision, taken after reading a week of them.

-- Reading the legacy blob, in a block that cannot fail the migration.
--
-- `settings.value` is jsonb, but this row holds a jsonb STRING whose contents
-- are themselves JSON — that is how `migrateSettings` carries a `varchar`
-- column across, and `#>> '{}'` is what unwraps it. On a shop where somebody
-- edited that column by hand the text may not parse, and an uncaught cast
-- error here would take down a migration whose actual job is inserting nine
-- unrelated rows. So the parse is attempted and its failure means «no legacy
-- answer», which is the same branch a fresh install takes.
DO $$
DECLARE
  blob jsonb;
BEGIN
  BEGIN
    SELECT (value #>> '{}')::jsonb INTO blob
      FROM settings WHERE scope = 'bot' AND key = 'cron_status';
  EXCEPTION WHEN others THEN
    blob := NULL;
  END;
  -- `-> key` yields NULL for a missing key and jsonb `null` for an explicit
  -- one; `jsonb_typeof(...) = 'boolean'` refuses both, so only a real true or
  -- false from the legacy is honoured and everything else falls back.
  INSERT INTO settings (scope, key, value) VALUES
    ('bot', 'cron_warn_time',
      CASE WHEN jsonb_typeof(blob -> 'day') = 'boolean'
           THEN blob -> 'day' ELSE 'true'::jsonb END),
    ('bot', 'cron_warn_volume',
      CASE WHEN jsonb_typeof(blob -> 'volume') = 'boolean'
           THEN blob -> 'volume' ELSE 'true'::jsonb END),
    ('bot', 'cron_warn_unused',
      CASE WHEN jsonb_typeof(blob -> 'on_hold') = 'boolean'
           THEN blob -> 'on_hold' ELSE 'true'::jsonb END)
  ON CONFLICT (scope, key) DO NOTHING;
END $$;

INSERT INTO settings (scope, key, value) VALUES
  -- The two that delete. Off, whatever the blob says — see above.
  ('bot', 'cron_remove_expired', 'false'::jsonb),
  ('bot', 'cron_remove_volume',  'false'::jsonb),
  ('bot', 'cron_remove_dry_run', 'true'::jsonb),

  -- New here, in no legacy: the nudge to somebody who started the bot and
  -- never bought. Off, because it messages people who are not customers and
  -- that is a decision about the shop's voice, not a default.
  ('bot', 'cron_nudge_never_bought', 'false'::jsonb),
  ('bot', 'nudge_after_days', '3'::jsonb),

  -- The invoice deadline, which has been the constant `ORDER_TTL_MS` in
  -- `expire.ts` since it was written. 24 hours is `cronbot/payment_expire.php`
  -- (`time() - 86400`) and stays the default, so nothing moves on upgrade.
  ('bot', 'order_ttl_hours', '24'::jsonb)
ON CONFLICT (scope, key) DO NOTHING;

-- The two removal thresholds. `removedayc` and `cronvolumere` are legacy
-- columns the importer already brings across, so a migrated shop keeps the
-- numbers its admin typed; only a shop that has never had them gets these.
-- Production reads 30 and 17 on `backup_2026-09-02.sql` and 7 and 7 on the
-- 08-11 dump — which is precisely why they are not hardcoded here.
INSERT INTO settings (scope, key, value) VALUES
  ('bot', 'removedayc',   '30'::jsonb),
  ('bot', 'cronvolumere', '17'::jsonb)
ON CONFLICT (scope, key) DO NOTHING;
