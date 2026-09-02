-- Taking an import back.
--
-- Sam, 2026-09-02: «اگر کسی backup اشتباهی رو ایمپورت کرد، بتونه برگرده عقب».
-- An APPLY commits by definition, so the transaction cannot be the answer, and
-- until now the panel had nothing to offer afterwards but a psql session.
--
-- WHAT IS STORED HERE IS A POINTER, NOT THE DATA. The rows a run wrote are
-- recorded by `packages/migrate/src/undo.ts` into a schema of their own, keyed
-- by primary key only -- `xmin = pg_current_xact_id()::xid`, asked inside the
-- migration's own transaction, which is Postgres's own answer to "what did this
-- transaction insert". These three columns say which schema belongs to which
-- run and whether it has already been used.
--
-- WHY NOT A SNAPSHOT OF THE ROWS. Two reasons, and the second is Sam's
-- decision. A copy of every affected row would be a second copy of the customer
-- data the dump already made us careful about -- card numbers, telegram ids,
-- panel credentials -- sitting in a schema nobody would remember to redact. And
-- an undo built from a snapshot restores, which would also take back a purchase
-- somebody made AFTER the import. Sam chose «only this import's rows», so the
-- undo deletes exactly what the run inserted and touches nothing else.
--
-- WHY THE SCHEMA NAME IS DERIVED, NOT FREE TEXT. `undoSchemaFor(runId)` builds
-- it from the run id, so a row here and a schema in the database cannot come to
-- disagree about which belongs to which. The column records what was made
-- rather than deciding it.

BEGIN;

ALTER TABLE import_runs
  -- Set only by an APPLY that succeeded. NULL means there is nothing to take
  -- back: a pre-flight wrote nothing, a dry run rolled its schema back with
  -- everything else, and a failed apply left the database untouched.
  ADD COLUMN undo_schema text,
  ADD COLUMN undone_at timestamptz,
  ADD COLUMN undone_by text,

  -- Both halves of "who took it back", or neither. The same shape as
  -- `revenue_adjustments`' void columns, and for the same reason: a timestamp
  -- with no name is a record of an event with no author.
  ADD CONSTRAINT import_runs_undone_complete
    CHECK ((undone_at IS NULL) = (undone_by IS NULL)),

  -- An undo that happened must name the schema it emptied. Without this a row
  -- could claim to have been undone while pointing at nothing, which is the
  -- kind of claim `docs/STATUS.md` keeps a table of.
  ADD CONSTRAINT import_runs_undone_needs_schema
    CHECK (undone_at IS NULL OR undo_schema IS NOT NULL);

-- The one question the panel asks of this column: is there an undo waiting?
-- Partial, because the answer is a handful of rows out of everything that has
-- ever been run.
CREATE INDEX idx_import_runs_undoable ON import_runs (started_at DESC)
  WHERE undo_schema IS NOT NULL AND undone_at IS NULL;

COMMIT;
