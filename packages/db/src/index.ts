/**
 * A Postgres implementation of the payment hub's D1 interface.
 *
 * The hub never imported `@cloudflare/workers-types`; `packages/database`
 * declares its own `D1Database` shape and every consumer depends on that
 * interface alone. So moving off Cloudflare is an adapter, not a rewrite —
 * this file is the whole of it.
 *
 * Two differences from D1, both upgrades:
 *   - `batch()` runs inside a real Postgres transaction on one connection.
 *     D1 batches are atomic but have no isolation level to reason about.
 *   - `INSERT OR IGNORE` becomes `ON CONFLICT DO NOTHING`, which swallows a
 *     uniqueness conflict and nothing else. A CHECK violation now raises.
 */

import pg from 'pg';
import { toPostgres } from './dialect.js';

export type {
  D1Database, D1PreparedStatement, D1Result, D1ExecResult, D1DatabaseSession,
} from './types.js';
import type {
  D1Database, D1PreparedStatement, D1Result, D1ExecResult, D1DatabaseSession,
} from './types.js';

export { DialectError, toPostgres, parameterCount } from './dialect.js';

// ---------------------------------------------------------------------------
// type parsing
// ---------------------------------------------------------------------------

/**
 * The hub's row types declare every timestamp and amount as `number`, and
 * node-postgres hands back `bigint` columns as strings by default. Parsing them
 * as numbers keeps the ported code — and its ~800 tests — working unchanged.
 *
 * Safe for this schema: epoch milliseconds are ~1.8e12 and the largest money
 * value in production is ~1e10 IRR, both far below Number.MAX_SAFE_INTEGER
 * (9.007e15). A value that ever exceeded it would arrive silently rounded, so
 * the parser checks rather than trusts.
 */
function parseInt8(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(
      `bigint ${value} exceeds Number.MAX_SAFE_INTEGER; this column must be ` +
        'read as a string or the schema must change',
    );
  }
  return n;
}

let typesConfigured = false;

/** Idempotent: node-postgres type parsers are process-global. */
export function configureTypeParsers(): void {
  if (typesConfigured) return;
  pg.types.setTypeParser(pg.types.builtins.INT8, parseInt8);
  // numeric: the hub has no numeric columns, but a future one must not become
  // a float behind our back.
  pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
  typesConfigured = true;
}

// ---------------------------------------------------------------------------
// statement
// ---------------------------------------------------------------------------

/** Anything that can run one query: the pool, or a client inside a batch. */
interface Executor {
  query(sql: string, values: unknown[]): Promise<pg.QueryResult>;
}

function toResult<T>(res: pg.QueryResult, startedAt: number): D1Result<T> {
  return {
    results: (res.rows ?? []) as T[],
    success: true,
    meta: {
      duration: Date.now() - startedAt,
      changes: res.rowCount ?? 0,
      // Postgres has no rowid. Nothing in the hub reads this — `meta.changes`
      // is the only field used (assignmentPreview.ts:579, index.ts:1858).
      last_row_id: 0,
    },
  };
}

class PgStatement implements D1PreparedStatement {
  constructor(
    private readonly exec: Executor,
    private readonly sql: string,
    private readonly values: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new PgStatement(this.exec, this.sql, values);
  }

  private run_(): Promise<pg.QueryResult> {
    return this.exec.query(toPostgres(this.sql), [...this.values]);
  }

  async first<T = unknown>(col?: string): Promise<T | null> {
    const res = await this.run_();
    const row = res.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    // D1: first(col) returns that column's value, first() returns the row.
    return (col === undefined ? row : (row[col] ?? null)) as T;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const started = Date.now();
    return toResult<T>(await this.run_(), started);
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    const started = Date.now();
    return toResult<T>(await this.run_(), started);
  }

  /** Internal: lets batch() rerun the statement against a transaction client. */
  withExecutor(exec: Executor): PgStatement {
    return new PgStatement(exec, this.sql, this.values);
  }
}

// ---------------------------------------------------------------------------
// database
// ---------------------------------------------------------------------------

class PgDatabase implements D1Database {
  constructor(private readonly pool: pg.Pool) {}

  prepare(sql: string): D1PreparedStatement {
    return new PgStatement(this.pool, sql);
  }

  /**
   * Runs every statement on one connection inside a transaction.
   *
   * All-or-nothing is not a convenience here: `mirzabotVerify` writes the match
   * row and both status updates in a single batch, and a partial application
   * would leave a claim verified with no match backing it.
   */
  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    if (statements.length === 0) return [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out: D1Result<T>[] = [];
      for (const st of statements) {
        if (!(st instanceof PgStatement)) {
          throw new TypeError('batch() received a statement from another driver');
        }
        out.push(await st.withExecutor(client).run<T>());
      }
      await client.query('COMMIT');
      return out;
    } catch (err) {
      // Best effort: if the connection itself failed, the rollback will too and
      // the original error is the one worth reporting.
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async withSession<T>(fn: (tx: D1DatabaseSession) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const session: D1DatabaseSession = {
        prepare: (sql) => new PgStatement(client, sql),
        batch: async (statements) => {
          const out: D1Result<unknown>[] = [];
          for (const st of statements) {
            if (!(st instanceof PgStatement)) {
              throw new TypeError('batch() received a statement from another driver');
            }
            out.push(await st.withExecutor(client).run());
          }
          return out;
        },
      };
      const value = await fn(session);
      await client.query('COMMIT');
      return value;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async exec(sql: string): Promise<D1ExecResult> {
    const started = Date.now();
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const st of statements) {
      await this.pool.query(toPostgres(st));
    }
    return { duration: Date.now() - started, count: statements.length };
  }

  async dump(): Promise<ArrayBuffer> {
    // D1-only: it serialises the whole SQLite file. Nothing in the hub calls it,
    // and the Postgres equivalent is pg_dump, which is an operational task.
    throw new Error('dump() is not available on Postgres — use pg_dump');
  }
}

export interface CreateOptions {
  connectionString?: string;
  pool?: pg.Pool;
  max?: number;
}

/**
 * Builds a D1-shaped database on top of Postgres.
 *
 * Pass an existing pool to share one with the rest of the process; otherwise a
 * pool is created from `connectionString` (falling back to `DATABASE_URL`).
 */
export function createPostgresD1(options: CreateOptions = {}): {
  db: D1Database;
  pool: pg.Pool;
} {
  configureTypeParsers();
  const pool =
    options.pool ??
    new pg.Pool({
      connectionString: options.connectionString ?? process.env.DATABASE_URL,
      max: options.max ?? 10,
    });
  return { db: new PgDatabase(pool), pool };
}
