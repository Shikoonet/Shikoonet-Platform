/**
 * A withdrawal SMS becomes a row — and only a row.
 *
 * End to end through `POST /api/v1/sms`: the phone's contract is frozen, so
 * the response for a debit stays `outgoing_ignored` (the app must not retry
 * it), while the database now holds a DEBIT candidate with the bank's
 * balance, disposition OUTGOING_IGNORED, and nothing in
 * `reconciliation_matches` — the row was recorded, not matched.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index.js';
import { applySchema, env } from './helpers/env.js';

const API_KEY = 'd'.repeat(40);
const DEVICE = 'phone-debit';

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The same shape `integration.test.ts` seeds, reduced to one active phone. */
async function seedDevice(): Promise<void> {
  const now = Date.now();
  const existing = await env.DB.prepare(`SELECT id FROM devices WHERE device_code = ?1`)
    .bind(DEVICE)
    .first<{ id: string }>();
  const deviceId = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO devices (id, device_code, display_name, description, active, created_at, updated_at)
       VALUES (?1, ?2, 'Debit Phone', NULL, 1, ?3, ?3)`,
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

function postSms(message: string): Promise<Response> {
  return app.fetch(
    new Request('https://example.com/api/v1/sms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: API_KEY,
        deviceId: DEVICE,
        deviceName: 'Debit Phone',
        message,
        sender: 'BANK',
        timestamp: String(Date.now()),
        checksum: crypto.randomUUID().replace(/-/g, ''),
      }),
    }),
    env,
  );
}

beforeAll(async () => {
  await applySchema();
  await seedDevice();
});

describe('a withdrawal SMS', () => {
  it('is stored as a DEBIT row with its balance, and matched to nothing', async () => {
    const r = await postSms(
      'برداشت 2,500,000 ریال از حساب 30101883751600 مانده 18,816,315,000 ریال',
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as { eventId: string; status: string; actionable: boolean };
    expect(j.status).toBe('outgoing_ignored');
    expect(j.actionable).toBe(false);

    const row = await env.DB.prepare(
      `SELECT direction, processing_disposition, amount_irr, balance_irr,
              (SELECT COUNT(*) FROM reconciliation_matches m WHERE m.transaction_candidate_id = t.id) AS matches
         FROM transaction_candidates t WHERE raw_sms_event_id = ?1`,
    )
      .bind(j.eventId)
      .first<{
        direction: string;
        processing_disposition: string;
        amount_irr: number;
        balance_irr: number | null;
        matches: number;
      }>();
    expect(row?.direction).toBe('DEBIT');
    expect(row?.processing_disposition).toBe('OUTGOING_IGNORED');
    expect(row?.amount_irr).toBe(2_500_000);
    expect(row?.balance_irr).toBe(18_816_315_000);
    expect(row?.matches).toBe(0);
  });
});
