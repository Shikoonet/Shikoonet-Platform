-- Every Mirzabot import the panel has run, and what it found.
--
-- WHY THIS TABLE EXISTS AT ALL. The import is `packages/migrate`, which is a
-- CLI: it prints to a terminal and exits. A terminal is exactly what an admin
-- doing a cutover does not have, and "did it work" cannot be answered by a
-- process that has already gone. The run has to leave something behind that
-- outlives it, and this is that thing.
--
-- WHY IT IS NOT A JOB QUEUE. There is no scheduler in this system and this does
-- not introduce one. A row here is a record of a run, not an instruction to
-- start one -- nothing polls this table looking for work. The dashboard starts
-- the run in its own process and writes here as it goes, and the browser reads
-- it back. The one thing a queue would buy is surviving a restart mid-import,
-- and the migration already handles that better than a queue could: it runs in
-- a single transaction, so a dashboard that dies half way through leaves the
-- database untouched rather than half-imported.
--
-- WHY ONLY ONE MAY RUN. Two concurrent imports would race on the same legacy
-- keys and, worse, on the same scratch MySQL database -- the second would drop
-- and reload the dump the first is still reading. `idx_import_runs_one_active`
-- makes that unrepresentable rather than checked: a partial unique index on a
-- constant permits at most one RUNNING row, and the second INSERT fails. This
-- is the same reasoning as `idx_match_one_confirmed_per_tx`, and for the same
-- reason -- a count-then-insert in the application is a race, and this codebase
-- has been bitten by exactly that before.
--
-- WHY THE REPORT IS jsonb AND NOT TEXT. It is the same report the CLI prints,
-- captured line by line with its level, so the panel can render a failure in
-- red without parsing ANSI escapes back out of a blob.
--
-- WHAT IS DELIBERATELY NOT STORED. The dump itself, and anything read out of
-- it. `marzban_panel.password_panel`, `admin.password` and roughly ten
-- `PaySetting` keys are plaintext secrets in that file; `samples` is capped at
-- a handful of rows from OUR tables after import, where `isSettingSecret` and
-- `PROVIDER_SECRETS` have already dropped them. The path and a checksum are
-- enough to say which file was read.

BEGIN;

CREATE TABLE import_runs (
  id           uuid PRIMARY KEY,
  mode         text NOT NULL CHECK (mode IN ('PREFLIGHT', 'DRY_RUN', 'APPLY')),
  status       text NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),

  -- Which file, and which bytes. The checksum is of the decompressed SQL, so a
  -- `.sql` and its `.sql.gz` are recognisably the same dump.
  dump_path    text NOT NULL,
  dump_sha256  text,
  dump_bytes   bigint CHECK (dump_bytes IS NULL OR dump_bytes >= 0),

  -- The domains asked for, exactly as chosen, so a later reader can tell an
  -- import that skipped the wheel from one that found no wheel rows.
  domains      jsonb NOT NULL DEFAULT '[]'::jsonb,

  report       jsonb NOT NULL DEFAULT '[]'::jsonb,
  samples      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Set only when status = 'FAILED'; the message the operator has to act on.
  error        text,

  started_by   text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,

  CONSTRAINT import_runs_finished_when_settled
    CHECK ((status = 'RUNNING') = (finished_at IS NULL))
);

-- At most one run in flight, enforced by the database rather than by a check
-- the application performs and then hopes still holds.
CREATE UNIQUE INDEX idx_import_runs_one_active ON import_runs ((true)) WHERE status = 'RUNNING';

CREATE INDEX idx_import_runs_recent ON import_runs (started_at DESC);

COMMIT;
