/**
 * Tests for account resolution.
 *
 * These use a fake D1 implementation so the SQL is exercised verbatim
 * without spinning up Workers. Run with: pnpm --filter @shikoo/domain test
 */
import { describe, expect, it } from 'vitest';
import type { D1Database, D1PreparedStatement, D1Result } from '@shikoo/database';
import { resolveAccountByHint } from '../src/resolution.js';

// ---------------------------------------------------------------------------
// Fake D1 — implements only what the resolver touches. The resolver runs
// a single UNION ALL statement, so we just collect bound values and return
// pre-canned rows for the .all() call.
// ---------------------------------------------------------------------------

interface FakeStmt {
  sql: string;
  bound: unknown[];
  canned: Record<string, unknown>[];
}

function makeFakeDb(canned: Record<string, unknown>[]): {
  db: D1Database;
  captured: FakeStmt[];
} {
  const captured: FakeStmt[] = [];
  const self: D1PreparedStatement = {
    bind(...values: unknown[]) {
      // Update the most-recently-pushed statement's bound values. If no
      // prepare() ran first, create a placeholder.
      const last = captured[captured.length - 1];
      if (last && last.bound.length === 0) {
        last.bound = values;
      } else {
        captured.push({ sql: '', bound: values, canned });
      }
      return self;
    },
    first<T>(): Promise<T | null> {
      return Promise.resolve((canned[0] as T) ?? null);
    },
    all<T>(): Promise<D1Result<T>> {
      return Promise.resolve({
        results: canned as T[],
        success: true,
        meta: { duration: 0, changes: 0, last_row_id: 0 },
      });
    },
    run() {
      return Promise.resolve({
        results: [],
        success: true,
        meta: { duration: 0, changes: 0, last_row_id: 0 },
      });
    },
  };
  const db: D1Database = {
    prepare(sql: string) {
      // Push a placeholder; .bind() will populate bound values, and we
      // pre-fill sql here so the test can read it back from captured[0].
      captured.push({ sql, bound: [], canned });
      return self;
    },
    batch() {
      return Promise.resolve([]);
    },
    exec() {
      return Promise.resolve({ duration: 0, count: 0 });
    },
    dump() {
      return Promise.resolve(new ArrayBuffer(0));
    },
    withSession() {
      return Promise.resolve(undefined as never);
    },
  };
  return { db, captured };
}

describe('resolveAccountByHint', () => {
  it('returns NOT_FOUND for empty / null hint', async () => {
    const { db } = makeFakeDb([]);
    expect(await resolveAccountByHint(db, '')).toEqual({ status: 'NOT_FOUND' });
    expect(await resolveAccountByHint(db, null)).toEqual({ status: 'NOT_FOUND' });
    expect(await resolveAccountByHint(db, undefined)).toEqual({ status: 'NOT_FOUND' });
  });

  it('returns OK with account_id when exactly one row matches', async () => {
    const { db } = makeFakeDb([{ id: 'account-parsian-1', matched_by: 'account_hint' }]);
    const r = await resolveAccountByHint(db, '300422286226');
    expect(r).toEqual({
      status: 'OK',
      accountId: 'account-parsian-1',
      matchedBy: 'account_hint',
    });
  });

  it('returns AMBIGUOUS when two distinct account IDs match', async () => {
    const { db } = makeFakeDb([
      { id: 'account-A', matched_by: 'account_hint' },
      { id: 'account-B', matched_by: 'card_last_four' },
    ]);
    const r = await resolveAccountByHint(db, '1234');
    expect(r.status).toBe('ACCOUNT_IDENTIFIER_AMBIGUOUS');
    if (r.status === 'ACCOUNT_IDENTIFIER_AMBIGUOUS') {
      expect(r.matches).toHaveLength(2);
      expect(r.matches.map((m) => m.id).sort()).toEqual(['account-A', 'account-B']);
    }
  });

  it('returns OK when same account matches via two columns (de-dup)', async () => {
    const { db } = makeFakeDb([
      { id: 'account-parsian-1', matched_by: 'account_hint' },
      { id: 'account-parsian-1', matched_by: 'card_last_four' },
    ]);
    const r = await resolveAccountByHint(db, '1234');
    expect(r).toEqual({
      status: 'OK',
      accountId: 'account-parsian-1',
      matchedBy: 'account_hint',
    });
  });

  it('returns NOT_FOUND when zero rows', async () => {
    const { db } = makeFakeDb([]);
    const r = await resolveAccountByHint(db, 'unknown');
    expect(r).toEqual({ status: 'NOT_FOUND' });
  });

  it('NEVER uses LIMIT 1 — UNION ALL fetches up to 2 per source column', async () => {
    const { db, captured } = makeFakeDb([
      { id: 'account-A', matched_by: 'account_hint' },
      { id: 'account-B', matched_by: 'account_hint' },
    ]);
    await resolveAccountByHint(db, '9999');
    // The SQL contains UNION ALL with multiple LIMIT 2 — no LIMIT 1 anywhere.
    const sql = captured[0]!.sql;
    expect(sql).not.toMatch(/LIMIT\s+1\b/);
    expect(sql).toMatch(/UNION ALL/i);
    expect(sql).toMatch(/LIMIT 2/);
  });

  it('binds the hint as a single parameter (no SQL injection via the hint)', async () => {
    const { db, captured } = makeFakeDb([]);
    await resolveAccountByHint(db, "300422286226' OR 1=1 --");
    expect(captured[0]!.bound).toEqual(["300422286226' OR 1=1 --"]);
  });
});
