/**
 * Revert manual Mirzabot verification via dashboard API.
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
const ACCOUNT = 'acc-revert-api';
const AMOUNT = 1_500_000;
const BASE_MS = 1_786_091_200_000;

function envAs(email = EMAIL) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

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
     VALUES (?1,'Melli','Revert Target',NULL,'CARD',1,'ACTIVE','{}',?2,?2)`,
  )
    .bind(ACCOUNT, now)
    .run();
  await baseEnv.DB.prepare(
    `INSERT OR IGNORE INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES ('dev-revert-api','revert-api','Revert API',1,?1,?1)`,
  )
    .bind(now)
    .run();
});

beforeEach(async () => {
  await baseEnv.DB.prepare(`DELETE FROM audit_logs`).run();
  await baseEnv.DB.prepare(`DELETE FROM reconciliation_matches`).run();
  await baseEnv.DB.prepare(`DELETE FROM payment_claims`).run();
  await baseEnv.DB.prepare(`DELETE FROM transaction_candidates`).run();
  await baseEnv.DB.prepare(`DELETE FROM raw_sms_events`).run();
});

async function seedClaim(id: string) {
  const now = Date.now();
  await baseEnv.DB.prepare(
    `INSERT INTO payment_claims
       (id, external_order_id, customer_reference, expected_amount_irr, target_financial_account_id,
        submitted_at, source_system, metadata_json, status, paid_clicked_at, receipt_submitted_at,
        suspect_reason, suspect_metadata_json, created_at, updated_at)
     VALUES (?1, ?2, 'tg-1', ?3, ?4, ?5, 'MIRZABOT', '{}', 'PENDING', ?5, ?5, 'AMBIGUOUS_CLAIMS', '{}', ?6, ?6)`,
  )
    .bind(id, `mirzabot:test:${id}`, AMOUNT, ACCOUNT, BASE_MS, now)
    .run();
}

async function seedTx(id: string) {
  const now = Date.now();
  const smsId = `sms-${id}`;
  await baseEnv.DB.prepare(
    `INSERT INTO raw_sms_events
       (id, device_id, sender, normalized_body, body_sha256, app_checksum, sms_timestamp,
        received_at, classification, parser_status, parser_id, parser_version, created_at)
     VALUES (?1,'dev-revert-api','TEST','seed',?2,'cksum',?3,?4,'BANK_CREDIT','OK','test','v1',?4)`,
  )
    .bind(smsId, `hash-${id}`, BASE_MS + 20_000, now)
    .run();
  await baseEnv.DB.prepare(
    `INSERT INTO transaction_candidates
       (id, raw_sms_event_id, financial_account_id, direction, amount_irr, status, bank_timestamp,
        confidence, parser_id, parser_version, parser_evidence_json, processing_disposition,
        created_at, updated_at)
     VALUES (?1, ?2, ?3, 'CREDIT', ?4, 'MATCH_SUGGESTED', ?5, 1.0, 'test', 'v1', '{}',
             'ACTIONABLE', ?6, ?6)`,
  )
    .bind(id, smsId, ACCOUNT, AMOUNT, BASE_MS + 20_000, now)
    .run();
}

function approve(claimId: string, transactionId: string) {
  return app.fetch(
    new Request(`https://example.com/api/v1/suspects/${claimId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transactionId }),
    }),
    envAs(),
  );
}

function revert(claimId: string) {
  return app.fetch(
    new Request(`https://example.com/api/v1/payment-claims/${claimId}/revert-manual-verification`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }),
    envAs(),
  );
}

describe('revert manual verification API', () => {
  it('reverts manual approve and exposes revertEligible on All tab list', async () => {
    await seedClaim('c-api');
    await seedTx('t-api');
    expect((await approve('c-api', 't-api')).status).toBe(200);

    const listBefore = await app.fetch(
      new Request('https://example.com/api/v1/payments?tab=all&range=all'),
      envAs(),
    );
    const bodyBefore = (await listBefore.json()) as {
      items: Array<{ id: string; revertEligible: boolean; reviewState: string }>;
    };
    const row = bodyBefore.items.find((i) => i.id === 'c-api');
    expect(row?.reviewState).toBe('MANUALLY_VERIFIED');
    expect(row?.revertEligible).toBe(true);

    const resp = await revert('c-api');
    expect(resp.status).toBe(200);
    const reverted = (await resp.json()) as { restoredClaimStatus: string };
    expect(reverted.restoredClaimStatus).toBe('PENDING');

    const claim = await baseEnv.DB.prepare(
      `SELECT status, suspect_reason FROM payment_claims WHERE id = 'c-api'`,
    ).first<{ status: string; suspect_reason: string | null }>();
    expect(claim?.status).toBe('PENDING');
    expect(claim?.suspect_reason).toBeTruthy();

    const listAfter = await app.fetch(
      new Request('https://example.com/api/v1/payments?tab=all&range=all'),
      envAs(),
    );
    const bodyAfter = (await listAfter.json()) as {
      items: Array<{ id: string; revertEligible?: boolean; reviewState: string }>;
    };
    const afterRow = bodyAfter.items.find((i) => i.id === 'c-api');
    expect(afterRow?.reviewState).toBe('NEEDS_REVIEW');
    expect(afterRow?.revertEligible).toBeFalsy();

    const audit = await baseEnv.DB.prepare(
      `SELECT action FROM audit_logs WHERE action = 'claim.reverted_manual_verification'`,
    ).first<{ action: string }>();
    expect(audit?.action).toBe('claim.reverted_manual_verification');
  });

  it('does not mark bot auto verified rows as revert eligible', async () => {
    await seedClaim('c-auto');
    await seedTx('t-auto');
    const now = Date.now();
    await baseEnv.DB.prepare(
      `INSERT INTO reconciliation_matches
         (id, transaction_candidate_id, payment_claim_id, score, matching_reasons_json,
          mismatch_reasons_json, status, created_at, updated_at)
       VALUES ('m-auto','t-auto','c-auto',1.0,'[]','[]','AUTO_VERIFIED',?1,?1)`,
    )
      .bind(now)
      .run();
    await baseEnv.DB.prepare(
      `UPDATE payment_claims SET status = 'VERIFIED', suspect_reason = NULL, updated_at = ?1 WHERE id = 'c-auto'`,
    )
      .bind(now)
      .run();
    await baseEnv.DB.prepare(
      `UPDATE transaction_candidates SET status = 'APPROVED', updated_at = ?1 WHERE id = 't-auto'`,
    )
      .bind(now)
      .run();

    const list = await app.fetch(
      new Request('https://example.com/api/v1/payments?tab=all&range=all'),
      envAs(),
    );
    const body = (await list.json()) as {
      items: Array<{ id: string; revertEligible?: boolean }>;
    };
    expect(body.items.find((i) => i.id === 'c-auto')?.revertEligible).toBeFalsy();

    const resp = await revert('c-auto');
    expect(resp.status).toBe(409);
    expect(((await resp.json()) as { error: string }).error).toBe('auto_verified_not_revertable');
  });

  it('leaves processing_disposition ACTIONABLE after revert', async () => {
    await seedClaim('c-pd');
    await seedTx('t-pd');
    expect((await approve('c-pd', 't-pd')).status).toBe(200);
    expect((await revert('c-pd')).status).toBe(200);

    const tx = await baseEnv.DB.prepare(
      `SELECT processing_disposition FROM transaction_candidates WHERE id = 't-pd'`,
    ).first<{ processing_disposition: string }>();
    expect(tx?.processing_disposition).toBe('ACTIONABLE');
  });
});
