/**
 * Undoing an import — taking back exactly the rows one run wrote.
 *
 * ## Why this exists
 *
 * Sam's question on 2026-09-02: «اگر کسی backup اشتباهی رو ایمپورت کرد، بتونه
 * برگرده عقب». An APPLY commits by definition, so the transaction cannot be
 * the answer, and the panel had nothing to offer afterwards but a `psql`
 * session and a steady hand.
 *
 * ## What "the rows one run wrote" means, exactly
 *
 * `xmin = pg_current_xact_id()::xid`.
 *
 * Every row carries the id of the transaction that inserted it, and the whole
 * migration is one transaction. So the set is not estimated, not diffed
 * against a snapshot, and not derived from a hand-kept list of tables that
 * would drift the first time a step learned to write somewhere new. Postgres
 * already knows the answer; this asks it.
 *
 * Three things fall out of that choice, and each of them was a bug in the
 * designs it replaced:
 *
 *   * **A concurrent write is not ours.** A customer who buys while the import
 *     runs gets a row with a different `xmin`. A before/after snapshot diff
 *     would have swept that purchase up as «something the import added».
 *   * **No list to maintain.** Every base table is asked the same question, so
 *     a new step, a new table or a reordered `STEPS` cannot leave a hole. The
 *     empty answers are dropped, so the undo schema names only what moved.
 *   * **A re-import is separable.** The migration is idempotent, so running it
 *     twice inserts only what was missing the second time — and the second
 *     run's undo removes only that, leaving the first import intact.
 *
 * ## What it deliberately does NOT do
 *
 * It is not a restore. It never brings a deleted row back, never reverses an
 * UPDATE, and never touches a row the import did not insert. That is the whole
 * point — Sam chose it over «rewind the database» precisely so that a purchase
 * made after the import survives the undo of the import.
 *
 * The migration is INSERT-only (`ON CONFLICT DO NOTHING` throughout), which is
 * what makes that choice complete rather than merely narrow: there are no
 * updates to reverse.
 */

import type pg from 'pg';
import { report } from './db.js';

/** A table and the primary-key columns that identify a row in it. */
interface Keyed {
  table: string;
  keys: string[];
}

/**
 * Every base table in `public`, with its primary key.
 *
 * A table with no primary key is skipped and named, rather than guessed at:
 * without a key there is no way to say which row to take back, and `ctid`
 * moves under `VACUUM`. There are none today — all 71 have one — and this
 * exists so that the day somebody adds one, the undo says so instead of
 * silently covering less than it claims.
 */
async function keyedTables(pgc: pg.Client): Promise<Keyed[]> {
  const { rows } = await pgc.query<{ table: string; keys: string[] }>(
    `SELECT c.relname AS table,
            -- Cast to text, rather than the bare name column: array_agg over a
            -- name column yields name[], which node-pg hands back as the raw
            -- literal string instead of an array, and the first .map on it
            -- throws somewhere a long way from this query.
            array_agg(a.attname::text ORDER BY k.ord) AS keys
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       JOIN pg_constraint p ON p.conrelid = c.oid AND p.contype = 'p'
       JOIN unnest(p.conkey) WITH ORDINALITY k(attnum, ord) ON TRUE
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
      WHERE c.relkind = 'r'
      GROUP BY c.relname
      ORDER BY c.relname`,
  );
  return rows;
}

const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * Records what this transaction has written so far, into `schema`.
 *
 * Call it after the last step and BEFORE the commit, from inside the migration's
 * own transaction — `pg_current_xact_id()` is the whole mechanism, and outside
 * that transaction it answers about a different one. A dry run rolls the schema
 * back with everything else, which is correct: nothing was kept, so there is
 * nothing to take back.
 */
export async function captureUndo(pgc: pg.Client, schema: string): Promise<number> {
  await pgc.query(`CREATE SCHEMA ${ident(schema)}`);
  let tables = 0;
  let rows = 0;
  for (const { table, keys } of await keyedTables(pgc)) {
    const cols = keys.map(ident).join(', ');
    // `WITH NO DATA` then `INSERT` would need the column types spelled out;
    // `AS SELECT` takes them from the source, which is the point.
    const made = await pgc.query(
      `CREATE TABLE ${ident(schema)}.${ident(table)} AS
         SELECT ${cols} FROM public.${ident(table)}
          WHERE xmin = pg_current_xact_id()::xid`,
    );
    if (made.rowCount === 0) {
      // An empty table would make the undo schema a list of every table in the
      // database rather than a list of what this run touched.
      await pgc.query(`DROP TABLE ${ident(schema)}.${ident(table)}`);
      continue;
    }
    tables += 1;
    rows += made.rowCount ?? 0;
  }
  report.step(`undo: ${rows} row(s) across ${tables} table(s) recorded in ${schema}`);
  return rows;
}

/**
 * The order rows must be deleted in.
 *
 * Only a foreign key that REFUSES the delete constrains the order —
 * `NO ACTION` and `RESTRICT`. A `CASCADE` or `SET NULL` key resolves itself,
 * and treating those as edges is what turns this graph cyclic: `orders
 * .target_subscription_id` and `subscriptions.order_id` point at each other,
 * both `SET NULL`, and a topological sort that believed them would give up on
 * a pair that has no ordering problem at all.
 *
 * A self-reference is skipped for the same reason it is not a problem: the
 * rows go in one statement, and `users.referred_by` is `SET NULL` besides.
 */
async function deletionOrder(pgc: pg.Client, tables: string[]): Promise<string[]> {
  const { rows: edges } = await pgc.query<{ child: string; parent: string }>(
    `SELECT c.relname AS child, p.relname AS parent
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_class p ON p.oid = k.confrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      WHERE k.contype = 'f'
        AND k.confdeltype IN ('a', 'r')
        AND c.relname <> p.relname`,
  );

  const want = new Set(tables);
  // parent -> children that must go first
  const before = new Map<string, Set<string>>();
  for (const t of tables) before.set(t, new Set());
  for (const { child, parent } of edges) {
    if (want.has(child) && want.has(parent)) before.get(parent)!.add(child);
  }

  const done = new Set<string>();
  const order: string[] = [];
  // Kahn, smallest-first for a stable order that reads the same in two logs.
  while (order.length < tables.length) {
    const ready = tables
      .filter((t) => !done.has(t) && [...before.get(t)!].every((c) => done.has(c)))
      .sort();
    if (ready.length === 0) {
      // A real cycle of refusing keys. Nothing can be deleted first, so say so
      // rather than deleting in an order that will fail halfway.
      const stuck = tables.filter((t) => !done.has(t)).join(', ');
      throw new Error(`undo: foreign keys form a cycle across ${stuck}`);
    }
    for (const t of ready) {
      done.add(t);
      order.push(t);
    }
  }
  return order;
}

/**
 * The append-only triggers standing in the way, switched off for this
 * transaction only.
 *
 * `wallet_entries` and `activity_log` carry `deny_mutation`, and the wallets
 * step writes to the first of them. The rule they enforce is real — a wallet
 * balance is DERIVED from those rows, so editing history silently moves money —
 * and it is exactly why this is narrow, explicit, and asserted back on before
 * the transaction is allowed to commit.
 *
 * Found the same way on 2026-09-01, by hand, clearing seed fixtures: the first
 * attempt rolled the whole transaction back with «wallet_entries is
 * append-only», which is the guard doing its job.
 */
async function denyTriggers(pgc: pg.Client, tables: string[]): Promise<[string, string][]> {
  if (tables.length === 0) return [];
  const { rows } = await pgc.query<{ table: string; trigger: string }>(
    `SELECT c.relname AS table, t.tgname AS trigger
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       JOIN pg_proc f ON f.oid = t.tgfoid
      WHERE NOT t.tgisinternal
        AND f.proname = 'deny_mutation'
        AND c.relname = ANY($1)`,
    [tables],
  );
  return rows.map((r) => [r.table, r.trigger]);
}

export interface UndoResult {
  /** Rows removed, per table, in the order they were removed. */
  removed: { table: string; rows: number }[];
  total: number;
}

/**
 * Deletes the rows `captureUndo` recorded. Caller owns the transaction.
 *
 * A foreign key that refuses is NOT worked around. If a row created after the
 * import points at an imported row with a refusing key, the delete fails and
 * the whole undo rolls back — which is the honest answer: taking that row back
 * would break something real that now depends on it, and an undo that quietly
 * deleted the dependent too would be the «rewind the database» behaviour Sam
 * chose against.
 */
export async function applyUndo(pgc: pg.Client, schema: string): Promise<UndoResult> {
  const { rows: present } = await pgc.query<{ table: string }>(
    `SELECT c.relname AS table
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = $1
      WHERE c.relkind = 'r'`,
    [schema],
  );
  const tables = present.map((r) => r.table);
  if (tables.length === 0) return { removed: [], total: 0 };

  const keyed = new Map((await keyedTables(pgc)).map((k) => [k.table, k.keys]));
  const order = await deletionOrder(pgc, tables);

  const triggers = await denyTriggers(pgc, tables);
  for (const [table, trigger] of triggers) {
    await pgc.query(`ALTER TABLE public.${ident(table)} DISABLE TRIGGER ${ident(trigger)}`);
  }

  const removed: { table: string; rows: number }[] = [];
  try {
    for (const table of order) {
      const keys = keyed.get(table);
      if (keys === undefined) continue;
      const cols = keys.map((k) => `public.${ident(table)}.${ident(k)}`).join(', ');
      const undoCols = keys.map((k) => `u.${ident(k)}`).join(', ');
      const res = await pgc.query(
        `DELETE FROM public.${ident(table)}
           USING ${ident(schema)}.${ident(table)} u
          WHERE (${cols}) = (${undoCols})`,
      );
      const n = res.rowCount ?? 0;
      if (n > 0) removed.push({ table, rows: n });
    }
  } finally {
    for (const [table, trigger] of triggers) {
      await pgc.query(`ALTER TABLE public.${ident(table)} ENABLE TRIGGER ${ident(trigger)}`);
    }
  }

  // Asserted, not assumed. A trigger left off is a rule silently repealed, and
  // the `finally` above runs even on the path where the delete threw — this is
  // the check that the repeal did not outlive the transaction.
  const stillOff = await pgc.query<{ tgname: string }>(
    `SELECT t.tgname FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_proc f ON f.oid = t.tgfoid
      WHERE f.proname = 'deny_mutation' AND t.tgenabled = 'D'`,
  );
  if (stillOff.rowCount !== 0) {
    throw new Error(
      `undo: append-only trigger(s) left disabled: ${stillOff.rows.map((r) => r.tgname).join(', ')}`,
    );
  }

  const total = removed.reduce((sum, r) => sum + r.rows, 0);
  for (const r of removed) report.count(r.table, r.rows);
  report.step(`undo: ${total} row(s) removed`);
  return { removed, total };
}

/** Drops a recorded undo, once it has been used or is no longer wanted. */
export async function dropUndo(pgc: pg.Client, schema: string): Promise<void> {
  await pgc.query(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`);
}

/**
 * The schema name for a run.
 *
 * Derived from the run id rather than stored as a free string, so a row in
 * `import_runs` and a schema in the database cannot disagree about which
 * belongs to which. Dashes are not legal unquoted, and quoting a schema name
 * everywhere it appears in a log is a worse trade than replacing four
 * characters.
 */
export function undoSchemaFor(runId: string): string {
  return `import_undo_${runId.replace(/-/g, '_')}`;
}
