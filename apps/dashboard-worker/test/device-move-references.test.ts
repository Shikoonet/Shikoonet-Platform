/**
 * Moving a device's history so the device can be deleted.
 *
 * `DELETE /devices/:id` refuses a device that owns bank SMS, and that refusal
 * is right — `raw_sms_events.device_id` is `NOT NULL ... ON DELETE RESTRICT`
 * and the transaction candidates built from those events cascade off them, so
 * a cascading delete would destroy money evidence to tidy a screen. The cost
 * was that a device which had ever relayed one message could never be removed:
 * seven of eight rows on staging on 2026-08-29, holding six hundred synthetic
 * messages between them, permanently.
 *
 * These tests hold the shape of the way out. The one that matters most is
 * «nothing is destroyed»: it counts the rows before and after and asserts they
 * are the same rows, on the target. A move that quietly deleted the awkward
 * half would satisfy every other assertion here.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

async function resetTables() {
  await baseEnv.DB.batch([
    baseEnv.DB.prepare('TRUNCATE audit_logs CASCADE'),
    baseEnv.DB.prepare('DELETE FROM transaction_candidates'),
    baseEnv.DB.prepare('DELETE FROM raw_sms_events'),
    baseEnv.DB.prepare('DELETE FROM financial_account_identifiers'),
    baseEnv.DB.prepare('DELETE FROM financial_accounts'),
    baseEnv.DB.prepare('DELETE FROM device_credentials'),
    baseEnv.DB.prepare('DELETE FROM devices'),
    baseEnv.DB.prepare('DELETE FROM access_users'),
  ]);
}

async function seedUser(email: string, role: 'ADMIN' | 'REVIEWER') {
  await baseEnv.DB.prepare(
    'INSERT INTO access_users (id, email, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
  )
    .bind(crypto.randomUUID(), email, role, Date.now(), Date.now())
    .run();
}

async function seedDevice(code: string, active: boolean): Promise<string> {
  const id = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO devices (id, device_code, display_name, description, active, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?)`,
  )
    .bind(id, code, code, active ? 1 : 0, Date.now(), Date.now())
    .run();
  return id;
}

async function seedCredential(deviceId: string) {
  const hash = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  await baseEnv.DB.prepare(
    `INSERT INTO device_credentials (id, device_id, token_hash, token_prefix, status, created_at)
     VALUES (?, ?, ?, 'abcd', 'REVOKED', ?)`,
  )
    .bind(crypto.randomUUID(), deviceId, hash, Date.now())
    .run();
}

/** `bodySha` is explicit so a test can make two devices hold the same message. */
async function seedSms(deviceId: string, bodySha = crypto.randomUUID().replace(/-/g, '')) {
  const id = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO raw_sms_events
       (id, device_id, sender, normalized_body, body_sha256, app_checksum,
        sms_timestamp, received_at, classification, parser_status, parser_id,
        parser_version, created_at)
     VALUES (?, ?, 'BANK', 'test body', ?, 'c', ?, ?, 'BANK_CREDIT', 'OK', 'test', 'v1', ?)`,
  )
    .bind(id, deviceId, bodySha, Date.now(), Date.now(), Date.now())
    .run();
  return id;
}

async function seedAccount(deviceId: string) {
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

async function seedTransaction(deviceId: string) {
  const smsId = await seedSms(deviceId);
  const id = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO transaction_candidates
       (id, raw_sms_event_id, financial_account_id, direction, amount_irr,
        status, bank_timestamp, confidence, parser_id, parser_version,
        parser_evidence_json, created_at, updated_at)
     VALUES (?, ?, NULL, 'CREDIT', 100000, 'NEEDS_REVIEW', ?, 1.0, 'test', 'v1', '{}', ?, ?)`,
  )
    .bind(id, smsId, Date.now(), Date.now(), Date.now())
    .run();
  return id;
}

function get(path: string, email = 'admin@example.com'): Request {
  return new Request(`https://example.com${path}`, {
    method: 'GET',
    headers: { 'cf-access-authenticated-user-email': email },
  });
}

function post(path: string, body: unknown, email = 'admin@example.com'): Request {
  return new Request(`https://example.com${path}`, {
    method: 'POST',
    headers: {
      'cf-access-authenticated-user-email': email,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

const asAdmin = { ...baseEnv, TEST_ACCESS_USER: 'admin@example.com' };

async function countOn(table: 'raw_sms_events' | 'financial_accounts', deviceId: string) {
  const r = await baseEnv.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE device_id = ?1`,
  )
    .bind(deviceId)
    .first<{ n: number }>();
  return Number(r?.n ?? 0);
}

async function totalRows(table: 'raw_sms_events' | 'financial_accounts' | 'transaction_candidates') {
  const r = await baseEnv.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetTables();
  await seedUser('admin@example.com', 'ADMIN');
  await seedUser('op@example.com', 'REVIEWER');
});

describe('GET /api/v1/devices/:idOrCode/move-preview', () => {
  it('is ADMIN-only', async () => {
    const src = await seedDevice('src', false);
    const dst = await seedDevice('dst', true);
    const r = await app.fetch(get(`/api/v1/devices/${src}/move-preview?target=${dst}`), {
      ...baseEnv,
      TEST_ACCESS_USER: 'op@example.com',
    });
    expect(r.status).toBe(403);
  });

  it('says what would move, and that nothing stops it', async () => {
    const src = await seedDevice('src', false);
    const dst = await seedDevice('dst', true);
    await seedSms(src);
    await seedSms(src);
    await seedAccount(src);
    await seedTransaction(src); // adds a third SMS plus one candidate

    const r = await app.fetch(get(`/api/v1/devices/${src}/move-preview?target=${dst}`), asAdmin);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      moves: { rawSmsEvents: number; financialAccounts: number; transactions: number };
      duplicateSmsOnTarget: number;
      canMove: boolean;
      canDeleteSourceAfterwards: boolean;
    };
    expect(body.moves).toEqual({ rawSmsEvents: 3, financialAccounts: 1, transactions: 1 });
    expect(body.duplicateSmsOnTarget).toBe(0);
    expect(body.canMove).toBe(true);
    expect(body.canDeleteSourceAfterwards).toBe(true);
  });

  it('refuses to preview a move onto the device itself', async () => {
    const src = await seedDevice('src', false);
    const r = await app.fetch(get(`/api/v1/devices/${src}/move-preview?target=${src}`), asAdmin);
    expect(r.status).toBe(400);
  });

  it('counts a body the target already holds, and says the move cannot run', async () => {
    const src = await seedDevice('src', false);
    const dst = await seedDevice('dst', true);
    const shared = 'a'.repeat(32);
    await seedSms(src, shared);
    await seedSms(dst, shared);
    await seedSms(src); // one that would move fine

    const r = await app.fetch(get(`/api/v1/devices/${src}/move-preview?target=${dst}`), asAdmin);
    const body = (await r.json()) as { duplicateSmsOnTarget: number; canMove: boolean };
    expect(body.duplicateSmsOnTarget).toBe(1);
    expect(body.canMove).toBe(false);
  });

  it('reports that an ON device cannot be deleted afterwards', async () => {
    const src = await seedDevice('src', true);
    const dst = await seedDevice('dst', true);
    const r = await app.fetch(get(`/api/v1/devices/${src}/move-preview?target=${dst}`), asAdmin);
    const body = (await r.json()) as { canDeleteSourceAfterwards: boolean };
    expect(body.canDeleteSourceAfterwards).toBe(false);
  });
});

describe('POST /api/v1/devices/:idOrCode/move-references', () => {
  it('moves the history and deletes the source, destroying nothing', async () => {
    const src = await seedDevice('src', false);
    const dst = await seedDevice('dst', true);
    await seedCredential(src);
    await seedSms(src);
    await seedSms(src);
    await seedAccount(src);
    await seedTransaction(src);

    const smsBefore = await totalRows('raw_sms_events');
    const acctBefore = await totalRows('financial_accounts');
    const txBefore = await totalRows('transaction_candidates');

    const r = await app.fetch(
      post(`/api/v1/devices/${src}/move-references`, {
        targetDeviceId: dst,
        deleteSource: true,
      }),
      asAdmin,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { deletedSource: boolean; moved: { rawSmsEvents: number } };
    expect(body.deletedSource).toBe(true);
    expect(body.moved.rawSmsEvents).toBe(3);

    // The device is gone.
    const gone = await baseEnv.DB.prepare(`SELECT COUNT(*) AS n FROM devices WHERE id = ?1`)
      .bind(src)
      .first<{ n: number }>();
    expect(Number(gone?.n ?? -1)).toBe(0);

    // And every row it owned is still a row — on the target, not in a bin. The
    // totals are the assertion that matters: a delete disguised as a move would
    // pass «the source has nothing left» perfectly.
    expect(await totalRows('raw_sms_events')).toBe(smsBefore);
    expect(await totalRows('financial_accounts')).toBe(acctBefore);
    expect(await totalRows('transaction_candidates')).toBe(txBefore);
    expect(await countOn('raw_sms_events', dst)).toBe(3);
    expect(await countOn('financial_accounts', dst)).toBe(1);
  });

  it('can move without deleting, leaving an empty source behind', async () => {
    const src = await seedDevice('src', false);
    const dst = await seedDevice('dst', true);
    await seedSms(src);

    const r = await app.fetch(
      post(`/api/v1/devices/${src}/move-references`, { targetDeviceId: dst }),
      asAdmin,
    );
    expect(r.status).toBe(200);
    expect(await countOn('raw_sms_events', src)).toBe(0);
    expect(await countOn('raw_sms_events', dst)).toBe(1);
    const still = await baseEnv.DB.prepare(`SELECT COUNT(*) AS n FROM devices WHERE id = ?1`)
      .bind(src)
      .first<{ n: number }>();
    expect(Number(still?.n ?? 0)).toBe(1);
  });

  it('refuses a duplicate body and moves nothing at all', async () => {
    const src = await seedDevice('src', false);
    const dst = await seedDevice('dst', true);
    const shared = 'b'.repeat(32);
    await seedSms(src, shared);
    await seedSms(dst, shared);
    await seedSms(src);

    const r = await app.fetch(
      post(`/api/v1/devices/${src}/move-references`, {
        targetDeviceId: dst,
        deleteSource: true,
      }),
      asAdmin,
    );
    expect(r.status).toBe(409);
    expect((await r.json()) as { error: string }).toMatchObject({
      error: 'duplicate_sms_on_target',
    });
    // All of it, not just the colliding one: a partial move would leave the
    // operator with history split across two devices and no way to tell.
    expect(await countOn('raw_sms_events', src)).toBe(2);
    expect(await countOn('raw_sms_events', dst)).toBe(1);
  });

  it('refuses to delete a source that is still switched on, and moves nothing', async () => {
    const src = await seedDevice('src', true);
    const dst = await seedDevice('dst', true);
    await seedSms(src);

    const r = await app.fetch(
      post(`/api/v1/devices/${src}/move-references`, {
        targetDeviceId: dst,
        deleteSource: true,
      }),
      asAdmin,
    );
    expect(r.status).toBe(409);
    expect((await r.json()) as { error: string }).toMatchObject({
      error: 'device_must_be_inactive',
    });
    // Checked BEFORE the move, so the source is not left emptied by a request
    // that then refused.
    expect(await countOn('raw_sms_events', src)).toBe(1);
  });

  it('is ADMIN-only, and a REVIEWER moves nothing', async () => {
    const src = await seedDevice('src', false);
    const dst = await seedDevice('dst', true);
    await seedSms(src);
    const r = await app.fetch(
      post(`/api/v1/devices/${src}/move-references`, { targetDeviceId: dst }, 'op@example.com'),
      { ...baseEnv, TEST_ACCESS_USER: 'op@example.com' },
    );
    expect(r.status).toBe(403);
    expect(await countOn('raw_sms_events', src)).toBe(1);
  });

  it('records where everything went, without a token or an SMS body', async () => {
    const src = await seedDevice('src', false);
    const dst = await seedDevice('dst', true);
    await seedCredential(src);
    await seedSms(src);

    await app.fetch(
      post(`/api/v1/devices/${src}/move-references`, {
        targetDeviceId: dst,
        deleteSource: true,
      }),
      asAdmin,
    );

    const rows = await baseEnv.DB.prepare(
      `SELECT action, before_json, after_json FROM audit_logs WHERE entity_id = ?1 ORDER BY action`,
    )
      .bind(src)
      .all<{ action: string; before_json: string | null; after_json: string | null }>();
    const actions = rows.results.map((r) => r.action);
    expect(actions).toContain('device.references_moved');
    expect(actions).toContain('device.deleted');

    const moved = rows.results.find((r) => r.action === 'device.references_moved')!;
    expect(JSON.parse(moved.after_json!)).toMatchObject({ targetDeviceCode: 'dst' });
    // The audit is a place secrets have leaked before. Nothing here carries one.
    const all = JSON.stringify(rows.results);
    expect(all).not.toContain('test body');
    expect(all).not.toContain('abcd');
  });
});
