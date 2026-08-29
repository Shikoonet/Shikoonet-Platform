/**
 * Financial analytics: sales, balances, period comparison.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env as baseEnv } from 'cloudflare:test';
import SHA from '../../migrations/0001_init.sql?raw';
import SHA2 from '../../migrations/0002_bank_transaction.sql?raw';
import SHA3 from '../../migrations/0003_unique_account_identifier.sql?raw';
import SHA4 from '../../migrations/0004_detected_identifiers.sql?raw';
import SHA5 from '../../migrations/0005_transaction_reviews.sql?raw';
import SHA6 from '../../migrations/0006_assignment_history_and_notifications.sql?raw';
import SHA7 from '../../migrations/0007_transaction_reads.sql?raw';
import SHA8 from '../../migrations/0008_account_assignment_previews.sql?raw';
import SHA9 from '../../migrations/0009_credit_only.sql?raw';
import SHA10 from '../../migrations/0010_account_status.sql?raw';
import SHA11 from '../../migrations/0011_mirzabot_integration.sql?raw';
import SHA12 from '../../migrations/0012_claim_card_digits.sql?raw';
import SHA13 from '../../migrations/0013_resellers.sql?raw';
import SHA14 from '../../migrations/0014_income_declined.sql?raw';
import { computePercentChange } from '@hub/domain';
import { app } from '../src/index.js';

const SCHEMA = [SHA, SHA2, SHA3, SHA4, SHA5, SHA6, SHA7, SHA8, SHA9, SHA10, SHA11, SHA12, SHA13, SHA14]
  .map((s) =>
    s
      .replace(/^\s*--[^\n]*\n/gm, '')
      .replace(/^PRAGMA\s+foreign_keys\s*=\s*ON\s*;?\s*$/gim, '')
      .trim(),
  )
  .join('\n\n');

function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  for (const raw of sql.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('--')) continue;
    buf += raw + '\n';
    if (line.endsWith(';')) {
      out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

const EMAIL = 'admin@example.com';
const ACCOUNT = 'acc-analytics';
const BASE = 1_786_091_200_000;
const AMOUNT = 2_000_000;

function envAs(email = EMAIL) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

beforeAll(async () => {
  for (const stmt of splitStatements(SCHEMA)) {
    try {
      await baseEnv.DB.prepare(stmt).run();
    } catch (err) {
      const msg = String(err);
      if (msg.includes('already exists') || msg.includes('duplicate column name')) continue;
      throw err;
    }
  }
  const now = Date.now();
  await baseEnv.DB.prepare(
    `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
     VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)`,
  )
    .bind(crypto.randomUUID(), EMAIL, now)
    .run();
  await baseEnv.DB.prepare(
    `INSERT OR IGNORE INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES ('dev-a', 'DEV-A', 'Analytics Device', 1, ?1, ?1)`,
  )
    .bind(now)
    .run();
  await baseEnv.DB.prepare(
    `INSERT OR IGNORE INTO financial_accounts
     (id, bank_name, display_name, owner_label, account_type, active, status, account_hint,
      parser_configuration, created_at, updated_at)
     VALUES (?1,'Melli','Analytics Main',NULL,'CARD',1,'ACTIVE','6006','{}',?2,?2)`,
  )
    .bind(ACCOUNT, now)
    .run();
});

beforeEach(async () => {
  await baseEnv.DB.prepare(`DELETE FROM audit_logs`).run();
  await baseEnv.DB.prepare(`DELETE FROM reseller_transactions`).run();
  await baseEnv.DB.prepare(`DELETE FROM resellers`).run();
  await baseEnv.DB.prepare(`DELETE FROM reconciliation_matches`).run();
  await baseEnv.DB.prepare(`DELETE FROM payment_claims`).run();
  await baseEnv.DB.prepare(`DELETE FROM transaction_candidates`).run();
  await baseEnv.DB.prepare(`DELETE FROM raw_sms_events`).run();
});

async function seedTx(id: string, opts: { amount?: number; balance?: number; ts?: number } = {}) {
  const now = Date.now();
  const smsId = `sms-${id}`;
  const ts = opts.ts ?? BASE;
  await baseEnv.DB.prepare(
    `INSERT INTO raw_sms_events
       (id, device_id, sender, normalized_body, body_sha256, app_checksum, sms_timestamp,
        received_at, classification, parser_status, parser_id, parser_version, created_at)
     VALUES (?1,'dev-a','TEST','seed',?2,'cksum',?3,?4,'BANK_CREDIT','OK','test','v1',?4)`,
  )
    .bind(smsId, `hash-${id}`, ts, now)
    .run();
  await baseEnv.DB.prepare(
    `INSERT INTO transaction_candidates
       (id, raw_sms_event_id, financial_account_id, direction, amount_irr, balance_irr, status,
        bank_timestamp, confidence, parser_id, parser_version, parser_evidence_json,
        processing_disposition, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'CREDIT', ?4, ?5, 'PARSED', ?6, 1.0, 'test', 'v1', '{}',
             'ACTIONABLE', ?7, ?7)`,
  )
    .bind(id, smsId, ACCOUNT, opts.amount ?? AMOUNT, opts.balance ?? null, ts, now)
    .run();
}

async function seedClaim(
  id: string,
  txId: string,
  opts: { matchStatus: 'AUTO_VERIFIED' | 'CONFIRMED'; reviewedAt: number; amount?: number },
) {
  const now = Date.now();
  await baseEnv.DB.prepare(
    `INSERT INTO payment_claims
       (id, external_order_id, customer_reference, expected_amount_irr, target_financial_account_id,
        submitted_at, source_system, metadata_json, status, paid_clicked_at, receipt_submitted_at,
        suspect_reason, suspect_metadata_json, card_digits, created_at, updated_at)
     VALUES (?1, ?2, 'u1', ?3, ?4, ?5, 'MIRZABOT', '{}', 'VERIFIED', ?5, ?5, NULL, '{}', '5678', ?5, ?5)`,
  )
    .bind(id, `ord-${id}`, opts.amount ?? AMOUNT, ACCOUNT, now)
    .run();
  await baseEnv.DB.prepare(
    `INSERT INTO reconciliation_matches
       (id, transaction_candidate_id, payment_claim_id, score, matching_reasons_json,
        mismatch_reasons_json, status, reviewed_by, reviewed_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, 1.0, '[]', '[]', ?4, ?5, ?6, ?7, ?7)`,
  )
    .bind(`m-${id}`, txId, id, opts.matchStatus, EMAIL, opts.reviewedAt, now)
    .run();
}

describe('GET /api/v1/analytics', () => {
  it('counts auto and manual verified sales separately', async () => {
    await seedTx('tx-auto', { ts: BASE });
    await seedTx('tx-man', { ts: BASE + 60_000 });
    await seedClaim('c-auto', 'tx-auto', { matchStatus: 'AUTO_VERIFIED', reviewedAt: BASE });
    await seedClaim('c-man', 'tx-man', { matchStatus: 'CONFIRMED', reviewedAt: BASE + 60_000 });

    const r = await app.fetch(new Request('https://x/api/v1/analytics?range=all'), envAs());
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      sales: { count: number; amountIrr: number };
      botAutoVerified: { count: number };
      manualVerified: { count: number };
    };
    expect(body.sales.count).toBe(2);
    expect(body.sales.amountIrr).toBe(AMOUNT * 2);
    expect(body.botAutoVerified.count).toBe(1);
    expect(body.manualVerified.count).toBe(1);
  });

  it('uses latest balance_irr per account', async () => {
    await seedTx('tx-old', { balance: 1_000_000, ts: BASE });
    await seedTx('tx-new', { balance: 4_200_000, ts: BASE + 3600_000 });

    const r = await app.fetch(new Request('https://x/api/v1/accounts/analytics?range=all'), envAs());
    const body = (await r.json()) as {
      items: Array<{
        currentBalanceIrr: number | null;
        primaryDeviceDisplayName: string | null;
      }>;
      totals: { knownAccounts: number; totalKnownBalanceIrr: number };
    };
    expect(body.items[0]!.currentBalanceIrr).toBe(4_200_000);
    expect(body.totals.knownAccounts).toBe(1);
    expect(body.totals.totalKnownBalanceIrr).toBe(4_200_000);
    expect(body.items[0]!.primaryDeviceDisplayName).toBe('Analytics Device');
  });

  it('does not show Infinity when previous period is zero', () => {
    expect(computePercentChange(100, 0, '7d')).toEqual({ kind: 'new' });
    expect(computePercentChange(0, 0, 'all')).toEqual({ kind: 'all_time' });
  });
});

describe('GET /api/v1/cards/analytics', () => {
  it('groups auto-verified purchases by mapped card', async () => {
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO payment_cards (id, financial_account_id, card_digits, created_at)
       VALUES ('pc-1', ?1, '5054161706277613', ?2)`,
    )
      .bind(ACCOUNT, Date.now())
      .run();
    await seedTx('tx-card', { ts: BASE });
    await seedClaim('c-card', 'tx-card', { matchStatus: 'AUTO_VERIFIED', reviewedAt: BASE });

    const r = await app.fetch(new Request('https://x/api/v1/cards/analytics?range=all'), envAs());
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      entity: string;
      items: Array<{ cardMasked: string; purchaseCount: number; hubEligible: boolean }>;
    };
    expect(body.entity).toBe('card_number');
    expect(body.items.some((i) => i.cardMasked === '****7613' && i.purchaseCount === 1)).toBe(true);
  });
});
