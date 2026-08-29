/**
 * Per-row read-state tests.
 *
 * Covers:
 *   - is_new is computed server-side per row using both the global cursor
 *     AND a per-actor dashboard_transaction_reads row.
 *   - POST /api/v1/notifications/transactions/:id/seen upserts a read row
 *     and returns the new unread count.
 *   - GET /api/v1/notifications/seen-ids returns the actor's seen ids.
 *   - Read state is per-actor (different Access users see different state).
 *   - Marking one row does NOT touch other rows.
 *   - The operational counts (unassigned/unmatched/suggested) are unaffected.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env as baseEnv } from 'cloudflare:test';
import SHA from '../../migrations/0001_init.sql?raw';
import SHA2 from '../../migrations/0002_bank_transaction.sql?raw';
import SHA3 from '../../migrations/0003_unique_account_identifier.sql?raw';
import SHA4 from '../../migrations/0004_detected_identifiers.sql?raw';
import SHA5 from '../../migrations/0005_transaction_reviews.sql?raw';
import SHA6 from '../../migrations/0006_assignment_history_and_notifications.sql?raw';
import SHA7 from '../../migrations/0007_transaction_reads.sql?raw';
import SHA8 from '../../migrations/0008_account_assignment_previews.sql?raw';
import SHA9 from '../../migrations/0009_credit_only.sql?raw';
import SHA10 from '../../migrations/0010_account_status.sql?raw';
import SHA11 from '../../migrations/0011_mirzabot_integration.sql?raw';
import SHA12CARD from '../../migrations/0012_claim_card_digits.sql?raw';
import SHA13 from '../../migrations/0013_resellers.sql?raw';
import SHA14 from '../../migrations/0014_income_declined.sql?raw';
import { app } from '../src/index.js';

const SCHEMA = [SHA, SHA2, SHA3, SHA4, SHA5, SHA6, SHA7, SHA8, SHA9, SHA10, SHA11, SHA12CARD, SHA13, SHA14]
  .map((s) =>
    s
      .replace(/^\s*--[^\n]*\n/gm, '')
      .replace(/^PRAGMA\s+foreign_keys\s*=\s*ON\s*;?\s*$/gim, '')
      .trim(),
  )
  .join('\n\n');

function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  for (const raw of sql.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('--')) continue;
    buf += raw + '\n';
    if (line.endsWith(';')) {
      out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

async function applySchema() {
  for (const stmt of splitStatements(SCHEMA)) {
    try {
      await baseEnv.DB.prepare(stmt).run();
    } catch (err) {
      const msg = String(err);
      if (msg.includes('already exists') || msg.includes('duplicate column name')) continue;
      throw err;
    }
  }
}

async function resetTables() {
  await baseEnv.DB.batch([
    baseEnv.DB.prepare('DELETE FROM dashboard_transaction_reads'),
    baseEnv.DB.prepare('DELETE FROM transaction_account_assignments'),
    baseEnv.DB.prepare('DELETE FROM dashboard_notification_state'),
    baseEnv.DB.prepare('DELETE FROM audit_logs'),
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

async function seedTransaction(bankTimestamp: number, accountId: string | null = null) {
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
    .bind(smsId, deviceId, bankTimestamp, bankTimestamp, Date.now())
    .run();
  const txId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO transaction_candidates
     (id, raw_sms_event_id, financial_account_id, direction, amount_irr, status, bank_timestamp, confidence, parser_id, parser_version, parser_evidence_json, created_at, updated_at)
     VALUES (?, ?, ?, 'CREDIT', 100000, 'PARSED', ?, 1.0, 'test', 'v1', '{}', ?, ?)`,
  )
    .bind(txId, smsId, accountId, bankTimestamp, Date.now(), Date.now())
    .run();
  return txId;
}

function req(method: string, path: string, body?: unknown, email = 'admin@example.com'): Request {
  const init: RequestInit = {
    method,
    headers: {
      'cf-access-authenticated-user-email': email,
    },
  };
  if (body !== undefined) {
    init.headers = { ...init.headers, 'content-type': 'application/json' };
    (init as RequestInit).body = JSON.stringify(body);
  }
  return new Request(`https://example.com${path}`, init);
}

function envFor(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetTables();
  await seedAdmin('admin@example.com');
  await seedAdmin('admin2@example.com');
});

describe('is_new per row', () => {
  it('is_new=true for an unread transaction', async () => {
    const tx = await seedTransaction(Date.now() - 60_000);
    const r = await app.fetch(req('GET', '/api/v1/today'), envFor('admin@example.com'));
    const body = (await r.json()) as { items: { id: string; is_new: boolean }[] };
    expect(body.items.find((i) => i.id === tx)?.is_new).toBe(true);
  });

  it('is_new becomes false after POST /seen for that specific row', async () => {
    const tx1 = await seedTransaction(Date.now() - 90_000);
    const tx2 = await seedTransaction(Date.now() - 30_000);
    const r1 = await app.fetch(
      req('POST', `/api/v1/notifications/transactions/${tx1}/seen`),
      envFor('admin@example.com'),
    );
    expect(r1.status).toBe(200);

    const r = await app.fetch(req('GET', '/api/v1/today'), envFor('admin@example.com'));
    const body = (await r.json()) as { items: { id: string; is_new: boolean }[] };
    const t1 = body.items.find((i) => i.id === tx1);
    const t2 = body.items.find((i) => i.id === tx2);
    expect(t1?.is_new).toBe(false);
    expect(t2?.is_new).toBe(true);
  });

  it('is_new is per-actor: another user still sees the row as new', async () => {
    const tx = await seedTransaction(Date.now() - 60_000);
    await app.fetch(
      req('POST', `/api/v1/notifications/transactions/${tx}/seen`),
      envFor('admin@example.com'),
    );

    // Second user fetches /today.
    const r = await app.fetch(req('GET', '/api/v1/today'), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin2@example.com',
    });
    const body = (await r.json()) as { items: { id: string; is_new: boolean }[] };
    expect(body.items.find((i) => i.id === tx)?.is_new).toBe(true);
  });

  it('returns the new unread count in the response', async () => {
    const tx1 = await seedTransaction(Date.now() - 90_000);
    const tx2 = await seedTransaction(Date.now() - 30_000);
    const r = await app.fetch(
      req('POST', `/api/v1/notifications/transactions/${tx2}/seen`),
      envFor('admin@example.com'),
    );
    const body = (await r.json()) as {
      ok: boolean;
      is_new: boolean;
      seen_at: number;
      unread: number;
    };
    expect(body.ok).toBe(true);
    expect(body.is_new).toBe(false);
    expect(body.seen_at).toBeGreaterThan(0);
    expect(body.unread).toBe(1); // tx1 still unread
    void tx1;
  });

  it('does not affect operational counts', async () => {
    const tx = await seedTransaction(Date.now() - 60_000, null);
    const before = await app.fetch(
      req('GET', '/api/v1/notifications/counts'),
      envFor('admin@example.com'),
    );
    const beforeBody = (await before.json()) as {
      counts: { unassigned: number; unmatched: number; suggested: number; new: number };
    };
    await app.fetch(
      req('POST', `/api/v1/notifications/transactions/${tx}/seen`),
      envFor('admin@example.com'),
    );
    const after = await app.fetch(
      req('GET', '/api/v1/notifications/counts'),
      envFor('admin@example.com'),
    );
    const afterBody = (await after.json()) as {
      counts: { unassigned: number; unmatched: number; suggested: number; new: number };
    };
    expect(afterBody.counts.unassigned).toBe(beforeBody.counts.unassigned);
    expect(afterBody.counts.unmatched).toBe(beforeBody.counts.unmatched);
    expect(afterBody.counts.suggested).toBe(beforeBody.counts.suggested);
    expect(afterBody.counts.new).toBe(0);
  });

  it('returns 404 when posting /seen for a non-existent transaction', async () => {
    const r = await app.fetch(
      req('POST', '/api/v1/notifications/transactions/00000000-0000-0000-0000-000000000000/seen'),
      envFor('admin@example.com'),
    );
    expect(r.status).toBe(404);
  });

  it('rejects unauthenticated callers with 401', async () => {
    const tx = await seedTransaction(Date.now() - 60_000);
    const r = await app.fetch(
      new Request(`https://example.com/api/v1/notifications/transactions/${tx}/seen`, {
        method: 'POST',
      }),
      { ...baseEnv, TEST_ACCESS_USER: '' },
    );
    expect(r.status).toBe(401);
  });
});

describe('GET /api/v1/notifications/seen-ids', () => {
  it('returns seen ids for the actor', async () => {
    const tx1 = await seedTransaction(Date.now() - 90_000);
    const tx2 = await seedTransaction(Date.now() - 30_000);
    await app.fetch(
      req('POST', `/api/v1/notifications/transactions/${tx1}/seen`),
      envFor('admin@example.com'),
    );
    await app.fetch(
      req('POST', `/api/v1/notifications/transactions/${tx2}/seen`),
      envFor('admin@example.com'),
    );

    const r = await app.fetch(
      req('GET', '/api/v1/notifications/seen-ids'),
      envFor('admin@example.com'),
    );
    const body = (await r.json()) as { ok: boolean; seen_at_by_id: Record<string, number> };
    expect(body.ok).toBe(true);
    expect(Object.keys(body.seen_at_by_id).sort()).toEqual([tx1, tx2].sort());
    expect(body.seen_at_by_id[tx1]).toBeGreaterThan(0);
  });

  it('is per-actor', async () => {
    const tx = await seedTransaction(Date.now() - 60_000);
    await app.fetch(
      req('POST', `/api/v1/notifications/transactions/${tx}/seen`),
      envFor('admin@example.com'),
    );

    const r = await app.fetch(req('GET', '/api/v1/notifications/seen-ids'), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin2@example.com',
    });
    const body = (await r.json()) as { seen_at_by_id: Record<string, number> };
    expect(Object.keys(body.seen_at_by_id)).not.toContain(tx);
  });
});
