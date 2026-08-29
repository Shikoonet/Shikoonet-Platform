/**
 * Device-name API tests.
 *
 * Every list/detail endpoint that returns a transaction must include the
 * originating device of that transaction, resolved through:
 *   transaction_candidates.raw_sms_event_id
 *   → raw_sms_events.device_id
 *   → devices.id
 *
 * The fields returned are:
 *   - device_id              (UUID — debug-only, NOT shown as label)
 *   - device_display_name    (primary visible label — e.g. "Poyan Android Phone")
 *   - device_code            (secondary metadata — e.g. "poyan-01")
 *
 * Devices must NOT be inferred from the financial account (one device may
 * carry SMS for multiple bank accounts).
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
      .replace(/^PRAGMA\s+foreign_keys\s*=\s*ON\s*;?$/gim, '')
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

interface SeededTx {
  txId: string;
  smsId: string;
  deviceId: string;
  deviceCode: string;
  displayName: string;
}

/**
 * Seed one transaction with a known originating device. If `displayName` is
 * the empty string the row will have an empty `devices.display_name` so
 * callers can verify the API still returns the device_code in that case.
 */
async function seedTransactionWithDevice(opts: {
  displayName: string;
  deviceCode: string;
}): Promise<SeededTx> {
  const now = Date.now();
  const deviceId = crypto.randomUUID();
  const displayName = opts.displayName.length > 0 ? opts.displayName : ' '; // SQLite NOT NULL but allow empty
  await baseEnv.DB.prepare(
    `INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
  )
    .bind(deviceId, opts.deviceCode, displayName, now, now)
    .run();

  const smsId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO raw_sms_events
       (id, device_id, sender, normalized_body, body_sha256, app_checksum,
        sms_timestamp, received_at, classification, parser_status, parser_id,
        parser_version, created_at)
     VALUES (?, ?, 'BANK', 'device-name test', ?, 'c',
             ?, ?, 'BANK_CREDIT', 'OK', 'test', 'v1', ?)`,
  )
    .bind(smsId, deviceId, crypto.randomUUID().replace(/-/g, ''), now, now, now)
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
    .bind(txId, smsId, now, now, now)
    .run();

  return {
    txId,
    smsId,
    deviceId,
    deviceCode: opts.deviceCode,
    displayName: opts.displayName,
  };
}

async function seedSuggestedMatch(txId: string) {
  const now = Date.now();
  const claimId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO payment_claims
       (id, external_order_id, expected_amount_irr, target_financial_account_id,
        submitted_at, source_system, status, created_at, updated_at)
     VALUES (?, ?, 100000, NULL, ?, 'test', 'PENDING', ?, ?)`,
  )
    .bind(claimId, `order-${Date.now()}-${crypto.randomUUID()}`, now, now, now)
    .run();

  const matchId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO reconciliation_matches
       (id, transaction_candidate_id, payment_claim_id, score, status,
        matching_reasons_json, mismatch_reasons_json, created_at, updated_at)
     VALUES (?, ?, ?, 0.9, 'SUGGESTED', '[]', '[]', ?, ?)`,
  )
    .bind(matchId, txId, claimId, now, now)
    .run();
  return { claimId, matchId };
}

async function seedConfirmedMatchAndReview(txId: string) {
  const now = Date.now();
  const claimId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO payment_claims
       (id, external_order_id, expected_amount_irr, target_financial_account_id,
        submitted_at, source_system, status, created_at, updated_at)
     VALUES (?, ?, 100000, NULL, ?, 'test', 'PENDING', ?, ?)`,
  )
    .bind(claimId, `order-${Date.now()}-${crypto.randomUUID()}`, now, now, now)
    .run();

  const matchId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO reconciliation_matches
       (id, transaction_candidate_id, payment_claim_id, score, status,
        matching_reasons_json, mismatch_reasons_json, reviewed_by, reviewed_at,
        created_at, updated_at)
     VALUES (?, ?, ?, 0.9, 'CONFIRMED', '[]', '[]',
             'admin@example.com', ?, ?, ?)`,
  )
    .bind(matchId, txId, claimId, now, now, now)
    .run();
  return { claimId, matchId };
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

describe('GET /api/v1/today — device contract', () => {
  it('returns device_id, device_display_name, device_code resolved through raw_sms_events', async () => {
    const seeded = await seedTransactionWithDevice({
      displayName: 'Poyan Android Phone',
      deviceCode: 'poyan-01',
    });
    const r = await app.fetch(req('/api/v1/today'), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      items: Array<{
        id: string;
        device_id: string | null;
        device_display_name: string | null;
        device_code: string | null;
      }>;
    };
    const tx = body.items.find((i) => i.id === seeded.txId);
    expect(tx).toBeDefined();
    expect(tx!.device_id).toBe(seeded.deviceId);
    expect(tx!.device_display_name).toBe('Poyan Android Phone');
    expect(tx!.device_code).toBe('poyan-01');
  });
});

describe('GET /api/v1/matches/unmatched — device contract', () => {
  it('returns device_id, device_display_name, device_code', async () => {
    const seeded = await seedTransactionWithDevice({
      displayName: 'Poyan Android Phone',
      deviceCode: 'poyan-01',
    });
    const r = await app.fetch(req('/api/v1/matches/unmatched'), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      items: Array<{
        id: string;
        device_id: string | null;
        device_display_name: string | null;
        device_code: string | null;
      }>;
    };
    const tx = body.items.find((i) => i.id === seeded.txId);
    expect(tx).toBeDefined();
    expect(tx!.device_id).toBe(seeded.deviceId);
    expect(tx!.device_display_name).toBe('Poyan Android Phone');
    expect(tx!.device_code).toBe('poyan-01');
  });
});

describe('GET /api/v1/matches/suggested — device contract', () => {
  it('returns device_id, device_display_name, device_code on each item', async () => {
    const seeded = await seedTransactionWithDevice({
      displayName: 'Poyan Android Phone',
      deviceCode: 'poyan-01',
    });
    await seedSuggestedMatch(seeded.txId);
    const r = await app.fetch(req('/api/v1/matches/suggested'), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      items: Array<{
        transaction: { id: string };
        device_id: string | null;
        device_display_name: string | null;
        device_code: string | null;
      }>;
    };
    const found = body.items.find((i) => i.transaction.id === seeded.txId);
    expect(found).toBeDefined();
    expect(found!.device_id).toBe(seeded.deviceId);
    expect(found!.device_display_name).toBe('Poyan Android Phone');
    expect(found!.device_code).toBe('poyan-01');
  });
});

describe('GET /api/v1/matches/reviewed — device contract', () => {
  it('returns device_id, device_display_name, device_code on each confirmed/rejected match', async () => {
    const seeded = await seedTransactionWithDevice({
      displayName: 'Poyan Android Phone',
      deviceCode: 'poyan-01',
    });
    await seedConfirmedMatchAndReview(seeded.txId);
    const r = await app.fetch(req('/api/v1/matches/reviewed'), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      items: Array<{
        transaction: { id: string };
        device_id: string | null;
        device_display_name: string | null;
        device_code: string | null;
      }>;
    };
    const found = body.items.find((i) => i.transaction.id === seeded.txId);
    expect(found).toBeDefined();
    expect(found!.device_id).toBe(seeded.deviceId);
    expect(found!.device_display_name).toBe('Poyan Android Phone');
    expect(found!.device_code).toBe('poyan-01');
  });
});

describe('GET /api/v1/matches/reviewed/transactions — device contract', () => {
  it('returns device_id, device_display_name, device_code on each reviewed tx', async () => {
    const seeded = await seedTransactionWithDevice({
      displayName: 'Poyan Android Phone',
      deviceCode: 'poyan-01',
    });
    // Just create a review row (no match needed for the reviewed-tx endpoint).
    const now = Date.now();
    await baseEnv.DB.prepare(
      `INSERT INTO transaction_reviews
         (id, transaction_candidate_id, decision, reason, comment,
          reviewed_by, reviewer_role, reviewed_at, created_at, updated_at)
       VALUES (?, ?, 'ACCEPTED', NULL, NULL, 'admin@example.com', 'ADMIN', ?, ?, ?)`,
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
        device_id: string | null;
        device_display_name: string | null;
        device_code: string | null;
      }>;
    };
    const found = body.items.find((i) => i.id === seeded.txId);
    expect(found).toBeDefined();
    expect(found!.device_id).toBe(seeded.deviceId);
    expect(found!.device_display_name).toBe('Poyan Android Phone');
    expect(found!.device_code).toBe('poyan-01');
  });
});

describe('Device is resolved via raw_sms_events, NOT financial_accounts', () => {
  it('keeps the device even when the tx has no financial_account_id', async () => {
    // Same transaction with no account assigned: device must still appear.
    const seeded = await seedTransactionWithDevice({
      displayName: 'Poyan Android Phone',
      deviceCode: 'poyan-01',
    });
    const r = await app.fetch(req('/api/v1/matches/unmatched'), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    const body = (await r.json()) as {
      items: Array<{ id: string; device_display_name: string | null; device_code: string | null }>;
    };
    const found = body.items.find((i) => i.id === seeded.txId);
    expect(found!.device_display_name).toBe('Poyan Android Phone');
    expect(found!.device_code).toBe('poyan-01');
  });
});

describe('Device field shape', () => {
  it('returns string device_code (not the UUID) when devices.display_name is empty', async () => {
    // Seed a device with display_name = ' ' (effectively empty for the UI).
    const seeded = await seedTransactionWithDevice({
      displayName: '',
      deviceCode: 'fallback-device',
    });
    const r = await app.fetch(req('/api/v1/matches/unmatched'), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    const body = (await r.json()) as {
      items: Array<{
        id: string;
        device_id: string | null;
        device_display_name: string | null;
        device_code: string | null;
      }>;
    };
    const found = body.items.find((i) => i.id === seeded.txId);
    expect(found).toBeDefined();
    // device_display_name is the value seeded (whitespace → UI treats as empty
    // and falls back to device_code); device_code is the secondary.
    expect(found!.device_code).toBe('fallback-device');
    expect(found!.device_id).toBe(seeded.deviceId);
    expect(found!.device_id).not.toBe(found!.device_code);
  });
});
