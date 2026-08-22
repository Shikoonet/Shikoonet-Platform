/**
 * Manual approval safety for Mirzabot suspects.
 *
 * The Suspects queue is where a human resolves ambiguity, so the ±5m window
 * and the uniqueness rules are deliberately NOT re-imposed here. What must
 * still hold is that an admin cannot approve a mismatched amount or account,
 * cannot spend a transaction twice, and cannot win a race against the
 * automatic matcher.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

// Schema now comes from migrations/000*.sql, applied to the test database.

const EMAIL = 'admin@example.com';
const ACCOUNT = 'acc-approve';
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
     VALUES (?1,'Melli','Approve Target',NULL,'CARD',1,'ACTIVE','{}',?2,?2)`,
  )
    .bind(ACCOUNT, now)
    .run();
  await baseEnv.DB.prepare(
    `INSERT OR IGNORE INTO financial_accounts
     (id, bank_name, display_name, owner_label, account_type, active, status, parser_configuration, created_at, updated_at)
     VALUES ('acc-other','Melli','Other',NULL,'CARD',1,'ACTIVE','{}',?1,?1)`,
  )
    .bind(now)
    .run();
  await baseEnv.DB.prepare(
    `INSERT OR IGNORE INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES ('dev-approve','approve-test','Approve Test',1,?1,?1)`,
  )
    .bind(now)
    .run();
});

beforeEach(async () => {
  await baseEnv.DB.prepare(`DELETE FROM reconciliation_matches`).run();
  await baseEnv.DB.prepare(`DELETE FROM payment_claims`).run();
  await baseEnv.DB.prepare(`DELETE FROM transaction_candidates`).run();
  await baseEnv.DB.prepare(`DELETE FROM raw_sms_events`).run();
});

async function seedClaim(
  id: string,
  over: { amount?: number; account?: string; status?: string } = {},
) {
  const now = Date.now();
  await baseEnv.DB.prepare(
    `INSERT INTO payment_claims
       (id, external_order_id, customer_reference, expected_amount_irr, target_financial_account_id,
        submitted_at, source_system, metadata_json, status, paid_clicked_at, receipt_submitted_at,
        suspect_reason, suspect_metadata_json, created_at, updated_at)
     VALUES (?1, ?2, 'tg-1', ?3, ?4, ?5, 'MIRZABOT', '{}', ?6, ?5, ?5, 'AMBIGUOUS_CLAIMS', '{}', ?7, ?7)`,
  )
    .bind(
      id,
      `mirzabot:test:${id}`,
      over.amount ?? AMOUNT,
      over.account ?? ACCOUNT,
      BASE_MS,
      over.status ?? 'PENDING',
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
     VALUES (?1,'dev-approve','TEST','seed',?2,'cksum',?3,?4,'BANK_CREDIT','OK','test','v1',?4)`,
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

describe('manual approval of Mirzabot suspects', () => {
  it('approves an ambiguous claim the admin picked and consumes the transaction once', async () => {
    await seedClaim('c-ok');
    await seedTx('t-ok');

    const r = await approve('c-ok', 't-ok');
    expect(r.status).toBe(200);

    const claim = await baseEnv.DB.prepare(
      `SELECT status, suspect_reason FROM payment_claims WHERE id = 'c-ok'`,
    ).first<{ status: string; suspect_reason: string | null }>();
    expect(claim?.status).toBe('VERIFIED');
    expect(claim?.suspect_reason).toBeNull();

    const matches = await baseEnv.DB.prepare(
      `SELECT status FROM reconciliation_matches WHERE transaction_candidate_id = 't-ok'`,
    ).all<{ status: string }>();
    expect(matches.results).toHaveLength(1);
    expect(matches.results[0]!.status).toBe('CONFIRMED');
  });

  it('refuses a transaction already spent on another claim', async () => {
    await seedClaim('c-first');
    await seedClaim('c-second');
    await seedTx('t-shared');

    expect((await approve('c-first', 't-shared')).status).toBe(200);
    const second = await approve('c-second', 't-shared');
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe('transaction_already_consumed');

    const claim = await baseEnv.DB.prepare(
      `SELECT status FROM payment_claims WHERE id = 'c-second'`,
    ).first<{ status: string }>();
    expect(claim?.status).not.toBe('VERIFIED');
  });

  it('refuses an amount mismatch', async () => {
    await seedClaim('c-amt');
    await seedTx('t-amt', { amount: AMOUNT + 1 });
    const r = await approve('c-amt', 't-amt');
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe('amount_mismatch');
  });

  it('refuses an account mismatch', async () => {
    await seedClaim('c-acct');
    await seedTx('t-acct', { account: 'acc-other' });
    const r = await approve('c-acct', 't-acct');
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe('account_mismatch');
  });

  it('refuses to re-verify an already verified claim', async () => {
    await seedClaim('c-done');
    await seedTx('t-done-a');
    await seedTx('t-done-b');
    expect((await approve('c-done', 't-done-a')).status).toBe(200);

    const r = await approve('c-done', 't-done-b');
    expect(r.status).toBe(409);

    const matches = await baseEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM reconciliation_matches
       WHERE payment_claim_id = 'c-done' AND status IN ('CONFIRMED','AUTO_VERIFIED')`,
    ).first<{ n: number }>();
    expect(matches?.n).toBe(1);
  });

  it('two admins approving the same transaction concurrently: exactly one wins', async () => {
    await seedClaim('c-race-a');
    await seedClaim('c-race-b');
    await seedTx('t-race');

    const [a, b] = await Promise.all([
      approve('c-race-a', 't-race'),
      approve('c-race-b', 't-race'),
    ]);
    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);

    const consuming = await baseEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM reconciliation_matches
       WHERE transaction_candidate_id = 't-race' AND status IN ('CONFIRMED','AUTO_VERIFIED')`,
    ).first<{ n: number }>();
    expect(consuming?.n).toBe(1);

    const verified = await baseEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM payment_claims
       WHERE id IN ('c-race-a','c-race-b') AND status = 'VERIFIED'`,
    ).first<{ n: number }>();
    expect(verified?.n).toBe(1);
  });

  it('rejecting a suspect never marks it fake automatically', async () => {
    await seedClaim('c-rej');
    const r = await app.fetch(
      new Request('https://example.com/api/v1/suspects/c-rej/reject', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'NO_BANK_TRANSACTION' }),
      }),
      envAs(),
    );
    expect(r.status).toBe(200);
    const claim = await baseEnv.DB.prepare(
      `SELECT status FROM payment_claims WHERE id = 'c-rej'`,
    ).first<{ status: string }>();
    expect(claim?.status).toBe('REJECTED');
    expect(claim?.status).not.toBe('FAKE_RECEIPT');
  });
});
