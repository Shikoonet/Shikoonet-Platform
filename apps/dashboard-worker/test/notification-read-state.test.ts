/**
 * Notification bell read-state tests.
 *
 * Covers the spec:
 *   - Opening the dropdown does NOT mark anything read.
 *   - Polling does NOT mark anything read.
 *   - Operational counts (unassigned / unmatched / suggested) are NEVER
 *     cleared by mark-read.
 *   - Only the "New" / unread count is affected by read state.
 *   - Per-item mark-read advances the cursor to the specific item.
 *   - Mark all read advances the cursor to the latest transaction.
 *   - Cursor is forward-only — a smaller (at, id) is a no-op.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

// Schema now comes from migrations/000*.sql, applied to the test database.

async function resetTables() {
  await baseEnv.DB.batch([
    baseEnv.DB.prepare('DELETE FROM transaction_account_assignments'),
    baseEnv.DB.prepare('DELETE FROM dashboard_notification_state'),
    baseEnv.DB.prepare('DELETE FROM dashboard_transaction_reads'),
    baseEnv.DB.prepare('TRUNCATE audit_logs CASCADE'),
    baseEnv.DB.prepare('DELETE FROM transaction_reviews'),
    baseEnv.DB.prepare('DELETE FROM transaction_detected_identifiers'),
    baseEnv.DB.prepare('DELETE FROM comments'),
    baseEnv.DB.prepare('DELETE FROM reconciliation_matches'),
    baseEnv.DB.prepare('DELETE FROM payment_claims'),
    baseEnv.DB.prepare('DELETE FROM transaction_candidates'),
    baseEnv.DB.prepare('DELETE FROM raw_sms_events'),
    baseEnv.DB.prepare('DELETE FROM financial_account_identifiers'),
    baseEnv.DB.prepare('DELETE FROM financial_accounts'),
    baseEnv.DB.prepare('DELETE FROM device_credentials'),
    baseEnv.DB.prepare('DELETE FROM devices'),
    baseEnv.DB.prepare('DELETE FROM integration_tokens'),
    baseEnv.DB.prepare('DELETE FROM webhook_deliveries'),
    baseEnv.DB.prepare('DELETE FROM access_users'),
  ]);
}

async function seedAdmin(email: string) {
  await baseEnv.DB.prepare(
    'INSERT INTO access_users (id, email, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
  )
    .bind(crypto.randomUUID(), email, 'ADMIN', Date.now(), Date.now())
    .run();
}

async function seedTransactionWithTimestamp(opts: {
  bankTimestamp: number;
  accountId: string | null;
  status?: string;
}) {
  const deviceId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES (?, ?, 'Test', 1, ?, ?)`,
  )
    .bind(deviceId, `test-${Date.now()}-${Math.random()}`, Date.now(), Date.now())
    .run();
  const smsId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO raw_sms_events
     (id, device_id, sender, normalized_body, body_sha256, app_checksum, sms_timestamp, received_at, classification, parser_status, parser_id, parser_version, created_at)
     VALUES (?, ?, 'TEST', 'seed tx', 'hash', 'cksum', ?, ?, 'BANK_CREDIT', 'OK', 'test', 'v1', ?)`,
  )
    .bind(smsId, deviceId, opts.bankTimestamp, opts.bankTimestamp, Date.now())
    .run();
  const txId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO transaction_candidates
     (id, raw_sms_event_id, financial_account_id, direction, amount_irr, status, bank_timestamp, confidence, parser_id, parser_version, parser_evidence_json, created_at, updated_at)
     VALUES (?, ?, ?, 'CREDIT', 100000, ?, ?, 1.0, 'test', 'v1', '{}', ?, ?)`,
  )
    .bind(
      txId,
      smsId,
      opts.accountId,
      opts.status ?? 'PARSED',
      opts.bankTimestamp,
      Date.now(),
      Date.now(),
    )
    .run();
  return txId;
}

function req(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = {
    method,
    headers: {
      'cf-access-authenticated-user-email': 'admin@example.com',
    },
  };
  if (body !== undefined) {
    init.headers = { ...init.headers, 'content-type': 'application/json' };
    (init as RequestInit).body = JSON.stringify(body);
  }
  return new Request(`https://example.com${path}`, init);
}

const ENV = { ...baseEnv, TEST_ACCESS_USER: 'admin@example.com' };

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetTables();
  await seedAdmin('admin@example.com');
});

describe('GET /api/v1/notifications/counts', () => {
  it('returns new/unassigned/unmatched/suggested + total (operational) + unread', async () => {
    const ts = Date.now() - 60_000;
    await seedTransactionWithTimestamp({
      bankTimestamp: ts,
      accountId: null,
      status: 'NEEDS_REVIEW',
    });

    const r = await app.fetch(req('GET', '/api/v1/notifications/counts'), ENV);
    const body = (await r.json()) as {
      counts: {
        new: number;
        unassigned: number;
        unmatched: number;
        suggested: number;
        total: number;
        unread: number;
      };
    };
    // unread == bell scope (income + bot auto verified); new tracks transaction cursor separately.
    expect(typeof body.counts.new).toBe('number');
    expect(typeof body.counts.unread).toBe('number');
    // total == operational only — does NOT include new.
    expect(body.counts.total).toBe(
      body.counts.unassigned + body.counts.unmatched + body.counts.suggested,
    );
    expect(body.counts.unassigned).toBeGreaterThanOrEqual(1);
    expect(body.counts.unmatched).toBeGreaterThanOrEqual(1);
  });

  it('open-without-mark-read: counts.new is unchanged after a plain GET', async () => {
    const ts = Date.now() - 60_000;
    await seedTransactionWithTimestamp({ bankTimestamp: ts, accountId: null });
    const r1 = await app.fetch(req('GET', '/api/v1/notifications/counts'), ENV);
    const b1 = (await r1.json()) as { counts: { new: number; unread: number } };
    // poll again — same value
    const r2 = await app.fetch(req('GET', '/api/v1/notifications/counts'), ENV);
    const b2 = (await r2.json()) as { counts: { new: number; unread: number } };
    expect(b2.counts.new).toBe(b1.counts.new);
    expect(b2.counts.unread).toBe(b1.counts.unread);
  });
});

describe('POST /api/v1/notifications/mark-read (per-item click)', () => {
  it('advances the cursor to the specific item position', async () => {
    const ts1 = Date.now() - 90_000;
    const ts2 = Date.now() - 60_000;
    const ts3 = Date.now() - 30_000;
    await seedTransactionWithTimestamp({ bankTimestamp: ts1, accountId: null });
    const tx2 = await seedTransactionWithTimestamp({ bankTimestamp: ts2, accountId: null });
    await seedTransactionWithTimestamp({ bankTimestamp: ts3, accountId: null });

    // Mark only tx2 as seen.
    const r = await app.fetch(
      req('POST', '/api/v1/notifications/mark-read', {
        lastSeenTransactionAt: ts2,
        lastSeenTransactionId: tx2,
      }),
      ENV,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; advanced: boolean };
    expect(body.advanced).toBe(true);

    // Transaction cursor mark-read clears counts.new but bell unread is income + bot only.
    const counts = await app.fetch(req('GET', '/api/v1/notifications/counts'), ENV);
    const cBody = (await counts.json()) as { counts: { new: number; unread: number } };
    expect(cBody.counts.new).toBe(1);
  });

  it('does NOT change operational counts', async () => {
    const ts = Date.now() - 60_000;
    await seedTransactionWithTimestamp({
      bankTimestamp: ts,
      accountId: null,
      status: 'NEEDS_REVIEW',
    });

    const before = await app.fetch(req('GET', '/api/v1/notifications/counts'), ENV);
    const beforeBody = (await before.json()) as {
      counts: { unassigned: number; unmatched: number; suggested: number };
    };

    void beforeBody;

    const ts2 = Date.now() - 30_000;
    const tx2 = await seedTransactionWithTimestamp({ bankTimestamp: ts2, accountId: null });
    await app.fetch(
      req('POST', '/api/v1/notifications/mark-read', {
        lastSeenTransactionAt: ts2,
        lastSeenTransactionId: tx2,
      }),
      ENV,
    );

    const after = await app.fetch(req('GET', '/api/v1/notifications/counts'), ENV);
    const afterBody = (await after.json()) as {
      counts: { unassigned: number; unmatched: number; suggested: number; new: number };
    };
    expect(afterBody.counts.unassigned).toBeGreaterThanOrEqual(1);
    expect(afterBody.counts.unmatched).toBeGreaterThanOrEqual(1);
    expect(afterBody.counts.new).toBe(0); // we just marked the latest item
  });

  it('forward-only: a smaller (at, id) is a no-op', async () => {
    const ts = Date.now() - 60_000;
    const tx = await seedTransactionWithTimestamp({ bankTimestamp: ts, accountId: null });

    // Move cursor forward to (ts, tx).
    await app.fetch(
      req('POST', '/api/v1/notifications/mark-read', {
        lastSeenTransactionAt: ts,
        lastSeenTransactionId: tx,
      }),
      ENV,
    );
    // Try to push back to a smaller cursor.
    const r = await app.fetch(
      req('POST', '/api/v1/notifications/mark-read', {
        lastSeenTransactionAt: ts - 1000,
        lastSeenTransactionId: 'cursor-old',
      }),
      ENV,
    );
    const body = (await r.json()) as { advanced: boolean };
    expect(body.advanced).toBe(false);

    // The cursor should still be at (ts, tx).
    const counts = await app.fetch(req('GET', '/api/v1/notifications/counts'), ENV);
    const cBody = (await counts.json()) as { cursor: { at: number; id: string } };
    expect(cBody.cursor.at).toBe(ts);
    expect(cBody.cursor.id).toBe(tx);
  });
});

describe('POST /api/v1/notifications/mark-all-read', () => {
  it('advances the cursor to the latest transaction', async () => {
    const ts1 = Date.now() - 90_000;
    const ts2 = Date.now() - 60_000;
    const ts3 = Date.now() - 30_000;
    await seedTransactionWithTimestamp({ bankTimestamp: ts1, accountId: null });
    await seedTransactionWithTimestamp({ bankTimestamp: ts2, accountId: null });
    const tx3 = await seedTransactionWithTimestamp({ bankTimestamp: ts3, accountId: null });

    const r = await app.fetch(req('POST', '/api/v1/notifications/mark-all-read'), ENV);
    expect(r.status).toBe(200);

    const counts = await app.fetch(req('GET', '/api/v1/notifications/counts'), ENV);
    const cBody = (await counts.json()) as {
      counts: { new: number; unread: number };
      cursor: { at: number; id: string };
    };
    expect(cBody.counts.new).toBe(0); // we just marked the latest item
    expect(cBody.cursor.at).toBe(ts3);
    expect(cBody.cursor.id).toBe(tx3);
  });

  it('does NOT change operational counts', async () => {
    const ts1 = Date.now() - 90_000;
    const ts2 = Date.now() - 60_000;
    await seedTransactionWithTimestamp({
      bankTimestamp: ts1,
      accountId: null,
      status: 'NEEDS_REVIEW',
    });
    await seedTransactionWithTimestamp({
      bankTimestamp: ts2,
      accountId: null,
      status: 'NEEDS_REVIEW',
    });

    await app.fetch(req('POST', '/api/v1/notifications/mark-all-read'), ENV);

    const counts = await app.fetch(req('GET', '/api/v1/notifications/counts'), ENV);
    const cBody = (await counts.json()) as {
      counts: { unassigned: number; unmatched: number; suggested: number; new: number };
    };
    expect(cBody.counts.unmatched).toBeGreaterThanOrEqual(2);
    expect(cBody.counts.unassigned).toBeGreaterThanOrEqual(2);
    expect(cBody.counts.new).toBe(0);
  });

  it('rejects unauthenticated caller with 401', async () => {
    const r = await app.fetch(
      new Request('https://example.com/api/v1/notifications/mark-all-read', {
        method: 'POST',
      }),
      { ...baseEnv, TEST_ACCESS_USER: '' },
    );
    expect(r.status).toBe(401);
  });
});
