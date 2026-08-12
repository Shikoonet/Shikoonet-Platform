/**
 * Device permanent-delete tests.
 *
 * Covers:
 *  - /devices/:idOrCode/delete-preview returns {ok, device, references, canDelete, blockingReasons}
 *  - ADMIN required for both preview and DELETE
 *  - DELETE returns 409 device_must_be_inactive when active
 *  - DELETE returns 409 device_in_use when raw_sms_events / financial_accounts / transactions exist
 *  - DELETE atomically removes credentials + device when safe
 *  - raw_sms_events / transaction_candidates / financial_accounts are NEVER cascade-deleted
 *  - Audit log contains device.deleted with deletedCredentialCount and NO tokens / secrets / SMS bodies
 *  - Cache-Control: private, no-store on the delete-preview
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

// Schema now comes from migrations/000*.sql, applied to the test database.

async function resetTables() {
  await baseEnv.DB.batch([
    baseEnv.DB.prepare('DELETE FROM dashboard_transaction_reads'),
    baseEnv.DB.prepare('DELETE FROM dashboard_notification_state'),
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

async function seedReviewer(email: string) {
  await baseEnv.DB.prepare(
    'INSERT INTO access_users (id, email, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
  )
    .bind(crypto.randomUUID(), email, 'REVIEWER', Date.now(), Date.now())
    .run();
}

async function seedReadOnly(email: string) {
  await baseEnv.DB.prepare(
    'INSERT INTO access_users (id, email, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
  )
    .bind(crypto.randomUUID(), email, 'READ_ONLY', Date.now(), Date.now())
    .run();
}

async function seedDevice(opts: {
  code: string;
  displayName: string;
  active: boolean;
}): Promise<string> {
  const id = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO devices (id, device_code, display_name, description, active, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?)`,
  )
    .bind(id, opts.code, opts.displayName, opts.active ? 1 : 0, Date.now(), Date.now())
    .run();
  return id;
}

async function seedCredential(deviceId: string, status: 'ACTIVE' | 'REVOKED' = 'ACTIVE') {
  const id = crypto.randomUUID();
  // token_hash has a UNIQUE constraint — randomize so two seeded credentials
  // for the same device don't collide on the same hash.
  const tokenHash = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  await baseEnv.DB.prepare(
    `INSERT INTO device_credentials
       (id, device_id, token_hash, token_prefix, status, created_at)
     VALUES (?, ?, ?, 'abcd', ?, ?)`,
  )
    .bind(id, deviceId, tokenHash, status, Date.now())
    .run();
  return id;
}

async function seedRawSmsEvent(deviceId: string) {
  const id = crypto.randomUUID();
  // body_sha256 is part of a UNIQUE(device_id, body_sha256) index — randomize
  // so the same device can carry multiple events in a test.
  const bodySha = crypto.randomUUID().replace(/-/g, '');
  await baseEnv.DB.prepare(
    `INSERT INTO raw_sms_events
       (id, device_id, sender, normalized_body, body_sha256, app_checksum,
        sms_timestamp, received_at, classification, parser_status, parser_id,
        parser_version, created_at)
     VALUES (?, ?, 'BANK', 'test body', ?, 'c',
             ?, ?, 'BANK_CREDIT', 'OK', 'test', 'v1', ?)`,
  )
    .bind(id, deviceId, bodySha, Date.now(), Date.now(), Date.now())
    .run();
  return id;
}

async function seedFinancialAccount(deviceId: string) {
  const id = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO financial_accounts
       (id, display_name, bank_name, account_type, owner_label, active,
        parser_configuration, device_id, created_at, updated_at)
     VALUES (?, 'Test', 'PARSIAN', 'ACCOUNT', NULL, 1, '{}', ?, ?, ?)`,
  )
    .bind(id, deviceId, Date.now(), Date.now())
    .run();
  return id;
}

async function seedTransactionFor(deviceId: string) {
  const smsId = await seedRawSmsEvent(deviceId);
  await baseEnv.DB.prepare(
    `INSERT INTO transaction_candidates
       (id, raw_sms_event_id, financial_account_id, direction, amount_irr,
        status, bank_timestamp, confidence, parser_id, parser_version,
        parser_evidence_json, created_at, updated_at)
     VALUES (?, ?, NULL, 'CREDIT', 100000, 'NEEDS_REVIEW', ?, 1.0,
             'test', 'v1', '{}', ?, ?)`,
  )
    .bind(crypto.randomUUID(), smsId, Date.now(), Date.now(), Date.now())
    .run();
}

function req(method: string, path: string): Request {
  return new Request(`https://example.com${path}`, {
    method,
    headers: { 'cf-access-authenticated-user-email': 'admin@example.com' },
  });
}

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetTables();
  await seedAdmin('admin@example.com');
  await seedReviewer('op@example.com');
  await seedReadOnly('viewer@example.com');
});

describe('GET /api/v1/devices/:idOrCode/delete-preview', () => {
  it('rejects unauthenticated caller with 401', async () => {
    const r = await app.fetch(
      new Request('https://example.com/api/v1/devices/abc/delete-preview'),
      { ...baseEnv, TEST_ACCESS_USER: '' },
    );
    expect(r.status).toBe(401);
  });

  it('rejects REVIEWER with 403', async () => {
    const r = await app.fetch(req('GET', '/api/v1/devices/abc/delete-preview'), {
      ...baseEnv,
      TEST_ACCESS_USER: 'op@example.com',
    });
    expect(r.status).toBe(403);
  });

  it('rejects READ_ONLY with 403', async () => {
    const r = await app.fetch(req('GET', '/api/v1/devices/abc/delete-preview'), {
      ...baseEnv,
      TEST_ACCESS_USER: 'viewer@example.com',
    });
    expect(r.status).toBe(403);
  });

  it('returns references + canDelete=false for an active device', async () => {
    const id = await seedDevice({ code: 'active-1', displayName: 'Phone A', active: true });
    await seedCredential(id);
    const r = await app.fetch(req('GET', `/api/v1/devices/${id}/delete-preview`), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe('private, no-store');
    const body = (await r.json()) as {
      ok: boolean;
      device: { deviceCode: string; active: boolean };
      references: { credentials: number };
      canDelete: boolean;
      blockingReasons: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.device.active).toBe(true);
    expect(body.canDelete).toBe(false);
    expect(body.blockingReasons).toContain('device_must_be_inactive');
    expect(body.references.credentials).toBe(1);
  });

  it('flags device_in_use when raw_sms_events reference the device', async () => {
    const id = await seedDevice({ code: 'sms-1', displayName: 'Phone B', active: false });
    await seedRawSmsEvent(id);
    const r = await app.fetch(req('GET', `/api/v1/devices/${id}/delete-preview`), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    const body = (await r.json()) as {
      references: { rawSmsEvents: number };
      canDelete: boolean;
      blockingReasons: string[];
    };
    expect(body.references.rawSmsEvents).toBe(1);
    expect(body.canDelete).toBe(false);
    expect(body.blockingReasons).toContain('device_in_use');
  });

  it('flags device_in_use when financial_accounts reference the device', async () => {
    const id = await seedDevice({ code: 'acct-1', displayName: 'Phone C', active: false });
    await seedFinancialAccount(id);
    const r = await app.fetch(req('GET', `/api/v1/devices/${id}/delete-preview`), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    const body = (await r.json()) as {
      references: { financialAccounts: number };
      blockingReasons: string[];
    };
    expect(body.references.financialAccounts).toBe(1);
    expect(body.blockingReasons).toContain('device_in_use');
  });

  it('flags device_in_use when transactions exist for the device', async () => {
    const id = await seedDevice({ code: 'tx-1', displayName: 'Phone D', active: false });
    await seedTransactionFor(id);
    const r = await app.fetch(req('GET', `/api/v1/devices/${id}/delete-preview`), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    const body = (await r.json()) as {
      references: { transactions: number };
      blockingReasons: string[];
    };
    expect(body.references.transactions).toBe(1);
    expect(body.blockingReasons).toContain('device_in_use');
  });

  it('returns canDelete=true for an inactive device with credentials and zero references', async () => {
    const id = await seedDevice({ code: 'clean-1', displayName: 'Phone E', active: false });
    await seedCredential(id);
    await seedCredential(id, 'REVOKED');
    const r = await app.fetch(req('GET', `/api/v1/devices/${id}/delete-preview`), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    const body = (await r.json()) as {
      references: { credentials: number };
      canDelete: boolean;
      blockingReasons: string[];
    };
    expect(body.references.credentials).toBe(2);
    expect(body.canDelete).toBe(true);
    expect(body.blockingReasons).toEqual([]);
  });

  it('returns 404 for unknown device', async () => {
    const r = await app.fetch(req('GET', '/api/v1/devices/nope/delete-preview'), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    expect(r.status).toBe(404);
  });
});

describe('DELETE /api/v1/devices/:idOrCode', () => {
  it('rejects REVIEWER with 403', async () => {
    const id = await seedDevice({ code: 'auth-r', displayName: 'Phone R', active: false });
    const r = await app.fetch(req('DELETE', `/api/v1/devices/${id}`), {
      ...baseEnv,
      TEST_ACCESS_USER: 'op@example.com',
    });
    expect(r.status).toBe(403);
  });

  it('returns 409 device_must_be_inactive when device is still active', async () => {
    const id = await seedDevice({ code: 'still-active', displayName: 'Active', active: true });
    const r = await app.fetch(req('DELETE', `/api/v1/devices/${id}`), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('device_must_be_inactive');
    // Confirm the device row is still present.
    const stillThere = await baseEnv.DB.prepare('SELECT id FROM devices WHERE id = ?')
      .bind(id)
      .first();
    expect(stillThere).not.toBeNull();
  });

  it('returns 409 device_in_use when raw_sms_events reference the device', async () => {
    const id = await seedDevice({ code: 'sms-block', displayName: 'Phone S', active: false });
    await seedRawSmsEvent(id);
    const r = await app.fetch(req('DELETE', `/api/v1/devices/${id}`), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('device_in_use');
  });

  it('returns 409 device_in_use when financial_accounts reference the device', async () => {
    const id = await seedDevice({ code: 'acct-block', displayName: 'Phone F', active: false });
    await seedFinancialAccount(id);
    const r = await app.fetch(req('DELETE', `/api/v1/devices/${id}`), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('device_in_use');
  });

  it('successfully deletes an inactive device with credentials and zero references', async () => {
    const id = await seedDevice({ code: 'delete-ok', displayName: 'Phone OK', active: false });
    await seedCredential(id);
    await seedCredential(id, 'REVOKED');
    const r = await app.fetch(req('DELETE', `/api/v1/devices/${id}`), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      deleted: string;
      deletedCredentialCount: number;
      references: { credentials: number };
    };
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(id);
    expect(body.deletedCredentialCount).toBe(2);
    expect(body.references.credentials).toBe(2);
    // Row gone.
    const stillThere = await baseEnv.DB.prepare('SELECT id FROM devices WHERE id = ?')
      .bind(id)
      .first();
    expect(stillThere).toBeNull();
    // Credentials gone.
    const creds = await baseEnv.DB.prepare(
      'SELECT COUNT(*) AS c FROM device_credentials WHERE device_id = ?',
    )
      .bind(id)
      .first<{ c: number }>();
    expect(creds!.c).toBe(0);
  });

  it('does NOT cascade-delete raw_sms_events or transactions when blocking', async () => {
    const id = await seedDevice({ code: 'keep-history', displayName: 'Phone H', active: false });
    const smsId = await seedRawSmsEvent(id);
    await seedTransactionFor(id);
    await app.fetch(req('DELETE', `/api/v1/devices/${id}`), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    // Raw SMS event still present (its device_id is NOT NULL though, so the
    // row stays even after a rejected delete).
    const sms = await baseEnv.DB.prepare('SELECT id FROM raw_sms_events WHERE id = ?')
      .bind(smsId)
      .first();
    expect(sms).not.toBeNull();
    // Transactions still present.
    const txs = await baseEnv.DB.prepare(
      'SELECT COUNT(*) AS c FROM transaction_candidates tc JOIN raw_sms_events r ON r.id = tc.raw_sms_event_id WHERE r.device_id = ?',
    )
      .bind(id)
      .first<{ c: number }>();
    expect(txs!.c).toBe(1);
    // Device row still present because delete was blocked.
    const dev = await baseEnv.DB.prepare('SELECT id FROM devices WHERE id = ?').bind(id).first();
    expect(dev).not.toBeNull();
  });

  it('writes a device.deleted audit log with deletedCredentialCount and no secrets', async () => {
    const id = await seedDevice({ code: 'audit-del', displayName: 'Phone Audit', active: false });
    await seedCredential(id);
    await app.fetch(req('DELETE', `/api/v1/devices/${id}`), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    const log = await baseEnv.DB.prepare(
      `SELECT action, entity_type, entity_id, before_json, after_json, actor_email
       FROM audit_logs
       WHERE entity_type = 'DEVICE' AND action = 'device.deleted'
       ORDER BY created_at DESC
       LIMIT 1`,
    ).first<{
      action: string;
      entity_type: string;
      entity_id: string;
      before_json: string | null;
      after_json: string | null;
      actor_email: string | null;
    }>();
    expect(log).not.toBeNull();
    expect(log!.action).toBe('device.deleted');
    expect(log!.entity_type).toBe('DEVICE');
    expect(log!.entity_id).toBe(id);
    expect(log!.actor_email).toBe('admin@example.com');
    const before = JSON.parse(log!.before_json ?? '{}');
    expect(before.deviceCode).toBe('audit-del');
    expect(before.displayName).toBe('Phone Audit');
    const after = JSON.parse(log!.after_json ?? '{}');
    expect(after.deletedCredentialCount).toBe(1);
    // Hard guarantee: no token-shaped strings anywhere in the log row.
    const blob = JSON.stringify(log);
    expect(blob).not.toMatch(/api[_-]?key/i);
    expect(blob).not.toMatch(/token/i);
    expect(blob).not.toMatch(/authorization/i);
    expect(blob).not.toMatch(/cf[_-]?authorization/i);
    expect(blob).not.toMatch(/test body/); // SMS bodies must not be logged
  });

  it('returns 404 for unknown device', async () => {
    const r = await app.fetch(req('DELETE', '/api/v1/devices/nope'), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    expect(r.status).toBe(404);
  });
});
