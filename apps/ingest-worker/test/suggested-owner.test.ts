/**
 * The Pol transfer of 2026-09-18, through `POST /api/v1/sms`: it names an
 * account number nobody registered, so ingest makes a PENDING account —
 * and, because the bank's balance chains from «کشاورزی-مامان»'s last text,
 * writes that account on the PENDING row as the likely owner (0080).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index.js';
import { applySchema, env } from './helpers/env.js';

const API_KEY = 'f'.repeat(40);
const DEVICE = 'phone-owner';
const MOM = 'acct-owner-mom';
// 13:04 Tehran on 1405/06/27, when the Pol transfer arrived.
const NOW = Date.UTC(2026, 8, 18, 9, 34, 0);
vi.spyOn(Date, 'now').mockReturnValue(NOW);

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function seed(): Promise<void> {
  const now = Date.now();
  const existing = await env.DB.prepare(`SELECT id FROM devices WHERE device_code = ?1`).bind(DEVICE).first<{ id: string }>();
  const deviceId = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO devices (id, device_code, display_name, description, active, created_at, updated_at)
       VALUES (?1, ?2, 'Owner Phone', NULL, 1, ?3, ?3)`,
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
  // Mom's account, keyed by her card; nobody registered 47045299.
  await env.DB.prepare(
    `INSERT INTO financial_accounts (id, bank_name, display_name, account_type, account_hint, card_last_four, active, status, parser_configuration, created_at, updated_at)
     VALUES (?1, 'Keshavarzi', 'کشاورزی-مامان', 'CARD', '4006', '4006', 1, 'ACTIVE', '{}', ?2, ?2)
     ON CONFLICT (id) DO UPDATE SET active = 1, status = 'ACTIVE'`,
  )
    .bind(MOM, now)
    .run();
}

async function postSms(message: string, sender: string, timestamp: number): Promise<{ eventId: string }> {
  const r = await app.fetch(
    new Request('https://example.com/api/v1/sms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: API_KEY, deviceId: DEVICE, deviceName: 'Owner Phone', message, sender, timestamp: String(timestamp), checksum: 'f'.repeat(32) }),
    }),
    env,
  );
  expect(r.status).toBe(200);
  return (await r.json()) as { eventId: string };
}

beforeAll(async () => {
  await applySchema();
  await seed();
});

afterAll(() => vi.restoreAllMocks());

describe('a deposit to a number nobody registered', () => {
  it('gets a PENDING account whose likely owner is the account its balance chains from', async () => {
    // 06:05 Tehran: mom's card text, balance 2,854,098.
    await postSms('واریز1,000,000\nمانده2,854,098\n050627-06:05\nکارت4006*\nbki. ir', 'KESHAVARZI', NOW - 7 * 3_600_000);
    // 13:04: the Pol transfer to the account number, balance 8,354,098 = 2,854,098 + 5,500,000.
    const j = await postSms('واریز پل5,500,000\nمانده8,354,098\n050627-13:04\n47045299\nbki. ir', '+989192030800', NOW);

    const tx = await env.DB.prepare(`SELECT financial_account_id FROM transaction_candidates WHERE raw_sms_event_id = ?1`)
      .bind(j.eventId)
      .first<{ financial_account_id: string }>();
    expect(tx?.financial_account_id).toBeTruthy();
    expect(tx!.financial_account_id).not.toBe(MOM);

    const pending = await env.DB.prepare(
      `SELECT status, account_hint, suggested_owner_id, suggested_reason FROM financial_accounts WHERE id = ?1`,
    )
      .bind(tx!.financial_account_id)
      .first<{ status: string; account_hint: string; suggested_owner_id: string | null; suggested_reason: string | null }>();
    expect(pending).toEqual({ status: 'PENDING', account_hint: '47045299', suggested_owner_id: MOM, suggested_reason: 'balance_chain' });
  });
});
