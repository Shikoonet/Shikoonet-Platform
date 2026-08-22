/**
 * Which schema migrations this database has, and applying the ones it has not.
 *
 * ## Why this exists
 *
 * On 2026-08-17 the dashboard was deployed with the operator-login code and
 * `0021_operator_auth.sql` had never been run against the production database.
 * The only symptom was `POST /api/v1/auth/login` answering 500 with
 * `column "password_hash" does not exist`. Nobody could sign in, and nothing
 * anywhere said why: `schema_meta` is a key/value table for `money_unit` and
 * `legacy_tz`, not a ledger, so the database had no opinion about which
 * migrations it had seen. A gap between deployed code and deployed schema was
 * silent by construction.
 *
 * This lives in `packages/db` rather than `packages/migrate` on purpose.
 * `packages/migrate` is the one-time legacy import and is retired at phase 5;
 * the schema ledger has to outlive it, and every service already depends on
 * this package.
 *
 * ## Shape
 *
 * A row per applied file, keyed by filename, carrying the sha256 of what was
 * actually run. Three properties follow from that and each one is a failure we
 * can otherwise only find by reading production by hand:
 *
 *   - **pending** — a file on disk with no row. This is today's bug.
 *   - **drift** — a row whose checksum no longer matches the file. Editing an
 *     applied migration is how two databases silently stop being the same
 *     schema; the ledger is the only thing that can see it.
 *   - **unknown** — a row with no file, which means the database is ahead of
 *     this checkout. Rolling back the code without rolling back the schema is a
 *     real deploy, and it should say so rather than look clean.
 *
 * Everything runs under one Postgres advisory lock, so two replicas deploying
 * at the same moment cannot both apply `0022`. Each file gets its own
 * transaction together with its ledger row: a run that dies halfway leaves the
 * files it finished recorded, and re-running continues rather than restarting.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

/**
 * Arbitrary but fixed. Postgres advisory locks live in one global namespace per
 * database, so the only requirement is that nothing else in this system picks
 * the same number. Nothing else in this system takes a session-level advisory
 * lock at all.
 */
export const SCHEMA_LOCK_ID = 8_15_2026;

const LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name       text        PRIMARY KEY,
    checksum   text        NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    applied_by text
  )`;

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export interface SchemaStatus {
  applied: string[];
  pending: string[];
  /** Applied files whose contents changed since. `expected` is what ran. */
  drifted: { name: string; expected: string; found: string }[];
  /** Rows with no file on disk — the database is ahead of this checkout. */
  unknown: string[];
}

/**
 * May a service carrying this checkout start against this database?
 *
 * Deliberately a different question from `status`, and the difference is one
 * word in the answer: `unknown`.
 *
 * A **pending** migration is the bug this ledger was built after — code that
 * needs a column the database does not have, whose only symptom was a 500 on
 * every login. A **drifted** one is worse, because the two databases stopped
 * being the same schema and nothing says which is right. Neither is safe to
 * serve customers on, so both refuse.
 *
 * **unknown** is the database being AHEAD of the code, and that is what a
 * rollback looks like. Refusing it would mean the one deploy you make while
 * something is already broken — putting yesterday's image back — is the one
 * deploy the gate blocks. Migrations here are additive, so older code on a
 * newer schema runs; it is told loudly and allowed through.
 */
export function gateReasons(s: SchemaStatus): { blocking: string[]; warnings: string[] } {
  const blocking: string[] = [];
  if (s.pending.length > 0) {
    blocking.push(`${s.pending.length} migration(s) never applied here: ${s.pending.join(', ')}`);
  }
  for (const d of s.drifted) {
    blocking.push(
      `${d.name} was edited after it was applied (ran ${d.expected.slice(0, 12)}, on disk ${d.found.slice(0, 12)})`,
    );
  }
  const warnings = s.unknown.map(
    (u) => `${u} is applied here but absent from this checkout — the database is ahead of the code`,
  );
  return { blocking, warnings };
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * `0*.sql`, sorted by name — never `000*.sql`, which silently drops everything
 * from `0010` on. That glob is written down in `docs/STATUS.md` because it has
 * been got wrong by hand before; here it is code instead of a note.
 *
 * `verify_invariants.sql` sits in the same directory and is not a migration; it
 * has no leading digit, so the filter excludes it without naming it.
 */
export function readMigrations(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^0\d.*\.sql$/.test(f))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), 'utf8');
      return { name, sql, checksum: sha256(sql) };
    });
}

async function ensureLedger(c: pg.ClientBase): Promise<void> {
  await c.query(LEDGER);
}

export async function status(c: pg.ClientBase, dir: string): Promise<SchemaStatus> {
  await ensureLedger(c);
  const files = readMigrations(dir);
  const { rows } = await c.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migrations',
  );
  const recorded = new Map(rows.map((r) => [r.name, r.checksum]));

  const applied: string[] = [];
  const pending: string[] = [];
  const drifted: SchemaStatus['drifted'] = [];
  for (const f of files) {
    const was = recorded.get(f.name);
    if (was === undefined) {
      pending.push(f.name);
      continue;
    }
    applied.push(f.name);
    if (was !== f.checksum) drifted.push({ name: f.name, expected: was, found: f.checksum });
  }
  const onDisk = new Set(files.map((f) => f.name));
  const unknown = [...recorded.keys()].filter((n) => !onDisk.has(n)).sort();

  return { applied, pending, drifted, unknown };
}

/**
 * Does this database already carry the schema without carrying the ledger?
 *
 * Every database that existed before this file does — production has all 21
 * migrations applied and no `schema_migrations` row for any of them. Running
 * `up()` there would try to `CREATE TABLE users` on a database that has 62
 * tables and 11,241 customers in them.
 *
 * `users` is the probe because `0001_core.sql` creates it and nothing drops it.
 *
 * Unqualified on purpose: `to_regclass('public.users')` would answer about
 * `public` no matter which schema the connection is actually pointed at, so a
 * runner working in any other schema would be told it was already migrated by a
 * table belonging to somebody else. Written qualified first, and the tests
 * refused every migration on their scratch schema because the simulation's own
 * `public.users` was answering for them.
 */
export async function looksAlreadyMigrated(c: pg.ClientBase): Promise<boolean> {
  const { rows } = await c.query<{ present: boolean }>(
    `SELECT to_regclass('users') IS NOT NULL AS present`,
  );
  return rows[0]?.present === true;
}

/**
 * Records migrations as applied without running them.
 *
 * The one-time step for a database that predates the ledger. Deliberately
 * explicit — `through` names the last migration believed to be applied, so
 * baselining is a statement about a specific database rather than a shrug.
 */
export async function baseline(
  c: pg.ClientBase,
  dir: string,
  through: string,
  actor: string,
): Promise<string[]> {
  await ensureLedger(c);
  const files = readMigrations(dir);
  const cut = files.findIndex((f) => f.name === through);
  if (cut < 0) {
    throw new Error(
      `no migration named ${through} in ${dir} — baseline names the last one already applied`,
    );
  }
  const marked: string[] = [];
  for (const f of files.slice(0, cut + 1)) {
    const res = await c.query(
      `INSERT INTO schema_migrations (name, checksum, applied_by)
       VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING`,
      [f.name, f.checksum, `baseline:${actor}`],
    );
    if ((res.rowCount ?? 0) > 0) marked.push(f.name);
  }
  return marked;
}

export interface UpResult {
  applied: string[];
  alreadyCurrent: boolean;
}

/**
 * Applies every pending migration, in order, under one advisory lock.
 *
 * Refuses rather than guesses in two cases:
 *
 *   - a checksum no longer matches what was applied. The two databases have
 *     diverged and only a person can say which is right.
 *   - the ledger is empty on a database that already has the schema. That is
 *     the baseline case, and applying `0001` there would fail halfway through
 *     with a confusing error instead of an honest one here.
 */
export async function up(c: pg.ClientBase, dir: string, actor: string): Promise<UpResult> {
  await c.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK_ID]);
  try {
    const s = await status(c, dir);
    if (s.drifted.length > 0) {
      throw new Error(
        `refusing to migrate: ${s.drifted.length} applied migration(s) changed on disk — ` +
          `${s.drifted.map((d) => d.name).join(', ')}. An applied migration is history; ` +
          'write a new one instead of editing it.',
      );
    }
    if (s.applied.length === 0 && s.pending.length > 0 && (await looksAlreadyMigrated(c))) {
      throw new Error(
        'refusing to migrate: this database already has the schema but no ledger. ' +
          `Run \`baseline\` with the last migration it actually has (probably ${
            s.pending[s.pending.length - 1]
          }) before the first \`up\`.`,
      );
    }
    if (s.pending.length === 0) return { applied: [], alreadyCurrent: true };

    const files = readMigrations(dir);
    const applied: string[] = [];
    for (const f of files.filter((f) => s.pending.includes(f.name))) {
      // Its own transaction, with the ledger row inside it. A file that fails
      // rolls back completely and is not recorded, so re-running retries
      // exactly it — and the files before it stay applied.
      await c.query('BEGIN');
      try {
        await c.query(f.sql);
        await c.query(
          `INSERT INTO schema_migrations (name, checksum, applied_by) VALUES ($1, $2, $3)`,
          [f.name, f.checksum, actor],
        );
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK');
        throw new Error(`${f.name} failed and was rolled back: ${(err as Error).message}`, {
          cause: err,
        });
      }
      applied.push(f.name);
    }
    return { applied, alreadyCurrent: false };
  } finally {
    await c.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK_ID]);
  }
}
