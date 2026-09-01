/** Connections, batched inserts, and the console reporting both commands share. */

import { existsSync, readFileSync } from 'node:fs';
import { createConnection, type Connection } from 'mysql2/promise';
import pg from 'pg';

// A bigint column must not silently become a float. node-postgres returns int8
// as a string by default; this makes that explicit so nobody "fixes" it later.
//
// WHY THIS IS PER-CLIENT AND NOT `pg.types.setTypeParser`.
//
// It used to be the global call, which was harmless while the only thing that
// imported this file was the CLI. The moment the dashboard imported it to run
// an import, the two settings collided: `packages/db` installs int8 -> number
// process-wide and says so in its own comment, this installed int8 -> string,
// and whichever module loaded last won for EVERY query in the process. Money is
// bigint, so the dashboard began reading `amount_irr` as a string; 86 tests
// failed at once, which is the only reason it was not shipped.
//
// A parser attached to the client keeps the migration's reading of its own
// connection without touching anybody else's.
const AS_TEXT = (v: string): string => v;
const INT8 = 20;
const NUMERIC = 1700;

const migrationTypes = {
  getTypeParser(oid: number, format?: unknown): unknown {
    if (oid === INT8 || oid === NUMERIC) return AS_TEXT;
    return (pg.types.getTypeParser as (o: number, f?: unknown) => unknown)(oid, format);
  },
};

export interface Config {
  mysql: { host: string; port: number; user: string; password: string; database: string };
  postgres: { connectionString: string };
  /** Directory holding the D1 JSON export (one file per table). */
  d1ExportDir: string;
}

export function loadConfig(): Config {
  const env = process.env;
  // The one value with no default, and the asymmetry is deliberate. Everything
  // else here is a SOURCE: a wrong one fails to connect, or reads the wrong
  // rows and the verify step refuses to agree. `DATABASE_URL` is the
  // DESTINATION. With a default it invented for itself, a cutover run where
  // somebody forgot to export one would migrate production into the simulation
  // database on this laptop, report zero Rial of difference, and be right —
  // about the wrong database. The tests that want the local one say so in
  // `vitest.config.ts`.
  const connectionString = env.DATABASE_URL;
  if (connectionString === undefined || connectionString === '') {
    throw new Error(
      'DATABASE_URL is required: this writes a whole migration into it, so it is ' +
        'never guessed. Export the destination explicitly.',
    );
  }
  return {
    mysql: {
      host: env.MYSQL_HOST ?? '127.0.0.1',
      port: Number(env.MYSQL_PORT ?? 3307),
      user: env.MYSQL_USER ?? 'root',
      password: env.MYSQL_PASSWORD ?? 'shikoo_local',
      database: env.MYSQL_DATABASE ?? 'mirzabot',
    },
    postgres: { connectionString },
    d1ExportDir:
      env.D1_EXPORT_DIR ??
      new URL(
        '../../../legacy/hub-cloudflare/.production-backups/' +
          'dashboard-before-dev-20260810T064246Z/d1-export',
        import.meta.url,
      ).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  };
}

/**
 * The same Config, but from explicit values rather than the environment.
 *
 * `loadConfig()` stays the only path the CLI uses, so a cutover on a terminal
 * still cannot guess its destination. This exists for the dashboard, which
 * already knows which dump and which database it was asked about, and would
 * otherwise have to mutate `process.env` — a global, in a process serving other
 * requests.
 */
export function configFrom(overrides: {
  mysql: Partial<Config['mysql']> & { database: string };
  postgres: { connectionString: string };
  d1ExportDir?: string;
}): Config {
  return {
    mysql: {
      host: overrides.mysql.host ?? '127.0.0.1',
      port: overrides.mysql.port ?? 3306,
      user: overrides.mysql.user ?? 'root',
      password: overrides.mysql.password ?? '',
      database: overrides.mysql.database,
    },
    postgres: overrides.postgres,
    // Empty string, not a guess: `d1Table` reads it as "no export present" and
    // the hub steps stand down instead of failing the whole transaction.
    d1ExportDir: overrides.d1ExportDir ?? '',
  };
}

export async function connectMysql(cfg: Config): Promise<Connection> {
  return createConnection({
    ...cfg.mysql,
    charset: 'utf8mb4',
    // Keep every legacy value as the string MySQL stored. The transforms decide
    // what a value means; the driver must not decide first.
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
}

export async function connectPostgres(cfg: Config): Promise<pg.Client> {
  const client = new pg.Client({ ...cfg.postgres, types: migrationTypes as never });
  await client.connect();
  return client;
}

export async function mysqlRows<T = Record<string, unknown>>(
  conn: Connection,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const [rows] = await conn.query(sql, params);
  return rows as T[];
}

/** Reads one table out of the `wrangler d1 export` JSON layout. */
export function d1Table<T = Record<string, unknown>>(cfg: Config, table: string): T[] {
  // No export directory configured, or no file for this table, means the D1
  // side simply was not supplied. That is a legitimate MySQL-only import, so it
  // reads as zero rows. Before this, `readFileSync` threw ENOENT from inside
  // the migration transaction and rolled back every other step with it.
  if (cfg.d1ExportDir === '') return [];
  const path = `${cfg.d1ExportDir}/${table}.json`;
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed) || parsed.length === 0) return [];
  const first = parsed[0] as { results?: unknown };
  return Array.isArray(first.results) ? (first.results as T[]) : [];
}

// ---------------------------------------------------------------------------
// batched insert
// ---------------------------------------------------------------------------

export interface Column {
  name: string;
  /**
   * Wraps the bound parameter, e.g. to convert a legacy timestamp.
   *
   * `siblings` is every placeholder in the same row, in column order, for the
   * one case a column's value is not enough on its own: `revenue_adjustments.kind`
   * is decided by `expense_kind_of(note, amount_irr)`, a Postgres function the
   * migration's own backfill also calls, so that «what is a fake receipt» has
   * one definition rather than one per language. Reading a sibling by index is
   * the price of not writing that rule twice.
   */
  expr?: (placeholder: string, siblings: readonly string[]) => string;
}

export interface InsertOptions {
  /** Conflict target for idempotency, e.g. '(legacy_id)'. */
  conflict: string;
  batchSize?: number;
}

/**
 * Inserts rows in batches, skipping any that already exist.
 *
 * `ON CONFLICT DO NOTHING` is only a correct idempotency strategy because every
 * migrated table carries the legacy natural key under a UNIQUE constraint — the
 * conflict target is that key. Re-running the migration produces no duplicates
 * and no updates, so a half-finished run can simply be run again.
 *
 * Returns how many rows the database actually wrote, which is what makes a
 * second run visibly a no-op instead of merely assumed to be one.
 */
export async function insertBatch(
  client: pg.Client,
  table: string,
  columns: readonly Column[],
  rows: readonly unknown[][],
  opts: InsertOptions,
): Promise<number> {
  if (rows.length === 0) return 0;
  const batchSize = opts.batchSize ?? 500;
  const names = columns.map((c) => `"${c.name}"`).join(', ');
  let written = 0;

  for (let start = 0; start < rows.length; start += batchSize) {
    const slice = rows.slice(start, start + batchSize);
    const params: unknown[] = [];
    const tuples = slice.map((row) => {
      if (row.length !== columns.length) {
        throw new Error(`${table}: row has ${row.length} values for ${columns.length} columns`);
      }
      // Bind every value first, so an expression can name a sibling's
      // placeholder. Two passes rather than one: an expression cannot be
      // written until the placeholder it refers to exists.
      const bound = row.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      const placeholders = bound.map((ph, i) => {
        const col = columns[i];
        return col?.expr ? col.expr(ph, bound) : ph;
      });
      return `(${placeholders.join(', ')})`;
    });

    const sql =
      `INSERT INTO ${table} (${names}) VALUES ${tuples.join(', ')} ` +
      `ON CONFLICT ${opts.conflict} DO NOTHING`;
    const result = await client.query(sql, params);
    written += result.rowCount ?? 0;
  }
  return written;
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

const BOLD = '[1m';
const DIM = '[2m';
const RED = '[31m';
const GREEN = '[32m';
const YELLOW = '[33m';
const RESET = '[0m';

/** One reported line, kept without ANSI so it can be rendered anywhere. */
export interface ReportLine {
  level: 'title' | 'step' | 'ok' | 'warn' | 'fail' | 'detail' | 'count';
  text: string;
}

/**
 * Where the report goes in addition to the console.
 *
 * Console output is unchanged - the CLI must keep printing exactly what it
 * printed before, because that output is how a cutover is read. The sink is an
 * extra copy for callers that have to show the same run in a browser.
 */
let sink: ReportLine[] | null = null;

export function captureReport(into: ReportLine[]): () => void {
  const previous = sink;
  sink = into;
  return () => {
    sink = previous;
  };
}

function emit(level: ReportLine['level'], text: string, printed: string): void {
  if (sink !== null) sink.push({ level, text });
  console.log(printed);
}

export const report = {
  title: (s: string) => emit('title', s, `
${BOLD}${s}${RESET}`),
  step: (s: string) => emit('step', s, `  ${s}`),
  ok: (s: string) => emit('ok', s, `  ${GREEN}ok${RESET}    ${s}`),
  warn: (s: string) => emit('warn', s, `  ${YELLOW}warn${RESET}  ${s}`),
  fail: (s: string) => emit('fail', s, `  ${RED}FAIL${RESET}  ${s}`),
  detail: (s: string) => emit('detail', s, `        ${DIM}${s}${RESET}`),
  count: (label: string, n: number | string) =>
    emit('count', `${String(n).padStart(7)}  ${label}`, `  ${String(n).padStart(7)}  ${label}`),
};

export function fmt(n: bigint | number | string): string {
  return BigInt(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
