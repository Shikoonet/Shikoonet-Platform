/**
 * Emptying a shop's data so the next import starts on a clean page.
 *
 * ## Why this is not `undo.ts`
 *
 * «بازگرداندن» already exists and does what it was built for: it takes back
 * exactly the rows one APPLY inserted. Sam's scenario on 2026-09-03 is a
 * different one — a reseller takes an installation, imports, works on it for a
 * while, and then wants the shop's data gone so they can pour a new dump in —
 * and undo comes up short in four ways, three of which are merely awkward and
 * one of which is a wall:
 *
 *   * a run from before `0044` has no recording at all;
 *   * a run already undone cannot be undone twice;
 *   * N imports stacked on each other is N undos, which is not «a clean page»;
 *   * **a customer bought something after the import**, so a foreign key
 *     refuses the DELETE, the route answers `409 undo_failed`, and there is no
 *     way forward from there.
 *
 * That last row is Sam's actual requirement: «نباید ارور بده و مشکل بخوره».
 * An undo can always fail, because it DELETEs and foreign keys hold a veto. A
 * reset must not be able to.
 *
 * ## The engine was already written, and it runs every day
 *
 * `TRUNCATE … CASCADE`, one statement. It steps around all three sources of
 * failure at once: ordering stops mattering, the `ON DELETE RESTRICT` and
 * `NO ACTION` keys never fire, and the `deny_mutation` triggers on
 * `wallet_entries`, `activity_log` and `transaction_account_assignments` do
 * not fire either — they are row triggers on DELETE, and TRUNCATE is not a
 * DELETE.
 *
 * That is not an argument, it is an observation: `packages/seed/src/run.ts`
 * has been truncating those same three tables in one statement on every
 * `seed:sim` for months. So nothing here is a new mechanism. What is new is
 * the KEEP set — the answer to «what makes this installation still this
 * installation».
 *
 * ## The trap the KEEP set alone does not close
 *
 * `TRUNCATE … CASCADE` also empties any table that REFERENCES a listed one,
 * whether or not it is in the list, and it says nothing while doing it. So a
 * KEEP table could be emptied in silence and the first sign would be a panel
 * that 403s its own admin.
 *
 * Today no KEEP table references a wiped one — asked of `pg_constraint` on a
 * migrated database, not read off the schema files — but that is a fact about
 * today's schema, and a foreign key added next month would flip it with no
 * warning anywhere. So the counts are taken before and after inside the same
 * transaction, and one row of difference aborts the whole thing. The list is a
 * claim; the count is the evidence.
 */

import type pg from 'pg';
import { report } from './db.js';

/**
 * What survives a reset, and the one question each entry answers.
 *
 * The rule is narrow on purpose: the import writes all seven of its domains
 * across most of the database — `settings`, `products` and
 * `provisioning_providers` included — so «keep the shop's own configuration»
 * is not a line anybody can draw. What stays is only what this installation
 * cannot be reached or operated without.
 *
 * `@shikoo/seed`'s own KEEP has five entries and every one of them is here.
 * That is a starting point rather than an answer: seed runs against a database
 * nobody is logged into, and this one runs against a panel somebody is holding
 * open.
 */
export const RESET_KEEP: readonly string[] = [
  // A statement about the SCHEMA, not the data. Wiping it makes the schema
  // gate refuse to start the next container.
  'schema_migrations',
  'schema_meta',
  // Without it the dashboard answers 403 to the person who pressed the button,
  // which is the exact trap `grantLocalAdmin` was written for.
  'access_users',
  // …and the sessions hanging off it, or the operator is logged out midway
  // through their own reset.
  'operator_sessions',
  // The bot's own operators.
  'admins',
  // The bot's token and its `env_name`. Losing this is losing the bot, and
  // `env_name` is what keeps a copied database off the real one.
  'bot_credentials',
  // Re-pairing the SMS phone is a physical trip to wherever it is plugged in.
  'devices',
  'device_credentials',
  // Reference data about Iranian banks. It is not this shop's, it belongs to
  // every shop, and admins correct it in the dashboard.
  'bank_card_prefixes',
  'bank_sms_patterns',
  // Both edited by admins on their screens and both the target of a foreign
  // key from `users`; seed keeps them for the same reason.
  'expense_categories',
  'reseller_tiers',
  // The log of the very thing that led to this reset.
  'import_runs',
];

/** A table and how many rows it holds. */
export interface TableCount {
  table: string;
  rows: number;
}

const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Every base table in `public`, split into what goes and what stays. */
async function split(pgc: pg.Client): Promise<{ wipe: string[]; keep: string[] }> {
  const { rows } = await pgc.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  const present = new Set(rows.map((r) => r.tablename));

  // A KEEP entry naming no table is a typo, and a typo here does not fail
  // loudly — it silently moves a table into the wipe set. `bank_sms_pattern`
  // for `bank_sms_patterns` would read exactly like a working list right up
  // until the shop lost every bank parser it had.
  const missing = RESET_KEEP.filter((t) => !present.has(t));
  if (missing.length > 0) {
    throw new Error(`reset: KEEP names ${missing.join(', ')}, which no table matches`);
  }

  const keep = new Set(RESET_KEEP);
  return {
    wipe: [...present].filter((t) => !keep.has(t)).sort(),
    keep: [...RESET_KEEP].sort(),
  };
}

/** `count(*)` for each named table, in order. */
async function counts(pgc: pg.Client, tables: string[]): Promise<TableCount[]> {
  const out: TableCount[] = [];
  for (const table of tables) {
    const { rows } = await pgc.query<{ n: string }>(
      `SELECT count(*)::bigint AS n FROM public.${ident(table)}`,
    );
    out.push({ table, rows: Number(rows[0]?.n ?? 0) });
  }
  return out;
}

export interface ResetPreview {
  /** Tables that will be emptied, with what they hold now. Non-empty only. */
  wipe: TableCount[];
  /** Tables that will survive, with what they hold. */
  keep: TableCount[];
  /** Rows the reset would remove in total. */
  total: number;
}

/**
 * What a reset would remove, without removing anything.
 *
 * The pattern is `/accounts/:id/references` before `DELETE /accounts/:id`: a
 * destructive button says what it is about to cost before it is armed, and the
 * number comes from the database rather than from a sentence in the UI.
 *
 * Empty tables are dropped from `wipe` so the list names what actually moves
 * rather than every table in the database — the same choice `captureUndo`
 * makes about the undo schema, for the same reason.
 */
export async function previewReset(pgc: pg.Client): Promise<ResetPreview> {
  const { wipe, keep } = await split(pgc);
  const wipeCounts = (await counts(pgc, wipe)).filter((c) => c.rows > 0);
  return {
    wipe: wipeCounts.sort((a, b) => b.rows - a.rows),
    keep: await counts(pgc, keep),
    total: wipeCounts.reduce((sum, c) => sum + c.rows, 0),
  };
}

export interface ResetResult {
  /** What was removed, per table, largest first. Empty tables are not listed. */
  removed: TableCount[];
  total: number;
  /** Undo recordings dropped, by schema name. */
  undoSchemas: string[];
}

/**
 * Empties every table except {@link RESET_KEEP}. Caller owns the transaction.
 *
 * Caller-owned for the same reason `applyUndo` is: the lock, the audit row and
 * the rollback all belong to the route, and two functions each opening their
 * own transaction is how a half-finished reset becomes possible. It also means
 * the KEEP guard below can simply throw — the caller's ROLLBACK is what makes
 * that safe, and Postgres rolls a TRUNCATE back like anything else.
 *
 * The caller must already hold `claimImportLock`. An import writing to these
 * tables while they are being truncated is the one thing that could make this
 * fail.
 */
export async function resetShopData(pgc: pg.Client): Promise<ResetResult> {
  const { wipe, keep } = await split(pgc);

  const before = await counts(pgc, wipe);
  const keptBefore = await counts(pgc, keep);

  if (wipe.length > 0) {
    // One statement, so no foreign key ever sees a half-empty database.
    // RESTART IDENTITY because the next import expects to start at 1 — and see
    // the undo schemas below for why that is not merely tidy.
    await pgc.query(`TRUNCATE ${wipe.map(ident).join(', ')} RESTART IDENTITY CASCADE`);
  }

  // The guard. CASCADE reaches tables nobody listed and reports nothing, so
  // the only honest check is to ask again.
  const keptAfter = await counts(pgc, keep);
  const lost = keptAfter
    .map((a, i) => ({ table: a.table, was: keptBefore[i]?.rows ?? 0, now: a.rows }))
    .filter((r) => r.was !== r.now);
  if (lost.length > 0) {
    throw new Error(
      'reset: CASCADE emptied a table that must survive — ' +
        lost.map((r) => `${r.table} ${r.was}→${r.now}`).join(', ') +
        '. Nothing was changed.',
    );
  }

  // Every undo recording, gone with the data it describes.
  //
  // This is not tidiness, it is a data-loss bug if it is left out. An undo
  // schema holds PRIMARY KEYS only, and `RESTART IDENTITY` has just set every
  // sequence back to 1. So the ids in an old recording are about to be handed
  // out again to rows from a completely different dump — and «بازگرداندن» on
  // that old run would delete them. Dropped in the same transaction as the
  // truncate so there is no moment at which one exists without the other.
  const { rows: schemas } = await pgc.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'import\\_undo\\_%' ORDER BY nspname`,
  );
  for (const { nspname } of schemas) {
    await pgc.query(`DROP SCHEMA IF EXISTS ${ident(nspname)} CASCADE`);
  }
  // `import_runs` survives the truncate — it is the log of what led here — so
  // its pointers have to be cleared by hand, or the panel offers a button for
  // a recording that is gone. An UPDATE, not a DELETE, so the count this
  // function guarded a moment ago still holds.
  await pgc.query(`UPDATE import_runs SET undo_schema = NULL WHERE undo_schema IS NOT NULL`);

  const removed = before.filter((c) => c.rows > 0).sort((a, b) => b.rows - a.rows);
  const total = removed.reduce((sum, c) => sum + c.rows, 0);
  for (const r of removed) report.count(r.table, r.rows);
  report.step(
    `reset: ${total} row(s) removed from ${removed.length} table(s); ` +
      `${keep.length} kept; ${schemas.length} undo recording(s) dropped`,
  );
  return { removed, total, undoSchemas: schemas.map((s) => s.nspname) };
}
