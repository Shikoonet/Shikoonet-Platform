/**
 * Vertical-slice integration test for the ingest Worker.
 *
 * Architecture (Option 2 from docs/verification/d1-isolate-root-cause.md):
 * - Schema is applied and rows are seeded using `env.DB` directly.
 * - The Worker is invoked via `app.fetch(request, env)` so the test and
 *   the Worker share the same D1 binding instance.
 * - No `SELF.fetch` (cross-isolate), no `setupFiles` (different module
 *   scope).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { applySchema, env } from './helpers/env.js';
import { app } from '../src/index.js';

// Schema now comes from migrations/000*.sql, applied to the test database.

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface SeedArgs {
  deviceCode?: string;
  deviceName?: string;
  apiKey?: string;
  deviceActive?: boolean;
  credentialStatus?: 'ACTIVE' | 'ROTATING' | 'REVOKED';
  preSeed?: (db: typeof env.DB) => Promise<void>;
}

async function seedDevice(args: SeedArgs = {}) {
  const deviceCode = args.deviceCode ?? 'phone-test';
  const deviceName = args.deviceName ?? 'Test Phone';
  const apiKey = args.apiKey ?? 'a'.repeat(40);
  const now = Date.now();

  // Look up existing device by code; reuse its id so credentials point at it.
  const existing = await env.DB.prepare(`SELECT id FROM devices WHERE device_code = ?1`)
    .bind(deviceCode)
    .first<{ id: string }>();
  const deviceId = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO devices (id, device_code, display_name, description, active, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?5)`,
    )
      .bind(deviceId, deviceCode, deviceName, args.deviceActive === false ? 0 : 1, now)
      .run();
  } else if (args.deviceActive === false) {
    await env.DB.prepare(`UPDATE devices SET active = 0, updated_at = ?2 WHERE id = ?1`)
      .bind(deviceId, now)
      .run();
  }

  const tokenHash = await sha256Hex(apiKey);
  const credId = crypto.randomUUID();
  // Replace any prior credential for this device+prefix so the seed is
  // idempotent across tests that share deviceCode+apiKey.
  // Delete by token_hash, not by device+prefix. `token_hash` is UNIQUE, and
  // several fixtures deliberately reuse the same apiKey across different device
  // codes — so a prior device's credential collides even though it belongs to
  // another device. The old per-file database hid this; one shared database
  // does not.
  await env.DB.prepare(`DELETE FROM device_credentials WHERE token_hash = ?1`)
    .bind(tokenHash)
    .run();
  await env.DB.prepare(
    `INSERT INTO device_credentials (id, device_id, token_hash, token_prefix, status, created_at, activated_at, revoked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)`,
  )
    .bind(
      credId,
      deviceId,
      tokenHash,
      apiKey.slice(0, 4),
      args.credentialStatus ?? 'ACTIVE',
      now,
      args.credentialStatus === 'REVOKED' ? now : null,
    )
    .run();
  return { deviceId, credId, apiKey, deviceCode, deviceName };
}

async function postSms(body: Record<string, unknown>): Promise<Response> {
  return app.fetch(
    new Request('https://example.com/api/v1/sms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );
}

const baseBody = (overrides: Record<string, unknown> = {}) => ({
  apiKey: 'a'.repeat(40),
  deviceId: 'phone-test',
  deviceName: 'Test Phone',
  message: 'واریز 50,000 ریال به کارت *1234 - مانده 250,000 ریال',
  sender: 'BANK',
  timestamp: String(Date.now()),
  checksum: 'a'.repeat(32),
  ...overrides,
});

beforeAll(async () => {
  await applySchema();
});

describe('ingest worker — authentication', () => {
  it('valid device + valid token → success, persists exactly once', async () => {
    const s = await seedDevice();
    const ts = Date.now();
    const body = baseBody({
      apiKey: s.apiKey,
      deviceId: s.deviceCode,
      deviceName: s.deviceName,
      timestamp: String(ts),
    });

    const r1 = await postSms(body);
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as { ok: boolean; eventId: string; duplicate: boolean };
    expect(j1.ok).toBe(true);
    expect(j1.duplicate).toBe(false);

    const r2 = await postSms(body);
    expect(r2.status).toBe(200);
    const j2 = (await r2.json()) as { eventId: string; duplicate: boolean; status: string };
    expect(j2.eventId).toBe(j1.eventId);
    expect(j2.duplicate).toBe(true);
    expect(j2.status).toBe('already_received');

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM raw_sms_events WHERE device_id = ?1`,
    )
      .bind(s.deviceId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);

    const txRows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM transaction_candidates WHERE raw_sms_event_id = ?1`,
    )
      .bind(j1.eventId)
      .first<{ n: number }>();
    expect(txRows?.n).toBe(1);
  });

  it('invalid token → generic 401, no row created', async () => {
    const s = await seedDevice({ deviceCode: 'phone-bad-key', apiKey: 'a'.repeat(40) });
    const ts = Date.now() + 1;
    const body = baseBody({
      apiKey: 'b'.repeat(40),
      deviceId: s.deviceCode,
      deviceName: s.deviceName,
      timestamp: String(ts),
    });
    const r = await postSms(body);
    expect(r.status).toBe(401);
    const j = (await r.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toBe('unauthorized');

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM raw_sms_events WHERE device_id = ?1`,
    )
      .bind(s.deviceId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('unknown device → generic 401 (same shape as invalid token)', async () => {
    await seedDevice({ deviceCode: 'phone-known' });
    const ts = Date.now() + 2;
    const body = baseBody({
      deviceId: 'phone-missing',
      apiKey: 'c'.repeat(40),
      timestamp: String(ts),
    });
    const r = await postSms(body);
    expect(r.status).toBe(401);

    // Confirm response shape is identical to invalid token (allow extra
    // diagnostic `code` field; security contract is just ok=false+error).
    const j = (await r.json()) as { ok: boolean; error: string; code?: string };
    expect(j.ok).toBe(false);
    expect(j.error).toBe('unauthorized');
  });

  it('revoked credential → generic 401', async () => {
    const s = await seedDevice({ deviceCode: 'phone-revoked', credentialStatus: 'REVOKED' });
    const r = await postSms(
      baseBody({ deviceId: s.deviceCode, apiKey: s.apiKey, timestamp: String(Date.now() + 3) }),
    );
    expect(r.status).toBe(401);
  });

  it('disabled device → generic 401', async () => {
    const s = await seedDevice({ deviceCode: 'phone-disabled', deviceActive: false });
    const r = await postSms(
      baseBody({ deviceId: s.deviceCode, apiKey: s.apiKey, timestamp: String(Date.now() + 4) }),
    );
    expect(r.status).toBe(401);
  });

  it('apiKey never stored in raw_sms_events or audit_logs', async () => {
    const s = await seedDevice();
    const ts = Date.now() + 5;
    const apiKey = s.apiKey;
    const r = await postSms(
      baseBody({ apiKey, deviceId: s.deviceCode, deviceName: s.deviceName, timestamp: String(ts) }),
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as { eventId: string };

    // Sweep every persisted row for the literal apiKey.
    const sweep = (await env.DB.batch([
      env.DB.prepare(
        `SELECT normalized_body, encrypted_or_protected_body, sender FROM raw_sms_events WHERE id = ?1`,
      ).bind(j.eventId),
      env.DB.prepare(
        `SELECT actor_email, action, before_json, after_json, reason FROM audit_logs WHERE entity_id = ?1`,
      ).bind(j.eventId),
    ])) as D1Result<Record<string, unknown>>[];
    for (const result of sweep) {
      for (const row of result.results) {
        for (const v of Object.values(row)) {
          if (typeof v === 'string') {
            expect(v.includes(apiKey)).toBe(false);
          } else if (v !== null) {
            expect(JSON.stringify(v).includes(apiKey)).toBe(false);
          }
        }
      }
    }
  });

  it('same checksum from different devices → not deduplicated across devices', async () => {
    // Distinct apiKeys so the token_hash uniqueness doesn't collide, since
    // the spec asserts the dedupe fingerprint uses (deviceId, sender,
    // timestamp, normalized_body) — the app_checksum alone must not merge.
    const a = await seedDevice({ deviceCode: 'phone-a', apiKey: 'a'.repeat(40) });
    const b = await seedDevice({ deviceCode: 'phone-b', apiKey: 'b'.repeat(40) });
    const sameChecksum = 'abcdef0123456789abcdef0123456789';
    const ts = Date.now() + 6;
    const bodyA = baseBody({
      deviceId: a.deviceCode,
      apiKey: a.apiKey,
      timestamp: String(ts),
      checksum: sameChecksum,
    });
    const bodyB = baseBody({
      deviceId: b.deviceCode,
      apiKey: b.apiKey,
      timestamp: String(ts),
      checksum: sameChecksum,
    });
    // different bodies too — same checksum should still not merge.
    bodyA.message = 'واریز 10,000 ریال';
    bodyB.message = 'برداشت 10,000 ریال';

    const ra = await postSms(bodyA);
    const rb = await postSms(bodyB);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    const ja = (await ra.json()) as { eventId: string };
    const jb = (await rb.json()) as { eventId: string };
    expect(ja.eventId).not.toBe(jb.eventId);

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM raw_sms_events WHERE app_checksum = ?1`,
    )
      .bind(sameChecksum)
      .first<{ n: number }>();
    expect(rows?.n).toBe(2);
  });

  it('oversized body (via Content-Length header) → 413 PAYLOAD_TOO_LARGE', async () => {
    const s = await seedDevice({ deviceCode: 'phone-big' });
    const body = baseBody({ deviceId: s.deviceCode, apiKey: s.apiKey });
    const bodyStr = JSON.stringify(body);
    const r = await app.fetch(
      new Request('https://example.com/api/v1/sms', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '99999' },
        body: bodyStr,
      }),
      env,
    );
    expect(r.status).toBe(413);
  });

  it('oversized message (above Zod cap) → 400 BAD_REQUEST', async () => {
    const s = await seedDevice({ deviceCode: 'phone-huge-msg' });
    const huge = 'x'.repeat(5_000);
    const r = await postSms(baseBody({ deviceId: s.deviceCode, apiKey: s.apiKey, message: huge }));
    expect(r.status).toBe(400);
  });

  it('missing field → 400 BAD_REQUEST', async () => {
    const s = await seedDevice({ deviceCode: 'phone-bad-body' });
    const body = baseBody({ deviceId: s.deviceCode, apiKey: s.apiKey });
    delete (body as Record<string, unknown>).message;
    const r = await postSms(body);
    expect(r.status).toBe(400);
  });

  it('invalid timestamp → 400', async () => {
    const s = await seedDevice({ deviceCode: 'phone-bad-ts' });
    const r = await postSms(
      baseBody({ deviceId: s.deviceCode, apiKey: s.apiKey, timestamp: 'not-a-number' }),
    );
    expect(r.status).toBe(400);
    const j = (await r.json()) as { ok: boolean; error: string };
    expect(j.error).toBe('invalid_timestamp');
  });
});

describe('ingest worker — iPhone compatibility', () => {
  it('Android epoch-ms + checksum → unchanged pass', async () => {
    const s = await seedDevice({ deviceCode: 'phone-android' });
    const ts = Date.now();
    const body = baseBody({
      apiKey: s.apiKey,
      deviceId: s.deviceCode,
      deviceName: s.deviceName,
      timestamp: String(ts),
      checksum: 'deadbeef'.repeat(4),
    });
    const r = await postSms(body);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; duplicate: boolean };
    expect(j.ok).toBe(true);
    expect(j.duplicate).toBe(false);

    const row = await env.DB.prepare(
      `SELECT sms_timestamp, app_checksum FROM raw_sms_events WHERE device_id = ?1`,
    )
      .bind(s.deviceId)
      .first<{ sms_timestamp: number; app_checksum: string }>();
    expect(row?.sms_timestamp).toBe(ts);
    expect(row?.app_checksum).toBe('deadbeef'.repeat(4));
  });

  it('iPhone ISO timestamp + no checksum → pass', async () => {
    const s = await seedDevice({ deviceCode: 'phone-iphone-no-cs' });
    const iso = '2026-08-07T14:06:45Z';
    const expectedMs = Date.parse(iso);
    const { checksum: _omit, ...withoutChecksum } = baseBody({
      apiKey: s.apiKey,
      deviceId: s.deviceCode,
      deviceName: s.deviceName,
      timestamp: iso,
    });
    const r = await postSms(withoutChecksum);
    expect(r.status).toBe(200);

    const row = await env.DB.prepare(
      `SELECT sms_timestamp, app_checksum FROM raw_sms_events WHERE device_id = ?1`,
    )
      .bind(s.deviceId)
      .first<{ sms_timestamp: number; app_checksum: string }>();
    expect(row?.sms_timestamp).toBe(expectedMs);
    expect(row?.app_checksum).toBe('');
  });

  it('iPhone ISO timestamp + checksum → pass', async () => {
    const s = await seedDevice({ deviceCode: 'phone-iphone-cs' });
    const iso = '2026-08-07T17:06:45+03:00';
    const r = await postSms(
      baseBody({
        apiKey: s.apiKey,
        deviceId: s.deviceCode,
        deviceName: s.deviceName,
        timestamp: iso,
        checksum: 'abc123'.repeat(6).slice(0, 32),
      }),
    );
    expect(r.status).toBe(200);
    const row = await env.DB.prepare(
      `SELECT sms_timestamp, app_checksum FROM raw_sms_events WHERE device_id = ?1`,
    )
      .bind(s.deviceId)
      .first<{ sms_timestamp: number; app_checksum: string }>();
    expect(row?.sms_timestamp).toBe(Date.parse(iso));
    expect(row?.app_checksum).toBe('abc123'.repeat(6).slice(0, 32));
  });

  it('duplicate identical iPhone SMS → deduped via server body hash', async () => {
    const s = await seedDevice({ deviceCode: 'phone-iphone-dup' });
    const iso = '2026-08-07T14:10:00Z';
    const body = {
      apiKey: s.apiKey,
      deviceId: s.deviceCode,
      deviceName: s.deviceName,
      message: 'واریز 75,000 ریال',
      sender: 'BANK',
      timestamp: iso,
    };
    const r1 = await postSms(body);
    const j1 = (await r1.json()) as { eventId: string; duplicate: boolean };
    expect(j1.duplicate).toBe(false);

    const r2 = await postSms(body);
    const j2 = (await r2.json()) as { eventId: string; duplicate: boolean; status: string };
    expect(j2.eventId).toBe(j1.eventId);
    expect(j2.duplicate).toBe(true);
    expect(j2.status).toBe('already_received');

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM raw_sms_events WHERE device_id = ?1`,
    )
      .bind(s.deviceId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('iPhone ISO timestamp + null checksum → pass', async () => {
    const s = await seedDevice({ deviceCode: 'phone-iphone-null-cs' });
    const iso = '2026-08-07T14:06:45Z';
    const r = await postSms(
      baseBody({
        apiKey: s.apiKey,
        deviceId: s.deviceCode,
        deviceName: s.deviceName,
        timestamp: iso,
        checksum: null,
      }),
    );
    expect(r.status).toBe(200);
  });

  it('Shortcuts-style ISO offset without colon → pass', async () => {
    const s = await seedDevice({ deviceCode: 'phone-shortcuts-iso' });
    const iso = '2026-08-07T17:06:45+0300';
    const r = await postSms({
      apiKey: s.apiKey,
      deviceId: s.deviceCode,
      deviceName: s.deviceName,
      message: 'test bank sms',
      sender: 'BANK',
      timestamp: iso,
    });
    expect(r.status).toBe(200);
    const row = await env.DB.prepare(
      `SELECT sms_timestamp FROM raw_sms_events WHERE device_id = ?1`,
    )
      .bind(s.deviceId)
      .first<{ sms_timestamp: number }>();
    expect(row?.sms_timestamp).toBe(Date.parse(iso));
  });

  it('iPhone Shortcuts lowercase apikey → pass', async () => {
    const s = await seedDevice({ deviceCode: 'iphone' });
    const r = await postSms({
      apikey: s.apiKey,
      deviceId: s.deviceCode,
      deviceName: 'iphone',
      message: 'واریز 90,000 ریال',
      sender: 'BANK',
    } as Record<string, unknown>);
    expect(r.status).toBe(200);
  });

  it('iPhone payload without timestamp → pass (server time used)', async () => {
    const s = await seedDevice({ deviceCode: 'phone-iphone-no-ts' });
    const before = Date.now();
    const r = await postSms({
      apiKey: s.apiKey,
      deviceId: s.deviceCode,
      deviceName: s.deviceName,
      message: 'واریز 90,000 ریال',
      sender: 'BANK',
    });
    const after = Date.now();
    expect(r.status).toBe(200);

    const row = await env.DB.prepare(
      `SELECT sms_timestamp FROM raw_sms_events WHERE device_id = ?1`,
    )
      .bind(s.deviceId)
      .first<{ sms_timestamp: number }>();
    expect(row!.sms_timestamp).toBeGreaterThanOrEqual(before);
    expect(row!.sms_timestamp).toBeLessThanOrEqual(after);
  });

  it('different devices with same iPhone message → not deduped across devices', async () => {
    const s1 = await seedDevice({ deviceCode: 'iphone-a', apiKey: 'd'.repeat(40) });
    const s2 = await seedDevice({ deviceCode: 'iphone-b', apiKey: 'e'.repeat(40) });
    const iso = '2026-08-07T14:11:00Z';
    const shared = {
      message: 'واریز 80,000 ریال',
      sender: 'BANK',
      timestamp: iso,
    };
    await postSms({ ...shared, apiKey: s1.apiKey, deviceId: s1.deviceCode, deviceName: s1.deviceName });
    await postSms({ ...shared, apiKey: s2.apiKey, deviceId: s2.deviceCode, deviceName: s2.deviceName });

    const n1 = await env.DB.prepare(`SELECT COUNT(*) AS n FROM raw_sms_events WHERE device_id = ?1`)
      .bind(s1.deviceId)
      .first<{ n: number }>();
    const n2 = await env.DB.prepare(`SELECT COUNT(*) AS n FROM raw_sms_events WHERE device_id = ?1`)
      .bind(s2.deviceId)
      .first<{ n: number }>();
    expect(n1?.n).toBe(1);
    expect(n2?.n).toBe(1);
  });
});

interface D1Result<T> {
  results: T[];
  success: boolean;
  meta: { duration: number; changes: number; last_row_id: number };
}

describe('ingest worker — OTP redaction', () => {
  it('OTP body never persisted, no transaction_candidate created', async () => {
    const s = await seedDevice({ deviceCode: 'phone-otp' });
    const r = await postSms(
      baseBody({
        deviceId: s.deviceCode,
        apiKey: s.apiKey,
        sender: 'FRIEND',
        message: 'کد تایید: 123456 - هرگز با کسی به اشتراک نگذارید',
        timestamp: String(Date.now() + 100),
      }),
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as { eventId: string };
    const ev = await env.DB.prepare(
      `SELECT classification, normalized_body, encrypted_or_protected_body FROM raw_sms_events WHERE id = ?1`,
    )
      .bind(j.eventId)
      .first<{
        classification: string;
        normalized_body: string | null;
        encrypted_or_protected_body: string | null;
      }>();
    expect(ev!.classification).toBe('OTP');
    expect(ev!.normalized_body).toBeNull();

    const txs = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM transaction_candidates WHERE raw_sms_event_id = ?1`,
    )
      .bind(j.eventId)
      .first<{ n: number }>();
    expect(txs?.n).toBe(0);
  });
});
