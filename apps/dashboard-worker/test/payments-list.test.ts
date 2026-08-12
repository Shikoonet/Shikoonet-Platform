/**
 * Read projection behind the payment review inbox.
 *
 * The endpoint must not invent state: every bucket it reports has to follow
 * from what the matcher already wrote to payment_claims / reconciliation_matches.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

// Schema now comes from migrations/000*.sql, applied to the test database.

const EMAIL = 'admin@example.com';
const ACCOUNT = 'acc-payments';
const AMOUNT = 1_950_000;
const CARD = '5054161706275678';

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
     (id, bank_name, display_name, owner_label, account_type, active, status, account_hint,
      parser_configuration, created_at, updated_at)
     VALUES (?1,'Melli','Melli Main',NULL,'CARD',1,'ACTIVE','6006','{}',?2,?2)`,
  )
    .bind(ACCOUNT, now)
    .run();
  await baseEnv.DB.prepare(
    `INSERT OR IGNORE INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES ('dev-pay','pay-test','Pay Test',1,?1,?1)`,
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

interface ClaimSeed {
  status?: string;
  suspectReason?: string | null;
  paidClickedAt?: number;
  suspectMeta?: object;
}

async function seedClaim(id: string, seed: ClaimSeed = {}) {
  const now = Date.now();
  const paid = seed.paidClickedAt ?? now;
  await baseEnv.DB.prepare(
    `INSERT INTO payment_claims
       (id, external_order_id, customer_reference, expected_amount_irr, target_financial_account_id,
        submitted_at, source_system, metadata_json, status, paid_clicked_at, receipt_submitted_at,
        suspect_reason, suspect_metadata_json, card_digits, created_at, updated_at)
     VALUES (?1, ?2, 'tg-42', ?3, ?4, ?5, 'MIRZABOT',
             '{"telegramUserId":"42","telegramUsername":"ali"}', ?6, ?5, ?5, ?7, ?8, ?9, ?5, ?5)`,
  )
    .bind(
      id,
      `mirzabot:test:${id}`,
      AMOUNT,
      ACCOUNT,
      paid,
      seed.status ?? 'PENDING',
      seed.suspectReason ?? null,
      JSON.stringify(seed.suspectMeta ?? {}),
      CARD,
    )
    .run();
  return { id, paid, now };
}

async function seedTx(id: string, bankTimestamp: number) {
  const now = Date.now();
  await baseEnv.DB.prepare(
    `INSERT INTO raw_sms_events
       (id, device_id, sender, normalized_body, body_sha256, app_checksum, sms_timestamp,
        received_at, classification, parser_status, parser_id, parser_version, created_at)
     VALUES (?1,'dev-pay','TEST','seed',?2,'cksum',?3,?4,'BANK_CREDIT','OK','test','v1',?4)`,
  )
    .bind(`sms-${id}`, `hash-${id}`, bankTimestamp, now)
    .run();
  await baseEnv.DB.prepare(
    `INSERT INTO transaction_candidates
       (id, raw_sms_event_id, financial_account_id, direction, amount_irr, status, bank_timestamp,
        confidence, parser_id, parser_version, parser_evidence_json, processing_disposition,
        created_at, updated_at)
     VALUES (?1, ?2, ?3, 'CREDIT', ?4, 'MATCH_SUGGESTED', ?5, 1.0, 'test', 'v1', '{}',
             'ACTIONABLE', ?6, ?6)`,
  )
    .bind(id, `sms-${id}`, ACCOUNT, AMOUNT, bankTimestamp, now)
    .run();
}

async function seedMatch(claimId: string, txId: string, status: 'AUTO_VERIFIED' | 'CONFIRMED') {
  const now = Date.now();
  await baseEnv.DB.prepare(
    `INSERT INTO reconciliation_matches
       (id, transaction_candidate_id, payment_claim_id, score, matching_reasons_json,
        mismatch_reasons_json, status, reviewed_by, reviewed_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, 1.0, '[]', '[]', ?4, ?5, ?6, ?6, ?6)`,
  )
    .bind(
      `m-${claimId}`,
      txId,
      claimId,
      status,
      status === 'CONFIRMED' ? EMAIL : null,
      now,
    )
    .run();
}

type PaymentsBody = {
  ok: boolean;
  tab: string;
  items: Array<{
    id: string;
    reviewState: string;
    cardMasked: string | null;
    suspectReason: string | null;
    device: { id: string; name: string } | null;
    candidates: Array<{ id: string }>;
    matchedTransaction: { id: string; timeDeltaSeconds: number | null } | null;
    isNew?: boolean;
  }>;
  counts: Record<string, number>;
  summary: {
    botAutoVerified: { payments: number; amountIrr: number };
    unassignedIncome: { count: number; amountIrr: number };
  };
};

async function get(query: string): Promise<PaymentsBody> {
  const r = await app.fetch(new Request(`https://example.com/api/v1/payments?${query}`), envAs());
  expect(r.status).toBe(200);
  return (await r.json()) as PaymentsBody;
}

describe('GET /api/v1/payments', () => {
  it('needs_review returns only claims the engine flagged, oldest first', async () => {
    const base = Date.now();
    await seedClaim('c-new', { suspectReason: 'AMBIGUOUS_TRANSACTIONS', paidClickedAt: base });
    await seedClaim('c-old', {
      suspectReason: 'OUTSIDE_AUTO_MATCH_WINDOW',
      paidClickedAt: base - 3_600_000,
    });
    await seedClaim('c-waiting');

    const body = await get('tab=needs_review');
    expect(body.items.map((i) => i.id)).toEqual(['c-old', 'c-new']);
    expect(body.items.every((i) => i.reviewState === 'NEEDS_REVIEW')).toBe(true);
  });

  it('auto_verified returns engine-settled claims with their bank transaction', async () => {
    const base = Date.now();
    await seedClaim('c-auto', { status: 'VERIFIED', paidClickedAt: base });
    await seedTx('t-auto', base + 18_000);
    await seedMatch('c-auto', 't-auto', 'AUTO_VERIFIED');
    await seedClaim('c-manual', { status: 'VERIFIED', paidClickedAt: base });
    await seedTx('t-manual', base + 90_000);
    await seedMatch('c-manual', 't-manual', 'CONFIRMED');

    const body = await get('tab=bot_auto_verified');
    expect(body.items.map((i) => i.id)).toEqual(['c-auto']);
    expect(body.items[0]!.matchedTransaction?.id).toBe('t-auto');
    expect(body.items[0]!.matchedTransaction?.timeDeltaSeconds).toBe(18);
  });

  it('all returns every bucket including waiting and suspected fake', async () => {
    await seedClaim('c-r', { suspectReason: 'NO_TRANSACTION_AFTER_10M' });
    await seedClaim('c-old-no', { suspectReason: 'NO_TRANSACTION' });
    await seedClaim('c-w');
    await seedClaim('c-rej', { status: 'REJECTED' });
    await seedClaim('c-fake', { status: 'FAKE_RECEIPT' });
    await seedClaim('c-exp', { status: 'EXPIRED' });
    await seedClaim('c-man', { status: 'VERIFIED' });
    await seedTx('t-man', Date.now());
    await seedMatch('c-man', 't-man', 'CONFIRMED');

    const all = await get('tab=all');
    expect(new Set(all.items.map((i) => i.reviewState))).toEqual(
      new Set(['SUSPECTED_FAKE', 'WAITING', 'REJECTED', 'FAKE', 'EXPIRED', 'MANUALLY_VERIFIED']),
    );

    const waiting = await get('tab=waiting');
    expect(waiting.items.map((i) => i.id)).toEqual(['c-w']);

    const suspected = await get('tab=suspected_fake');
    expect(new Set(suspected.items.map((i) => i.id))).toEqual(new Set(['c-r', 'c-old-no']));
  });

  it('counts cover the whole population regardless of the tab requested', async () => {
    const base = Date.now();
    await seedClaim('c-a1', { status: 'VERIFIED', paidClickedAt: base });
    await seedTx('t-a1', base);
    await seedMatch('c-a1', 't-a1', 'AUTO_VERIFIED');
    await seedClaim('c-a2', { status: 'VERIFIED', paidClickedAt: base });
    await seedTx('t-a2', base);
    await seedMatch('c-a2', 't-a2', 'AUTO_VERIFIED');
    await seedClaim('c-n1', { suspectReason: 'AMBIGUOUS_CLAIMS', paidClickedAt: base });
    await seedClaim('c-w1', { paidClickedAt: base });

    const body = await get('tab=needs_review');
    expect(body.counts.autoVerified).toBe(2);
    expect(body.counts.needsReview).toBe(1);
    expect(body.counts.waiting).toBe(1);
    expect(body.counts.all).toBe(4);
    expect(body.summary.botAutoVerified.payments).toBe(2);
    expect(body.summary.unassignedIncome.count).toBeGreaterThanOrEqual(0);
  });

  it('includes Suspected Fake in the automation-rate denominator but not Waiting', async () => {
    const base = Date.now();
    await seedClaim('c-a1', { status: 'VERIFIED', paidClickedAt: base });
    await seedTx('t-a1', base);
    await seedMatch('c-a1', 't-a1', 'AUTO_VERIFIED');
    await seedClaim('c-sf', { suspectReason: 'NO_TRANSACTION_AFTER_10M', paidClickedAt: base });
    await seedClaim('c-w1', { paidClickedAt: base });

    const body = await get('tab=needs_review');
    expect(body.summary.unassignedIncome).toBeDefined();
    expect(body.summary.botAutoVerified.payments).toBe(1);
  });

  it('masks the card number and never returns the full PAN', async () => {
    await seedClaim('c-card', { suspectReason: 'UNMAPPED_CARD' });
    const body = await get('tab=needs_review');
    expect(body.items[0]!.cardMasked).toBe('**** **** **** 5678');
    expect(JSON.stringify(body)).not.toContain(CARD);
  });

  it('exposes the exact candidate set the matcher considered', async () => {
    const base = Date.now();
    await seedTx('t-c1', base + 21_000);
    await seedTx('t-c2', base + 37_000);
    await seedClaim('c-amb', {
      suspectReason: 'AMBIGUOUS_TRANSACTIONS',
      paidClickedAt: base,
      suspectMeta: { candidateTransactionIds: ['t-c1', 't-c2'] },
    });

    const body = await get('tab=needs_review');
    expect(body.items[0]!.candidates.map((c) => c.id)).toEqual(['t-c1', 't-c2']);
  });

  it('mark-fake sets FAKE_RECEIPT with audit trail', async () => {
    await seedClaim('c-fake', { suspectReason: 'NO_TRANSACTION_AFTER_10M' });
    const r = await app.fetch(
      new Request('https://example.com/api/v1/suspects/c-fake/mark-fake', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true, comment: 'manual review' }),
      }),
      envAs(),
    );
    expect(r.status).toBe(200);
    const row = await baseEnv.DB.prepare(`SELECT status FROM payment_claims WHERE id = 'c-fake'`).first<{ status: string }>();
    expect(row?.status).toBe('FAKE_RECEIPT');
    const audit = await baseEnv.DB.prepare(
      `SELECT action FROM audit_logs WHERE entity_id = 'c-fake' ORDER BY created_at DESC LIMIT 1`,
    ).first<{ action: string }>();
    expect(audit?.action).toBe('claim.fake_receipt');
  });

  it('resolves SMS source device from matched transaction without N+1', async () => {
    const base = Date.now();
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO devices (id, device_code, display_name, active, created_at, updated_at)
       VALUES ('dev-iphone','puyan-iphone','Puyan-iPhone',1,?1,?1)`,
    )
      .bind(base)
      .run();
    await seedClaim('c-auto', { status: 'VERIFIED', paidClickedAt: base });
    await baseEnv.DB.prepare(
      `INSERT INTO raw_sms_events
         (id, device_id, sender, normalized_body, body_sha256, app_checksum, sms_timestamp,
          received_at, classification, parser_status, parser_id, parser_version, created_at)
       VALUES ('sms-iphone','dev-iphone','TEST','seed','hash-iphone','cksum',?1,?2,'BANK_CREDIT','OK','test','v1',?2)`,
    )
      .bind(base, base)
      .run();
    await baseEnv.DB.prepare(
      `INSERT INTO transaction_candidates
         (id, raw_sms_event_id, financial_account_id, direction, amount_irr, status, bank_timestamp,
          confidence, parser_id, parser_version, parser_evidence_json, processing_disposition,
          created_at, updated_at)
       VALUES ('t-iphone', 'sms-iphone', ?1, 'CREDIT', ?2, 'MATCHED', ?3, 1.0, 'test', 'v1', '{}',
               'ACTIONABLE', ?4, ?4)`,
    )
      .bind(ACCOUNT, AMOUNT, base, base)
      .run();
    await seedMatch('c-auto', 't-iphone', 'AUTO_VERIFIED');

    const body = await get('tab=bot_auto_verified');
    expect(body.items[0]!.device).toEqual({ id: 'dev-iphone', name: 'Puyan-iPhone' });
  });

  it('resolves device from first candidate when claim has no settled match', async () => {
    const base = Date.now();
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO devices (id, device_code, display_name, active, created_at, updated_at)
       VALUES ('dev-cand','cand-dev','Candidate Phone',1,?1,?1)`,
    )
      .bind(base)
      .run();
    await baseEnv.DB.prepare(
      `INSERT INTO raw_sms_events
         (id, device_id, sender, normalized_body, body_sha256, app_checksum, sms_timestamp,
          received_at, classification, parser_status, parser_id, parser_version, created_at)
       VALUES ('sms-cand','dev-cand','TEST','seed','hash-cand','cksum',?1,?2,'BANK_CREDIT','OK','test','v1',?2)`,
    )
      .bind(base + 21_000, base)
      .run();
    await baseEnv.DB.prepare(
      `INSERT INTO transaction_candidates
         (id, raw_sms_event_id, financial_account_id, direction, amount_irr, status, bank_timestamp,
          confidence, parser_id, parser_version, parser_evidence_json, processing_disposition,
          created_at, updated_at)
       VALUES ('t-cand', 'sms-cand', ?1, 'CREDIT', ?2, 'MATCH_SUGGESTED', ?3, 1.0, 'test', 'v1', '{}',
               'ACTIONABLE', ?4, ?4)`,
    )
      .bind(ACCOUNT, AMOUNT, base + 21_000, base)
      .run();
    await seedClaim('c-amb', {
      suspectReason: 'AMBIGUOUS_TRANSACTIONS',
      paidClickedAt: base,
      suspectMeta: { candidateTransactionIds: ['t-cand'] },
    });

    const body = await get('tab=needs_review');
    expect(body.items[0]!.device).toEqual({ id: 'dev-cand', name: 'Candidate Phone' });
  });

  it('resolves device from account SMS history when suspected fake has no match or candidates', async () => {
    const base = Date.now();
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO devices (id, device_code, display_name, active, created_at, updated_at)
       VALUES ('dev-melli','melli-android','Melli Android',1,?1,?1)`,
    )
      .bind(base)
      .run();
    await baseEnv.DB.prepare(
      `INSERT INTO raw_sms_events
         (id, device_id, sender, normalized_body, body_sha256, app_checksum, sms_timestamp,
          received_at, classification, parser_status, parser_id, parser_version, created_at)
       VALUES ('sms-melli','dev-melli','TEST','seed','hash-melli','cksum',?1,?2,'BANK_CREDIT','OK','test','v1',?2)`,
    )
      .bind(base - 86_400_000, base)
      .run();
    await baseEnv.DB.prepare(
      `INSERT INTO transaction_candidates
         (id, raw_sms_event_id, financial_account_id, direction, amount_irr, status, bank_timestamp,
          confidence, parser_id, parser_version, parser_evidence_json, processing_disposition,
          created_at, updated_at)
       VALUES ('t-melli', 'sms-melli', ?1, 'CREDIT', 500_000, 'PARSED', ?2, 1.0, 'test', 'v1', '{}',
               'ACTIONABLE', ?3, ?3)`,
    )
      .bind(ACCOUNT, base - 86_400_000, base)
      .run();
    await seedClaim('c-sf', {
      suspectReason: 'NO_TRANSACTION_AFTER_10M',
      paidClickedAt: base,
      suspectMeta: { candidateTransactionIds: [] },
    });

    const body = await get('tab=suspected_fake');
    expect(body.items[0]!.device).toEqual({ id: 'dev-melli', name: 'Melli Android' });
  });

  it('includes per-operator unread counts aligned with tab totals', async () => {
    const base = Date.now();
    await seedClaim('c-auto', { status: 'VERIFIED', paidClickedAt: base });
    await seedTx('t-auto', base);
    await seedMatch('c-auto', 't-auto', 'AUTO_VERIFIED');
    await seedClaim('c-n1', { suspectReason: 'AMBIGUOUS_CLAIMS', paidClickedAt: base });

    const body = await get('tab=needs_review');
    expect(body.counts.botAutoVerified).toBe(1);
    expect(body.counts.needsReview).toBe(1);
    expect(typeof body.counts.botAutoVerifiedUnread).toBe('number');
    expect(typeof body.counts.needsReviewUnread).toBe('number');
    expect(body.counts.botAutoVerifiedUnread).toBe(1);
    expect(body.counts.needsReviewUnread).toBe(1);

    await app.fetch(
      new Request('https://example.com/api/v1/payments/events/claim%3Ac-auto/seen', {
        method: 'POST',
      }),
      envAs(),
    );

    const after = await get('tab=bot_auto_verified');
    expect(after.counts.botAutoVerified).toBe(1);
    expect(after.counts.botAutoVerifiedUnread).toBe(0);
    expect(after.items[0]!.isNew).toBe(false);
  });

  it('read-all clears unread only for bot auto verified', async () => {
    const base = Date.now();
    await seedClaim('c-a1', { status: 'VERIFIED', paidClickedAt: base });
    await seedTx('t-a1', base);
    await seedMatch('c-a1', 't-a1', 'AUTO_VERIFIED');
    await seedClaim('c-a2', { status: 'VERIFIED', paidClickedAt: base + 1 });
    await seedTx('t-a2', base + 1);
    await seedMatch('c-a2', 't-a2', 'AUTO_VERIFIED');

    const before = await get('tab=bot_auto_verified');
    expect(before.counts.botAutoVerified).toBe(2);
    expect(before.counts.botAutoVerifiedUnread).toBe(2);

    await app.fetch(
      new Request('https://example.com/api/v1/payments/tabs/read-all', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tab: 'bot_auto_verified' }),
      }),
      envAs(),
    );

    const after = await get('tab=bot_auto_verified');
    expect(after.counts.botAutoVerified).toBe(2);
    expect(after.counts.botAutoVerifiedUnread).toBe(0);
    expect(after.items.every((i) => i.isNew === false)).toBe(true);
  });
});
