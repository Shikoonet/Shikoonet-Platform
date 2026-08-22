/**
 * Reseller classification and income eligibility.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import {
  classifyResellerTransaction,
  createReseller,
  type D1Database as DomainD1Database,
} from '@shikoo/domain';
import { app } from '../src/index.js';

// Schema now comes from migrations/000*.sql, applied to the test database.

const EMAIL = 'admin@example.com';
const ACCOUNT = 'acc-reseller';
const AMOUNT = 2_000_000;
const BASE_MS = 1_786_091_200_000;

function envAs(email = EMAIL) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

const db = () => baseEnv.DB as unknown as DomainD1Database;

beforeAll(async () => {
  await applySchema();
  const now = Date.now();
  await baseEnv.DB.prepare(
    `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
     VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)`,
  )
    .bind(crypto.randomUUID(), EMAIL, now)
    .run();
  await baseEnv.DB.prepare(
    `INSERT OR IGNORE INTO financial_accounts
     (id, bank_name, display_name, owner_label, account_type, active, status, parser_configuration, created_at, updated_at)
     VALUES (?1,'Melli','Reseller Target',NULL,'CARD',1,'ACTIVE','{}',?2,?2)`,
  )
    .bind(ACCOUNT, now)
    .run();
  await baseEnv.DB.prepare(
    `INSERT OR IGNORE INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES ('dev-r', 'DEV-R', 'Reseller Test Device', 1, ?1, ?1)`,
  )
    .bind(now)
    .run();
});

beforeEach(async () => {
  await baseEnv.DB.prepare(`TRUNCATE audit_logs CASCADE`).run();
  await baseEnv.DB.prepare(`DELETE FROM reseller_transactions`).run();
  await baseEnv.DB.prepare(`DELETE FROM resellers`).run();
  await baseEnv.DB.prepare(`DELETE FROM reconciliation_matches`).run();
  await baseEnv.DB.prepare(`DELETE FROM payment_claims`).run();
  await baseEnv.DB.prepare(`DELETE FROM transaction_candidates`).run();
  await baseEnv.DB.prepare(`DELETE FROM raw_sms_events`).run();
});

async function seedTx(id: string) {
  const now = Date.now();
  const smsId = `sms-${id}`;
  await baseEnv.DB.prepare(
    `INSERT INTO raw_sms_events
       (id, device_id, sender, normalized_body, body_sha256, app_checksum, sms_timestamp,
        received_at, classification, parser_status, parser_id, parser_version, created_at)
     VALUES (?1,'dev-r','TEST','seed',?2,'cksum',?3,?4,'BANK_CREDIT','OK','test','v1',?4)`,
  )
    .bind(smsId, `hash-${id}`, BASE_MS, now)
    .run();
  await baseEnv.DB.prepare(
    `INSERT INTO transaction_candidates
       (id, raw_sms_event_id, financial_account_id, direction, amount_irr, status, bank_timestamp,
        confidence, parser_id, parser_version, parser_evidence_json, processing_disposition,
        created_at, updated_at)
     VALUES (?1, ?2, ?3, 'CREDIT', ?4, 'PARSED', ?5, 1.0, 'test', 'v1', '{}',
             'ACTIONABLE', ?6, ?6)`,
  )
    .bind(id, smsId, ACCOUNT, AMOUNT, BASE_MS, now)
    .run();
}

describe('reseller classification', () => {
  it('classifies income transaction and excludes from ACTIONABLE', async () => {
    await seedTx('t-income');
    const reseller = await createReseller(db(), { name: 'ABC Networks' });
    expect(reseller.ok).toBe(true);
    if (!reseller.ok) return;

    const result = await classifyResellerTransaction(db(), {
      transactionId: 't-income',
      resellerId: reseller.id,
      actorEmail: EMAIL,
      note: 'August top-up',
    });
    expect(result.ok).toBe(true);

    const tx = await baseEnv.DB.prepare(
      `SELECT processing_disposition FROM transaction_candidates WHERE id = 't-income'`,
    ).first<{ processing_disposition: string }>();
    expect(tx?.processing_disposition).toBe('ADMIN_EXCLUDED');
  });

  it('blocks double classification', async () => {
    await seedTx('t-dup');
    const r1 = await createReseller(db(), { name: 'XYZ' });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(
      (
        await classifyResellerTransaction(db(), {
          transactionId: 't-dup',
          resellerId: r1.id,
          actorEmail: EMAIL,
        })
      ).ok,
    ).toBe(true);

    const r2 = await createReseller(db(), { name: 'Other' });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const second = await classifyResellerTransaction(db(), {
      transactionId: 't-dup',
      resellerId: r2.id,
      actorEmail: EMAIL,
    });
    expect(second.ok).toBe(false);
  });

  it('writes audit on API classify', async () => {
    await seedTx('t-audit');
    const r = await createReseller(db(), { name: 'Audit Co' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const resp = await app.fetch(
      new Request('https://example.com/api/v1/transactions/t-audit/classify-reseller', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resellerId: r.id, note: 'test note' }),
      }),
      envAs(),
    );
    expect(resp.status).toBe(200);

    const audit = await baseEnv.DB.prepare(
      `SELECT action FROM audit_logs WHERE action = 'transaction.classified_reseller'`,
    ).first<{ action: string }>();
    expect(audit?.action).toBe('transaction.classified_reseller');
  });

  it('lists income excluding classified reseller tx', async () => {
    await seedTx('t-visible');
    await seedTx('t-hidden');
    const r = await createReseller(db(), { name: 'Hidden Reseller' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await classifyResellerTransaction(db(), {
      transactionId: 't-hidden',
      resellerId: r.id,
      actorEmail: EMAIL,
    });

    const resp = await app.fetch(
      new Request('https://example.com/api/v1/payments?tab=income&range=all'),
      envAs(),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(['t-visible']);
  });

  it('loads income tab with range=today without SQL bind errors', async () => {
    await seedTx('t-today');
    const resp = await app.fetch(
      new Request('https://example.com/api/v1/payments?tab=income&range=today'),
      envAs(),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; range: string; items: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.range).toBe('today');
    expect(Array.isArray(body.items)).toBe(true);
  });
});
