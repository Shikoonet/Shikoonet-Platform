/**
 * Atomic transaction reassignment between Mirzabot payment claims.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

// Schema now comes from migrations/000*.sql, applied to the test database.

const EMAIL = 'admin@example.com';
const ACCOUNT = 'acc-reassign';
const AMOUNT = 1_000_000;
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
     VALUES (?1,'Melli','Reassign Target',NULL,'CARD',1,'ACTIVE','{}',?2,?2)`,
  )
    .bind(ACCOUNT, now)
    .run();
  await baseEnv.DB.prepare(
    `INSERT OR IGNORE INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES ('dev-reassign','reassign-test','Reassign Test',1,?1,?1)`,
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

async function seedClaim(
  id: string,
  over: {
    amount?: number;
    account?: string;
    status?: string;
    order?: string;
    meta?: string;
    suspect?: string | null;
  } = {},
) {
  const now = Date.now();
  await baseEnv.DB.prepare(
    `INSERT INTO payment_claims
       (id, external_order_id, customer_reference, expected_amount_irr, target_financial_account_id,
        submitted_at, source_system, metadata_json, status, paid_clicked_at, receipt_submitted_at,
        suspect_reason, suspect_metadata_json, created_at, updated_at)
     VALUES (?1, ?2, '560573543', ?3, ?4, ?5, 'MIRZABOT', ?6, ?7, ?5, ?5, ?8, '{}', ?9, ?9)`,
  )
    .bind(
      id,
      over.order ?? `mirzabot:test:${id}`,
      over.amount ?? AMOUNT,
      over.account ?? ACCOUNT,
      BASE_MS,
      over.meta ?? '{"telegramUserId":"560573543","telegramUsername":"ali"}',
      over.status ?? 'PENDING',
      over.suspect ?? 'NO_TRANSACTION_AFTER_10M',
      now,
    )
    .run();
}

async function seedTx(id: string, over: { amount?: number; account?: string } = {}) {
  const now = Date.now();
  const smsId = `sms-${id}`;
  await baseEnv.DB.prepare(
    `INSERT INTO raw_sms_events
       (id, device_id, sender, normalized_body, body_sha256, app_checksum, sms_timestamp,
        received_at, classification, parser_status, parser_id, parser_version, created_at)
     VALUES (?1,'dev-reassign','TEST','seed',?2,'cksum',?3,?4,'BANK_CREDIT','OK','test','v1',?4)`,
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
    .bind(id, smsId, over.account ?? ACCOUNT, over.amount ?? AMOUNT, BASE_MS + 20_000, now)
    .run();
}

async function seedSuggestedMatch(matchId: string, txId: string, claimId: string) {
  const now = Date.now();
  await baseEnv.DB.prepare(
    `INSERT INTO reconciliation_matches
       (id, transaction_candidate_id, payment_claim_id, score, matching_reasons_json,
        mismatch_reasons_json, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, 0.9, '[]', '[]', 'SUGGESTED', ?4, ?4)`,
  )
    .bind(matchId, txId, claimId, now)
    .run();
  await baseEnv.DB.prepare(
    `UPDATE payment_claims SET status = 'MATCH_SUGGESTED' WHERE id = ?1`,
  )
    .bind(claimId)
    .run();
}

function reassign(
  claimId: string,
  body: { transactionId: string; reason: string; verifyAfterAssign?: boolean },
) {
  return app.fetch(
    new Request(`https://example.com/api/v1/payment-claims/${claimId}/reassign-transaction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    envAs(),
  );
}

describe('transaction reassignment', () => {
  it('assigns an unassigned transaction and verifies the target claim', async () => {
    await seedClaim('c-target');
    await seedTx('t-free');

    const r = await reassign('c-target', {
      transactionId: 't-free',
      reason: 'Found the correct transfer',
      verifyAfterAssign: true,
    });
    expect(r.status).toBe(200);

    const claim = await baseEnv.DB.prepare(
      `SELECT status FROM payment_claims WHERE id = 'c-target'`,
    ).first<{ status: string }>();
    expect(claim?.status).toBe('VERIFIED');

    const match = await baseEnv.DB.prepare(
      `SELECT status FROM reconciliation_matches WHERE transaction_candidate_id = 't-free'`,
    ).first<{ status: string }>();
    expect(match?.status).toBe('CONFIRMED');
  });

  it('reassigns a suggested transaction from one claim to another', async () => {
    await seedClaim('c-old', { order: 'mirzabot:test:order-a', meta: '{"telegramUserId":"1","telegramUsername":"reza"}' });
    await seedClaim('c-new', { order: 'mirzabot:test:order-b' });
    await seedTx('t-shared');
    await seedSuggestedMatch('m-old', 't-shared', 'c-old');

    const r = await reassign('c-new', {
      transactionId: 't-shared',
      reason: 'Wrong order suggested',
      verifyAfterAssign: true,
    });
    expect(r.status).toBe(200);

    const oldClaim = await baseEnv.DB.prepare(
      `SELECT status FROM payment_claims WHERE id = 'c-old'`,
    ).first<{ status: string }>();
    expect(oldClaim?.status).toBe('PENDING');

    const newClaim = await baseEnv.DB.prepare(
      `SELECT status FROM payment_claims WHERE id = 'c-new'`,
    ).first<{ status: string }>();
    expect(newClaim?.status).toBe('VERIFIED');

    const consuming = await baseEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM reconciliation_matches
       WHERE transaction_candidate_id = 't-shared' AND status IN ('CONFIRMED','AUTO_VERIFIED')`,
    ).first<{ n: number }>();
    expect(consuming?.n).toBe(1);
  });

  it('blocks reassignment when the transaction is already confirmed', async () => {
    await seedClaim('c-owner', { status: 'VERIFIED' });
    await seedClaim('c-want');
    await seedTx('t-used');
    const now = Date.now();
    await baseEnv.DB.prepare(
      `INSERT INTO reconciliation_matches
         (id, transaction_candidate_id, payment_claim_id, score, matching_reasons_json,
          mismatch_reasons_json, status, reviewed_at, created_at, updated_at)
       VALUES ('m-confirmed', 't-used', 'c-owner', 1.0, '[]', '[]', 'CONFIRMED', ?1, ?1, ?1)`,
    )
      .bind(now)
      .run();

    const r = await reassign('c-want', {
      transactionId: 't-used',
      reason: 'Attempt steal',
      verifyAfterAssign: true,
    });
    expect(r.status).toBe(409);
    const j = (await r.json()) as { error: string; consumedBy?: { orderId: string } };
    expect(j.error).toBe('transaction_already_consumed');
    expect(j.consumedBy?.orderId).toBeTruthy();
  });

  it('writes an audit log for reassignment', async () => {
    await seedClaim('c-audit');
    await seedTx('t-audit');

    expect(
      (
        await reassign('c-audit', {
          transactionId: 't-audit',
          reason: 'Operator correction',
          verifyAfterAssign: true,
        })
      ).status,
    ).toBe(200);

    const audit = await baseEnv.DB.prepare(
      `SELECT action, reason FROM audit_logs WHERE action = 'transaction.reassigned'`,
    ).first<{ action: string; reason: string }>();
    expect(audit?.action).toBe('transaction.reassigned');
    expect(audit?.reason).toBe('Operator correction');
  });

  it('two admins reassigning the same transaction concurrently: exactly one wins', async () => {
    await seedClaim('c-race-a');
    await seedClaim('c-race-b');
    await seedTx('t-race');

    const [a, b] = await Promise.all([
      reassign('c-race-a', {
        transactionId: 't-race',
        reason: 'A',
        verifyAfterAssign: true,
      }),
      reassign('c-race-b', {
        transactionId: 't-race',
        reason: 'B',
        verifyAfterAssign: true,
      }),
    ]);
    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);

    const verified = await baseEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM payment_claims
       WHERE id IN ('c-race-a','c-race-b') AND status = 'VERIFIED'`,
    ).first<{ n: number }>();
    expect(verified?.n).toBe(1);
  });

  it('requires a reassignment reason', async () => {
    await seedClaim('c-reason');
    await seedTx('t-reason');
    const r = await reassign('c-reason', {
      transactionId: 't-reason',
      reason: '   ',
      verifyAfterAssign: false,
    });
    expect(r.status).toBe(400);
  });
});
