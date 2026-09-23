import { beforeAll, describe, expect, it } from 'vitest';
import { applySchema, env } from './helpers/env.js';
import { app } from '../src/index.js';
import { MIRZABOT_CLAIMS_PATH } from '@shikoo/contracts';
// 0013 creates reseller_transactions, which the ingest path writes to. Without
// it the whole Mirzabot flow 500s here even though production is fine.

// Schema now comes from migrations/000*.sql, applied to the test database.

const SECRET = 'test-hmac-secret-32chars-minimum!!';
const INTEGRATION_ID = 'mirzabot-test';

async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function signedPost(body: Record<string, unknown>, eventId: string): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000).toString();
  const bodyHash = await sha256Hex(rawBody);
  const payload = `${ts}\nPOST\n${MIRZABOT_CLAIMS_PATH}\n${bodyHash}`;
  const signature = `sha256=${await hmacSha256Hex(SECRET, payload)}`;
  return app.fetch(
    new Request(`https://example.com${MIRZABOT_CLAIMS_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Integration-Id': INTEGRATION_ID,
        'X-Event-Id': eventId,
        'X-Timestamp': ts,
        'X-Signature': signature,
      },
      body: rawBody,
    }),
    {
      ...env,
      MIRZABOT_INTEGRATION_ENABLED: 'true',
      MIRZABOT_INTEGRATION_HMAC_SECRET: SECRET,
      MIRZABOT_INTEGRATION_ID: INTEGRATION_ID,
      AUTO_MATCH_ENABLED: 'true',
    },
  );
}

const BASE_MS = 1_786_091_200_000;

async function seedAccountAndCard() {
  const now = Date.now();
  const accountId = 'acc-mirza-1';
  await env.DB.prepare(
    `INSERT INTO financial_accounts
     (id, bank_name, display_name, owner_label, account_type, active, status, parser_configuration, created_at, updated_at)
     VALUES (?1,'Melli','Test Account',NULL,'CARD',1,'ACTIVE','{}',?2,?2)`,
  )
    .bind(accountId, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO payment_cards (id, financial_account_id, card_digits, holder_name, created_at)
     VALUES ('pc-1', ?1, '6037997512345678', 'test', ?2)`,
  )
    .bind(accountId, now)
    .run();
  return accountId;
}

async function seedTransaction(
  accountId: string,
  amountIrr: number,
  bankTs: number,
  txId = 'tx-1',
) {
  const now = Date.now();
  const deviceId = 'dev-mirza-test';
  await env.DB.prepare(
    `INSERT OR IGNORE INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES (?1,'mirza-test','Mirza Test',1,?2,?2)`,
  )
    .bind(deviceId, now)
    .run();
  const smsId = `sms-${txId}`;
  await env.DB.prepare(
    `INSERT INTO raw_sms_events
     (id, device_id, sender, normalized_body, body_sha256, app_checksum, sms_timestamp, received_at, classification, parser_status, parser_id, parser_version, created_at)
     VALUES (?1,?2,'TEST','seed','hash-${txId}','cksum',?3,?4,'BANK_CREDIT','OK','test','v1',?4)`,
  )
    .bind(smsId, deviceId, bankTs, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO transaction_candidates
     (id, raw_sms_event_id, financial_account_id, direction, amount_irr, status, bank_timestamp,
      confidence, parser_id, parser_version, parser_evidence_json, processing_disposition, created_at, updated_at)
     VALUES (?1,?2,?3,'CREDIT',?4,'PARSED',?5,1.0,'test','v1','{}','ACTIONABLE',?6,?6)`,
  )
    .bind(txId, smsId, accountId, amountIrr, bankTs, now)
    .run();
}

function claimBody(over: Record<string, unknown> = {}) {
  return {
    eventId: `evt-${crypto.randomUUID()}`,
    source: 'MIRZABOT',
    orderId: `ord-${crypto.randomUUID().slice(0, 8)}`,
    telegramUserId: '12345',
    telegramUsername: 'testuser',
    amountToman: 100_000,
    expectedAmountIrr: 1_000_000,
    cardNumber: '6037-9975-1234-5678',
    paidClickedAt: BASE_MS,
    receiptSubmittedAt: BASE_MS + 5000,
    receipt: { telegramFileUniqueId: 'file-abc' },
    ...over,
  };
}

beforeAll(async () => {
  await applySchema();
});

describe('mirzabot integration claims', () => {
  it('happy path — auto verify within 20s', async () => {
    const accountId = await seedAccountAndCard();
    await seedTransaction(accountId, 1_000_000, BASE_MS + 20_000);
    const body = claimBody();
    const res = await signedPost(body, body.eventId);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { autoVerified: boolean; suspectReason: string | null };
    expect(json.autoVerified).toBe(true);
    expect(json.suspectReason).toBeNull();
  });

  it('61 second boundary — OUTSIDE_AUTO_MATCH_WINDOW suspect', async () => {
    const accountId = 'acc-mirza-61';
    const cardDigits = '6037997512345679';
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO financial_accounts
       (id, bank_name, display_name, owner_label, account_type, active, status, parser_configuration, created_at, updated_at)
       VALUES (?1,'Melli','Test 61',NULL,'CARD',1,'ACTIVE','{}',?2,?2)`,
    )
      .bind(accountId, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO payment_cards (id, financial_account_id, card_digits, created_at)
       VALUES ('pc-61', ?1, ?2, ?3)`,
    )
      .bind(accountId, cardDigits, now)
      .run();
    await seedTransaction(accountId, 1_000_000, BASE_MS + 5 * 60_000 + 1_000, 'tx-5m1');
    const body = claimBody({ orderId: 'ord-5min1', cardNumber: '6037-9975-1234-5679' });
    const res = await signedPost(body, body.eventId);
    const json = (await res.json()) as { autoVerified: boolean; suspectReason: string };
    expect(json.autoVerified).toBe(false);
    expect(json.suspectReason).toBe('OUTSIDE_AUTO_MATCH_WINDOW');
  });

  it('duplicate eventId — idempotent', async () => {
    const body = claimBody({ orderId: 'ord-dup-evt' });
    const res1 = await signedPost(body, body.eventId);
    expect(res1.status).toBe(200);
    const res2 = await signedPost(body, body.eventId);
    expect(res2.status).toBe(200);
    const json = (await res2.json()) as { duplicateEvent: boolean };
    expect(json.duplicateEvent).toBe(true);
  });

  it('unmapped card — UNMAPPED_CARD suspect', async () => {
    const body = claimBody({
      cardNumber: '6219861234567890',
      orderId: 'ord-unmapped',
    });
    const res = await signedPost(body, body.eventId);
    const json = (await res.json()) as { suspectReason: string; autoVerified: boolean };
    expect(json.autoVerified).toBe(false);
    expect(json.suspectReason).toBe('UNMAPPED_CARD');
  });
});

async function seedAccountWithCard(accountId: string, cardDigits: string, status = 'ACTIVE') {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO financial_accounts
     (id, bank_name, display_name, owner_label, account_type, active, status, parser_configuration, created_at, updated_at)
     VALUES (?1,'Melli',?2,NULL,'CARD',1,?3,'{}',?4,?4)`,
  )
    .bind(accountId, `Account ${accountId}`, status, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO payment_cards (id, financial_account_id, card_digits, created_at)
     VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(`pc-${accountId}`, accountId, cardDigits, now)
    .run();
}

async function claimByOrder(orderId: string) {
  return env.DB.prepare(
    `SELECT id, status, suspect_reason, target_financial_account_id
     FROM payment_claims WHERE external_order_id = ?1`,
  )
    .bind(`mirzabot:test:${orderId}`)
    .first<{
      id: string;
      status: string;
      suspect_reason: string | null;
      target_financial_account_id: string | null;
    }>();
}

/** Ambient Cloudflare D1Database is a structural subset of the domain's. */
function domainDb() {
  return env.DB as unknown as import('@shikoo/domain').D1Database;
}

async function rematch(accountId: string, amountIrr: number, txId: string, bankTs: number) {
  const { rematchMirzabotClaimsForCreditTx } = await import('../src/integrations/mirzabot.js');
  return rematchMirzabotClaimsForCreditTx(
    domainDb(),
    {
      id: txId,
      financial_account_id: accountId,
      amount_irr: amountIrr,
      direction: 'CREDIT',
      bank_timestamp: bankTs,
      processing_disposition: 'ACTIONABLE',
    },
    { autoMatchEnabled: true, now: bankTs + 5_000 },
  );
}

describe('PHASE 8 — integration: AUTO path', () => {
  it('bank SMS arriving after the claim auto-verifies via paid_clicked_at', async () => {
    const accountId = 'acc-int-auto';
    await seedAccountWithCard(accountId, '6037997512345680');

    const body = claimBody({
      orderId: 'ord-int-auto',
      cardNumber: '6037-9975-1234-5680',
      paidClickedAt: BASE_MS,
      receiptSubmittedAt: BASE_MS + 2000,
    });
    const claimRes = await signedPost(body, body.eventId);
    const claimJson = (await claimRes.json()) as {
      autoVerified: boolean;
      suspectReason: string | null;
    };
    expect(claimJson.autoVerified).toBe(false);

    await seedTransaction(accountId, 1_000_000, BASE_MS + 25_000, 'tx-int-auto');
    const run = await rematch(accountId, 1_000_000, 'tx-int-auto', BASE_MS + 25_000);
    expect(run.autoVerifiedCount).toBe(1);

    const claim = await claimByOrder('ord-int-auto');
    expect(claim?.status).toBe('VERIFIED');
    expect(claim?.suspect_reason).toBeNull();

    const match = await env.DB.prepare(
      `SELECT status, transaction_candidate_id FROM reconciliation_matches WHERE payment_claim_id = ?1`,
    )
      .bind(claim!.id)
      .all<{ status: string; transaction_candidate_id: string }>();
    expect(match.results).toHaveLength(1);
    expect(match.results[0]!.status).toBe('AUTO_VERIFIED');

    const txStatus = await env.DB.prepare(
      `SELECT status FROM transaction_candidates WHERE id = 'tx-int-auto'`,
    ).first<{ status: string }>();
    expect(txStatus?.status).toBe('APPROVED');
  });

  it('a claim whose card is mapped only afterwards still recovers', async () => {
    const accountId = 'acc-int-late-map';
    const body = claimBody({
      orderId: 'ord-late-map',
      cardNumber: '6037-9975-1234-5681',
      paidClickedAt: BASE_MS,
      receiptSubmittedAt: BASE_MS + 1000,
    });
    const res = await signedPost(body, body.eventId);
    expect(((await res.json()) as { suspectReason: string | null }).suspectReason).toBe(
      'UNMAPPED_CARD',
    );

    await seedAccountWithCard(accountId, '6037997512345681');
    await seedTransaction(accountId, 1_000_000, BASE_MS + 30_000, 'tx-late-map');
    const run = await rematch(accountId, 1_000_000, 'tx-late-map', BASE_MS + 30_000);
    expect(run.autoVerifiedCount).toBe(1);
    expect((await claimByOrder('ord-late-map'))?.status).toBe('VERIFIED');
  });
});

describe('PHASE 8 — integration: SUGGESTED path', () => {
  it('two claims contending for one transaction stay reviewable and unfulfilled', async () => {
    const accountId = 'acc-int-ambig';
    await seedAccountWithCard(accountId, '6037997512345690');

    for (const [orderId, offset] of [
      ['ord-ambig-1', 0],
      ['ord-ambig-2', 10_000],
    ] as const) {
      const body = claimBody({
        orderId,
        cardNumber: '6037-9975-1234-5690',
        paidClickedAt: BASE_MS + offset,
        receiptSubmittedAt: BASE_MS + offset + 1000,
      });
      const res = await signedPost(body, body.eventId);
      expect(((await res.json()) as { autoVerified: boolean }).autoVerified).toBe(false);
    }

    await seedTransaction(accountId, 1_000_000, BASE_MS + 20_000, 'tx-int-ambig');
    const run = await rematch(accountId, 1_000_000, 'tx-int-ambig', BASE_MS + 20_000);
    expect(run.autoVerifiedCount).toBe(0);

    for (const orderId of ['ord-ambig-1', 'ord-ambig-2']) {
      const claim = await claimByOrder(orderId);
      expect(claim?.status).not.toBe('VERIFIED');
      expect(claim?.suspect_reason).toBe('AMBIGUOUS_CLAIMS');
    }

    const consumed = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM reconciliation_matches
       WHERE transaction_candidate_id = 'tx-int-ambig' AND status IN ('CONFIRMED','AUTO_VERIFIED')`,
    ).first<{ n: number }>();
    expect(consumed?.n).toBe(0);

    const txStatus = await env.DB.prepare(
      `SELECT status FROM transaction_candidates WHERE id = 'tx-int-ambig'`,
    ).first<{ status: string }>();
    expect(txStatus?.status).not.toBe('APPROVED');
  });

  it('one claim with two candidate transactions reports AMBIGUOUS_TRANSACTIONS', async () => {
    const accountId = 'acc-int-two-tx';
    await seedAccountWithCard(accountId, '6037997512345691');
    const body = claimBody({
      orderId: 'ord-two-tx',
      cardNumber: '6037-9975-1234-5691',
      paidClickedAt: BASE_MS,
      receiptSubmittedAt: BASE_MS + 1000,
    });
    await signedPost(body, body.eventId);

    await seedTransaction(accountId, 1_000_000, BASE_MS + 10_000, 'tx-two-a');
    await seedTransaction(accountId, 1_000_000, BASE_MS + 40_000, 'tx-two-b');
    const run = await rematch(accountId, 1_000_000, 'tx-two-b', BASE_MS + 40_000);
    expect(run.autoVerifiedCount).toBe(0);

    const claim = await claimByOrder('ord-two-tx');
    expect(claim?.suspect_reason).toBe('AMBIGUOUS_TRANSACTIONS');
    expect(claim?.status).not.toBe('VERIFIED');
  });

  /**
   * Issue #424. The pool read «consumed» as `EXISTS(...) === 1`, and Postgres
   * answers a real boolean — so a transaction that had already settled one
   * claim still looked free to the next claim of the same amount on the same
   * account, and that claim, with its own transfer, was never 1↔1.
   */
  it('a transaction that already settled a claim is not a candidate for the next one', async () => {
    const accountId = 'acc-int-spent';
    await seedAccountWithCard(accountId, '6037997512345694');
    const post = async (orderId: string, at: number) => {
      const body = claimBody({
        orderId,
        cardNumber: '6037-9975-1234-5694',
        paidClickedAt: at,
        receiptSubmittedAt: at + 1000,
      });
      await signedPost(body, body.eventId);
    };

    await post('ord-spent-a', BASE_MS);
    await seedTransaction(accountId, 1_000_000, BASE_MS + 20_000, 'tx-spent-a');
    expect((await rematch(accountId, 1_000_000, 'tx-spent-a', BASE_MS + 20_000)).autoVerifiedCount).toBe(1);

    // A minute later, same amount, same account: tx-spent-a is inside B's
    // window and must not count.
    await post('ord-spent-b', BASE_MS + 60_000);
    await seedTransaction(accountId, 1_000_000, BASE_MS + 80_000, 'tx-spent-b');
    const run = await rematch(accountId, 1_000_000, 'tx-spent-b', BASE_MS + 80_000);
    expect(run.autoVerifiedCount).toBe(1);

    const claim = await claimByOrder('ord-spent-b');
    expect(claim?.status).toBe('VERIFIED');
    const settledBy = await env.DB.prepare(
      `SELECT transaction_candidate_id FROM reconciliation_matches
        WHERE payment_claim_id = ?1 AND status = 'AUTO_VERIFIED'`,
    )
      .bind(claim!.id)
      .first<{ transaction_candidate_id: string }>();
    expect(settledBy?.transaction_candidate_id).toBe('tx-spent-b');
  });

  /**
   * «شارژ کیف پول» (#441) spends a deposit with a wallet entry and no match
   * row. The pool read only matches, so that deposit still looked free: inside
   * the next same-amount claim's window it was a second candidate, and a real
   * 1↔1 sat in review as AMBIGUOUS_TRANSACTIONS.
   */
  it('a deposit already credited to a wallet is not a candidate either', async () => {
    const accountId = 'acc-int-wallet';
    await seedAccountWithCard(accountId, '6037997512345702');
    await seedTransaction(accountId, 1_000_000, BASE_MS + 10_000, 'tx-wallet-spent');
    const user = await env.DB.prepare(
      `INSERT INTO users (telegram_id, username, registered_at) VALUES (9123400000441, 'wallet-spent', now())
       ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username RETURNING id`,
    ).first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO wallet_entries (user_id, amount_irr, kind, idempotency_key)
       VALUES (?1, 1000000, 'TOPUP', 'deposit:tx-wallet-spent:wallet') ON CONFLICT (idempotency_key) DO NOTHING`,
    )
      .bind(user!.id)
      .run();

    const body = claimBody({
      orderId: 'ord-wallet-b',
      cardNumber: '6037-9975-1234-5702',
      paidClickedAt: BASE_MS,
      receiptSubmittedAt: BASE_MS + 1000,
    });
    await signedPost(body, body.eventId);
    await seedTransaction(accountId, 1_000_000, BASE_MS + 20_000, 'tx-wallet-b');
    expect((await rematch(accountId, 1_000_000, 'tx-wallet-b', BASE_MS + 20_000)).autoVerifiedCount).toBe(1);

    const claim = await claimByOrder('ord-wallet-b');
    expect(claim?.status).toBe('VERIFIED');
    const settledBy = await env.DB.prepare(
      `SELECT transaction_candidate_id FROM reconciliation_matches
        WHERE payment_claim_id = ?1 AND status = 'AUTO_VERIFIED'`,
    )
      .bind(claim!.id)
      .first<{ transaction_candidate_id: string }>();
    expect(settledBy?.transaction_candidate_id).toBe('tx-wallet-b');
  });

  it('a claim held in WAIT is settled as NO_TRANSACTION_AFTER_10M once waiting expires', async () => {
    const accountId = 'acc-int-wait';
    await seedAccountWithCard(accountId, '6037997512345693');
    const clickedAt = Date.now();
    const receiptAt = clickedAt + 1000;
    const body = claimBody({
      orderId: 'ord-wait',
      cardNumber: '6037-9975-1234-5693',
      paidClickedAt: clickedAt,
      receiptSubmittedAt: receiptAt,
    });
    const res = await signedPost(body, body.eventId);
    expect(((await res.json()) as { suspectReason: string | null }).suspectReason).toBeNull();

    const { finalizeExpiredMirzabotWaits } = await import('../src/integrations/mirzabot.js');

    await finalizeExpiredMirzabotWaits(domainDb(), {
      autoMatchEnabled: true,
      now: receiptAt + 30_000,
    });
    expect((await claimByOrder('ord-wait'))?.suspect_reason).toBeNull();

    await finalizeExpiredMirzabotWaits(domainDb(), {
      autoMatchEnabled: true,
      now: receiptAt + 120_000,
    });
    expect((await claimByOrder('ord-wait'))?.suspect_reason).toBeNull();

    await finalizeExpiredMirzabotWaits(domainDb(), {
      autoMatchEnabled: true,
      now: receiptAt + 10 * 60_000 + 1_000,
    });
    const settled = await claimByOrder('ord-wait');
    expect(settled?.suspect_reason).toBe('NO_TRANSACTION_AFTER_10M');
    expect(settled?.status).not.toBe('VERIFIED');
    expect(settled?.status).not.toBe('FAKE_RECEIPT');
  });

  it('a muted account never auto-verifies', async () => {
    const accountId = 'acc-int-muted';
    await seedAccountWithCard(accountId, '6037997512345692', 'MUTED');
    const body = claimBody({
      orderId: 'ord-muted',
      cardNumber: '6037-9975-1234-5692',
      paidClickedAt: BASE_MS,
      receiptSubmittedAt: BASE_MS + 1000,
    });
    await signedPost(body, body.eventId);
    await seedTransaction(accountId, 1_000_000, BASE_MS + 5_000, 'tx-muted');
    const run = await rematch(accountId, 1_000_000, 'tx-muted', BASE_MS + 5_000);
    expect(run.autoVerifiedCount).toBe(0);
    expect((await claimByOrder('ord-muted'))?.suspect_reason).toBe('ACCOUNT_NOT_ACTIVE');
  });
});

describe('PHASE 5 — concurrency and double-use', () => {
  it('auto and manual approval racing the same transaction: exactly one wins', async () => {
    const accountId = 'acc-race';
    await seedAccountWithCard(accountId, '6037997512345700');
    await seedAccountWithCard('acc-race-2', '6037997512345701');

    for (const [orderId, card] of [
      ['ord-race-1', '6037-9975-1234-5700'],
      ['ord-race-2', '6037-9975-1234-5701'],
    ] as const) {
      const body = claimBody({
        orderId,
        cardNumber: card,
        paidClickedAt: BASE_MS,
        receiptSubmittedAt: BASE_MS + 1000,
      });
      await signedPost(body, body.eventId);
    }
    await seedTransaction(accountId, 1_000_000, BASE_MS + 10_000, 'tx-race');

    const c1 = await claimByOrder('ord-race-1');
    const c2 = await claimByOrder('ord-race-2');
    // Point the second claim at the same account so both can target one tx.
    await env.DB.prepare(`UPDATE payment_claims SET target_financial_account_id = ?2 WHERE id = ?1`)
      .bind(c2!.id, accountId)
      .run();

    const { verifyMirzabotClaim } = await import('@shikoo/domain');
    const results = await Promise.all([
      verifyMirzabotClaim(domainDb(), {
        claimId: c1!.id,
        transactionId: 'tx-race',
        mode: 'AUTO_VERIFIED',
      }),
      verifyMirzabotClaim(domainDb(), {
        claimId: c2!.id,
        transactionId: 'tx-race',
        mode: 'ADMIN_APPROVED',
        actorEmail: 'admin@example.com',
      }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);

    const consuming = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM reconciliation_matches
       WHERE transaction_candidate_id = 'tx-race' AND status IN ('CONFIRMED','AUTO_VERIFIED')`,
    ).first<{ n: number }>();
    expect(consuming?.n).toBe(1);

    const verifiedClaims = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM payment_claims WHERE id IN (?1, ?2) AND status = 'VERIFIED'`,
    )
      .bind(c1!.id, c2!.id)
      .first<{ n: number }>();
    expect(verifiedClaims?.n).toBe(1);
  });

  it('a verified order is never verified a second time', async () => {
    const accountId = 'acc-once';
    await seedAccountWithCard(accountId, '6037997512345710');
    const body = claimBody({
      orderId: 'ord-once',
      cardNumber: '6037-9975-1234-5710',
      paidClickedAt: BASE_MS,
      receiptSubmittedAt: BASE_MS + 1000,
    });
    await signedPost(body, body.eventId);
    await seedTransaction(accountId, 1_000_000, BASE_MS + 10_000, 'tx-once-a');
    expect(
      (await rematch(accountId, 1_000_000, 'tx-once-a', BASE_MS + 10_000)).autoVerifiedCount,
    ).toBe(1);

    // A second qualifying transaction must not verify the same order again.
    await seedTransaction(accountId, 1_000_000, BASE_MS + 20_000, 'tx-once-b');
    expect(
      (await rematch(accountId, 1_000_000, 'tx-once-b', BASE_MS + 20_000)).autoVerifiedCount,
    ).toBe(0);

    const matches = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM reconciliation_matches m
       JOIN payment_claims c ON c.id = m.payment_claim_id
       WHERE c.external_order_id = 'mirzabot:test:ord-once'
         AND m.status IN ('CONFIRMED','AUTO_VERIFIED')`,
    ).first<{ n: number }>();
    expect(matches?.n).toBe(1);
  });

  it('replaying a settled order does not re-open or re-fulfil it', async () => {
    const accountId = 'acc-replay';
    await seedAccountWithCard(accountId, '6037997512345720');
    const body = claimBody({
      orderId: 'ord-replay',
      cardNumber: '6037-9975-1234-5720',
      paidClickedAt: BASE_MS,
      receiptSubmittedAt: BASE_MS + 1000,
    });
    await signedPost(body, body.eventId);
    await seedTransaction(accountId, 1_000_000, BASE_MS + 10_000, 'tx-replay');
    expect(
      (await rematch(accountId, 1_000_000, 'tx-replay', BASE_MS + 10_000)).autoVerifiedCount,
    ).toBe(1);
    expect((await claimByOrder('ord-replay'))?.status).toBe('VERIFIED');

    // Same order, brand-new eventId: the customer re-submitted the receipt.
    const replay = claimBody({
      orderId: 'ord-replay',
      cardNumber: '6037-9975-1234-5720',
      paidClickedAt: BASE_MS,
      receiptSubmittedAt: BASE_MS + 1000,
    });
    const res = await signedPost(replay, replay.eventId);
    const json = (await res.json()) as { autoVerified: boolean; suspectReason: string | null };
    expect(json.autoVerified).toBe(false);
    expect(json.suspectReason).toBe('DUPLICATE_ORDER');
    expect((await claimByOrder('ord-replay'))?.status).toBe('VERIFIED');

    const matches = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM reconciliation_matches m
       JOIN payment_claims c ON c.id = m.payment_claim_id
       WHERE c.external_order_id = 'mirzabot:test:ord-replay'
         AND m.status IN ('CONFIRMED','AUTO_VERIFIED')`,
    ).first<{ n: number }>();
    expect(matches?.n).toBe(1);
  });
});

/**
 * Production, 2026-09-16 — the night the shop went live on this hub. Four
 * customers transferred first and pressed «پرداخت کردم» seconds later; every
 * one of them waited for an operator, because (a) the matcher was gated on
 * `MIRZABOT_INTEGRATION_ENABLED`, which production had off, and (b) the new
 * bot only INSERTs its claim, and the sweep skipped anything younger than the
 * 10-minute wait. Both are pinned here from the new bot's side: a claim row
 * written directly, never posted to the HMAC endpoint.
 */
describe('the new bot: SMS first, «پرداخت کردم» after', () => {
  async function botClaim(
    orderId: string,
    accountId: string,
    cardDigits: string,
    amountIrr: number,
    at: number,
  ) {
    await env.DB.prepare(
      `INSERT INTO payment_claims
         (id, external_order_id, customer_reference, expected_amount_irr,
          target_financial_account_id, card_digits, submitted_at, paid_clicked_at,
          source_system, metadata_json, status, created_at, updated_at)
       VALUES (?1, ?2, '174181341', ?3, ?4, ?6, ?5, ?5, 'MIRZABOT', '{}', 'PENDING', ?5, ?5)`,
    )
      .bind(`claim-${orderId}`, `shikoo:${orderId}`, amountIrr, accountId, at, cardDigits)
      .run();
  }
  /** What `recordReceipt` in the bot does: stamps the receipt on the open claim. */
  async function botReceipt(orderId: string, at: number) {
    await env.DB.prepare(
      `UPDATE payment_claims SET receipt_url_or_r2_key = 'tg:receipt', receipt_submitted_at = ?2
        WHERE external_order_id = ?1`,
    )
      .bind(`shikoo:${orderId}`, at)
      .run();
  }
  async function botClaimStatus(orderId: string) {
    return env.DB.prepare(`SELECT status FROM payment_claims WHERE external_order_id = ?1`)
      .bind(`shikoo:${orderId}`)
      .first<{ status: string }>();
  }

  it('verifies on the next sweep, not on the tenth minute', async () => {
    const accountId = 'acc-bot-sms-first';
    await seedAccountWithCard(accountId, '6037997512349900');
    const smsAt = BASE_MS + 60_000;
    await seedTransaction(accountId, 1_990_000, smsAt, 'tx-bot-sms-first');
    // The SMS landed with no claim to meet: nothing to verify yet.
    expect((await rematch(accountId, 1_990_000, 'tx-bot-sms-first', smsAt)).autoVerifiedCount).toBe(0);

    await botClaim('sms-first', accountId, '6037997512349900', 1_990_000, smsAt + 20_000);

    // Sam, 2026-09-17: the transfer alone ships nothing. Without the receipt
    // the sweep holds the claim — PENDING, no suspect — even with the money
    // sitting right there.
    const { finalizeExpiredMirzabotWaits } = await import('../src/integrations/mirzabot.js');
    await finalizeExpiredMirzabotWaits(domainDb(), {
      autoMatchEnabled: true,
      now: smsAt + 35_000,
    });
    expect((await botClaimStatus('sms-first'))?.status).toBe('PENDING');

    await botReceipt('sms-first', smsAt + 40_000);
    await finalizeExpiredMirzabotWaits(domainDb(), {
      autoMatchEnabled: true,
      now: smsAt + 50_000,
    });
    expect((await botClaimStatus('sms-first'))?.status).toBe('VERIFIED');
  });

  it('a transfer without a receipt goes to the operator after the waiting period', async () => {
    const accountId = 'acc-bot-no-receipt';
    await seedAccountWithCard(accountId, '6037997512349902');
    const clickedAt = BASE_MS + 180_000;
    await botClaim('no-receipt', accountId, '6037997512349902', 2_490_000, clickedAt);
    await seedTransaction(accountId, 2_490_000, clickedAt + 5_000, 'tx-bot-no-receipt');

    const { finalizeExpiredMirzabotWaits } = await import('../src/integrations/mirzabot.js');
    await finalizeExpiredMirzabotWaits(domainDb(), {
      autoMatchEnabled: true,
      now: clickedAt + 10 * 60_000 + 1_000,
    });
    const row = await env.DB.prepare(
      `SELECT status, suspect_reason FROM payment_claims WHERE external_order_id = 'shikoo:no-receipt'`,
    ).first<{ status: string; suspect_reason: string | null }>();
    expect(row?.status).not.toBe('VERIFIED');
    expect(row?.suspect_reason).toBe('RECEIPT_MISSING');

    // The receipt arriving late still closes it: the sweep revisits
    // RECEIPT_MISSING claims, and the engine verifies once the picture is in.
    await botReceipt('no-receipt', clickedAt + 11 * 60_000);
    await finalizeExpiredMirzabotWaits(domainDb(), {
      autoMatchEnabled: true,
      now: clickedAt + 11 * 60_000 + 15_000,
    });
    expect((await botClaimStatus('no-receipt'))?.status).toBe('VERIFIED');
  });

  it('is not switched off by MIRZABOT_INTEGRATION_ENABLED=false', async () => {
    const accountId = 'acc-bot-legacy-off';
    await seedAccountWithCard(accountId, '6037997512349901');
    const clickedAt = BASE_MS + 120_000;
    await botClaim('legacy-off', accountId, '6037997512349901', 1_190_000, clickedAt);
    await botReceipt('legacy-off', clickedAt + 1_000);
    await seedTransaction(accountId, 1_190_000, clickedAt + 3_000, 'tx-bot-legacy-off');

    const { rematchMirzabotClaimsForCreditTx } = await import('../src/integrations/mirzabot.js');
    const run = await rematchMirzabotClaimsForCreditTx(
      domainDb(),
      {
        id: 'tx-bot-legacy-off',
        financial_account_id: accountId,
        amount_irr: 1_190_000,
        direction: 'CREDIT',
        bank_timestamp: clickedAt + 3_000,
        processing_disposition: 'ACTIONABLE',
      },
      { enabled: false, autoMatchEnabled: true, now: clickedAt + 8_000 },
    );
    expect(run.autoVerifiedCount).toBe(1);
    expect((await botClaimStatus('legacy-off'))?.status).toBe('VERIFIED');
  });
});
