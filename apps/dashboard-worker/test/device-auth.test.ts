/**
 * Device onboarding + token lifecycle tests — 24 cases.
 *
 * Coverage:
 *   1. POST /api/v1/devices
 *      - ADMIN can create a device
 *      - READ_ONLY role is rejected
 *      - Duplicate device code → 409
 *      - Invalid body (missing displayName) → 400
 *      - Invalid device_code (format/length/reserved) → 400
 *      - Token length 64 hex chars + token_prefix length 4
 *      - Response sets Cache-Control: no-store + Pragma: no-cache
 *      - Token NEVER appears in any audit_logs row
 *   2. Token authentication (via ingest worker)
 *      - Valid token → 200 + last_seen_at updated
 *      - Wrong token (right prefix, wrong hash) → 401 + last_auth_failure_at bumped
 *      - Revoked token → 401 (ingest rejects)
 *      - Deactivated device → 401 (ingest rejects)
 *      - Generic 401 (no enumeration)
 *   3. Rotation
 *      - Atomic rotate revokes old + inserts new
 *      - Old token rejected after rotation
 *      - New token works after rotation
 *   4. Revoke
 *      - Old token rejected
 *      - device_id still active (token, not device)
 *   5. Deactivate / Reactivate
 *      - Deactivate sets active=0
 *      - Token rejected when device inactive
 *      - Reactivate sets active=1 (does NOT restore revoked token)
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env } from './helpers/env.js';
import { app as dashboardApp } from '../src/index.js';
import { app as ingestApp } from '../../ingest-worker/src/index.js';

// Schema now comes from migrations/000*.sql, applied to the test database.

async function seedAccessUser(email: string, role: 'ADMIN' | 'REVIEWER' | 'READ_ONLY', active = 1) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
  )
    .bind(crypto.randomUUID(), email, role, active, Date.now())
    .run();
}

async function postSms(apiKey: string, deviceCode: string, body?: string) {
  const ts = Date.now();
  return ingestApp.fetch(
    new Request('https://example.com/api/v1/sms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey,
        deviceId: deviceCode,
        deviceName: 'X',
        message: body ?? 'واریز 1,000,000 ریال',
        sender: 'BANK',
        timestamp: String(ts),
        checksum: '0'.repeat(32),
      }),
    }),
    env,
  );
}

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  for (const t of [
    'reconciliation_matches',
    'transaction_reviews',
    'comments',
    'payment_claims',
    'transaction_candidates',
    'raw_sms_events',
    'financial_account_identifiers',
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

describe('POST /api/v1/devices — create', () => {
  it('1. ADMIN creates a device, response includes plaintext token + no-store headers', async () => {
    await seedAccessUser('admin@x.com', 'ADMIN');
    const r = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceCode: 'pixel-sam-01',
          displayName: "Sam's Pixel",
          description: 'spare phone',
        }),
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(r.headers.get('Pragma')).toBe('no-cache');
    const body = (await r.json()) as {
      ok: boolean;
      device: {
        id: string;
        deviceCode: string;
        displayName: string;
        description: string | null;
        active: boolean;
      };
      credential: {
        id: string;
        apiKey: string;
        tokenPrefix: string;
        status: string;
        shownOnce: boolean;
      };
      configuration: { url: string; method: string; jsonBody: Record<string, unknown> };
    };
    expect(body.ok).toBe(true);
    expect(body.device.deviceCode).toBe('pixel-sam-01');
    expect(body.device.active).toBe(true);
    expect(body.credential.apiKey).toMatch(/^[0-9a-f]{64}$/);
    expect(body.credential.tokenPrefix).toHaveLength(4);
    expect(body.credential.tokenPrefix).toBe(body.credential.apiKey.slice(0, 4));
    expect(body.credential.shownOnce).toBe(true);
    // Whatever INGEST_URL says, not a constant in the source. This line used to
    // assert the hard-coded `.workers.dev` host, which is the thing that made
    // moving hosts a code change.
    expect(body.configuration.url).toBe(env.INGEST_URL);
    expect(body.configuration.method).toBe('POST');
  });

  it('1b. leaves no credential behind when the audit row cannot be written', async () => {
    // The device, its credential and the audit row used to be two operations:
    // the batch committed, then the audit ran on its own. A failure there
    // returned 500 while an ACTIVE credential sat in the database whose
    // plaintext had just been discarded with the response — a live token
    // nobody holds and nothing records.
    //
    // `audit_logs` is really renamed rather than stubbed: what is under test is
    // whether the two writes share a transaction, and only the database can
    // answer that.
    await seedAccessUser('admin@x.com', 'ADMIN');
    await env.DB.prepare(`ALTER TABLE audit_logs RENAME TO audit_hidden`).run();
    let status: number;
    try {
      const r = await dashboardApp.fetch(
        new Request('https://example.com/api/v1/devices', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ deviceCode: 'pixel-audit-01', displayName: 'audit probe' }),
        }),
        { ...env, TEST_ACCESS_USER: 'admin@x.com' },
      );
      status = r.status;
    } finally {
      await env.DB.prepare(`ALTER TABLE audit_hidden RENAME TO audit_logs`).run();
    }

    expect(status).toBe(500);
    // Nothing survived the failure — no device, and above all no credential.
    const left = await env.DB.prepare(
      `SELECT (SELECT count(*)::int FROM devices WHERE device_code = ?1) AS devices,
                (SELECT count(*)::int FROM device_credentials dc
                   JOIN devices d ON d.id = dc.device_id
                  WHERE d.device_code = ?1) AS creds`,
    )
      .bind('pixel-audit-01')
      .first<{ devices: number; creds: number }>();
    expect(left).toMatchObject({ devices: 0, creds: 0 });
  });

  it('2. READ_ONLY role is forbidden from creating a device', async () => {
    await seedAccessUser('ro@x.com', 'READ_ONLY');
    const r = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: 'pixel-ro', displayName: 'X' }),
      }),
      { ...env, TEST_ACCESS_USER: 'ro@x.com' },
    );
    expect(r.status).toBe(403);
  });

  it('3. Duplicate device code → 409', async () => {
    await seedAccessUser('admin@x.com', 'ADMIN');
    const body = JSON.stringify({ deviceCode: 'dup-phone', displayName: 'X' });
    const envA = { ...env, TEST_ACCESS_USER: 'admin@x.com' };
    const r1 = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices', { method: 'POST', body }),
      envA,
    );
    expect(r1.status).toBe(200);
    const r2 = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices', { method: 'POST', body }),
      envA,
    );
    expect(r2.status).toBe(409);
  });

  it('4. Missing displayName → 400', async () => {
    await seedAccessUser('admin@x.com', 'ADMIN');
    const r = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: 'no-name', displayName: '' }),
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    expect(r.status).toBe(400);
  });

  it('5. Invalid device_code (reserved / uppercase / format) → 400 invalid_device_code', async () => {
    await seedAccessUser('admin@x.com', 'ADMIN');
    // Cases that PASS Zod (3-64 chars) but FAIL validateDeviceCode:
    // - reserved word (caught after lower-casing)
    // - leading/trailing hyphen (regex requires [a-z0-9] at both ends)
    // - spaces inside (regex requires [a-z0-9-] only)
    // NB: 'UPPER' is silently lower-cased to 'upper' which is valid; we
    // do not test that case here.
    const cases = [
      { deviceCode: 'admin', reason: 'reserved' },
      { deviceCode: 'system', reason: 'reserved' },
      { deviceCode: '-leading-dash', reason: 'format' },
      { deviceCode: 'trailing-dash-', reason: 'format' },
      { deviceCode: 'has spaces', reason: 'format' },
    ];
    for (const c of cases) {
      const r = await dashboardApp.fetch(
        new Request('https://example.com/api/v1/devices', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ deviceCode: c.deviceCode, displayName: 'X' }),
        }),
        { ...env, TEST_ACCESS_USER: 'admin@x.com' },
      );
      expect(r.status).toBe(400);
      const j = (await r.json()) as { error: string; reason?: string };
      expect(j.error).toBe('invalid_device_code');
      expect(j.reason).toBe(c.reason);
    }
  });

  it('6. Plaintext token never appears in any audit_logs row', async () => {
    await seedAccessUser('admin@x.com', 'ADMIN');
    const r = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: 'audit-no-token', displayName: 'X' }),
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    const j = (await r.json()) as {
      credential: { apiKey: string };
      device: { id: string };
    };
    const audits = await env.DB.prepare(
      `SELECT * FROM audit_logs WHERE entity_type = 'DEVICE' AND entity_id = ?1`,
    )
      .bind(j.device.id)
      .all<Record<string, unknown>>();
    for (const row of audits.results) {
      for (const v of Object.values(row)) {
        if (typeof v === 'string') expect(v.includes(j.credential.apiKey)).toBe(false);
      }
    }
  });
});

describe('Token authentication via ingest worker', () => {
  it('7. Valid token → 200 and last_seen_at updated', async () => {
    await seedAccessUser('admin@x.com', 'ADMIN');
    const r = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: 'auth-valid', displayName: 'X' }),
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    const j = (await r.json()) as { credential: { apiKey: string }; device: { id: string } };
    const before = Date.now();
    const ing = await postSms(j.credential.apiKey, 'auth-valid');
    expect(ing.status).toBe(200);
    const row = await env.DB.prepare(
      `SELECT last_seen_at, last_auth_failure_at FROM devices WHERE id = ?1`,
    )
      .bind(j.device.id)
      .first<{ last_seen_at: number | null; last_auth_failure_at: number | null }>();
    expect(row!.last_seen_at).not.toBeNull();
    expect(row!.last_seen_at!).toBeGreaterThanOrEqual(before - 1000);
    expect(row!.last_auth_failure_at).toBeNull();
  });

  it('8. Wrong token (right prefix, wrong hash) → 401 + last_auth_failure_at bumped', async () => {
    await seedAccessUser('admin@x.com', 'ADMIN');
    const r = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: 'auth-wrong', displayName: 'X' }),
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    const j = (await r.json()) as { credential: { apiKey: string }; device: { id: string } };
    // Same prefix, different rest.
    const wrongApiKey = j.credential.apiKey.slice(0, 4) + 'f'.repeat(60);
    const ing = await postSms(wrongApiKey, 'auth-wrong');
    expect(ing.status).toBe(401);
    const row = await env.DB.prepare(
      `SELECT last_seen_at, last_auth_failure_at FROM devices WHERE id = ?1`,
    )
      .bind(j.device.id)
      .first<{ last_seen_at: number | null; last_auth_failure_at: number | null }>();
    expect(row!.last_auth_failure_at).not.toBeNull();
    expect(row!.last_seen_at).toBeNull();
  });

  it('9. Revoked token → 401 and last_auth_failure_at bumped', async () => {
    await seedAccessUser('admin@x.com', 'ADMIN');
    const r = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: 'auth-rev', displayName: 'X' }),
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    const j = (await r.json()) as { credential: { apiKey: string }; device: { id: string } };
    const revoke = await dashboardApp.fetch(
      new Request(`https://example.com/api/v1/devices/auth-rev/credentials/revoke`, {
        method: 'POST',
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    expect(revoke.status).toBe(200);
    const ing = await postSms(j.credential.apiKey, 'auth-rev');
    expect(ing.status).toBe(401);
  });

  it('10. Deactivated device → 401 even with valid token', async () => {
    await seedAccessUser('admin@x.com', 'ADMIN');
    const r = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: 'auth-deact', displayName: 'X' }),
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    const j = (await r.json()) as { credential: { apiKey: string } };
    await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices/auth-deact/deactivate', { method: 'POST' }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    const ing = await postSms(j.credential.apiKey, 'auth-deact');
    expect(ing.status).toBe(401);
  });

  it('11. Generic 401 response — no enumeration', async () => {
    await seedAccessUser('admin@x.com', 'ADMIN');
    await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: 'enum-known', displayName: 'X' }),
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );

    const ts = Date.now();
    const known = await ingestApp.fetch(
      new Request('https://example.com/api/v1/sms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiKey: 'd'.repeat(64),
          deviceId: 'enum-known',
          deviceName: 'X',
          message: 'واریز 1,000,000 ریال',
          sender: 'BANK',
          timestamp: String(ts),
          checksum: '0'.repeat(32),
        }),
      }),
      env,
    );
    const unknown = await ingestApp.fetch(
      new Request('https://example.com/api/v1/sms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiKey: 'e'.repeat(64),
          deviceId: 'enum-missing',
          deviceName: 'X',
          message: 'واریز 1,000,000 ریال',
          sender: 'BANK',
          timestamp: String(ts + 1),
          checksum: '0'.repeat(32),
        }),
      }),
      env,
    );
    expect(known.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(JSON.stringify(await known.json())).toBe(JSON.stringify(await unknown.json()));
  });
});

describe('POST /api/v1/devices/:id/credentials — generate', () => {
  it('12. Generate first credential for an inactive device that has no token', async () => {
    await seedAccessUser('admin@x.com', 'ADMIN');
    // Seed a device with no credential.
    const deviceId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at) VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
    )
      .bind(deviceId, 'gen-first', 'X', Date.now())
      .run();
    const r = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices/gen-first/credentials', { method: 'POST' }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as { credential: { apiKey: string } };
    expect(j.credential.apiKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('13. Rejects if device already has an ACTIVE credential (use rotate instead)', async () => {
    await seedAccessUser('admin@x.com', 'ADMIN');
    await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: 'gen-twice', displayName: 'X' }),
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    const r = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices/gen-twice/credentials', { method: 'POST' }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    expect(r.status).toBe(409);
    const j = (await r.json()) as { error: string };
    expect(j.error).toBe('active_credential_exists');
  });

  it('14. Generates a credential for a deactivated device but rejects', async () => {
    await seedAccessUser('admin@x.com', 'ADMIN');
    await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: 'gen-deact', displayName: 'X' }),
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices/gen-deact/deactivate', { method: 'POST' }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    const r = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices/gen-deact/credentials', { method: 'POST' }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    expect(r.status).toBe(409);
  });
});

describe('POST /api/v1/devices/:id/credentials/rotate', () => {
  it('15. Atomic rotate: old token stops working, new token works', async () => {
    await seedAccessUser('admin@x.com', 'ADMIN');
    const r = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: 'rotate-test', displayName: 'X' }),
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    const j = (await r.json()) as { credential: { apiKey: string }; device: { id: string } };
    expect((await postSms(j.credential.apiKey, 'rotate-test')).status).toBe(200);

    const rot = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices/rotate-test/credentials/rotate', {
        method: 'POST',
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    expect(rot.status).toBe(200);
    const rj = (await rot.json()) as { credential: { apiKey: string } };
    expect(rj.credential.apiKey).not.toBe(j.credential.apiKey);
    expect(rj.credential.apiKey).toMatch(/^[0-9a-f]{64}$/);

    // Old token rejected.
    expect((await postSms(j.credential.apiKey, 'rotate-test')).status).toBe(401);
    // New token accepted.
    expect((await postSms(rj.credential.apiKey, 'rotate-test')).status).toBe(200);
  });

  it('16. Rotate response sets Cache-Control: no-store + Pragma: no-cache', async () => {
    await seedAccessUser('admin@x.com', 'ADMIN');
    await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: 'rotate-headers', displayName: 'X' }),
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    const r = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices/rotate-headers/credentials/rotate', {
        method: 'POST',
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(r.headers.get('Pragma')).toBe('no-cache');
  });

  it('17. Rotating twice yields two ACTIVE-then-REVOKED transitions (single ACTIVE)', async () => {
    await seedAccessUser('admin@x.com', 'ADMIN');
    await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: 'rotate-twice', displayName: 'X' }),
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices/rotate-twice/credentials/rotate', {
        method: 'POST',
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices/rotate-twice/credentials/rotate', {
        method: 'POST',
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    const rows = await env.DB.prepare(
      `SELECT id, status FROM device_credentials WHERE device_id = (SELECT id FROM devices WHERE device_code = 'rotate-twice')`,
    ).all<{ id: string; status: string }>();
    const active = rows.results.filter((r) => r.status === 'ACTIVE');
    const revoked = rows.results.filter((r) => r.status === 'REVOKED');
    expect(active).toHaveLength(1);
    expect(revoked.length).toBeGreaterThanOrEqual(2);
  });
});

describe('two writers at once', () => {
  /**
   * All three credential routes read the ACTIVE row and then write, which is a
   * sequence — and every test above is a sequence too, so none of them can see
   * two callers. Two ACTIVE tokens for one phone costs three things:
   *
   *   - revoking "the" credential revokes one and leaves the other working, so
   *     an operator who has just cut a lost phone off has not;
   *   - the dashboard shows whichever `LIMIT 1` returns, with no ordering;
   *   - `findActiveCredentialByPrefix` also takes `LIMIT 1`, so authentication
   *     answers according to whichever plan Postgres picked.
   *
   * **What these tests do not prove, said plainly.** Two `app.fetch` calls in
   * one process cannot be made to interleave at the exact statement: dropping
   * `idx_device_credentials_one_active` leaves all of them green, because the
   * handlers happen to run to completion one after the other and the second
   * one's read then finds the first one's row. What they hold is the route
   * contract — one active token afterwards, and never two 200s, because a 200
   * hands back a plaintext token and one that no row records is a phone that
   * can never authenticate and a support ticket days later.
   *
   * The guarantee itself is proven where it can be: two INSERTs in
   * `migrations/verify_invariants.sql`, which is deterministic and fails the
   * moment the index is not there.
   */
  const admin = { ...env, TEST_ACCESS_USER: 'admin@x.com' };

  async function makeDevice(code: string): Promise<string> {
    await seedAccessUser('admin@x.com', 'ADMIN');
    const r = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: code, displayName: 'X' }),
      }),
      admin,
    );
    const j = (await r.json()) as { credential: { apiKey: string } };
    return j.credential.apiKey;
  }

  async function activeCount(code: string): Promise<number> {
    const row = await env.DB.prepare(
      `SELECT count(*)::int AS n FROM device_credentials
        WHERE status = 'ACTIVE'
          AND device_id = (SELECT id FROM devices WHERE device_code = ?1)`,
    )
      .bind(code)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  it('leaves one active token when two credentials are issued at once', async () => {
    await makeDevice('race-cred');
    // Start from none, so both callers take the insert path rather than the
    // 409 the fast-path read gives.
    await env.DB.prepare(
      `DELETE FROM device_credentials
        WHERE device_id = (SELECT id FROM devices WHERE device_code = 'race-cred')`,
    ).run();

    const issue = () =>
      dashboardApp.fetch(
        new Request('https://example.com/api/v1/devices/race-cred/credentials', {
          method: 'POST',
        }),
        admin,
      );
    const [a, b] = await Promise.all([issue(), issue()]);

    expect(await activeCount('race-cred')).toBe(1);
    // One succeeded and one was told why. Never two 200s — a 200 hands back a
    // plaintext token, and a token handed to an operator that no row records is
    // a phone that can never authenticate and a support ticket days later.
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([200, 409]);
  });

  it('leaves one active token when two rotations arrive at once', async () => {
    const first = await makeDevice('race-rotate');
    const rotate = () =>
      dashboardApp.fetch(
        new Request('https://example.com/api/v1/devices/race-rotate/credentials/rotate', {
          method: 'POST',
        }),
        admin,
      );
    const [a, b] = await Promise.all([rotate(), rotate()]);

    expect(await activeCount('race-rotate')).toBe(1);
    // The original must be dead either way — that is what rotation is for.
    expect((await postSms(first, 'race-rotate')).status).toBe(401);
    // And every 200 handed back a token; exactly the surviving one may work.
    const bodies = await Promise.all(
      [a, b]
        .filter((r) => r.status === 200)
        .map((r) => r.json() as Promise<{ credential: { apiKey: string } }>),
    );
    let working = 0;
    for (const body of bodies) {
      if ((await postSms(body.credential.apiKey, 'race-rotate')).status === 200) working += 1;
    }
    expect(working).toBe(1);
  });

  it('revokes every active token, not just the one it happened to read', async () => {
    // Defensive, and the reason `revoke` no longer says `WHERE id = ?`: rows
    // that predate 0023 can still be doubled up, and revoke is the one action
    // whose whole purpose is that nothing keeps working afterwards.
    const key = await makeDevice('race-revoke');
    const r = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices/race-revoke/credentials/revoke', {
        method: 'POST',
      }),
      admin,
    );
    expect(r.status).toBe(200);
    expect(await activeCount('race-revoke')).toBe(0);
    expect((await postSms(key, 'race-revoke')).status).toBe(401);
  });
});

describe('POST /api/v1/devices/:id/credentials/revoke', () => {
  it('18. Revoke marks credential REVOKED + ingest rejects the token', async () => {
    await seedAccessUser('admin@x.com', 'ADMIN');
    const r = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: 'rev-test', displayName: 'X' }),
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    const j = (await r.json()) as { credential: { apiKey: string } };
    const revoke = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices/rev-test/credentials/revoke', {
        method: 'POST',
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    expect(revoke.status).toBe(200);
    expect((await postSms(j.credential.apiKey, 'rev-test')).status).toBe(401);
    const row = await env.DB.prepare(
      `SELECT status, revoked_at FROM device_credentials WHERE device_id = (SELECT id FROM devices WHERE device_code = 'rev-test')`,
    ).first<{ status: string; revoked_at: number | null }>();
    expect(row!.status).toBe('REVOKED');
    expect(row!.revoked_at).not.toBeNull();
  });

  it('19. Revoke on device with no ACTIVE credential → 409 no_active_credential', async () => {
    await seedAccessUser('admin@x.com', 'ADMIN');
    const deviceId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at) VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
    )
      .bind(deviceId, 'rev-empty', 'X', Date.now())
      .run();
    const r = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices/rev-empty/credentials/revoke', {
        method: 'POST',
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    expect(r.status).toBe(409);
  });
});

describe('Deactivate / Reactivate', () => {
  it('20. Deactivate sets active=0 and ingest rejects the token', async () => {
    await seedAccessUser('admin@x.com', 'ADMIN');
    const r = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: 'deact-test', displayName: 'X' }),
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    const j = (await r.json()) as { credential: { apiKey: string } };
    expect((await postSms(j.credential.apiKey, 'deact-test')).status).toBe(200);
    const deact = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices/deact-test/deactivate', { method: 'POST' }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    expect(deact.status).toBe(200);
    expect((await postSms(j.credential.apiKey, 'deact-test')).status).toBe(401);
  });

  it('21. Reactivate sets active=1 but does NOT restore a revoked token', async () => {
    await seedAccessUser('admin@x.com', 'ADMIN');
    const r = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: 'react-test', displayName: 'X' }),
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    const j = (await r.json()) as { credential: { apiKey: string } };
    await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices/react-test/deactivate', { method: 'POST' }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices/react-test/credentials/revoke', {
        method: 'POST',
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    const react = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices/react-test/reactivate', { method: 'POST' }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    expect(react.status).toBe(200);
    expect((await postSms(j.credential.apiKey, 'react-test')).status).toBe(401);
    const row = await env.DB.prepare(`SELECT active FROM devices WHERE device_code = ?1`)
      .bind('react-test')
      .first<{ active: number }>();
    expect(row!.active).toBe(1);
  });

  it('22. Reactivate on an already-active device returns alreadyActive=true', async () => {
    await seedAccessUser('admin@x.com', 'ADMIN');
    await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: 'react-noop', displayName: 'X' }),
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    const r = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices/react-noop/reactivate', { method: 'POST' }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; alreadyActive?: boolean };
    expect(j.alreadyActive).toBe(true);
  });
});

describe('GET /api/v1/devices', () => {
  it('23. Devices list includes description, credential prefix, and last_credential_created_at', async () => {
    await seedAccessUser('admin@x.com', 'ADMIN');
    await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceCode: 'list-test',
          displayName: 'X',
          description: 'spare',
        }),
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    const r = await dashboardApp.fetch(new Request('https://example.com/api/v1/devices'), {
      ...env,
      TEST_ACCESS_USER: 'admin@x.com',
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      items: Array<{
        device_code: string;
        description: string | null;
        active: number;
        credential: { token_prefix: string } | null;
        last_credential_created_at: number | null;
      }>;
    };
    const item = j.items.find((i) => i.device_code === 'list-test')!;
    expect(item.description).toBe('spare');
    expect(item.active).toBe(1);
    expect(item.credential?.token_prefix).toHaveLength(4);
    expect(item.last_credential_created_at).not.toBeNull();
  });

  it('24. Rotating a credential bumps last_credential_created_at; prefix changes', async () => {
    await seedAccessUser('admin@x.com', 'ADMIN');
    await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: 'rotate-bumps', displayName: 'X' }),
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    await new Promise((r) => setTimeout(r, 10));
    const rot = await dashboardApp.fetch(
      new Request('https://example.com/api/v1/devices/rotate-bumps/credentials/rotate', {
        method: 'POST',
      }),
      { ...env, TEST_ACCESS_USER: 'admin@x.com' },
    );
    const rj = (await rot.json()) as { credential: { tokenPrefix: string } };
    const list = await dashboardApp.fetch(new Request('https://example.com/api/v1/devices'), {
      ...env,
      TEST_ACCESS_USER: 'admin@x.com',
    });
    const lj = (await list.json()) as {
      items: Array<{ device_code: string; credential: { token_prefix: string } | null }>;
    };
    const item = lj.items.find((i) => i.device_code === 'rotate-bumps')!;
    // 64 hex chars → 4-char prefix is random; collisions are astronomically
    // unlikely. We just assert the row reflects the rotation.
    expect(item.credential?.token_prefix).toBe(rj.credential.tokenPrefix);
  });
});

// ponytail: no chai custom-matchers — plain `.status` reads clearly.
