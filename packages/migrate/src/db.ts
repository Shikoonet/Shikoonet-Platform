/** Connections, batched inserts, and the console reporting both commands share. */

import { readFileSync } from 'node:fs';
import { createConnection, type Connection } from 'mysql2/promise';
import pg from 'pg';

// A bigint column must not silently become a float. node-postgres returns
// int8 as a string by default; make that explicit so nobody "fixes" it later.
pg.types.setTypeParser(20, (v) => v); // int8 -> string
pg.types.setTypeParser(1700, (v) => v); // numeric -> string

export interface Config {
  mysql: { host: string; port: number; user: string; password: string; database: string };
  postgres: { connectionString: string };
  /** Directory holding the D1 JSON export (one file per table). */
  d1ExportDir: string;
}

export function loadConfig(): Config {
  const env = process.env;
  return {
    mysql: {
      host: env.MYSQL_HOST ?? '127.0.0.1',
      port: Number(env.MYSQL_PORT ?? 3307),
      user: env.MYSQL_USER ?? 'root',
      password: env.MYSQL_PASSWORD ?? 'shikoo_local',
      database: env.MYSQL_DATABASE ?? 'mirzabot',
    },
    postgres: {
      connectionString:
        env.DATABASE_URL ?? 'postgres://shikoo:shikoo_local@127.0.0.1:5433/shikoo',
    },
    d1ExportDir:
      env.D1_EXPORT_DIR ??
      new URL(
        '../../../legacy/hub-cloudflare/.production-backups/' +
          'dashboard-before-dev-20260810T064246Z/d1-export',
        import.meta.url,
      ).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
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
  const client = new pg.Client(cfg.postgres);
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
  const path = `${cfg.d1ExportDir}/${table}.json`;
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
  /** Wraps the bound parameter, e.g. to convert a legacy timestamp. */
  expr?: (placeholder: string) => string;
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
        throw new Error(
          `${table}: row has ${row.length} values for ${columns.length} columns`,
        );
      }
      const placeholders = row.map((value, i) => {
        params.push(value);
        const ph = `$${params.length}`;
        const col = columns[i];
        return col?.expr ? col.expr(ph) : ph;
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

export const report = {
  title: (s: string) => console.log(`\n${BOLD}${s}${RESET}`),
  step: (s: string) => console.log(`  ${s}`),
  ok: (s: string) => console.log(`  ${GREEN}ok${RESET}    ${s}`),
  warn: (s: string) => console.log(`  ${YELLOW}warn${RESET}  ${s}`),
  fail: (s: string) => console.log(`  ${RED}FAIL${RESET}  ${s}`),
  detail: (s: string) => console.log(`        ${DIM}${s}${RESET}`),
  count: (label: string, n: number | string) =>
    console.log(`  ${String(n).padStart(7)}  ${label}`),
};

export function fmt(n: bigint | number | string): string {
  return BigInt(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
