/**
 * The database interface the payment hub is written against.
 *
 * Copied verbatim from legacy/hub-cloudflare/packages/database/src/index.ts so
 * the ported code compiles unchanged. It is D1-shaped by history, not by
 * dependency: the hub never imported @cloudflare/workers-types, which is the
 * only reason this migration is an adapter instead of a rewrite.
 *
 * Do not extend this with Postgres-specific methods. The moment a caller needs
 * one, it stops being a seam and starts being a coupling — and the 14 domain
 * test files that fake this interface stop being able to.
 */

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(sql: string): Promise<D1ExecResult>;
  dump(): Promise<ArrayBuffer>;
  withSession<T>(fn: (tx: D1DatabaseSession) => Promise<T>): Promise<T>;
}

export interface D1DatabaseSession {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(col?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Result<T> {
  results: T[];
  success: boolean;
  meta: { duration: number; changes: number; last_row_id: number; served_by?: string };
}

export interface D1ExecResult {
  duration: number;
  count: number;
}
