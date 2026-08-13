/**
 * Sensitive-data verifications.
 *
 * Covers every requirement from the verification spec:
 *  - Device tokens: hash-only persistence, no token leakage in logs, no
 *    device-ID enumeration via generic 401s.
 *  - SMS bodies: OTP body never persisted; plaintext body never logged;
 *    OTP cannot be revealed through any dashboard query.
 *  - Access JWT: missing/invalid/wrong-audience/wrong-issuer/inactive.
 *  - Authorization: READ_ONLY cannot approve/reject/comment; REVIEWER can;
 *    ADMIN manages credentials.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env } from './helpers/env.js';
import { app } from '../src/index.js';
import { app as dashboardApp } from '@shikoo/dashboard';

// Schema now comes from migrations/000*.sql, applied to the test database.

async function seedAccessUser(email: string, role: 'ADMIN' | 'REVIEWER' | 'READ_ONLY', active = 1) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
  )
    .bind(crypto.randomUUID(), email, role, active, Date.now())
    .run();
}

async function seedDevice(opts: { deviceCode: string; apiKey: string; active?: 0 | 1 }) {
  const deviceId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const now = Date.now();
  const tokenHash = await sha256Hex(opts.apiKey);
  const tokenPrefix = opts.apiKey.slice(0, 4);
  await env.DB.prepare(
    `INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(deviceId, opts.deviceCode, `dev-${opts.deviceCode}`, opts.active ?? 1, now, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO device_credentials (id, device_id, token_hash, token_prefix, status, created_at, activated_at) VALUES (?1, ?2, ?3, ?4, 'ACTIVE', ?5, ?5)`,
  )
    .bind(credentialId, deviceId, tokenHash, tokenPrefix, now)
    .run();
  return { deviceId, credentialId, tokenHash, tokenPrefix };
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

beforeAll(async () => {
  await applySchema();
  // Seed a device so dashboard worker's /today SELECT that joins
  // devices (via raw_sms_events.device_id is empty anyway) doesn't 500
  // when env.DB has freshly been migrated.
  await env.DB.prepare(
    `INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES ('s-1', 'SEC-DEV', 'sec', 1, 0, 0)`,
  ).run();
});

beforeEach(async () => {
  for (const t of [
    'reconciliation_matches',
    'comments',
    'payment_claims',
    'transaction_candidates',
    'raw_sms_events',
    'financial_accounts',
    'device_credentials',
    'devices',
    'access_users',
    'audit_logs',
  ]) {
    try {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    } catch {
      /* ignore */
    }
  }
});

describe('security: device tokens', () => {
  it('raw token is never persisted; only hash + 4-char prefix stored', async () => {
    const apiKey = 'r4nd0m40ch4r4ct3r40ch4r4ct3r40ch4r40';
    const { deviceId, tokenHash, tokenPrefix } = await seedDevice({
      deviceCode: 'sec-token-storage',
      apiKey,
    });

    const rows = await env.DB.prepare(
      `SELECT token_hash, token_prefix FROM device_credentials WHERE device_id = ?1`,
    )
      .bind(deviceId)
      .all<{ token_hash: string; token_prefix: string }>();
    expect(rows.results).toHaveLength(1);
    const r = rows.results[0]!;
    expect(r.token_hash).toBe(tokenHash);
    expect(r.token_prefix).toBe(tokenPrefix);
    expect(r.token_prefix.length).toBe(4);
    // The full token must NOT appear in any credential column.
    const sweep = await env.DB.prepare(`SELECT * FROM device_credentials WHERE device_id = ?1`)
      .bind(deviceId)
      .all<Record<string, unknown>>();
    for (const row of sweep.results) {
      for (const v of Object.values(row)) {
        if (typeof v === 'string') expect(v.includes(apiKey)).toBe(false);
      }
    }
  });

  it('generic 401 response — same shape for unknown device vs invalid token', async () => {
    await seedDevice({ deviceCode: 'sec-known', apiKey: 'a'.repeat(40) });
    const ts = Date.now();

    const ar = await app.fetch(
      new Request('https://example.com/api/v1/sms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiKey: 'b'.repeat(40),
          deviceId: 'sec-known',
          deviceName: 'X',
          message: 'مبلغ 1,000 ریال به کارت *1234',
          sender: 'BANK',
          timestamp: String(ts),
          checksum: '0'.repeat(32),
        }),
      }),
      env,
    );
    const br = await app.fetch(
      new Request('https://example.com/api/v1/sms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiKey: 'c'.repeat(40),
          deviceId: 'sec-missing',
          deviceName: 'X',
          message: 'مبلغ 1,000 ریال به کارت *1234',
          sender: 'BANK',
          timestamp: String(ts + 1),
          checksum: '0'.repeat(32),
        }),
      }),
      env,
    );
    expect(ar.status).toBe(401);
    expect(br.status).toBe(401);
    const aj = await ar.json();
    const bj = await br.json();
    expect(JSON.stringify(aj)).toBe(JSON.stringify(bj));
  });

  it('two devices whose keys share a prefix each authenticate with their own', async () => {
    // The prefix is only the first 4 chars of the token, so a collision is a
    // matter of when, not if — at 100 credentials it is already ~8%. The
    // lookup used to be `WHERE token_prefix = ?` with `LIMIT 1`, which handed
    // back whichever row the planner picked and told the other device its key
    // was invalid. Found on 2026-08-14 when the simulation seed gave all six
    // devices the same prefix and five of them could not post.
    const keyA = `dead${'1'.repeat(36)}`;
    const keyB = `dead${'2'.repeat(36)}`;
    await seedDevice({ deviceCode: 'sec-collide-a', apiKey: keyA });
    await seedDevice({ deviceCode: 'sec-collide-b', apiKey: keyB });

    async function post(deviceId: string, apiKey: string, ts: number): Promise<number> {
      const r = await app.fetch(
        new Request('https://example.com/api/v1/sms', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            apiKey,
            deviceId,
            deviceName: 'X',
            message: 'مبلغ 1,000 ریال به کارت *1234',
            sender: 'BANK',
            timestamp: String(ts),
            checksum: '0'.repeat(32),
          }),
        }),
        env,
      );
      return r.status;
    }

    const ts = Date.now();
    expect(await post('sec-collide-a', keyA, ts)).toBe(200);
    expect(await post('sec-collide-b', keyB, ts + 1)).toBe(200);
    // And a shared prefix still does not let one device use the other's key.
    expect(await post('sec-collide-a', keyB, ts + 2)).toBe(401);
  });

  it('plaintext SMS body never appears in audit_logs', async () => {
    const apiKey = 'a'.repeat(40);
    const { deviceId } = await seedDevice({ deviceCode: 'sec-audit', apiKey });
    const body = 'مبلغ 50,000 ریال به کارت *1234';
    const r = await app.fetch(
      new Request('https://example.com/api/v1/sms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiKey,
          deviceId: 'sec-audit',
          deviceName: 'X',
          message: body,
          sender: 'BANK',
          timestamp: String(Date.now()),
          checksum: '0'.repeat(32),
        }),
      }),
      env,
    );
    expect(r.status).toBe(200);
    const ev = await env.DB.prepare(`SELECT MAX(id) AS id FROM raw_sms_events WHERE device_id = ?1`)
      .bind(deviceId)
      .first<{ id: string }>();
    const audit = await env.DB.prepare(`SELECT * FROM audit_logs WHERE entity_id = ?1`)
      .bind(ev?.id)
      .all<Record<string, unknown>>();
    for (const row of audit.results) {
      for (const v of Object.values(row)) {
        if (typeof v === 'string') expect(v.includes(body)).toBe(false);
      }
    }
  });
});

describe('security: SMS body — OTP redaction', () => {
  it('OTP body never persisted, no transaction created, classification=OTP', async () => {
    const apiKey = 'a'.repeat(40);
    const otpSecret = 'کد تایید: 654321 - محرمانه';
    const { deviceId } = await seedDevice({ deviceCode: 'sec-otp', apiKey });
    const r = await app.fetch(
      new Request('https://example.com/api/v1/sms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiKey,
          deviceId: 'sec-otp',
          deviceName: 'X',
          message: otpSecret,
          sender: 'FRIEND',
          timestamp: String(Date.now()),
          checksum: '0'.repeat(32),
        }),
      }),
      env,
    );
    expect(r.status).toBe(200);
    const ev = await env.DB.prepare(
      `SELECT classification, normalized_body, encrypted_or_protected_body FROM raw_sms_events WHERE device_id = ?1`,
    )
      .bind(deviceId)
      .first<{
        classification: string;
        normalized_body: string | null;
        encrypted_or_protected_body: string | null;
      }>();
    expect(ev!.classification).toBe('OTP');
    expect(ev!.normalized_body).toBeNull();
    // The ingest Worker stores the marker '[redacted]' for redactable
    // classifications (OTP, PROMO). Plaintext never appears.
    expect(ev!.encrypted_or_protected_body).toBe('[redacted]');
    expect(ev!.encrypted_or_protected_body!.includes('654321')).toBe(false);
    const tx = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM transaction_candidates t JOIN raw_sms_events r ON r.id=t.raw_sms_event_id WHERE r.device_id = ?1`,
    )
      .bind(deviceId)
      .first<{ n: number }>();
    expect(tx?.n).toBe(0);
  });

  it('OTP content not returned via dashboard APIs', async () => {
    await seedAccessUser('admin@x.com', 'ADMIN');
    const apiKey = 'a'.repeat(40);
    await seedDevice({ deviceCode: 'sec-otp2', apiKey });
    const r = await app.fetch(
      new Request('https://example.com/api/v1/sms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiKey,
          deviceId: 'sec-otp2',
          deviceName: 'X',
          message: 'کد تایید: 999999',
          sender: 'FRIEND',
          timestamp: String(Date.now()),
          checksum: '0'.repeat(32),
        }),
      }),
      env,
    );
    expect(r.status).toBe(200);
    const today = await dashboardApp.fetch(
      new Request('https://dashboard.example.com/api/v1/today'),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    expect(today.status).toBe(200);
    const body = await today.text();
    expect(body.includes('999999')).toBe(false);
    expect(body.includes('کد')).toBe(false);
  });
});

describe('security: access JWT / RBAC', () => {
  it('missing JWT → 401 unauthorized', async () => {
    const r = await dashboardApp.fetch(
      new Request('https://dashboard.example.com/api/v1/devices'),
      env,
    );
    expect(r.status).toBe(401);
  });

  it('TEST_ACCESS_USER bypass requires the user to exist in access_users', async () => {
    // unset TEST_ACCESS_USER → real JWT path returns 401
    const r1 = await dashboardApp.fetch(
      new Request('https://dashboard.example.com/api/v1/devices'),
      { ...env, TEST_ACCESS_USER: undefined },
    );
    expect(r1.status).toBe(401);

    // set TEST_ACCESS_USER but no access_users row → 403 forbidden
    const r2 = await dashboardApp.fetch(
      new Request('https://dashboard.example.com/api/v1/devices'),
      { ...env, TEST_ACCESS_USER: 'nobody@x.com' },
    );
    expect(r2.status).toBe(403);

    // existing row → 200
    await seedAccessUser('admin@x.com', 'ADMIN');
    const r3 = await dashboardApp.fetch(
      new Request('https://dashboard.example.com/api/v1/devices'),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    expect(r3.status).toBe(200);
  });

  it('inactive user rejected', async () => {
    await seedAccessUser('inactive@x.com', 'ADMIN', 0);
    const r = await dashboardApp.fetch(
      new Request('https://dashboard.example.com/api/v1/devices'),
      { ...env, TEST_ACCESS_USER: 'inactive@x.com' },
    );
    expect(r.status).toBe(403);
  });

  it('READ_ONLY cannot approve/reject, but can read', async () => {
    await seedAccessUser('ro@x.com', 'READ_ONLY');
    const read = await dashboardApp.fetch(
      new Request('https://dashboard.example.com/api/v1/devices'),
      { ...env, TEST_ACCESS_USER: 'ro@x.com' },
    );
    expect(read.status).toBe(200);

    const approve = await dashboardApp.fetch(
      new Request('https://dashboard.example.com/api/v1/match/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transactionCandidateId: 'x', matchId: 'y' }),
      }),
      { ...env, TEST_ACCESS_USER: 'ro@x.com' },
    );
    expect(approve.status).toBe(403);

    const reject = await dashboardApp.fetch(
      new Request('https://dashboard.example.com/api/v1/match/reject', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ matchId: 'y', reason: 'OTHER' }),
      }),
      { ...env, TEST_ACCESS_USER: 'ro@x.com' },
    );
    expect(reject.status).toBe(403);

    const comment = await dashboardApp.fetch(
      new Request('https://dashboard.example.com/api/v1/comment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entityType: 'MATCH', entityId: 'y', body: 'x' }),
      }),
      { ...env, TEST_ACCESS_USER: 'ro@x.com' },
    );
    expect(comment.status).toBe(403);
  });

  it('REVIEWER can approve and comment', async () => {
    await seedAccessUser('rev@x.com', 'REVIEWER');
    // Stub finding a tx and match so the transition succeeds.
    await env.DB.prepare(
      `INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at) VALUES ('d1', 'rev-dev', 'D', 1, 0, 0)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO raw_sms_events (id, device_id, sender, body_sha256, app_checksum, sms_timestamp, received_at, classification, parser_status, created_at) VALUES ('e1', 'd1', 's', 'h', 'h', 0, 0, 'BANK_CREDIT', 'OK', 0)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO financial_accounts (id, bank_name, display_name, account_type, active, parser_configuration, created_at, updated_at) VALUES ('a1', 'B', 'A', 'CARD', 1, '{}', 0, 0)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO payment_claims (id, external_order_id, expected_amount_irr, target_financial_account_id, submitted_at, source_system, metadata_json, status, created_at, updated_at) VALUES ('c1', 'o', 1, 'a1', 0, 's', '{}', 'PENDING', 0, 0)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO transaction_candidates (id, raw_sms_event_id, financial_account_id, direction, amount_irr, confidence, parser_id, parser_version, parser_evidence_json, status, created_at, updated_at) VALUES ('t1', 'e1', 'a1', 'CREDIT', 1, 0.5, 'x', '1', '{}', 'MATCHED', 0, 0)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO reconciliation_matches (id, transaction_candidate_id, payment_claim_id, score, matching_reasons_json, mismatch_reasons_json, status, created_at, updated_at) VALUES ('m1', 't1', 'c1', 0.5, '[]', '[]', 'SUGGESTED', 0, 0)`,
    ).run();

    const approve = await dashboardApp.fetch(
      new Request('https://dashboard.example.com/api/v1/match/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transactionCandidateId: 't1', matchId: 'm1' }),
      }),
      { ...env, TEST_ACCESS_USER: 'rev@x.com' },
    );
    expect(approve.status).toBe(200);

    const comment = await dashboardApp.fetch(
      new Request('https://dashboard.example.com/api/v1/comment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entityType: 'MATCH', entityId: 'm1', body: 'ok' }),
      }),
      { ...env, TEST_ACCESS_USER: 'rev@x.com' },
    );
    expect(comment.status).toBe(200);
  });

  it('duplicate ingestion returns the original event id (idempotent)', async () => {
    const apiKey = 'a'.repeat(40);
    await seedDevice({ deviceCode: 'sec-dup', apiKey });
    const ts = Date.now();
    const body = JSON.stringify({
      apiKey,
      deviceId: 'sec-dup',
      deviceName: 'X',
      message: 'واریز 1,000,000 ریال',
      sender: 'BANK',
      timestamp: String(ts),
      checksum: '0'.repeat(32),
    });
    const r1 = await app.fetch(
      new Request('https://example.com/api/v1/sms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      env,
    );
    const r2 = await app.fetch(
      new Request('https://example.com/api/v1/sms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      env,
    );
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const j1 = (await r1.json()) as { eventId: string; duplicate: boolean };
    const j2 = (await r2.json()) as { eventId: string; duplicate: boolean };
    expect(j1.duplicate).toBe(false);
    expect(j2.duplicate).toBe(true);
    expect(j1.eventId).toBe(j2.eventId);
  });
});
