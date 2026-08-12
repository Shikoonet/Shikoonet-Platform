/**
 * Reopen manual Mirzabot verification via dashboard API.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

// Schema now comes from migrations/000*.sql, applied to the test database.

const EMAIL = 'admin@example.com';
const ACCOUNT = 'acc-reopen-api';
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
     VALUES (?1,'Melli','Reopen Target',NULL,'CARD',1,'ACTIVE','{}',?2,?2)`,
  )
    .bind(ACCOUNT, now)
    .run();
  await baseEnv.DB.prepare(
    `INSERT OR IGNORE INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES ('dev-reopen-api','reopen-api','Reopen API',1,?1,?1)`,
  )
    .bind(now)
    .run();
});

beforeEach(async () => {
  await baseEnv.DB.prepare(`TRUNCATE audit_logs CASCADE`).run();
  await baseEnv.DB.prepare(`DELETE FROM reconciliation_matches`).run();
  await baseEnv.DB.prepare(`DELETE FROM payment_claims`).run();
  await baseEnv.DB.prepare(`DELETE FROM transaction_candidates`).run();
  await baseEnv.DB.prepare(`DELETE FROM raw_sms_events`).run();
});

async function seedClaim(id: string, suspectReason: string | null = 'AMBIGUOUS_CLAIMS') {
  const now = Date.now();
  await baseEnv.DB.prepare(
    `INSERT INTO payment_claims
       (id, external_order_id, customer_reference, expected_amount_irr, target_financial_account_id,
        submitted_at, source_system, metadata_json, status, paid_clicked_at, receipt_submitted_at,
        suspect_reason, suspect_metadata_json, created_at, updated_at)
     VALUES (?1, ?2, 'tg-1', ?3, ?4, ?5, 'MIRZABOT', '{}', 'PENDING', ?5, ?5, ?6, '{}', ?7, ?7)`,
  )
    .bind(id, `mirzabot:test:${id}`, AMOUNT, ACCOUNT, BASE_MS, suspectReason, now)
    .run();
}

async function seedTx(id: string, amount = AMOUNT, bankTs = BASE_MS + 20_000) {
  const now = Date.now();
  const smsId = `sms-${id}`;
  await baseEnv.DB.prepare(
    `INSERT INTO raw_sms_events
       (id, device_id, sender, normalized_body, body_sha256, app_checksum, sms_timestamp,
        received_at, classification, parser_status, parser_id, parser_version, created_at)
     VALUES (?1,'dev-reopen-api','TEST','seed',?2,'cksum',?3,?4,'BANK_CREDIT','OK','test','v1',?4)`,
  )
    .bind(smsId, `hash-${id}`, bankTs, now)
    .run();
  await baseEnv.DB.prepare(
    `INSERT INTO transaction_candidates
       (id, raw_sms_event_id, financial_account_id, direction, amount_irr, status, bank_timestamp,
        confidence, parser_id, parser_version, parser_evidence_json, processing_disposition,
        created_at, updated_at)
     VALUES (?1, ?2, ?3, 'CREDIT', ?4, 'MATCH_SUGGESTED', ?5, 1.0, 'test', 'v1', '{}',
             'ACTIONABLE', ?6, ?6)`,
  )
    .bind(id, smsId, ACCOUNT, amount, bankTs, now)
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

function reopen(claimId: string, reason = 'Wrong transaction linked') {
  return app.fetch(
    new Request(`https://example.com/api/v1/payment-claims/${claimId}/reopen-manual-verification`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
    }),
    envAs(),
  );
}

describe('reopen manual verification API', () => {
  it('requires reason', async () => {
    await seedClaim('c-reason');
    await seedTx('t-reason');
    expect((await approve('c-reason', 't-reason')).status).toBe(200);

    const resp = await app.fetch(
      new Request('https://example.com/api/v1/payment-claims/c-reason/reopen-manual-verification', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      envAs(),
    );
    expect(resp.status).toBe(400);
  });

  it('lists manually verified only on manually_verified tab', async () => {
    await seedClaim('c-manual');
    await seedTx('t-manual');
    expect((await approve('c-manual', 't-manual')).status).toBe(200);

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
      `UPDATE payment_claims SET status = 'VERIFIED', updated_at = ?1 WHERE id = 'c-auto'`,
    )
      .bind(now)
      .run();

    const manualTab = await app.fetch(
      new Request('https://example.com/api/v1/payments?tab=manually_verified&range=all'),
      envAs(),
    );
    const body = (await manualTab.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(['c-manual']);
  });

  it('reopens manual approve, preserves audit history, and reclassifies to Needs Review', async () => {
    await seedClaim('c-reopen');
    await seedTx('t-wrong', AMOUNT, BASE_MS + 20_000);
    await seedTx('t-mismatch', AMOUNT + 500_000, BASE_MS + 25_000);
    expect((await approve('c-reopen', 't-wrong')).status).toBe(200);

    const approveAudit = await baseEnv.DB.prepare(
      `SELECT action FROM audit_logs WHERE entity_id = 'c-reopen' AND action = 'claim.approved'`,
    ).first<{ action: string }>();
    expect(approveAudit?.action).toBe('claim.approved');

    const resp = await reopen('c-reopen', 'Linked wrong tx');
    expect(resp.status).toBe(200);
    const reopened = (await resp.json()) as { reviewQueue: string; suspectReason: string | null };
    expect(reopened.reviewQueue).toBe('NEEDS_REVIEW');
    expect(['AMOUNT_MISMATCH', 'AMBIGUOUS_TRANSACTIONS', 'UNIQUE_EXACT_MATCH']).toContain(
      reopened.suspectReason,
    );

    const reopenAudit = await baseEnv.DB.prepare(
      `SELECT action FROM audit_logs WHERE action = 'claim.manual_verification_reopened'`,
    ).first<{ action: string }>();
    expect(reopenAudit?.action).toBe('claim.manual_verification_reopened');
    expect(approveAudit?.action).toBe('claim.approved');

    const manualList = await app.fetch(
      new Request('https://example.com/api/v1/payments?tab=manually_verified&range=all'),
      envAs(),
    );
    const manualBody = (await manualList.json()) as { items: Array<{ id: string }> };
    expect(manualBody.items.find((i) => i.id === 'c-reopen')).toBeUndefined();

    const reviewList = await app.fetch(
      new Request('https://example.com/api/v1/payments?tab=needs_review&range=all'),
      envAs(),
    );
    const reviewBody = (await reviewList.json()) as { items: Array<{ id: string }> };
    expect(reviewBody.items.find((i) => i.id === 'c-reopen')).toBeTruthy();
  });

  it('reclassifies to Suspected Fake when no evidence after threshold', async () => {
    const oldPaid = Date.now() - 20 * 60_000;
    const now = Date.now();
    await baseEnv.DB.prepare(
      `INSERT INTO payment_claims
         (id, external_order_id, customer_reference, expected_amount_irr, target_financial_account_id,
          submitted_at, source_system, metadata_json, status, paid_clicked_at, receipt_submitted_at,
          suspect_reason, suspect_metadata_json, created_at, updated_at)
       VALUES ('c-old', 'mirzabot:test:c-old', 'tg-1', ?1, ?2, ?3, 'MIRZABOT', '{}', 'PENDING',
               ?3, ?3, NULL, '{}', ?4, ?4)`,
    )
      .bind(AMOUNT, ACCOUNT, oldPaid, now)
      .run();
    const manual = await app.fetch(
      new Request('https://example.com/api/v1/suspects/c-old/verify-manual', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'verified externally' }),
      }),
      envAs(),
    );
    expect(manual.status).toBe(200);

    const resp = await reopen('c-old', 'No real payment');
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { reviewQueue: string };
    expect(body.reviewQueue).toBe('SUSPECTED_FAKE');
  });

  it('concurrent reopen: exactly one wins', async () => {
    await seedClaim('c-race');
    await seedTx('t-race');
    expect((await approve('c-race', 't-race')).status).toBe(200);

    const [a, b] = await Promise.all([
      reopen('c-race', 'first'),
      reopen('c-race', 'second'),
    ]);
    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);

    const claim = await baseEnv.DB.prepare(
      `SELECT status FROM payment_claims WHERE id = 'c-race'`,
    ).first<{ status: string }>();
    expect(claim?.status).not.toBe('VERIFIED');
  });

  it('does not mark bot auto verified as reopen eligible', async () => {
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
      `UPDATE payment_claims SET status = 'VERIFIED', updated_at = ?1 WHERE id = 'c-auto'`,
    )
      .bind(now)
      .run();

    const resp = await reopen('c-auto');
    expect(resp.status).toBe(409);
  });
});
