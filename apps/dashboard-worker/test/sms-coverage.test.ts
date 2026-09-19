/**
 * «بانک‌ها › پیامک‌های بی‌پارسر» at the routes: who may read, what comes
 * back, and that the CSV carries the sample body someone will write a
 * parser from. The arithmetic is asserted in the domain test; this walks
 * the door.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-cov@example.com';
const REVIEWER = 'reviewer-cov@example.com';
const READER = 'reader-cov@example.com';
const P = 'zz-covr-';
const DEVICE = `${P}device`;

const envAs = (email: string) => ({ ...baseEnv, TEST_ACCESS_USER: email });
const get = (path: string, email = ADMIN) => app.request(path, {}, envAs(email));

async function raw(sender: string, body: string, classification: string, parserId: string): Promise<string> {
  const id = `${P}${crypto.randomUUID()}`;
  const now = Date.now();
  await baseEnv.DB.prepare(
    `INSERT INTO raw_sms_events
       (id, device_id, sender, normalized_body, body_sha256, app_checksum, sms_timestamp,
        received_at, classification, parser_status, parser_id, parser_version, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'c', ?6, ?6, ?7, 'OK', ?8, 'v1', ?6)`,
  )
    .bind(id, DEVICE, sender, body, `${P}hash-${id}`, now, classification, parserId)
    .run();
  return id;
}

beforeAll(async () => {
  await applySchema();
  const now = Date.now();
  for (const [email, role] of [[ADMIN, 'ADMIN'], [REVIEWER, 'REVIEWER'], [READER, 'READ_ONLY']]) {
    await baseEnv.DB.prepare(
      `INSERT INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4) ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, active = 1`,
    )
      .bind(crypto.randomUUID(), email, role, now)
      .run();
  }
  await baseEnv.DB.prepare(
    `INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES (?1, ?1, 'Coverage Phone', 1, ?2, ?2) ON CONFLICT (id) DO NOTHING`,
  )
    .bind(DEVICE, now)
    .run();
  await baseEnv.DB.prepare(`DELETE FROM raw_sms_events WHERE id LIKE ?1`).bind(`${P}%`).run();
  await raw('Bank Maskan', 'قبض: -107,000,000\nحساب:150028182866\nمانده:169,524\n0626-17:54', 'BALANCE', 'generic-balance');
});

afterAll(async () => {
  await baseEnv.DB.prepare(`DELETE FROM raw_sms_events WHERE id LIKE ?1`).bind(`${P}%`).run();
});

describe('GET /api/v1/admin/sms/coverage and /unparsed', () => {
  it('open to ADMIN and REVIEWER, closed to READ_ONLY', async () => {
    expect((await get('/api/v1/admin/sms/coverage')).status).toBe(200);
    expect((await get('/api/v1/admin/sms/coverage', REVIEWER)).status).toBe(200);
    expect((await get('/api/v1/admin/sms/coverage', READER)).status).toBe(403);
    expect((await get('/api/v1/admin/sms/unparsed', READER)).status).toBe(403);
    expect((await get('/api/v1/admin/sms/unparsed.csv', READER)).status).toBe(403);
  });

  it('lists the Maskan bill as unread, with its masked shape and the body to write a parser from', async () => {
    const cov = (await (await get('/api/v1/admin/sms/coverage?days=7')).json()) as { items: { sender: string; unread: number }[] };
    expect(cov.items.find((i) => i.sender === 'Bank Maskan')?.unread).toBeGreaterThanOrEqual(1);

    const un = (await (await get('/api/v1/admin/sms/unparsed?days=7')).json()) as {
      items: { sender: string; reason: string; shape: string; sampleBody: string; count: number }[];
    };
    const row = un.items.find((i) => i.sender === 'Bank Maskan' && i.shape.startsWith('قبض: -999,999,999'));
    expect(row).toMatchObject({ reason: 'unread', count: 1 });
    expect(row!.sampleBody).toContain('107,000,000');

    const csv = await get('/api/v1/admin/sms/unparsed.csv?days=7');
    expect(csv.headers.get('content-type')).toContain('text/csv');
    const text = await csv.text();
    expect(text).toContain('فرستنده');
    expect(text).toContain('107,000,000');
  });

  it('refuses a silly range by falling back to the default, never by erroring', async () => {
    expect((await get('/api/v1/admin/sms/coverage?days=abc')).status).toBe(200);
    expect((await get('/api/v1/admin/sms/coverage?days=100000')).status).toBe(200);
  });
});
