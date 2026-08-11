/**
 * Tests for the staged assignment-preview service.
 *
 * Uses a recording fake D1 that records every prepare()/bind() call so
 * tests can assert on SQL shape. The early-return paths (no_account /
 * not_found) are exercised here; the multi-statement build/apply flow
 * has full coverage in the dashboard-worker integration tests against
 * real D1.
 */
import { describe, expect, it } from 'vitest';
import type { D1Database, D1PreparedStatement } from '@shikoo/database';
import {
  applyAccountAssignmentPreview,
  declineAccountAssignmentPreview,
  buildAccountAssignmentPreview,
} from '../src/assignmentPreview.js';

interface RecordedCall {
  sql: string;
  bound: unknown[];
}

function makeRecordingDb() {
  const calls: RecordedCall[] = [];
  function makeStmt(sql: string): D1PreparedStatement {
    const call: RecordedCall = { sql, bound: [] };
    calls.push(call);
    const stmt: D1PreparedStatement = {
      bind(...values: unknown[]) {
        call.bound = values;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        return null;
      },
      async all() {
        return { results: [], success: true, meta: { duration: 0, changes: 0, last_row_id: 0 } };
      },
      async run() {
        return { results: [], success: true, meta: { duration: 0, changes: 0, last_row_id: 0 } };
      },
    };
    return stmt;
  }
  const db: D1Database = {
    prepare(sql: string) {
      return makeStmt(sql);
    },
    async batch() {
      return [];
    },
    async exec() {
      return { duration: 0, count: 0 };
    },
    async dump() {
      return new ArrayBuffer(0);
    },
    async withSession() {
      return undefined as never;
    },
  };
  return { db, calls };
}

describe('buildAccountAssignmentPreview', () => {
  it('returns no_account when the account row is missing', async () => {
    const { db, calls } = makeRecordingDb();
    const r = await buildAccountAssignmentPreview(
      db,
      'missing-id',
      'admin@example.com',
      1_700_000_000_000,
    );
    expect(r.kind).toBe('no_account');
    // The first statement we ran was a SELECT against financial_accounts.
    expect(calls[0]!.sql).toMatch(/SELECT.*FROM financial_accounts.*WHERE id = \?1/);
  });
});

describe('declineAccountAssignmentPreview', () => {
  it('returns not_found when the preview row is missing', async () => {
    const { db } = makeRecordingDb();
    const r = await declineAccountAssignmentPreview(
      db,
      'a1',
      'preview-1',
      'admin@example.com',
      1_700_000_000_000,
    );
    expect(r.kind).toBe('not_found');
  });
});

describe('applyAccountAssignmentPreview', () => {
  it('returns not_found when the preview row is missing', async () => {
    const { db } = makeRecordingDb();
    const r = await applyAccountAssignmentPreview(
      db,
      'a1',
      'preview-1',
      'admin@example.com',
      null,
      1_700_000_000_000,
      { actorRole: 'ADMIN', requestId: 'cf-ray-test' },
    );
    expect(r.kind).toBe('not_found');
  });
});

describe('assignment preview SQL — contract guards', () => {
  it('preview INSERT does not touch transaction_account_assignments', async () => {
    const { db, calls } = makeRecordingDb();
    await buildAccountAssignmentPreview(db, 'a1', 'admin@example.com', 1_700_000_000_000);
    // Hard invariant: the build path must never write to assignments or
    // raw sms. Only the preview tables and the read-only probe SELECTs.
    const writesToAssignments = calls.some((c) =>
      c.sql.includes('INSERT INTO transaction_account_assignments'),
    );
    const writesToRawSms = calls.some((c) => c.sql.includes('INSERT INTO raw_sms_events'));
    expect(writesToAssignments).toBe(false);
    expect(writesToRawSms).toBe(false);
  });

  it('apply helper does not throw on the not-found path', async () => {
    const { db, calls } = makeRecordingDb();
    await applyAccountAssignmentPreview(
      db,
      'a1',
      'preview-1',
      'admin@example.com',
      null,
      1_700_000_000_000,
      { actorRole: 'ADMIN', requestId: 'cf-ray-test' },
    );
    expect(calls.length).toBeGreaterThan(0);
  });
});
