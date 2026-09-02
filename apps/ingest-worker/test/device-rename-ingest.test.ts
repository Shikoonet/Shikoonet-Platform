/**
 * A renamed device keeps ingesting — asked of both workers at once.
 *
 * This file exists because the rename feature had a bug that no single-worker
 * test could see. `updateDeviceSeen` used to write `devices.display_name` from
 * the `deviceName` field of the incoming SMS body, and the Android app re-sends
 * that field on every message from a configuration blob this platform generated
 * when the device was created. So the dashboard was not the owner of the name:
 * the phone was, and it won by being last.
 *
 * An operator would rename a device, watch it save, and find the old name back
 * the next time that phone relayed a bank SMS — minutes later, with nothing in
 * `audit_logs` to explain it, on a screen that had already told them it worked.
 * `device-rename.test.ts` passes either way; only the two workers together show
 * it.
 *
 * The rename here goes through the real `PATCH` route rather than a hand-written
 * `UPDATE`, so what is asserted is the shipped path and not a re-statement of it.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env, resetHub } from './helpers/env.js';
import { app } from '../src/index.js';
import { app as dashboardApp } from '@shikoo/dashboard';

const ADMIN = 'rename-ingest-admin@example.com';
const DEVICE_CODE = 'phone-rename-ingest';
const API_KEY = 'b'.repeat(64);
/** What the handset was configured with, and keeps sending forever. */
const NAME_ON_THE_PHONE = 'Old Phone Name';
const NEW_NAME = 'گوشی فروشگاه';

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function seed(): Promise<{ deviceId: string; credentialId: string; tokenHash: string }> {
  const now = Date.now();
  const deviceId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const tokenHash = await sha256Hex(API_KEY);
  await env.DB.prepare(
    // Upsert, because this fixture runs once per test and the email is a unique
    // key. Three tests in this file, three inserts, one constraint — the second
    // test failed on the first test's row rather than on anything it asserted.
    `INSERT INTO access_users (id, email, role, active, created_at, updated_at)
     VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)
     ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, active = 1`,
  )
    .bind(crypto.randomUUID(), ADMIN, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO devices (id, device_code, display_name, description, active, created_at, updated_at)
     VALUES (?1, ?2, ?3, NULL, 1, ?4, ?4)`,
  )
    .bind(deviceId, DEVICE_CODE, NAME_ON_THE_PHONE, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO device_credentials
       (id, device_id, token_hash, token_prefix, status, created_at, activated_at)
     VALUES (?1, ?2, ?3, ?4, 'ACTIVE', ?5, ?5)`,
  )
    .bind(credentialId, deviceId, tokenHash, API_KEY.slice(0, 4), now)
    .run();
  return { deviceId, credentialId, tokenHash };
}

/** Exactly what the Android app posts: same key, same code, same stale name. */
async function postSms(amount: number): Promise<Response> {
  return app.fetch(
    new Request('https://ingest.example.com/api/v1/sms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: API_KEY,
        deviceId: DEVICE_CODE,
        deviceName: NAME_ON_THE_PHONE,
        message: `واریز ${amount} ریال به کارت *1234 - مانده 250,000 ریال`,
        sender: 'BANK',
        timestamp: String(Date.now()),
        checksum: 'a'.repeat(32),
      }),
    }),
    env,
  );
}

async function renameThroughTheDashboard(idOrCode: string, displayName: string): Promise<Response> {
  return dashboardApp.fetch(
    new Request(`https://dashboard.example.com/api/v1/devices/${idOrCode}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName }),
    }),
    { ...env, TEST_ACCESS_USER: ADMIN, INGEST_URL: 'https://ingest.test/api/v1/sms' },
  );
}

const deviceRow = async (id: string) =>
  (await env.DB.prepare(`SELECT * FROM devices WHERE id = ?1`)
    .bind(id)
    .first<Record<string, unknown>>())!;

beforeAll(applySchema);
beforeEach(resetHub);

describe('a renamed device', () => {
  it('keeps ingesting with the key it already had, and keeps the new name', async () => {
    const { deviceId, credentialId, tokenHash } = await seed();

    // Before: the phone works.
    const before = await postSms(50_000);
    expect(before.status).toBe(200);
    expect((await before.json()) as { ok: boolean }).toMatchObject({ ok: true });

    const renamed = await renameThroughTheDashboard(deviceId, NEW_NAME);
    expect(renamed.status).toBe(200);
    expect((await deviceRow(deviceId)).display_name).toBe(NEW_NAME);

    // After: the same handset, unchanged, posting the name it was configured
    // with two months ago. It must be accepted, and it must not win.
    const after = await postSms(75_000);
    expect(after.status).toBe(200);
    const body = (await after.json()) as { ok: boolean; duplicate: boolean };
    expect(body.ok).toBe(true);
    expect(body.duplicate).toBe(false);

    const row = await deviceRow(deviceId);
    expect(row.display_name).toBe(NEW_NAME);
    expect(row.id).toBe(deviceId);
    expect(row.device_code).toBe(DEVICE_CODE);
    expect(row.active).toBe(1);
    // The ingest still recorded the visit and the success, which is the whole
    // point of it touching the row at all.
    expect(Number(row.last_seen_at)).toBeGreaterThan(0);
    expect(Number(row.last_success_at)).toBeGreaterThan(0);

    // No key was rotated, revoked, or minted.
    const creds = await env.DB.prepare(
      `SELECT * FROM device_credentials WHERE device_id = ?1 ORDER BY id`,
    )
      .bind(deviceId)
      .all<Record<string, unknown>>();
    expect(creds.results).toHaveLength(1);
    expect(creds.results[0]?.id).toBe(credentialId);
    expect(creds.results[0]?.token_hash).toBe(tokenHash);
    expect(creds.results[0]?.status).toBe('ACTIVE');
    expect(creds.results[0]?.revoked_at).toBeNull();

    // No device was recreated or duplicated.
    const n = await env.DB.prepare(`SELECT COUNT(*)::int AS n FROM devices`).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it('keeps the SMS it already carried, and the ones that arrive after', async () => {
    const { deviceId } = await seed();

    const first = await postSms(11_000);
    expect(first.status).toBe(200);
    const firstEventId = ((await first.json()) as { eventId: string }).eventId;

    expect((await renameThroughTheDashboard(DEVICE_CODE, NEW_NAME)).status).toBe(200);

    const second = await postSms(22_000);
    expect(second.status).toBe(200);

    // Both events, before and after the rename, on the same device id. The
    // history is attached to the identity, and renaming did not fork it.
    const events = await env.DB.prepare(
      `SELECT id, device_id FROM raw_sms_events ORDER BY received_at`,
    ).all<{ id: string; device_id: string }>();
    expect(events.results).toHaveLength(2);
    expect(events.results.map((e) => e.device_id)).toEqual([deviceId, deviceId]);
    expect(events.results[0]?.id).toBe(firstEventId);

    // And the transactions parsed out of them, which is what a payment claim
    // eventually matches against.
    const txs = await env.DB.prepare(
      `SELECT t.id FROM transaction_candidates t
         JOIN raw_sms_events r ON r.id = t.raw_sms_event_id
        WHERE r.device_id = ?1`,
    )
      .bind(deviceId)
      .all<{ id: string }>();
    expect(txs.results).toHaveLength(2);
  });

  it('still refuses a wrong key after the rename — the boundary did not move', async () => {
    const { deviceId } = await seed();
    expect((await renameThroughTheDashboard(deviceId, NEW_NAME)).status).toBe(200);

    const r = await app.fetch(
      new Request('https://ingest.example.com/api/v1/sms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiKey: 'c'.repeat(64),
          deviceId: DEVICE_CODE,
          deviceName: NEW_NAME,
          message: 'واریز 1,000 ریال به کارت *1234 - مانده 1,000 ریال',
          sender: 'BANK',
          timestamp: String(Date.now()),
          checksum: 'a'.repeat(32),
        }),
      }),
      env,
    );
    expect(r.status).toBe(401);
    expect((await deviceRow(deviceId)).display_name).toBe(NEW_NAME);
  });
});
