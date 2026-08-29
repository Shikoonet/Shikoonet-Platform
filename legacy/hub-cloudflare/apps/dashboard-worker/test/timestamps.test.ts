/**
 * Dual-timestamp API tests.
 *
 * The dashboard surfaces two distinct timestamps:
 *   - `sms_timestamp` (raw_sms_events.sms_timestamp): the moment the SMS
 *     was received on the Android phone (per Android SMS Relay).
 *   - `received_at` (raw_sms_events.received_at): the moment the ingest
 *     worker persisted the event.
 *
 * These tests pin the API contract: every list/detail endpoint that
 * returns a transaction MUST include BOTH fields explicitly and NOT
 * alias them onto a single value.
 *
 * `transaction_candidates.bank_timestamp` ("Bank transaction time") is
 * a third, separate field used in the transaction detail modal only.
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
import SHA12CARD from '../../migrations/0012_claim_card_digits.sql?raw';
import { app } from '../src/index.js';

const SCHEMA = [SHA, SHA2, SHA3, SHA4, SHA5, SHA6, SHA7, SHA8, SHA9, SHA10, SHA12CARD]
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

async function seedAdmin() {
  const now = Date.now();
  await baseEnv.DB.prepare(
    `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
     VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)`,
  )
    .bind(crypto.randomUUID(), 'admin@example.com', now)
    .run();
}

/**
 * Seed one transaction with explicit, distinct sms_timestamp and
 * received_at. Returns the inserted transaction id and raw sms event id.
 */
async function seedTransactionWithDistinctTimestamps(): Promise<{
  txId: string;
  smsId: string;
  smsTimestamp: number;
  receivedAt: number;
  bankTimestamp: number;
}> {
  const now = Date.now();
  // SMS arrived on phone 30 seconds before the ingest worker persisted it.
  const smsTimestamp = now - 30_000;
  const receivedAt = now;
  const bankTimestamp = now - 60_000; // bank claim one minute earlier

  const deviceId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES (?, ?, 'Timestamps Test', 1, ?, ?)`,
  )
    .bind(deviceId, `ts-${Date.now()}`, now, now)
    .run();

  const smsId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO raw_sms_events
       (id, device_id, sender, normalized_body, body_sha256, app_checksum,
        sms_timestamp, received_at, classification, parser_status, parser_id,
        parser_version, created_at)
     VALUES (?, ?, 'BANK', 'ts test', ?, 'c',
             ?, ?, 'BANK_CREDIT', 'OK', 'test', 'v1', ?)`,
  )
    .bind(smsId, deviceId, crypto.randomUUID().replace(/-/g, ''), smsTimestamp, receivedAt, now)
    .run();

  const txId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO transaction_candidates
       (id, raw_sms_event_id, financial_account_id, direction, amount_irr,
        status, bank_timestamp, confidence, parser_id, parser_version,
        parser_evidence_json, created_at, updated_at)
     VALUES (?, ?, NULL, 'CREDIT', 100000, 'PARSED', ?, 1.0,
             'test', 'v1', '{}', ?, ?)`,
  )
    .bind(txId, smsId, bankTimestamp, now, now)
    .run();

  return { txId, smsId, smsTimestamp, receivedAt, bankTimestamp };
}

function req(path: string): Request {
  return new Request(`https://example.com${path}`, {
    headers: { 'cf-access-authenticated-user-email': 'admin@example.com' },
  });
}

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetTables();
  await seedAdmin();
});

describe('GET /api/v1/today — dual timestamp contract', () => {
  it('returns both sms_timestamp and received_at on each item, distinct from bank_timestamp', async () => {
    const seeded = await seedTransactionWithDistinctTimestamps();
    const r = await app.fetch(req('/api/v1/today'), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      items: Array<{
        id: string;
        sms_timestamp: number | null;
        received_at: number | null;
        bank_timestamp: number | null;
      }>;
    };
    expect(body.ok).toBe(true);
    const tx = body.items.find((i) => i.id === seeded.txId);
    expect(tx).toBeDefined();
    expect(tx!.sms_timestamp).toBe(seeded.smsTimestamp);
    expect(tx!.received_at).toBe(seeded.receivedAt);
    expect(tx!.bank_timestamp).toBe(seeded.bankTimestamp);
    // All three must be distinct — no aliasing.
    expect(tx!.sms_timestamp).not.toBe(tx!.received_at);
    expect(tx!.sms_timestamp).not.toBe(tx!.bank_timestamp);
    expect(tx!.received_at).not.toBe(tx!.bank_timestamp);
  });
});

describe('GET /api/v1/matches/unmatched — dual timestamp contract', () => {
  it('returns both sms_timestamp and received_at on each unmatched item', async () => {
    const seeded = await seedTransactionWithDistinctTimestamps();
    const r = await app.fetch(req('/api/v1/matches/unmatched'), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      items: Array<{
        id: string;
        sms_timestamp: number | null;
        received_at: number | null;
      }>;
    };
    const tx = body.items.find((i) => i.id === seeded.txId);
    expect(tx).toBeDefined();
    expect(tx!.sms_timestamp).toBe(seeded.smsTimestamp);
    expect(tx!.received_at).toBe(seeded.receivedAt);
  });
});

describe('GET /api/v1/matches/reviewed/transactions — dual timestamp contract', () => {
  it('returns both sms_timestamp and received_at on each reviewed tx item', async () => {
    const seeded = await seedTransactionWithDistinctTimestamps();
    // Mark the transaction as reviewed so it shows up in the reviewed list.
    const now = Date.now();
    await baseEnv.DB.prepare(
      `INSERT INTO transaction_reviews
         (id, transaction_candidate_id, decision, reason, comment,
          reviewed_by, reviewer_role, reviewed_at, created_at, updated_at)
       VALUES (?, ?, 'REJECTED', 'other', NULL, 'admin@example.com', 'ADMIN', ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), seeded.txId, now, now, now)
      .run();
    const r = await app.fetch(req('/api/v1/matches/reviewed/transactions'), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      items: Array<{
        id: string;
        sms_timestamp: number | null;
        received_at: number | null;
      }>;
    };
    const tx = body.items.find((i) => i.id === seeded.txId);
    expect(tx).toBeDefined();
    expect(tx!.sms_timestamp).toBe(seeded.smsTimestamp);
    expect(tx!.received_at).toBe(seeded.receivedAt);
  });
});

describe('GET /api/v1/matches/suggested — dual timestamp contract', () => {
  it('returns transaction.sms_timestamp and transaction.received_at inside each suggested item', async () => {
    const seeded = await seedTransactionWithDistinctTimestamps();
    // Insert a payment claim that creates a SUGGESTED match.
    const claimId = crypto.randomUUID();
    await baseEnv.DB.prepare(
      `INSERT INTO payment_claims
         (id, external_order_id, expected_amount_irr, target_financial_account_id,
          submitted_at, source_system, status, created_at, updated_at)
       VALUES (?, ?, 100000, NULL, ?, 'test', 'PENDING', ?, ?)`,
    )
      .bind(claimId, `order-${Date.now()}`, seeded.bankTimestamp, Date.now(), Date.now())
      .run();
    const now = Date.now();
    await baseEnv.DB.prepare(
      `INSERT INTO reconciliation_matches
         (id, transaction_candidate_id, payment_claim_id, score, status,
          matching_reasons_json, mismatch_reasons_json, created_at, updated_at)
       VALUES (?, ?, ?, 0.9, 'SUGGESTED', '[]', '[]', ?, ?)`,
    )
      .bind(crypto.randomUUID(), seeded.txId, claimId, now, now)
      .run();
    const r = await app.fetch(req('/api/v1/matches/suggested'), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      items: Array<{
        transaction: { id: string; sms_timestamp: number | null; received_at: number | null };
      }>;
    };
    const tx = body.items.find((i) => i.transaction.id === seeded.txId);
    expect(tx).toBeDefined();
    expect(tx!.transaction.sms_timestamp).toBe(seeded.smsTimestamp);
    expect(tx!.transaction.received_at).toBe(seeded.receivedAt);
  });
});

describe('GET /api/v1/matches/reviewed — dual timestamp contract', () => {
  it('returns transaction.sms_timestamp and transaction.received_at inside each reviewed item', async () => {
    const seeded = await seedTransactionWithDistinctTimestamps();
    const claimId = crypto.randomUUID();
    await baseEnv.DB.prepare(
      `INSERT INTO payment_claims
         (id, external_order_id, expected_amount_irr, target_financial_account_id,
          submitted_at, source_system, status, created_at, updated_at)
       VALUES (?, ?, 100000, NULL, ?, 'test', 'VERIFIED', ?, ?)`,
    )
      .bind(claimId, `order-${Date.now()}`, seeded.bankTimestamp, Date.now(), Date.now())
      .run();
    const now = Date.now();
    await baseEnv.DB.prepare(
      `INSERT INTO reconciliation_matches
         (id, transaction_candidate_id, payment_claim_id, score, status,
          matching_reasons_json, mismatch_reasons_json, reviewed_by, reviewed_at,
          created_at, updated_at)
       VALUES (?, ?, ?, 0.9, 'CONFIRMED', '[]', '[]',
               'admin@example.com', ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), seeded.txId, claimId, now, now, now)
      .run();
    const r = await app.fetch(req('/api/v1/matches/reviewed'), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      items: Array<{
        transaction: { id: string; sms_timestamp: number | null; received_at: number | null };
      }>;
    };
    const tx = body.items.find((i) => i.transaction.id === seeded.txId);
    expect(tx).toBeDefined();
    expect(tx!.transaction.sms_timestamp).toBe(seeded.smsTimestamp);
    expect(tx!.transaction.received_at).toBe(seeded.receivedAt);
  });
});
