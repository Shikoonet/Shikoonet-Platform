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
  /** The card the customer was told to pay into. Defaults to `CARD`. */
  cardDigits?: string;
  /** `payment_claims.customer_reference` — the Telegram id. Defaults to `tg-42`. */
  customerReference?: string;
  suspectReason?: string | null;
  paidClickedAt?: number;
  suspectMeta?: object;
  fulfilmentMode?: 'MANUAL' | 'CONTINUITY' | null;
  fulfilledAt?: number | null;
  fulfilledBy?: string | null;
  fulfilmentReason?: string | null;
  reconciledAt?: number | null;
  /**
   * `null` for the case the bot creates deliberately: a card nobody has mapped
   * to a financial account yet still opens a claim, because the alternative is
   * losing the customer's money in silence (`apps/bot/src/payment.ts:294-302`).
   */
  accountId?: string | null;
}

async function seedClaim(id: string, seed: ClaimSeed = {}) {
  const now = Date.now();
  const paid = seed.paidClickedAt ?? now;
  await baseEnv.DB.prepare(
    `INSERT INTO payment_claims
       (id, external_order_id, customer_reference, expected_amount_irr, target_financial_account_id,
        submitted_at, source_system, metadata_json, status, paid_clicked_at, receipt_submitted_at,
        suspect_reason, suspect_metadata_json, card_digits, created_at, updated_at,
        fulfilment_mode, fulfilled_at, fulfilled_by, fulfilment_reason, reconciled_at)
     VALUES (?1, ?2, ?10, ?3, ?4, ?5, 'MIRZABOT',
             '{"telegramUserId":"42","telegramUsername":"ali"}', ?6, ?5, ?5, ?7, ?8, ?9,
             ?5, ?5, ?11, ?12, ?13, ?14, ?15)`,
  )
    .bind(
      id,
      `mirzabot:test:${id}`,
      AMOUNT,
      seed.accountId === undefined ? ACCOUNT : seed.accountId,
      paid,
      seed.status ?? 'PENDING',
      seed.suspectReason ?? null,
      JSON.stringify(seed.suspectMeta ?? {}),
      seed.cardDigits ?? CARD,
      seed.customerReference ?? 'tg-42',
      seed.fulfilmentMode ?? null,
      seed.fulfilmentMode ? (seed.fulfilledAt ?? paid) : (seed.fulfilledAt ?? null),
      seed.fulfilledBy ?? null,
      seed.fulfilmentReason ?? null,
      seed.reconciledAt ?? null,
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
    .bind(`m-${claimId}`, txId, claimId, status, status === 'CONFIRMED' ? EMAIL : null, now)
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
    fulfilmentMode?: 'MANUAL' | 'CONTINUITY' | null;
    fulfilledAt?: number | null;
    fulfilledBy?: string | null;
    fulfilmentReason?: string | null;
    reconciledAt?: number | null;
  }>;
  counts: Record<string, number>;
  /** Present on every tab since the income tabs stopped cutting at 200. */
  page?: number;
  pageSize?: number;
  total?: number;
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

  it('continuity returns every claim delivered by that mode with its audit facts', async () => {
    const base = Date.now();
    await seedClaim('c-cont-pending', {
      status: 'FULFILLED_UNRECONCILED',
      paidClickedAt: base,
      fulfilmentMode: 'CONTINUITY',
      fulfilledAt: base + 1_000,
      fulfilledBy: 'operator@example.com',
      fulfilmentReason: 'SMS relay unavailable',
    });
    await seedClaim('c-cont-reconciled', {
      status: 'VERIFIED',
      paidClickedAt: base - 10_000,
      fulfilmentMode: 'CONTINUITY',
      fulfilledAt: base - 9_000,
      fulfilledBy: 'operator@example.com',
      fulfilmentReason: 'SMS relay unavailable',
      reconciledAt: base - 1_000,
    });
    await seedClaim('c-manual-mode', {
      status: 'FULFILLED_UNRECONCILED',
      fulfilmentMode: 'MANUAL',
    });
    await seedClaim('c-ordinary');

    const body = await get('tab=continuity&range=all');
    expect(new Set(body.items.map((i) => i.id))).toEqual(
      new Set(['c-cont-pending', 'c-cont-reconciled']),
    );
    expect(body.counts.continuity).toBe(2);
    expect(body.counts.continuityPending).toBe(1);
    expect(body.items.find((i) => i.id === 'c-cont-pending')).toMatchObject({
      fulfilmentMode: 'CONTINUITY',
      fulfilledAt: base + 1_000,
      fulfilledBy: 'operator@example.com',
      fulfilmentReason: 'SMS relay unavailable',
      reconciledAt: null,
    });
    expect(body.items.find((i) => i.id === 'c-cont-reconciled')?.reconciledAt).toBe(
      base - 1_000,
    );
  });

  it('all returns every bucket including waiting and no-transfer-found', async () => {
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
      new Set(['NO_TRANSFER_FOUND', 'WAITING', 'REJECTED', 'FAKE', 'EXPIRED', 'MANUALLY_VERIFIED']),
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

  it('includes «واریزی پیدا نشد» in the automation-rate denominator but not Waiting', async () => {
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

  /**
   * The badge and the list are two queries over the same rows, and they have
   * now drifted twice. This time `FULFILLED_UNRECONCILED` had no arm in the
   * badge's `CASE` at all: its own badge read zero forever, and its rows fell
   * through to `ELSE 'NEEDS_REVIEW'` — a queue whose `stateSql` filter can
   * never return them.
   *
   * Measured on staging, 2026-09-03: «در انتظار بررسی» promised 15 and listed
   * 2, with 14 delivered-but-unmatched claims making up the difference. That
   * is the one queue where the gap is money — the customer has the product and
   * the bank never confirmed the payment.
   *
   * So the assertion is not «FULFILLED_UNRECONCILED counts» but the rule the
   * screen actually needs: no badge may promise rows its own filter cannot
   * produce. Any future state added to `stateSql` without an arm in the badge
   * — or the reverse — fails here.
   */
  it('every badge equals the number of rows its own filter returns', async () => {
    const base = Date.now();
    await seedClaim('s-auto', { status: 'VERIFIED', paidClickedAt: base });
    await seedTx('t-auto', base);
    await seedMatch('s-auto', 't-auto', 'AUTO_VERIFIED');
    await seedClaim('s-man', { status: 'VERIFIED' });
    await seedClaim('s-ful', { status: 'FULFILLED_UNRECONCILED' });
    await seedClaim('s-wait');
    await seedClaim('s-need', { suspectReason: 'AMBIGUOUS_CLAIMS' });
    await seedClaim('s-no-tx', { suspectReason: 'NO_TRANSACTION_AFTER_10M' });
    await seedClaim('s-rej', { status: 'REJECTED' });
    await seedClaim('s-fake', { status: 'FAKE_RECEIPT' });
    await seedClaim('s-exp', { status: 'EXPIRED' });

    const states = [
      'AUTO_VERIFIED',
      'MANUALLY_VERIFIED',
      'FULFILLED_UNRECONCILED',
      'WAITING',
      'NEEDS_REVIEW',
      'NO_TRANSFER_FOUND',
      'REJECTED',
      'FAKE',
      'EXPIRED',
    ] as const;

    const badge = (await get('tab=all')).counts;
    for (const state of states) {
      const listed = await get(`tab=all&status=${state}`);
      expect(`${state} badge=${badge[state]}`).toBe(`${state} badge=${listed.items.length}`);
    }
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
    const row = await baseEnv.DB.prepare(
      `SELECT status FROM payment_claims WHERE id = 'c-fake'`,
    ).first<{ status: string }>();
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

  it('resolves device from account SMS history when a no-transfer claim has no match or candidates', async () => {
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

/**
 * «در انتظار بررسی» — the queue that replaced three.
 *
 * On 2026-08-24 Sam pressed «پرداخت کردم» in the bot, opened «پرداخت‌ها», and
 * saw nothing. He was right, and it was not the wrong tab alone: `needs_review`,
 * `waiting` and `suspected_fake` between them asked for
 * `suspect_reason IS NOT NULL`, `suspect_reason IS NULL AND within ten minutes`,
 * and `suspect_reason IN (…)`. A pending claim with no suspect reason and more
 * than ten minutes on the clock satisfied none of the three. It was real money
 * and it was on no screen but «همه».
 *
 * These assert the property rather than the wording: a claim nobody has decided
 * about is in this queue, whatever shape it has and however old it is.
 */
describe('the open review queue', () => {
  it('keeps a claim after the ten-minute matching window has passed', async () => {
    // Eleven minutes. This is the exact row that used to vanish: PENDING, no
    // suspect reason, past the window. `WAITING_TIMEOUT_MS` is ten minutes.
    const stale = Date.now() - 11 * 60_000;
    await seedClaim('c-stale', { paidClickedAt: stale });

    const body = await get('tab=open');
    expect(body.items.map((i) => i.id)).toContain('c-stale');
  });

  it('keeps a claim whose card was never mapped to an account', async () => {
    // The permanent case, and the worse one. The sweeper that would give this
    // claim a `suspect_reason` skips every row with a null account
    // (`apps/ingest-worker/src/integrations/mirzabot.ts:278`), so the condition
    // that was supposed to move it into another queue can never fire. Under the
    // old rules it was invisible not for ten minutes but forever.
    await seedClaim('c-unmapped', {
      accountId: null,
      paidClickedAt: Date.now() - 3 * 24 * 60 * 60_000,
    });

    const body = await get('tab=open');
    expect(body.items.map((i) => i.id)).toContain('c-unmapped');
  });

  it('holds every undecided claim and nothing that was decided', async () => {
    const base = Date.now();
    await seedClaim('o-fresh', { paidClickedAt: base });
    await seedClaim('o-stale', { paidClickedAt: base - 11 * 60_000 });
    await seedClaim('o-flagged', { suspectReason: 'AMBIGUOUS_TRANSACTIONS' });
    await seedClaim('o-suspect', { suspectReason: 'NO_TRANSACTION_AFTER_10M' });
    await seedClaim('o-suggested', { status: 'MATCH_SUGGESTED' });
    // Decided, each a different way. None of these is anybody's work any more.
    await seedClaim('o-verified', { status: 'VERIFIED' });
    await seedClaim('o-rejected', { status: 'REJECTED' });
    await seedClaim('o-fake', { status: 'FAKE_RECEIPT' });
    await seedClaim('o-expired', { status: 'EXPIRED' });

    const body = await get('tab=open');
    expect(body.items.map((i) => i.id).sort()).toEqual([
      'o-flagged',
      'o-fresh',
      'o-stale',
      'o-suggested',
      'o-suspect',
    ]);
  });

  it('counts on the badge exactly what the list returns', async () => {
    // The divergence this whole change exists to end. The badge summed one
    // population and the query selected another, so «در انتظار» could read «۱»
    // over an empty list — which is worse than either being wrong, because the
    // operator is told there is work and then told there is none.
    await seedClaim('b-fresh');
    await seedClaim('b-stale', { paidClickedAt: Date.now() - 11 * 60_000 });
    await seedClaim('b-unmapped', { accountId: null });
    await seedClaim('b-flagged', { suspectReason: 'AMBIGUOUS_CLAIMS' });
    await seedClaim('b-suspect', { suspectReason: 'NO_TRANSACTION' });
    await seedClaim('b-done', { status: 'VERIFIED' });

    const body = await get('tab=open');
    expect(body.counts['open']).toBe(body.items.length);
    expect(body.counts['open']).toBe(5);
  });

  it('is what an operator lands on', async () => {
    // The default used to be `income`, which reads `transaction_candidates` —
    // a table a claim is never in. Sam went looking for the order he had just
    // placed and the panel could not have shown it whatever he filtered by.
    await seedClaim('d-open');

    const body = await get('');
    expect(body.tab).toBe('open');
    expect(body.items.map((i) => i.id)).toContain('d-open');
  });
});

/**
 * `?claim=<id>` — one payment, wherever it is sitting.
 *
 * The review page opens from the address bar (`?claim=` in
 * `paymentsNav.tsx`), and it used to resolve that id by searching the page it
 * had already loaded: `claimItems.find(...)` over one `LIMIT 200` slice of one
 * tab. So the link worked for a claim near the top of the queue you happened
 * to be on, and every other link rendered «این پرداخت در فهرست باز نیست» —
 * which an operator reads as "somebody already decided this".
 *
 * Found in a browser on 2026-08-25, against a seeded queue of 505, using a
 * link handed to Sam an hour earlier. No test could have caught it: the whole
 * failure is that the row is outside the window, and every test here seeds a
 * handful of rows.
 *
 * The filter answers with that row and nothing else — no tab predicate, no
 * range, no ordering. That is what these assert, one narrowing at a time.
 */
describe('one claim by id', () => {
  it('answers with the claim and nothing else', async () => {
    await seedClaim('by-id-a');
    await seedClaim('by-id-b');

    const body = await get('claim=by-id-a');
    expect(body.items.map((i) => i.id)).toEqual(['by-id-a']);
  });

  it('ignores the tab, because the point is not knowing which queue it is in', async () => {
    // Decided, so it is in no open queue at all. A link to it still has to work
    // — reading a settled payment is most of what a link gets used for.
    await seedClaim('by-id-verified', { status: 'VERIFIED' });

    expect((await get('tab=open&claim=by-id-verified')).items.map((i) => i.id)).toEqual([
      'by-id-verified',
    ]);
    expect((await get('tab=bot_auto_verified&claim=by-id-verified')).items.map((i) => i.id)).toEqual(
      ['by-id-verified'],
    );
  });

  it('ignores the date range', async () => {
    // Two months old, on a tab that applies `historyRangeBounds`. The range is
    // the narrowing most likely to silently drop the answer, because the
    // default is not «همه».
    await seedClaim('by-id-old', {
      status: 'VERIFIED',
      paidClickedAt: Date.now() - 60 * 24 * 60 * 60_000,
    });

    const body = await get('tab=manually_verified&range=today&claim=by-id-old');
    expect(body.items.map((i) => i.id)).toEqual(['by-id-old']);
  });

  it('answers empty for an id that does not exist, rather than the whole queue', async () => {
    // The failure that matters if the filter is ever dropped: the parameter is
    // ignored and 200 unrelated rows come back, which the screen would render
    // as "found it" by picking the first one.
    await seedClaim('by-id-present');

    const body = await get('claim=no-such-claim');
    expect(body.items).toEqual([]);
  });
});

describe('filtering the payments list by card and by customer', () => {
  const CARD_A = '6104337712345678';
  const CARD_B = '6104338898765432';

  async function ask(qs: string) {
    const r = await app.fetch(new Request(`https://x/api/v1/payments?${qs}`), envAs());
    expect(r.status).toBe(200);
    return (await r.json()) as {
      items: Array<{ id: string }>;
      page: number;
      pageSize: number;
      total: number;
    };
  }

  it('narrows to one card, and the two cards do not bleed into each other', async () => {
    await seedClaim('f-a1', { status: 'VERIFIED', cardDigits: CARD_A });
    await seedClaim('f-a2', { status: 'VERIFIED', cardDigits: CARD_A });
    await seedClaim('f-b1', { status: 'VERIFIED', cardDigits: CARD_B });

    expect((await ask('tab=all&range=all')).total).toBe(3);
    const a = await ask(`tab=all&range=all&cardDigits=${CARD_A}`);
    expect(a.total).toBe(2);
    expect(a.items.map((i) => i.id).sort()).toEqual(['f-a1', 'f-a2']);
    expect((await ask(`tab=all&range=all&cardDigits=${CARD_B}`)).total).toBe(1);
  });

  it('narrows to one Telegram id', async () => {
    await seedClaim('f-u1', { status: 'VERIFIED', customerReference: '900000001' });
    await seedClaim('f-u2', { status: 'VERIFIED', customerReference: '900000001' });
    await seedClaim('f-u3', { status: 'VERIFIED', customerReference: '900000002' });

    const one = await ask('tab=all&range=all&telegramId=900000001');
    expect(one.total).toBe(2);
    expect(one.items.map((i) => i.id).sort()).toEqual(['f-u1', 'f-u2']);
  });

  it('answers a malformed filter with everything, not with an empty shop', async () => {
    // A rejected value must not become `card_digits = 'abc'`, which would
    // return nothing and read as «this card took no money» -- a sentence about
    // the shop rather than about the input.
    await seedClaim('f-x1', { status: 'VERIFIED', cardDigits: CARD_A });
    expect((await ask('tab=all&range=all&cardDigits=abc')).total).toBe(1);
    expect((await ask('tab=all&range=all&cardDigits=5678')).total).toBe(1);
    expect((await ask('tab=all&range=all&telegramId=not-a-number')).total).toBe(1);
  });

  /**
   * `?claim=` answers with that one row whatever else is asked.
   *
   * The route returns early for a deep link precisely so that no filter can
   * narrow away the row the caller named -- the alternative renders «این
   * پرداخت در فهرست باز نیست», which reads as «somebody decided this» and is
   * not what happened. Both new filters had to go inside that `else`, and
   * putting either one outside it would be silent: the link still works for
   * every claim the current filters happen to include.
   */
  it('a deep link ignores the filters, including the two added here', async () => {
    await seedClaim('f-deep', {
      status: 'VERIFIED',
      cardDigits: CARD_B,
      customerReference: '777',
    });
    const r = await ask('claim=f-deep&cardDigits=' + CARD_A + '&telegramId=999');
    expect(r.items.map((i) => i.id)).toEqual(['f-deep']);
  });

  it('combines the two filters rather than letting the later one win', async () => {
    await seedClaim('f-c1', { status: 'VERIFIED', cardDigits: CARD_A, customerReference: '5551' });
    await seedClaim('f-c2', { status: 'VERIFIED', cardDigits: CARD_A, customerReference: '5552' });
    await seedClaim('f-c3', { status: 'VERIFIED', cardDigits: CARD_B, customerReference: '5551' });

    const both = await ask(`tab=all&range=all&cardDigits=${CARD_A}&telegramId=5551`);
    expect(both.total).toBe(1);
    expect(both.items[0]!.id).toBe('f-c1');
  });
});

describe('the payments list is paginated rather than silently cut', () => {
  /**
   * 210 claims, because the old behaviour was a hard `LIMIT 200`.
   *
   * A fixture of three rows cannot see this at all -- the same reason rule 9
   * of CLAUDE.md gives for the subquery LIMIT: below the ceiling every version
   * of the code agrees, so a small fixture is silent, not green.
   */
  const N = 210;

  beforeEach(async () => {
    for (let i = 0; i < N; i++) {
      await seedClaim(`pg-${String(i).padStart(3, '0')}`, {
        status: 'VERIFIED',
        paidClickedAt: Date.now() - i * 60_000,
      });
    }
  });

  it('reports how many there are, not how many it sent', async () => {
    const r = await app.fetch(new Request('https://x/api/v1/payments?tab=all&range=all'), envAs());
    const body = (await r.json()) as { items: unknown[]; total: number; pageSize: number };
    expect(body.total).toBe(N);
    // The default page is still 200, so an unchanged caller sees exactly what
    // it saw before -- but now it is told there is more.
    expect(body.items.length).toBe(200);
    expect(body.pageSize).toBe(200);
  });

  it('page 2 continues where page 1 stopped, with no row lost or repeated', async () => {
    const p1 = (await (
      await app.fetch(
        new Request('https://x/api/v1/payments?tab=all&range=all&pageSize=100&page=1'),
        envAs(),
      )
    ).json()) as { items: Array<{ id: string }>; total: number };
    const p2 = (await (
      await app.fetch(
        new Request('https://x/api/v1/payments?tab=all&range=all&pageSize=100&page=2'),
        envAs(),
      )
    ).json()) as { items: Array<{ id: string }> };
    const p3 = (await (
      await app.fetch(
        new Request('https://x/api/v1/payments?tab=all&range=all&pageSize=100&page=3'),
        envAs(),
      )
    ).json()) as { items: Array<{ id: string }> };

    expect(p1.total).toBe(N);
    expect(p1.items.length).toBe(100);
    expect(p2.items.length).toBe(100);
    expect(p3.items.length).toBe(N - 200);

    const seen = [...p1.items, ...p2.items, ...p3.items].map((i) => i.id);
    expect(new Set(seen).size).toBe(N);
  });

  /**
   * Every row at the SAME instant, which the other pagination tests never do.
   *
   * They seed `now - i * 60_000`, so `effective_ts` is unique and the sort is
   * total whether or not it has a tie-breaker — green, and silent about the
   * one thing paging can get wrong. SQL leaves the order of tied rows
   * undefined, so without `c.id` the database may answer page 1 and page 2
   * with different orderings and a tied row lands on both pages or on
   * neither. A batch of claims imported with one timestamp, or two customers
   * paying in the same second, is all it takes.
   *
   * The assertion is on the SET across pages, not on any row's position:
   * position is genuinely free to change, losing a row is not.
   */
  it('pages tied timestamps without dropping or repeating a row', async () => {
    const SAME = Date.now();
    for (let i = 0; i < 120; i++) {
      await seedClaim(`tie-${String(i).padStart(3, '0')}`, {
        status: 'VERIFIED',
        paidClickedAt: SAME,
      });
    }

    const pageOf = async (nth: number) => {
      const r = await app.fetch(
        new Request(`https://x/api/v1/payments?tab=all&range=all&pageSize=50&page=${nth}`),
        envAs(),
      );
      return ((await r.json()) as { items: Array<{ id: string }> }).items.map((i) => i.id);
    };

    const tied = [...(await pageOf(1)), ...(await pageOf(2)), ...(await pageOf(3))].filter((id) =>
      id.startsWith('tie-'),
    );
    // 120 tied rows sit inside 210 seeded ones; whichever of them the three
    // pages reach, none may be reached twice.
    expect(new Set(tied).size).toBe(tied.length);

    // And every tied row is somewhere in the full walk — nothing falls between
    // two pages.
    const all: string[] = [];
    for (let nth = 1; nth <= 7; nth++) all.push(...(await pageOf(nth)));
    expect(all.filter((id) => id.startsWith('tie-')).length).toBe(120);
    expect(new Set(all).size).toBe(all.length);
  });

  it('caps pageSize, because every row in the answer costs its own query', async () => {
    // `isPaymentEventUnread` runs once per claim, so the page size multiplies
    // round trips. 200 is the cap as well as the default: a bigger page nobody
    // asked for would only buy a slower request.
    const r = await app.fetch(
      new Request('https://x/api/v1/payments?tab=all&range=all&pageSize=100000'),
      envAs(),
    );
    const body = (await r.json()) as { pageSize: number; items: unknown[]; total: number };
    expect(body.pageSize).toBe(200);
    expect(body.items.length).toBe(200);
    // And it still says how many there really are, which is the whole point.
    expect(body.total).toBe(N);
  });
});

describe('the payments list can be taken as a file', () => {
  const CRLF = '\r\n';

  async function csv(qs: string, email = EMAIL) {
    const r = await app.fetch(
      new Request(`https://x/api/v1/payments?${qs}&format=csv`),
      envAs(email),
    );
    // `bytes` as well as `text`: `Response.text()` decodes UTF-8 and the
    // decoder STRIPS a leading BOM, so asserting on the string can never see
    // the one thing Excel needs. Checked on the wire instead.
    const buf = await r.clone().arrayBuffer();
    return {
      status: r.status,
      text: await r.text(),
      bytes: new Uint8Array(buf),
      type: r.headers.get('content-type'),
    };
  }

  it('exports the SAME set the screen is showing, filters and all', async () => {
    // The whole reason this lives on the list route rather than beside it: an
    // export that answers a different question from the screen it was taken
    // from is worse than no export.
    await seedClaim('x-a1', { status: 'VERIFIED', cardDigits: '6104337712345678' });
    await seedClaim('x-a2', { status: 'VERIFIED', cardDigits: '6104337712345678' });
    await seedClaim('x-b1', { status: 'VERIFIED', cardDigits: '6104338898765432' });

    const all = await csv('tab=all&range=all');
    expect(all.status).toBe(200);
    // Three rows and one header.
    expect(all.text.trim().split(CRLF)).toHaveLength(4);

    const oneCard = await csv('tab=all&range=all&cardDigits=6104337712345678');
    const rows = oneCard.text.trim().split(CRLF).slice(1);
    expect(rows).toHaveLength(2);
    // The card is NAMED, not printed. This line used to demand the opposite —
    // `r.includes('6104337712345678')` — which is how a full PAN got into a
    // file that leaves the panel: the assertion protecting the export was the
    // one requiring the leak.
    expect(rows.every((r) => r.includes('5678'))).toBe(true);
    expect(oneCard.text).not.toContain('6104337712345678');
    expect(oneCard.text).not.toContain('6104338898765432');
  });

  /**
   * A CSV cell is text until a spreadsheet decides it is a formula.
   *
   * Quoting stops a comma from splitting a cell; it does not stop Excel,
   * LibreOffice or Sheets from EVALUATING one that begins `=`, `+`, `-` or
   * `@`. `customer_reference` is whatever the customer typed — it arrives from
   * outside the trust boundary and leaves as a file somebody double-clicks.
   */
  it('does not hand the spreadsheet a formula to run', async () => {
    await seedClaim('x-f1', { status: 'VERIFIED', customerReference: '=1+1' });
    await seedClaim('x-f2', { status: 'VERIFIED', customerReference: '@SUM(A1:A9)' });

    const r = await csv('tab=all&range=all');
    expect(r.text).toContain(`"'=1+1"`);
    expect(r.text).toContain(`"'@SUM(A1:A9)"`);
    // And the dangerous form is gone: no cell opens with the formula character
    // straight after the quote.
    expect(r.text).not.toContain('"=');
    expect(r.text).not.toContain('"@');
  });

  it('is a file Excel can read: BOM, CRLF, and Toman', async () => {
    await seedClaim('x-m1', { status: 'VERIFIED' });
    const r = await csv('tab=all&range=all');
    expect(r.type).toContain('text/csv');
    // Without the BOM every Persian heading arrives as mojibake. Asserted on
    // the bytes: the first version of this read `text.charCodeAt(0)` and got
    // 34 -- a quote -- because the decoder had already eaten the BOM. The file
    // was right and the test was looking at the wrong layer.
    expect([r.bytes[0], r.bytes[1], r.bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(r.text).toContain(CRLF);
    // AMOUNT is 1_950_000 IRR. The file is Toman, like every screen.
    expect(r.text).toContain('195000');
    expect(r.text).not.toContain('1950000');
  });

  it('refuses a READ_ONLY operator, who may still read the screen', async () => {
    // Deliberately stricter than the list. `/api/v1/payments` is not in
    // PERSONAL_DATA_PREFIXES, so READ_ONLY may browse it — but reading a page
    // and taking a file of every customer's Telegram id are different acts,
    // and only one of them leaves the building.
    const ro = 'ro@example.com';
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, 'READ_ONLY', 1, ?3, ?3)`,
    )
      .bind(crypto.randomUUID(), ro, Date.now())
      .run();
    await seedClaim('x-ro', { status: 'VERIFIED' });

    expect((await csv('tab=all&range=all', ro)).status).toBe(403);
    // ...and the screen itself still answers them.
    const list = await app.fetch(
      new Request('https://x/api/v1/payments?tab=all&range=all'),
      envAs(ro),
    );
    expect(list.status).toBe(200);
  });
});

describe('personal customers and resellers, told apart', () => {
  async function ask(qs: string) {
    const r = await app.fetch(new Request(`https://x/api/v1/payments?${qs}`), envAs());
    expect(r.status).toBe(200);
    return (await r.json()) as {
      items: Array<{ id: string; customerType: string }>;
      total: number;
    };
  }

  beforeEach(async () => {
    for (const [tg, isReseller] of [
      [7001, false],
      [7002, true],
    ] as const) {
      // No `id`: it is `generated always as identity`, and Postgres refuses a
      // supplied value outright rather than ignoring it. And no timestamps
      // either: `users` keeps `timestamptz` while `payment_claims` keeps epoch
      // milliseconds — the two conventions this schema carries, and handing
      // one to the other is «date/time field value out of range».
      //
      // Upsert rather than delete-then-insert. It used to delete these two
      // first, which passed on a fresh database and failed on every run after:
      // by then the users owned a wallet and its entries, and eleven tables
      // carry a RESTRICT foreign key to `users`. The test needs the two rows to
      // EXIST with a known `is_reseller` — it never needed them to be new.
      await baseEnv.DB.prepare(
        `INSERT INTO users (telegram_id, status, is_reseller, registered_at)
         VALUES (?1, 'ACTIVE', ?2, now())
         ON CONFLICT (telegram_id) DO UPDATE SET is_reseller = EXCLUDED.is_reseller`,
      )
        .bind(tg, isReseller)
        .run();
    }
  });

  it('splits the list three ways, and «unknown» is not «personal»', async () => {
    await seedClaim('s-p', { status: 'VERIFIED', customerReference: '7001' });
    await seedClaim('s-r', { status: 'VERIFIED', customerReference: '7002' });
    // The third case, and it is real: one production row carries
    // «Poyan test payment» in this column. It matches no user, and calling it
    // personal would be inventing a fact about a payment.
    await seedClaim('s-u', { status: 'VERIFIED', customerReference: 'Poyan test payment' });

    const all = await ask('tab=all&range=all');
    const by = new Map(all.items.map((i) => [i.id, i.customerType]));
    expect(by.get('s-p')).toBe('PERSONAL');
    expect(by.get('s-r')).toBe('RESELLER');
    expect(by.get('s-u')).toBe('UNKNOWN');

    expect((await ask('tab=all&range=all&customerType=reseller')).items.map((i) => i.id)).toEqual([
      's-r',
    ]);
    const personal = await ask('tab=all&range=all&customerType=personal');
    expect(personal.items.map((i) => i.id)).toEqual(['s-p']);
    // The unattributable one is in NEITHER bucket, which is the point.
    expect(personal.items.map((i) => i.id)).not.toContain('s-u');
  });

  it('does not fall over on a reference that is not a number', async () => {
    // `customer_reference::bigint` would error here and take the whole query
    // with it — which is why the join casts the column to text instead.
    await seedClaim('s-text', { status: 'VERIFIED', customerReference: 'Poyan test payment' });
    const r = await ask('tab=all&range=all');
    expect(r.items.map((i) => i.id)).toContain('s-text');
  });
});

/**
 * The three tabs that were left behind when the claim list got pagination.
 *
 * «واریزی‌ها» is where «پول رسید و به هیچ سفارشی نخورد» is answered, and on
 * staging on 2026-09-04 its badge said 225 while the screen listed 200 — no
 * pager, no `total`, and nothing saying 25 rows were missing (issue #82). The
 * claim tabs had been fixed the day before; `income`, `declined_income` and
 * `reseller` still ended in a bare `LIMIT 200`.
 *
 * A fixture below the ceiling cannot see the old bug, so these ask the
 * narrower question the fix has to answer anyway: does the tab report how many
 * rows exist, and does page 2 continue where page 1 stopped.
 */
describe('the income tabs count what they did not send', () => {
  beforeEach(async () => {
    const base = Date.now();
    for (let i = 0; i < 3; i++) await seedTx(`inc-${i}`, base - i * 60_000);
  });

  it('reports the total beside the page, not the page as the total', async () => {
    const body = await get('tab=income&range=all&pageSize=2');
    expect(body.items.length).toBe(2);
    expect(body.total).toBe(3);
    expect(body.pageSize).toBe(2);
    expect(body.page).toBe(1);
  });

  it('page 2 continues where page 1 stopped', async () => {
    const p1 = await get('tab=income&range=all&pageSize=2');
    const p2 = await get('tab=income&range=all&pageSize=2&page=2');
    expect(p2.items.length).toBe(1);
    expect(p2.page).toBe(2);
    const ids = [...p1.items, ...p2.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('the total agrees with the badge the tab draws', async () => {
    const body = await get('tab=income&range=all&pageSize=2');
    expect(body.total).toBe(body.counts.income);
  });
});
