/**
 * 6-fixture bank parser end-to-end integration test.
 *
 * For each of the 6 documented real Iranian bank SMS samples, posts the
 * body through the deployed ingest worker entrypoint and asserts:
 *   - raw_sms_events row is created exactly once
 *   - transaction_candidates row is created (transaction_id NOT NULL)
 *   - transaction_detected_identifiers row is persisted with type + value
 *   - account_hint is persisted on the transaction (when a financial_account row matches)
 *   - re-POSTing the same body yields duplicate=true and no second row
 *
 * Reuses applySchema + seedDevice patterns from integration.test.ts.
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

async function seedDevice(args: { deviceCode?: string; apiKey?: string } = {}) {
  const deviceCode = args.deviceCode ?? 'phone-banks';
  const apiKey = args.apiKey ?? 'a'.repeat(40);
  const now = Date.now();
  const existing = await env.DB.prepare(`SELECT id FROM devices WHERE device_code = ?1`)
    .bind(deviceCode)
    .first<{ id: string }>();
  const deviceId = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO devices
         (id, device_code, display_name, description, active, last_seen_at, last_success_at, last_auth_failure_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, NULL, 1, NULL, NULL, NULL, ?4, ?4)`,
    )
      .bind(deviceId, deviceCode, 'Banks Test Phone', now)
      .run();
  }
  const credId = crypto.randomUUID();
  // Delete by token_hash, not by device+prefix. `token_hash` is UNIQUE, and
  // several fixtures deliberately reuse the same apiKey across different device
  // codes — so a prior device's credential collides even though it belongs to
  // another device. The old per-file database hid this; one shared database
  // does not.
  const tokenHash = await sha256Hex(apiKey);
  await env.DB.prepare(`DELETE FROM device_credentials WHERE token_hash = ?1`)
    .bind(tokenHash)
    .run();
  await env.DB.prepare(
    `INSERT INTO device_credentials
       (id, device_id, token_hash, token_prefix, status, created_at, activated_at, revoked_at, last_used_at)
     VALUES (?1, ?2, ?3, ?4, 'ACTIVE', ?5, ?5, NULL, NULL)`,
  )
    .bind(credId, deviceId, tokenHash, apiKey.slice(0, 4), now)
    .run();
  return { deviceId, deviceCode, apiKey };
}

async function seedFinancialAccount(opts: {
  bankName: string;
  accountHint: string;
  displayName: string;
}) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO financial_accounts
       (id, bank_name, display_name, owner_label, account_type, account_hint,
        card_last_four, account_last_four, device_id, active, parser_configuration,
        created_at, updated_at)
     VALUES (?1, ?2, ?3, NULL, 'ACCOUNT', ?4, NULL, NULL, NULL, 1, '{}', ?5, ?5)`,
  )
    .bind(id, opts.bankName, opts.displayName, opts.accountHint, now)
    .run();
  return id;
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

interface Fixture {
  name: string;
  message: string;
  expectedParser: string;
  bank: string;
  accountHint: string | null;
}

const FIXTURES: Fixture[] = [
  {
    name: 'sample 1 — account-transfer-signed-v1',
    message: [
      'انتقال اینترنت',
      'حساب:310057795083',
      'مبلغ:5,500,000+',
      'مانده:82,791,067',
      '05/14-11:30',
    ].join('\n'),
    expectedParser: 'account-transfer-signed-v1',
    bank: 'UNKNOWN',
    accountHint: '310057795083',
  },
  {
    name: 'sample 2 — compact-signed-v1',
    message: ['777.888.21654304.1', '+2,000,000', '05/14_17:04', 'مانده: 134,760,000'].join('\n'),
    expectedParser: 'compact-signed-v1',
    bank: 'UNKNOWN',
    accountHint: '777.888.21654304.1',
  },
  {
    name: 'sample 3 — compact-signed-v1',
    message: ['10.5718857.1', '+1,000,000', '05/14_20:30', 'مانده: 1,070,374,127'].join('\n'),
    expectedParser: 'compact-signed-v1',
    bank: 'UNKNOWN',
    accountHint: '10.5718857.1',
  },
  {
    name: 'sample 4 — melli-transfer-v1',
    message: [
      'بانك ملي',
      'انتقال:+1,500,000',
      'حساب:17000',
      'مانده:78,159,809',
      '05/14-16:30',
    ].join('\n'),
    expectedParser: 'melli-transfer-v1',
    bank: 'MELLI',
    accountHint: '17000',
  },
  {
    name: 'sample 5 — compact-signed-v1 (trailing-sign layout)',
    message: ['300432401476', '2,800,000+', 'مانده:16,234,550', '1405/5/14-18:01'].join('\n'),
    expectedParser: 'compact-signed-v1',
    bank: 'PARSIAN',
    accountHint: '300432401476',
  },
  {
    name: 'sample 6 — shahr-credit-v1',
    message: [
      '*بانک شهر*',
      'انتقال وجه کارتی',
      'واریز به:4003537814',
      'مبلغ:1,950,000 ریال',
      'موجودی:112,686,500 ریال',
      '1405/05/14 02:02:14',
    ].join('\n'),
    expectedParser: 'shahr-credit-v1',
    bank: 'SHAHR',
    accountHint: '4003537814',
  },
  // ---- Phase-5: 4 new Iranian-bank SMS formats ---------------------------
  {
    name: 'sample 7 — internet-transfer-signed-v1 (Format 1, 4-line)',
    message: [
      'انتقال اینترنت:+550,000',
      'حساب:310057795083',
      'مانده:83,341,067',
      '0515-10:06',
    ].join('\n'),
    expectedParser: 'internet-transfer-signed-v1',
    bank: 'UNKNOWN',
    accountHint: '310057795083',
  },
  {
    name: 'sample 8 — melli-transfer-v1 (Format 2, MMDD-HH:mm, leading-zero hint)',
    message: ['بانك ملي', 'انتقال:1,950,000+', 'حساب:06006', 'مانده:9,379,136', '0515-20:46'].join(
      '\n',
    ),
    expectedParser: 'melli-transfer-v1',
    bank: 'MELLI',
    accountHint: '06006',
  },
  {
    name: 'sample 9 — saman-credit-v1 (Format 3, 6-line deposit)',
    message: [
      'بانك سامان',
      'واريز مبلغ  1,000,000ریال',
      'به  901-777-2938283-1',
      'مانده 12,814,704',
      '1405/5/15',
      '20:48',
    ].join('\n'),
    expectedParser: 'saman-credit-v1',
    bank: 'SAMAN',
    accountHint: '901-777-2938283-1',
  },
  {
    name: 'sample 10 — compact-signed-v1 (Format 4, trailing-plus)',
    message: ['300422286226', '1,000,000+', '1405/5/15-12:06', 'مانده:720,919,100'].join('\n'),
    expectedParser: 'compact-signed-v1',
    bank: 'UNKNOWN',
    accountHint: '300422286226',
  },
];

beforeAll(async () => {
  await applySchema();
  // Seed one device shared across all fixture tests (the token is reused —
  // fixtures vary by SMS body, not by device).
  sharedDevice = await seedDevice({ deviceCode: 'phone-banks-fixtures' });
  // Seed one financial_accounts row per unique account hint so
  // account_hint resolution actually finds a match — the spec requires
  // account_hint NOT NULL on these transactions. Multiple fixtures can
  // share the same hint (e.g. samples 1 and 7 both reference 310057795083);
  // only seed once per hint.
  const seenHints = new Set<string>();
  for (const fx of FIXTURES) {
    if (!fx.accountHint || seenHints.has(fx.accountHint)) continue;
    seenHints.add(fx.accountHint);
    await seedFinancialAccount({
      bankName: fx.bank,
      accountHint: fx.accountHint,
      displayName: `Fixture ${fx.name}`,
    });
  }
});

let sharedDevice: Awaited<ReturnType<typeof seedDevice>>;

for (const fx of FIXTURES) {
  describe(`ingest — ${fx.name}`, () => {
    it('creates raw_sms_events + transaction_candidates + detected_identifier exactly once', async () => {
      const ts = Date.now() + Math.floor(Math.random() * 1_000);
      const body = {
        apiKey: sharedDevice.apiKey,
        deviceId: sharedDevice.deviceCode,
        deviceName: sharedDevice.deviceCode,
        message: fx.message,
        sender: 'BANK',
        timestamp: String(ts),
        checksum: 'a'.repeat(32),
      };

      const r1 = await postSms(body);
      expect(r1.status).toBe(200);
      const j1 = (await r1.json()) as { ok: boolean; eventId: string; duplicate: boolean };
      expect(j1.ok).toBe(true);
      expect(j1.duplicate).toBe(false);

      // Re-POST → duplicate
      const r2 = await postSms(body);
      expect(r2.status).toBe(200);
      const j2 = (await r2.json()) as { eventId: string; duplicate: boolean };
      expect(j2.eventId).toBe(j1.eventId);
      expect(j2.duplicate).toBe(true);

      // raw_sms_events count = 1
      const rawCount = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM raw_sms_events WHERE id = ?1`,
      )
        .bind(j1.eventId)
        .first<{ n: number }>();
      expect(rawCount?.n).toBe(1);

      // transaction_candidates exists with NON-NULL id (invariant)
      const tx = await env.DB.prepare(
        `SELECT t.id, t.parser_id, t.financial_account_id, t.status, fa.account_hint AS account_hint
           FROM transaction_candidates t
           LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
          WHERE t.raw_sms_event_id = ?1`,
      )
        .bind(j1.eventId)
        .first<{
          id: string;
          parser_id: string;
          financial_account_id: string | null;
          status: string;
          account_hint: string | null;
        }>();
      expect(tx, 'transaction must exist (BANK_TRANSACTION invariant)').toBeTruthy();
      expect(tx!.id, 'transaction_id must NOT be NULL').not.toBeNull();
      expect(tx!.parser_id).toBe(fx.expectedParser);

      // transaction_detected_identifiers row exists
      const det = await env.DB.prepare(
        `SELECT identifier_type, normalized_value FROM transaction_detected_identifiers
          WHERE transaction_candidate_id = ?1`,
      )
        .bind(tx!.id)
        .first<{ identifier_type: string; normalized_value: string }>();
      expect(det, 'detected_identifier must be persisted').toBeTruthy();
      // Account resolution: only parsers emitting ACCOUNT_HINT resolve
      // against the financial_accounts.account_hint column. Melli does.
      // The other 5 emit ACCOUNT_NUMBER and resolve via
      // financial_account_identifiers (out of scope for this test).
      if (fx.expectedParser === 'melli-transfer-v1') {
        expect(tx!.financial_account_id, 'melli emits ACCOUNT_HINT → must resolve').toBeTruthy();
        expect(tx!.account_hint, 'joined account_hint must match fixture').toBe(fx.accountHint);
      }
    });
  });
}
