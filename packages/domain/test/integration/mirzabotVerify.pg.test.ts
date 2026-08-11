/**
 * `verifyMirzabotClaim` against a real Postgres.
 *
 * Every other domain test fakes the database, which proves the decision logic
 * and nothing about the engine. This one exercises the actual write path — the
 * batch, the partial unique indexes, the status updates — because that is where
 * a database swap can quietly change behaviour: a conflict that no longer
 * raises, a batch that half-applies, a bigint that arrives as a string and
 * makes `tx.amount_irr !== claim.expected_amount_irr` true for equal amounts.
 *
 * Needs DATABASE_URL and migrations 0001-0005 applied (`pnpm sim:up`).
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresD1 } from '@shikoo/db';
import { MIRZABOT_SOURCE } from '@shikoo/contracts';
import { verifyMirzabotClaim } from '../../src/mirzabotVerify.js';

const { db, pool } = createPostgresD1();

afterAll(async () => {
  await pool.end();
});

const NOW = 1_786_000_000_000;
const AMOUNT = 1_000_000;

async function seed(): Promise<void> {
  await db
    .prepare(
      `TRUNCATE reconciliation_matches, payment_claims, transaction_candidates,
                raw_sms_events, financial_accounts, devices, reseller_transactions
       RESTART IDENTITY CASCADE`,
    )
    .run();

  await db
    .prepare(`INSERT INTO devices (id, device_code, display_name, created_at, updated_at)
              VALUES ('dev-1', 'D1', 'phone', ?1, ?1)`)
    .bind(NOW)
    .run();

  for (const acct of ['acct-a', 'acct-b']) {
    await db
      .prepare(`INSERT INTO financial_accounts (id, bank_name, display_name, account_type,
                                                created_at, updated_at)
                VALUES (?1, 'melli', 'Melli', 'CARD', ?2, ?2)`)
      .bind(acct, NOW)
      .run();
  }

  // Two independent transactions, both actionable credits on acct-a.
  for (const [tx, sms] of [['tx-1', 'sms-1'], ['tx-2', 'sms-2']]) {
    await db
      .prepare(`INSERT INTO raw_sms_events (id, device_id, sender, body_sha256, app_checksum,
                                            sms_timestamp, received_at, classification,
                                            parser_status, created_at)
                VALUES (?1, 'dev-1', '710', ?2, 'c1', ?3, ?3, 'BANK_CREDIT', 'OK', ?3)`)
      .bind(sms, `hash-${sms}`, NOW)
      .run();
    await db
      .prepare(`INSERT INTO transaction_candidates (id, raw_sms_event_id, financial_account_id,
                                                    direction, amount_irr, bank_timestamp,
                                                    confidence, parser_id, parser_version,
                                                    status, processing_disposition,
                                                    created_at, updated_at)
                VALUES (?1, ?2, 'acct-a', 'CREDIT', ?3, ?4, 1.0, 'p', 'v1',
                        'PARSED', 'ACTIONABLE', ?4, ?4)`)
      .bind(tx, sms, AMOUNT, NOW)
      .run();
  }

  for (const claim of ['claim-1', 'claim-2']) {
    await db
      .prepare(`INSERT INTO payment_claims (id, external_order_id, expected_amount_irr,
                                            target_financial_account_id, submitted_at,
                                            source_system, status, metadata_json,
                                            suspect_metadata_json, created_at, updated_at)
                VALUES (?1, ?2, ?3, 'acct-a', ?4, ?5, 'PENDING', '{}', '{}', ?4, ?4)`)
      .bind(claim, `mirzabot:test:${claim}`, AMOUNT, NOW, MIRZABOT_SOURCE)
      .run();
  }
}

beforeEach(seed);

async function claimStatus(id: string): Promise<string | null> {
  return db.prepare(`SELECT status FROM payment_claims WHERE id = ?1`).bind(id).first<string>('status');
}

async function txStatus(id: string): Promise<string | null> {
  return db
    .prepare(`SELECT status FROM transaction_candidates WHERE id = ?1`)
    .bind(id)
    .first<string>('status');
}

describe('verifyMirzabotClaim on Postgres', () => {
  it('verifies a clean pair and moves all three rows together', async () => {
    const res = await verifyMirzabotClaim(db, {
      claimId: 'claim-1',
      transactionId: 'tx-1',
      mode: 'AUTO_VERIFIED',
    });

    expect(res.ok).toBe(true);
    expect(await claimStatus('claim-1')).toBe('VERIFIED');
    expect(await txStatus('tx-1')).toBe('APPROVED');

    const match = await db
      .prepare(`SELECT status, score FROM reconciliation_matches
                WHERE transaction_candidate_id = ?1 AND payment_claim_id = ?2`)
      .bind('tx-1', 'claim-1')
      .first<{ status: string; score: number }>();
    expect(match).toEqual({ status: 'AUTO_VERIFIED', score: 1 });
  });

  it('compares amounts as numbers, not strings', async () => {
    // amount_irr and expected_amount_irr are bigint columns. If the driver
    // returned them as strings, `!==` would be true for two equal amounts and
    // every verification would fail with AMOUNT_MISMATCH.
    const res = await verifyMirzabotClaim(db, {
      claimId: 'claim-1',
      transactionId: 'tx-1',
      mode: 'ADMIN_APPROVED',
      actorEmail: 'sam@example.com',
    });
    expect(res).toMatchObject({ ok: true, expectedAmountIrr: AMOUNT });
  });

  it('refuses to settle one transaction against a second claim', async () => {
    await verifyMirzabotClaim(db, {
      claimId: 'claim-1', transactionId: 'tx-1', mode: 'AUTO_VERIFIED',
    });
    const second = await verifyMirzabotClaim(db, {
      claimId: 'claim-2', transactionId: 'tx-1', mode: 'AUTO_VERIFIED',
    });
    expect(second).toEqual({ ok: false, error: 'TRANSACTION_ALREADY_CONSUMED' });
    expect(await claimStatus('claim-2')).toBe('PENDING');
  });

  it('refuses to settle one claim against a second transaction', async () => {
    await verifyMirzabotClaim(db, {
      claimId: 'claim-1', transactionId: 'tx-1', mode: 'AUTO_VERIFIED',
    });
    const second = await verifyMirzabotClaim(db, {
      claimId: 'claim-1', transactionId: 'tx-2', mode: 'AUTO_VERIFIED',
    });
    expect(second).toEqual({ ok: false, error: 'CLAIM_ALREADY_VERIFIED' });
    expect(await txStatus('tx-2')).toBe('PARSED');
  });

  it('lets the database arbitrate a race between two concurrent approvals', async () => {
    // The reason the guarantee lives in a partial unique index rather than in
    // the pre-checks above it: both callers pass every check, then collide.
    const [a, b] = await Promise.all([
      verifyMirzabotClaim(db, {
        claimId: 'claim-1', transactionId: 'tx-1', mode: 'AUTO_VERIFIED',
      }),
      verifyMirzabotClaim(db, {
        claimId: 'claim-2', transactionId: 'tx-1', mode: 'ADMIN_APPROVED',
        actorEmail: 'sam@example.com',
      }),
    ]);

    const winners = [a, b].filter((r) => r.ok);
    expect(winners).toHaveLength(1);

    const settled = await db
      .prepare(`SELECT COUNT(*)::int AS n FROM reconciliation_matches
                WHERE transaction_candidate_id = 'tx-1'
                  AND status IN ('CONFIRMED','AUTO_VERIFIED')`)
      .first<number>('n');
    expect(settled).toBe(1);
  });

  it('rejects a transaction on a different account', async () => {
    await db
      .prepare(`UPDATE transaction_candidates SET financial_account_id = 'acct-b' WHERE id = ?1`)
      .bind('tx-1')
      .run();
    expect(
      await verifyMirzabotClaim(db, {
        claimId: 'claim-1', transactionId: 'tx-1', mode: 'AUTO_VERIFIED',
      }),
    ).toEqual({ ok: false, error: 'ACCOUNT_MISMATCH' });
  });

  it('rejects a mismatched amount rather than settling the difference', async () => {
    await db
      .prepare(`UPDATE transaction_candidates SET amount_irr = ?2 WHERE id = ?1`)
      .bind('tx-1', AMOUNT - 1)
      .run();
    expect(
      await verifyMirzabotClaim(db, {
        claimId: 'claim-1', transactionId: 'tx-1', mode: 'AUTO_VERIFIED',
      }),
    ).toEqual({ ok: false, error: 'AMOUNT_MISMATCH' });
  });

  it('rejects a transaction excluded from processing', async () => {
    await db
      .prepare(`UPDATE transaction_candidates SET processing_disposition = 'ADMIN_EXCLUDED'
                WHERE id = ?1`)
      .bind('tx-1')
      .run();
    expect(
      await verifyMirzabotClaim(db, {
        claimId: 'claim-1', transactionId: 'tx-1', mode: 'AUTO_VERIFIED',
      }),
    ).toEqual({ ok: false, error: 'TRANSACTION_NOT_ACTIONABLE' });
  });

  it('leaves nothing behind when it refuses', async () => {
    await db
      .prepare(`UPDATE transaction_candidates SET amount_irr = ?2 WHERE id = ?1`)
      .bind('tx-1', AMOUNT + 5)
      .run();
    await verifyMirzabotClaim(db, {
      claimId: 'claim-1', transactionId: 'tx-1', mode: 'AUTO_VERIFIED',
    });

    const matches = await db
      .prepare(`SELECT COUNT(*)::int AS n FROM reconciliation_matches`)
      .first<number>('n');
    expect(matches).toBe(0);
    expect(await claimStatus('claim-1')).toBe('PENDING');
    expect(await txStatus('tx-1')).toBe('PARSED');
  });
});
