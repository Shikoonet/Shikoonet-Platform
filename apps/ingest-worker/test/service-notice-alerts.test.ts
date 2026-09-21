/**
 * A bank's «your SMS package is running out» text reaches a human.
 *
 * End to end through `POST /api/v1/sms`: the row is kept (classification
 * IGNORED, so the coverage page files it under «فیلترشده», not «ناخوانده»,
 * and the body is redacted the way an OTP's is), no transaction candidate is
 * made of it, and an `error`-level event goes to
 * the sink — which is what `alert()` turns into a message in the shop's
 * reports group (#382). The body itself is never in the event: the fields
 * carry the sender, the percent and the package name, and not the account.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setEventSink, type LogRecord } from '@shikoo/domain';
import { app } from '../src/index.js';
import { applySchema, env } from './helpers/env.js';

const API_KEY = 'e'.repeat(40);
const DEVICE = 'phone-notice';
const NOW = Date.UTC(2026, 8, 21, 13, 6, 0);
vi.spyOn(Date, 'now').mockReturnValue(NOW);

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
       VALUES (?1, ?2, 'Notice Phone', NULL, 1, ?3, ?3)`,
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

const ACCOUNT = '0123456789012';
const MELLI_QUOTA =
  'بانک ملی ایران\n' +
  `مشتری گرامی سرویس پیام کوتاه شماره حساب ${ACCOUNT} شما تا تاریخ 1405/06/30 16:36:15 به میزان 80.0 درصد از حجم بسته پیامکی "شارژ 300 پیامکی" خود را استفاده کرده اید.\n` +
  'شما دارای بسته رزرو نیستید و گزینه شارژ اتوماتیک را نیز انتخاب نکرده اید و با اتمام بسته فعلی سیستم ارسال پیامکی شما غیرفعال خواهد شد';

const records: LogRecord[] = [];

beforeAll(async () => {
  await applySchema();
  await seedDevice();
  setEventSink((r) => {
    records.push(r);
  });
});

afterAll(() => {
  setEventSink(null);
  vi.restoreAllMocks();
});

describe('a bank service notice', () => {
  it('is filed, makes no transaction, and raises an error event without the body', async () => {
    const r = await app.fetch(
      new Request('https://example.com/api/v1/sms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiKey: API_KEY,
          deviceId: DEVICE,
          deviceName: 'Notice Phone',
          message: MELLI_QUOTA,
          sender: '+987007170',
          timestamp: String(NOW),
          checksum: 'e'.repeat(32),
        }),
      }),
      env,
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as { eventId: string };

    // Filed like an OTP or an advert: classification kept, body redacted — so
    // the account number the bank wrote in it is never stored either.
    const raw = await env.DB.prepare(`SELECT classification, normalized_body FROM raw_sms_events WHERE id = ?1`)
      .bind(j.eventId)
      .first<{ classification: string; normalized_body: string | null }>();
    expect(raw?.classification).toBe('IGNORED');
    expect(raw?.normalized_body ?? '').not.toContain(ACCOUNT);
    const rows = await env.DB.prepare(`SELECT count(*)::int AS n FROM transaction_candidates WHERE raw_sms_event_id = ?1`)
      .bind(j.eventId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);

    const alert = records.find((x) => x.evt === 'sms.service_notice');
    expect(alert?.level).toBe('error');
    expect(alert?.ref).toBe(j.eventId);
    expect(alert?.fields).toMatchObject({ sender: '+987007170', bank: 'MELLI', percentUsed: 80, package: 'شارژ 300 پیامکی' });
    expect(JSON.stringify(alert)).not.toContain(ACCOUNT);
  });
});
