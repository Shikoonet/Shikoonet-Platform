/**
 * Two things Melli did on the night of 2026-09-18, replayed through
 * `POST /api/v1/sms`:
 *
 *  1. It delivered a 20:35 deposit at 21:13. The row must carry the bank's
 *     clock — 20:35 Tehran, which is 17:05 UTC — not the phone's, or the
 *     ledger orders balances by arrival and opens the books on a stale one.
 *  2. It sent one text twice, 26 minutes apart, byte-identical. The second
 *     delivery is a raw event marked `duplicate_of` the first and makes no
 *     second transaction: same balance, the money moved once.
 *
 * Expected instants come from Intl on Asia/Tehran, not from the code under
 * test.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index.js';
import { applySchema, env } from './helpers/env.js';

const API_KEY = 'e'.repeat(40);
const DEVICE = 'phone-melli-clock';
// 21:13:26 Tehran on 1405/06/27 — when the late text actually reached the phone.
const ARRIVED = Date.UTC(2026, 8, 18, 17, 43, 26);
vi.spyOn(Date, 'now').mockReturnValue(ARRIVED);

const LATE_DEPOSIT = 'بانک ملی ایران\nانتقال:3,300,000+\nحساب:24000\nمانده:15,393,140\n0627-20:35';
const TWICE_SENT = 'بانک ملی ایران\nانتقال:1,500,000+\nحساب:24000\nمانده:16,893,140\n0627-20:45';

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function seedDevice(): Promise<void> {
  const now = Date.now();
  const existing = await env.DB.prepare(`SELECT id FROM devices WHERE device_code = ?1`)
    .bind(DEVICE)
    .first<{ id: string }>();
  const deviceId = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO devices (id, device_code, display_name, description, active, created_at, updated_at)
       VALUES (?1, ?2, 'Melli Phone', NULL, 1, ?3, ?3)`,
    )
      .bind(deviceId, DEVICE, now)
      .run();
  }
  const tokenHash = await sha256Hex(API_KEY);
  await env.DB.prepare(`DELETE FROM device_credentials WHERE token_hash = ?1`).bind(tokenHash).run();
  await env.DB.prepare(
    `INSERT INTO device_credentials (id, device_id, token_hash, token_prefix, status, created_at, activated_at)
     VALUES (?1, ?2, ?3, ?4, 'ACTIVE', ?5, ?5)`,
  )
    .bind(crypto.randomUUID(), deviceId, tokenHash, API_KEY.slice(0, 4), now)
    .run();
}

async function postSms(message: string, timestamp: number): Promise<{ eventId: string; status: string; duplicate: boolean }> {
  const r = await app.fetch(
    new Request('https://example.com/api/v1/sms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: API_KEY,
        deviceId: DEVICE,
        deviceName: 'Melli Phone',
        message,
        sender: 'Bank Melli',
        timestamp: String(timestamp),
        checksum: 'e'.repeat(32),
      }),
    }),
    env,
  );
  expect(r.status).toBe(200);
  return (await r.json()) as { eventId: string; status: string; duplicate: boolean };
}

const tehran = (ms: number) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));

beforeAll(async () => {
  await applySchema();
  await seedDevice();
});

afterAll(() => vi.restoreAllMocks());

describe('a Melli deposit whose text arrives late', () => {
  it('is stamped with the bank clock in the text, not the phone clock', async () => {
    const j = await postSms(LATE_DEPOSIT, ARRIVED);
    expect(j.status).toBe('received');
    const row = await env.DB.prepare(`SELECT bank_timestamp FROM transaction_candidates WHERE raw_sms_event_id = ?1`)
      .bind(j.eventId)
      .first<{ bank_timestamp: number }>();
    expect(row).not.toBeNull();
    expect(tehran(row!.bank_timestamp)).toBe('20:35');
    expect(row!.bank_timestamp).toBe(Date.UTC(2026, 8, 18, 17, 5, 0));
    expect(row!.bank_timestamp).toBeLessThan(ARRIVED);
  });
});

describe('the same Melli text delivered twice', () => {
  it('keeps both raw events, marks the second as a duplicate of the first, and makes one transaction', async () => {
    const first = await postSms(TWICE_SENT, ARRIVED - 27 * 60_000); // 20:46
    const second = await postSms(TWICE_SENT, ARRIVED - 60_000); // 21:12
    expect(first.status).toBe('received');
    expect(second.duplicate).toBe(true);
    expect(second.status).toBe('already_received');
    expect(second.eventId).not.toBe(first.eventId);

    const link = await env.DB.prepare(`SELECT duplicate_of FROM raw_sms_events WHERE id = ?1`)
      .bind(second.eventId)
      .first<{ duplicate_of: string | null }>();
    expect(link?.duplicate_of).toBe(first.eventId);

    const n = await env.DB.prepare(
      `SELECT COUNT(*)::int AS n FROM transaction_candidates WHERE raw_sms_event_id IN (?1, ?2)`,
    )
      .bind(first.eventId, second.eventId)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it('is not a duplicate when the balance differs — that is a second, real deposit', async () => {
    const again = TWICE_SENT.replace('16,893,140', '18,393,140').replace('20:45', '22:10');
    const j = await postSms(again, ARRIVED + 60 * 60_000);
    expect(j.duplicate).toBe(false);
    expect(j.status).toBe('received');
  });
});
