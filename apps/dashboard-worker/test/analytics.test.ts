/**
 * Financial analytics: sales, balances, period comparison.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { computePercentChange } from '@shikoo/domain';
import { app } from '../src/index.js';

// Schema now comes from migrations/000*.sql, applied to the test database.

const EMAIL = 'admin@example.com';
const ACCOUNT = 'acc-analytics';
const BASE = 1_786_091_200_000;
const AMOUNT = 2_000_000;
/**
 * The instant the rolling-window test pretends it is — 12:30 Tehran, so no
 * boundary it uses sits near a Tehran midnight.
 *
 * Pinned rather than read live because two clocks are read otherwise: one when
 * the fixtures are seeded and one inside the route, and a window edge falling
 * between them flips a count. Today's margins are hours wide so it could not
 * actually happen, but «the margin is comfortable» is the argument rule 5 of
 * CLAUDE.md exists to refuse. The expectations stay offsets from this constant,
 * so nothing here is tied to the date itself.
 */
const NOW_MS = 1_788_339_600_000;

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
  await baseEnv.DB.prepare(`TRUNCATE audit_logs CASCADE`).run();
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
  opts: {
    matchStatus: 'AUTO_VERIFIED' | 'CONFIRMED';
    reviewedAt: number;
    amount?: number;
    /** The card the customer was told to pay into — `payment_claims.card_digits`. */
    cardDigits?: string;
    /** `payment_claims.customer_reference`, so «how many people» can be asked. */
    customerReference?: string;
  },
) {
  const now = Date.now();
  await baseEnv.DB.prepare(
    `INSERT INTO payment_claims
       (id, external_order_id, customer_reference, expected_amount_irr, target_financial_account_id,
        submitted_at, source_system, metadata_json, status, paid_clicked_at, receipt_submitted_at,
        suspect_reason, suspect_metadata_json, card_digits, created_at, updated_at)
     VALUES (?1, ?2, ?7, ?3, ?4, ?5, 'MIRZABOT', '{}', 'VERIFIED', ?5, ?5, NULL, '{}', ?6, ?5, ?5)`,
  )
    .bind(
      id,
      `ord-${id}`,
      opts.amount ?? AMOUNT,
      ACCOUNT,
      now,
      opts.cardDigits ?? '5678',
      opts.customerReference ?? 'u1',
    )
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

// The rolling-window test pins the clock; nothing else here mocks anything, so
// restoring after every test keeps the spy from leaking into the next one.
afterEach(() => {
  vi.restoreAllMocks();
});

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

    const r = await app.fetch(
      new Request('https://x/api/v1/accounts/analytics?range=all'),
      envAs(),
    );
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
  /**
   * Two cards on ONE account, and unequal takings between them.
   *
   * This is the shape the bug was invisible in. The query joined the claim to
   * the card's *account* and grouped by the card, so every card of an account
   * reported that account's total — an account figure printed once per card,
   * under a card's name. On a single-card account the two readings agree, so a
   * one-card fixture is silent about this rather than green.
   *
   * The claim knows which card it named: `payment_claims.card_digits` is
   * snapshotted on every claim and joins UNIQUE-ly to `payment_cards`.
   */
  it('counts each card separately when one account holds two', async () => {
    const CARD_A = '6037991111111111';
    const CARD_B = '6037992222222222';
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO payment_cards (id, financial_account_id, card_digits, created_at)
       VALUES ('pc-a', ?1, ?2, ?3), ('pc-b', ?1, ?4, ?3)`,
    )
      .bind(ACCOUNT, CARD_A, Date.now(), CARD_B)
      .run();

    // Two paid into A, one into B.
    for (const [n, card] of [
      ['a1', CARD_A],
      ['a2', CARD_A],
      ['b1', CARD_B],
    ] as const) {
      await seedTx(`tx-${n}`, { ts: BASE });
      await seedClaim(`c-${n}`, `tx-${n}`, {
        matchStatus: 'AUTO_VERIFIED',
        reviewedAt: BASE,
        cardDigits: card,
      });
    }

    const r = await app.fetch(new Request('https://x/api/v1/cards/analytics?range=all'), envAs());
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      items: Array<{ cardDigits: string; purchaseCount: number }>;
    };
    const byCard = new Map(body.items.map((i) => [i.cardDigits, i.purchaseCount]));
    expect(byCard.get(CARD_A)).toBe(2);
    expect(byCard.get(CARD_B)).toBe(1);
  });

  /**
   * The six windows are rolling and are NOT scoped by the page's range.
   *
   * Every assertion is an *offset* from `NOW_MS`, which both the fixtures and
   * the route read — so there is no date here to drift under, and no second
   * clock to disagree with the first.
   */
  it('counts activity per rolling window, independent of the selected range', async () => {
    const CARD = '6037993333333333';
    const HOUR = 3_600_000;
    const now = NOW_MS;
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO payment_cards (id, financial_account_id, card_digits, created_at)
       VALUES ('pc-w', ?1, ?2, ?3)`,
    )
      .bind(ACCOUNT, CARD, now)
      .run();

    // One an hour ago, one twenty hours ago, one ten days ago.
    for (const [n, agoHours] of [
      ['recent', 1],
      ['yesterday', 20],
      ['old', 24 * 10],
    ] as const) {
      await seedTx(`tx-w-${n}`, { ts: now - agoHours * HOUR });
      await seedClaim(`c-w-${n}`, `tx-w-${n}`, {
        matchStatus: 'AUTO_VERIFIED',
        reviewedAt: now - agoHours * HOUR,
        cardDigits: CARD,
      });
    }

    // `range=today` on purpose: a range that excludes the older two must not
    // shrink the windows, which answer a different question.
    const r = await app.fetch(
      new Request('https://x/api/v1/cards/analytics?range=today'),
      envAs(),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      windows: Array<{ key: string; label: string }>;
      items: Array<{ cardDigits: string; activity: Record<string, number> }>;
    };
    expect(body.windows.map((w) => w.key)).toEqual(['h12', 'h24', 'd3', 'd7', 'd15', 'd30']);

    const card = body.items.find((i) => i.cardDigits === CARD);
    expect(card).toBeDefined();
    expect(card!.activity).toEqual({ h12: 1, h24: 2, d3: 2, d7: 2, d15: 3, d30: 3 });
  });

  /**
   * «چقدر به کارت ملت رفت، و کدام کاربرها ریختند» — Sam, 2026-09-02.
   *
   * The expected numbers below were written before the query was run: card A
   * takes three claims from two customers (one of them twice) and card B one,
   * with amounts chosen so no two sums collide by accident. A test that reads
   * the answer and then asserts it is a test that agrees with itself.
   *
   * One of card A's claims is CONFIRMED rather than AUTO_VERIFIED, and that is
   * the point of the case: money does not care who approved it. `takingsIrr`
   * must count it and `purchaseCount` — which judges rotation fairness — must
   * not.
   */
  it('sums what each card actually took, and from how many people', async () => {
    const CARD_A = '6104337712345678';
    const CARD_B = '6104338898765432';
    for (const [id, card, amount, customer, status] of [
      ['t-a1', CARD_A, 1_000_000, 'u-1', 'AUTO_VERIFIED'],
      ['t-a2', CARD_A, 2_000_000, 'u-1', 'AUTO_VERIFIED'],
      ['t-a3', CARD_A, 4_000_000, 'u-2', 'CONFIRMED'],
      ['t-b1', CARD_B, 8_000_000, 'u-3', 'AUTO_VERIFIED'],
    ] as const) {
      await baseEnv.DB.prepare(
        `INSERT OR IGNORE INTO payment_cards (id, financial_account_id, card_digits, created_at)
         VALUES (?1, ?2, ?3, ?4)`,
      )
        .bind(`pc-${card.slice(-4)}`, ACCOUNT, card, Date.now())
        .run();
      await seedTx(`tx-${id}`, { ts: BASE, amount });
      await seedClaim(id, `tx-${id}`, {
        matchStatus: status,
        reviewedAt: BASE,
        amount,
        cardDigits: card,
        customerReference: customer,
      });
    }

    const r = await app.fetch(new Request('https://x/api/v1/cards/analytics?range=all'), envAs());
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      items: Array<{
        cardDigits: string;
        purchaseCount: number;
        verifiedCount: number;
        takingsIrr: number;
        uniqueCustomers: number;
      }>;
    };
    const by = new Map(body.items.map((i) => [i.cardDigits, i]));

    expect(by.get(CARD_A)).toMatchObject({
      takingsIrr: 7_000_000,
      verifiedCount: 3,
      uniqueCustomers: 2,
      // The manual one is money but not a rotation datapoint.
      purchaseCount: 2,
    });
    expect(by.get(CARD_B)).toMatchObject({
      takingsIrr: 8_000_000,
      verifiedCount: 1,
      uniqueCustomers: 1,
      purchaseCount: 1,
    });

    // The two cards share one account, so an account-level figure would print
    // 15,000,000 twice. This is the bug fixed in #61, asserted again from the
    // money side because that is where it would be most expensive.
    expect(by.get(CARD_A)!.takingsIrr).not.toBe(by.get(CARD_B)!.takingsIrr);
  });

  it('groups auto-verified purchases by mapped card', async () => {
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO payment_cards (id, financial_account_id, card_digits, created_at)
       VALUES ('pc-1', ?1, '5054161706277613', ?2)`,
    )
      .bind(ACCOUNT, Date.now())
      .run();
    await seedTx('tx-card', { ts: BASE });
    await seedClaim('c-card', 'tx-card', {
      matchStatus: 'AUTO_VERIFIED',
      reviewedAt: BASE,
      cardDigits: '5054161706277613',
    });

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
