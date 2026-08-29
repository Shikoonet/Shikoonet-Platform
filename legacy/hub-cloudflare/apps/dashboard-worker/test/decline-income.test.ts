/**
 * Income decline / restore workflow — reversible operator disposition.
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
import SHA13 from '../../migrations/0013_resellers.sql?raw';
import SHA14 from '../../migrations/0014_income_declined.sql?raw';
import {
  classifyResellerTransaction,
  createReseller,
  declineIncomeTransaction,
  restoreIncomeTransaction,
  type D1Database as DomainD1Database,
} from '@hub/domain';
import { app } from '../src/index.js';

const SCHEMA = [SHA, SHA2, SHA3, SHA4, SHA5, SHA6, SHA7, SHA8, SHA9, SHA10, SHA11, SHA13, SHA14]
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

async function applySchema() {
  for (const stmt of splitStatements(SCHEMA)) {
    try {
      await baseEnv.DB.prepare(stmt).run();
    } catch (err) {
      const msg = String(err);
      if (msg.includes('already exists') || msg.includes('duplicate column name')) continue;
      throw err;
    }
  }
}

const EMAIL = 'admin@example.com';
const ACCOUNT = 'acc-decline';
const AMOUNT = 1_000_000;
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
     VALUES (?1,'Gardeshgari','Decline Target',NULL,'CARD',1,'ACTIVE','{}',?2,?2)`,
  )
    .bind(ACCOUNT, now)
    .run();
  await baseEnv.DB.prepare(
    `INSERT OR IGNORE INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES ('dev-d', 'DEV-D', 'Decline Test Device', 1, ?1, ?1)`,
  )
    .bind(now)
    .run();
});

beforeEach(async () => {
  await baseEnv.DB.prepare(`DELETE FROM income_declined_transactions`).run();
  await baseEnv.DB.prepare(`DELETE FROM audit_logs`).run();
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
     VALUES (?1,'dev-d','TEST','seed',?2,'cksum',?3,?4,'BANK_CREDIT','OK','test','v1',?4)`,
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

describe('decline income', () => {
  it('declines active income without deleting financial rows', async () => {
    await seedTx('t-decline');
    const result = await declineIncomeTransaction(db(), {
      transactionId: 't-decline',
      actorEmail: EMAIL,
      reason: 'Already reconciled externally',
    });
    expect(result.ok).toBe(true);

    const tx = await baseEnv.DB.prepare(`SELECT id FROM transaction_candidates WHERE id = 't-decline'`)
      .first();
    const sms = await baseEnv.DB.prepare(
      `SELECT id FROM raw_sms_events WHERE id = 'sms-t-decline'`,
    ).first();
    expect(tx?.id).toBe('t-decline');
    expect(sms?.id).toBe('sms-t-decline');

    const income = await app.fetch(
      new Request('https://example.com/api/v1/payments?tab=income&range=all'),
      envAs(),
    );
    expect(income.status).toBe(200);
    const incomeBody = (await income.json()) as { items: Array<{ id: string }> };
    expect(incomeBody.items).toHaveLength(0);

    const declined = await app.fetch(
      new Request('https://example.com/api/v1/payments?tab=declined_income&range=all'),
      envAs(),
    );
    expect(declined.status).toBe(200);
    const declinedBody = (await declined.json()) as {
      items: Array<{ id: string; declineReason: string; declinedBy: string }>;
    };
    expect(declinedBody.items).toHaveLength(1);
    expect(declinedBody.items[0]?.id).toBe('t-decline');
    expect(declinedBody.items[0]?.declineReason).toBe('Already reconciled externally');
    expect(declinedBody.items[0]?.declinedBy).toBe(EMAIL);
  });

  it('restore returns eligible tx to income', async () => {
    await seedTx('t-restore');
    await declineIncomeTransaction(db(), {
      transactionId: 't-restore',
      actorEmail: EMAIL,
    });
    const restored = await restoreIncomeTransaction(db(), {
      transactionId: 't-restore',
      actorEmail: EMAIL,
    });
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.returnedToIncome).toBe(true);

    const income = await app.fetch(
      new Request('https://example.com/api/v1/payments?tab=income&range=all'),
      envAs(),
    );
    const body = (await income.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(['t-restore']);
  });

  it('restore does not return reseller-classified tx to income', async () => {
    await seedTx('t-reseller');
    await declineIncomeTransaction(db(), {
      transactionId: 't-reseller',
      actorEmail: EMAIL,
    });
    const r = await createReseller(db(), { name: 'Net Co' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await classifyResellerTransaction(db(), {
      transactionId: 't-reseller',
      resellerId: r.id,
      actorEmail: EMAIL,
    });

    const restored = await restoreIncomeTransaction(db(), {
      transactionId: 't-reseller',
      actorEmail: EMAIL,
    });
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.returnedToIncome).toBe(false);

    const income = await app.fetch(
      new Request('https://example.com/api/v1/payments?tab=income&range=all'),
      envAs(),
    );
    const body = (await income.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(0);
  });

  it('bulk decline via API', async () => {
    await seedTx('t-b1');
    await seedTx('t-b2');
    const resp = await app.fetch(
      new Request('https://example.com/api/v1/transactions/decline-income/bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transactionIds: ['t-b1', 't-b2'] }),
      }),
      envAs(),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { declined: string[] };
    expect(body.declined.sort()).toEqual(['t-b1', 't-b2']);
  });

  it('writes audit on decline', async () => {
    await seedTx('t-audit');
    const resp = await app.fetch(
      new Request('https://example.com/api/v1/transactions/t-audit/decline-income', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'test' }),
      }),
      envAs(),
    );
    expect(resp.status).toBe(200);
    const audit = await baseEnv.DB.prepare(
      `SELECT action FROM audit_logs WHERE action = 'transaction.declined_income'`,
    ).first<{ action: string }>();
    expect(audit?.action).toBe('transaction.declined_income');
  });

  it('leaves processing_disposition ACTIONABLE for matching semantics', async () => {
    await seedTx('t-match');
    await declineIncomeTransaction(db(), {
      transactionId: 't-match',
      actorEmail: EMAIL,
    });
    const tx = await baseEnv.DB.prepare(
      `SELECT processing_disposition FROM transaction_candidates WHERE id = 't-match'`,
    ).first<{ processing_disposition: string }>();
    expect(tx?.processing_disposition).toBe('ACTIONABLE');
  });
});
