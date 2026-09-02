/**
 * A delivered order cannot be un-delivered by a side door.
 *
 * `FULFILLED_UNRECONCILED` means the customer is holding the product and the
 * bank has not spoken yet. `state.ts` gives it exactly one exit — `VERIFIED`,
 * which is reconciliation — and every route that writes a claim status asks
 * `assertTransitionClaim` before it does.
 *
 * Every route but one. `POST /api/v1/match/reject` asks
 * `assertTransitionMatch` about the MATCH and then writes the CLAIM with
 * `SQL.updateClaimStatus`, whose WHERE clause is `id = ?1` and nothing else. So
 * rejecting a still-suggested match against a claim that was fulfilled in the
 * meantime rewrites that claim to REJECTED — a delivered order, recorded as
 * refused, with `fulfilled_at` still set beside it.
 *
 * The sequence is ordinary, not contrived: the matcher suggests a candidate,
 * the operator decides not to wait and fulfils manually, and somebody then
 * clears the stale suggestion out of the queue.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv, resetHub } from './helpers/env.js';
import { app } from '../src/index.js';
import {
  fulfilMirzabotClaimWithoutPayment,
  type D1Database as DomainD1Database,
} from '@shikoo/domain';

const ADMIN = 'terminal-admin@example.com';
const db = baseEnv.DB as unknown as DomainD1Database;
const envAs = (email: string) => ({ ...baseEnv, TEST_ACCESS_USER: email });

async function makeUser(email: string, role: string): Promise<void> {
  await baseEnv.DB.prepare(
    `INSERT INTO access_users (id, email, role, active, created_at, updated_at)
     VALUES (?1, ?2, ?3, 1, ?4, ?4)
     ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, active = 1`,
  )
    .bind(crypto.randomUUID(), email, role, Date.now())
    .run();
}

/** A claim the matcher has suggested a candidate for, plus that match row. */
async function claimWithSuggestedMatch(): Promise<{ claimId: string; matchId: string }> {
  const now = Date.now();
  const accountId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO financial_accounts
       (id, display_name, bank_name, account_type, owner_label, active,
        parser_configuration, created_at, updated_at)
     VALUES (?1, 'terminal acct', 'MELLAT', 'ACCOUNT', NULL, 1, '{}', ?2, ?2)`,
  )
    .bind(accountId, now)
    .run();

  const deviceId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES (?1, ?3, 'terminal-fixture', 1, ?2, ?2)`,
  )
    .bind(deviceId, now, `dev-${deviceId.slice(0, 8)}`)
    .run();

  const smsId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO raw_sms_events
       (id, device_id, sender, normalized_body, body_sha256, app_checksum,
        sms_timestamp, received_at, classification, parser_status, created_at)
     VALUES (?1, ?2, 'BANK', 'credit', ?3, 'c', ?4, ?4, 'BANK_CREDIT', 'OK', ?4)`,
  )
    .bind(smsId, deviceId, smsId, now)
    .run();

  const txId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO transaction_candidates
       (id, raw_sms_event_id, financial_account_id, direction, amount_irr, status,
        processing_disposition, bank_timestamp, confidence, parser_id, parser_version,
        parser_evidence_json, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'CREDIT', 250000, 'MATCH_SUGGESTED', 'ACTIONABLE', ?4, 1.0,
             'test', 'v1', '{}', ?4, ?4)`,
  )
    .bind(txId, smsId, accountId, now)
    .run();

  const claimId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO payment_claims
       (id, external_order_id, customer_reference, expected_amount_irr,
        target_financial_account_id, submitted_at, source_system, metadata_json,
        status, created_at, updated_at)
     VALUES (?1, ?2, 'tg-1', 250000, ?3, ?4, 'MIRZABOT', '{}', 'MATCH_SUGGESTED', ?4, ?4)`,
  )
    .bind(claimId, `mirzabot:test:${claimId.slice(0, 8)}`, accountId, now)
    .run();

  const matchId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO reconciliation_matches
       (id, transaction_candidate_id, payment_claim_id, score, status,
        matching_reasons_json, mismatch_reasons_json, created_at, updated_at)
     VALUES (?1, ?2, ?3, 0.9, 'SUGGESTED', '[]', '[]', ?4, ?4)`,
  )
    .bind(matchId, txId, claimId, now)
    .run();

  return { claimId, matchId };
}

async function claimRow(id: string) {
  return await baseEnv.DB.prepare(
    `SELECT status, fulfilled_at, fulfilment_mode FROM payment_claims WHERE id = ?1`,
  )
    .bind(id)
    .first<{ status: string; fulfilled_at: number | null; fulfilment_mode: string | null }>();
}

function rejectMatch(matchId: string, reason = 'NO_BANK_TRANSACTION') {
  return new Request('https://x/api/v1/match/reject', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://x' },
    body: JSON.stringify({ matchId, reason }),
  });
}

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetHub();
  await makeUser(ADMIN, 'ADMIN');
});

describe('a fulfilled claim has exactly one exit', () => {
  it('the premise holds: the fixture really is fulfilled and really has a live match', async () => {
    // Asserted rather than assumed, because a fixture that quietly failed to
    // create the match row would make the test below pass by doing nothing.
    const { claimId, matchId } = await claimWithSuggestedMatch();
    const out = await fulfilMirzabotClaimWithoutPayment(db, {
      claimId,
      actorEmail: ADMIN,
      actorRole: 'ADMIN',
      reason: 'relay down, customer waiting',
      mode: 'MANUAL',
    });
    expect(out.ok).toBe(true);
    expect((await claimRow(claimId))?.status).toBe('FULFILLED_UNRECONCILED');
    const m = await baseEnv.DB.prepare(
      `SELECT status FROM reconciliation_matches WHERE id = ?1`,
    )
      .bind(matchId)
      .first<{ status: string }>();
    expect(m?.status).toBe('SUGGESTED');
  });

  it('rejecting a stale suggestion cannot mark the delivered claim REJECTED', async () => {
    const { claimId, matchId } = await claimWithSuggestedMatch();
    await fulfilMirzabotClaimWithoutPayment(db, {
      claimId,
      actorEmail: ADMIN,
      actorRole: 'ADMIN',
      reason: 'relay down, customer waiting',
      mode: 'MANUAL',
    });

    const res = await app.fetch(rejectMatch(matchId), envAs(ADMIN));
    expect(res.status).toBe(409);

    const row = await claimRow(claimId);
    // The customer is holding the product. Whatever happens to the suggestion,
    // the claim cannot come out of this saying the payment was refused.
    expect(row?.status).toBe('FULFILLED_UNRECONCILED');
    expect(row?.fulfilled_at).not.toBeNull();
  });

  it('nor FAKE_RECEIPT, which is the same door with a different reason', async () => {
    const { claimId, matchId } = await claimWithSuggestedMatch();
    await fulfilMirzabotClaimWithoutPayment(db, {
      claimId,
      actorEmail: ADMIN,
      actorRole: 'ADMIN',
      reason: 'relay down, customer waiting',
      mode: 'CONTINUITY',
    });

    const res = await app.fetch(rejectMatch(matchId, 'FAKE_RECEIPT'), envAs(ADMIN));
    expect(res.status).toBe(409);
    expect((await claimRow(claimId))?.status).toBe('FULFILLED_UNRECONCILED');
  });

  it('refusing the claim does not silently leave the match rejected either', async () => {
    // The two writes are one batch. If the claim write is refused, the match
    // must not have been rejected on its own — that would strand the queue in a
    // state neither operator asked for.
    const { claimId, matchId } = await claimWithSuggestedMatch();
    await fulfilMirzabotClaimWithoutPayment(db, {
      claimId,
      actorEmail: ADMIN,
      actorRole: 'ADMIN',
      reason: 'relay down, customer waiting',
      mode: 'MANUAL',
    });

    await app.fetch(rejectMatch(matchId), envAs(ADMIN));

    const m = await baseEnv.DB.prepare(
      `SELECT status FROM reconciliation_matches WHERE id = ?1`,
    )
      .bind(matchId)
      .first<{ status: string }>();
    expect(m?.status).toBe('SUGGESTED');
  });

  it('an ordinary suggested match on a live claim is still rejectable', async () => {
    // The guard must refuse the delivered case WITHOUT breaking the normal one,
    // which is the whole reason this route exists.
    const { claimId, matchId } = await claimWithSuggestedMatch();
    const res = await app.fetch(rejectMatch(matchId), envAs(ADMIN));
    expect(res.status).toBe(200);
    expect((await claimRow(claimId))?.status).toBe('REJECTED');
  });
});
