/**
 * Fulfilment without evidence, against a real Postgres.
 *
 * ## Why not a fake db
 *
 * Because there is nothing here for a fake to prove. The exactly-once
 * guarantee of `fulfilMirzabotClaimWithoutPayment` is three database facts —
 * the UPDATE's `status IN (…) AND fulfilled_at IS NULL`, the notice id
 * colliding with itself on the primary key, and both of them inside one
 * `batch()` — and a mock would only assert that this file remembers what the
 * source says. CLAUDE.md rule 6.
 *
 * ## What «delivered twice» would look like
 *
 * Two rows in `audit_logs` for one claim, or a second `webhook_deliveries`
 * notice. Both are counted from the tables rather than read off a return
 * value, because a function can answer `ok` for the wrong reason and a row
 * cannot. The race below is two real calls against one row, not two calls that
 * agree to take turns.
 *
 * Needs DATABASE_URL with the schema applied (migration `0043`).
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresD1 } from '@shikoo/db';
import { MIRZABOT_SOURCE } from '@shikoo/contracts';
import {
  fulfilMirzabotClaimWithoutPayment,
  fulfilmentEventId,
} from '../../src/fulfilWithoutPayment.js';

const { db, pool } = createPostgresD1();

afterAll(async () => {
  await pool.end();
});

const NOW = 1_786_000_000_000;
const ACTOR = 'sam@example.com';
const REASON = 'the relay is down and the customer has waited an hour';
const AMOUNT = 250_000;

let seq = 0;

async function makeClaim(
  opts: { status?: string; source?: string; suspect?: string | null } = {},
): Promise<{ id: string; externalOrderId: string }> {
  seq += 1;
  const id = `claim-${seq}`;
  const externalOrderId = `mirzabot:test:${seq}`;
  await db
    .prepare(
      `INSERT INTO payment_claims
         (id, external_order_id, customer_reference, expected_amount_irr, submitted_at,
          source_system, metadata_json, suspect_reason, status, created_at, updated_at)
       VALUES (?1, ?2, 'tg-1', ?3, ?4, ?5, '{}', ?6, ?7, ?4, ?4)`,
    )
    .bind(
      id,
      externalOrderId,
      AMOUNT,
      NOW,
      opts.source ?? MIRZABOT_SOURCE,
      opts.suspect ?? null,
      opts.status ?? 'PENDING',
    )
    .run();
  return { id, externalOrderId };
}

async function claimRow(id: string) {
  return await db
    .prepare(
      `SELECT status, fulfilment_mode, fulfilled_at, fulfilled_by, fulfilment_reason,
              suspect_reason, reconciled_at, updated_at
         FROM payment_claims WHERE id = ?1`,
    )
    .bind(id)
    .first<{
      status: string;
      fulfilment_mode: string | null;
      fulfilled_at: number | null;
      fulfilled_by: string | null;
      fulfilment_reason: string | null;
      suspect_reason: string | null;
      reconciled_at: number | null;
      updated_at: number;
    }>();
}

async function auditRows(claimId: string) {
  const res = await db
    .prepare(
      `SELECT action, actor_email, actor_role, before_json, after_json, reason, request_id
         FROM audit_logs
        WHERE entity_type = 'CLAIM' AND entity_id = ?1
        ORDER BY id`,
    )
    .bind(claimId)
    .all<{
      action: string;
      actor_email: string | null;
      actor_role: string;
      before_json: string | null;
      after_json: string | null;
      reason: string | null;
      request_id: string | null;
    }>();
  return res.results;
}

async function notices() {
  const res = await db
    .prepare(
      `SELECT id, event_type, status, next_attempt_at, attempt_count, payload_json
         FROM webhook_deliveries ORDER BY id`,
    )
    .all<{
      id: string;
      event_type: string;
      status: string;
      next_attempt_at: number | null;
      attempt_count: number;
      payload_json: string;
    }>();
  return res.results;
}

beforeEach(async () => {
  await db
    .prepare(
      `TRUNCATE payment_claims, audit_logs, webhook_deliveries RESTART IDENTITY CASCADE`,
    )
    .run();
});

describe('fulfilmentEventId', () => {
  it('is derived from the claim and nothing else, so every retry produces it again', () => {
    // There is no transaction to mix in — that is the whole point — so the same
    // claim always names the same notice, whoever asks and however often.
    expect(fulfilmentEventId('claim-1')).toBe('fulfilled-claim-1');
    expect(fulfilmentEventId('claim-1')).toBe(fulfilmentEventId('claim-1'));
    expect(fulfilmentEventId('claim-2')).not.toBe(fulfilmentEventId('claim-1'));
  });
});

describe('a waiting claim is delivered, and is not called verified', () => {
  it('moves to FULFILLED_UNRECONCILED and records who decided and why', async () => {
    const { id, externalOrderId } = await makeClaim();

    const res = await fulfilMirzabotClaimWithoutPayment(db, {
      claimId: id,
      actorEmail: ACTOR,
      actorRole: 'ADMIN',
      reason: `  ${REASON}  `,
      mode: 'MANUAL',
      requestId: 'req-1',
      now: NOW,
    });

    expect(res).toEqual({
      ok: true,
      claimId: id,
      mode: 'MANUAL',
      already: false,
      externalOrderId,
      expectedAmountIrr: AMOUNT,
    });

    const row = await claimRow(id);
    // Not VERIFIED. Every revenue query in the app filters on that word, and
    // nobody has evidence this money arrived.
    expect(row?.status).toBe('FULFILLED_UNRECONCILED');
    expect(row?.fulfilment_mode).toBe('MANUAL');
    expect(row?.fulfilled_at).toBe(NOW);
    expect(row?.updated_at).toBe(NOW);
    expect(row?.fulfilled_by).toBe(ACTOR);
    expect(row?.fulfilment_reason).toBe(REASON);
    // Still owed an explanation: the reconciliation queue is `fulfilled_at IS
    // NOT NULL AND reconciled_at IS NULL`.
    expect(row?.reconciled_at).toBeNull();

    const audit = await auditRows(id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'claim.manual_fulfilled',
      actor_email: ACTOR,
      actor_role: 'ADMIN',
      reason: REASON,
      request_id: 'req-1',
    });
    // The status it came FROM, taken from the UPDATE's own RETURNING.
    expect(JSON.parse(audit[0]!.before_json!)).toEqual({ status: 'PENDING' });
    expect(JSON.parse(audit[0]!.after_json!)).toEqual({
      status: 'FULFILLED_UNRECONCILED',
      fulfilmentMode: 'MANUAL',
    });
  });

  it('a MATCH_SUGGESTED claim is eligible, and its suspicion is cleared', async () => {
    const { id } = await makeClaim({ status: 'MATCH_SUGGESTED', suspect: 'amount mismatch' });

    const res = await fulfilMirzabotClaimWithoutPayment(db, {
      claimId: id,
      actorEmail: ACTOR,
      actorRole: 'REVIEWER',
      reason: REASON,
      mode: 'MANUAL',
      now: NOW,
    });

    expect(res.ok).toBe(true);
    const row = await claimRow(id);
    expect(row?.status).toBe('FULFILLED_UNRECONCILED');
    expect(row?.suspect_reason).toBeNull();
    expect(JSON.parse((await auditRows(id))[0]!.before_json!)).toEqual({
      status: 'MATCH_SUGGESTED',
    });
  });

  it('Continuity is a different action in the log, because it is a different decision', async () => {
    const { id } = await makeClaim();

    const res = await fulfilMirzabotClaimWithoutPayment(db, {
      claimId: id,
      actorEmail: ACTOR,
      actorRole: 'ADMIN',
      reason: REASON,
      mode: 'CONTINUITY',
      now: NOW,
    });

    expect(res.ok && res.mode).toBe('CONTINUITY');
    expect((await claimRow(id))?.fulfilment_mode).toBe('CONTINUITY');
    expect((await auditRows(id))[0]?.action).toBe('claim.continuity_fulfilled');
  });

  it('a nullable request id is stored as null rather than as a string', async () => {
    const { id } = await makeClaim();
    await fulfilMirzabotClaimWithoutPayment(db, {
      claimId: id,
      actorEmail: ACTOR,
      actorRole: 'ADMIN',
      reason: REASON,
      mode: 'MANUAL',
      now: NOW,
    });
    expect((await auditRows(id))[0]?.request_id).toBeNull();
  });
});

describe('asking twice', () => {
  it('the second call changes nothing and is still a yes', async () => {
    const { id } = await makeClaim();
    const args = {
      claimId: id,
      actorEmail: ACTOR,
      actorRole: 'ADMIN',
      reason: REASON,
      mode: 'MANUAL' as const,
      now: NOW,
    };

    const first = await fulfilMirzabotClaimWithoutPayment(db, args);
    const second = await fulfilMirzabotClaimWithoutPayment(db, { ...args, now: NOW + 5_000 });

    expect(first.ok && first.already).toBe(false);
    // A retry is a success, not a conflict: the caller asked for the claim to be
    // fulfilled and it is.
    expect(second.ok && second.already).toBe(true);
    expect(await auditRows(id)).toHaveLength(1);
    // The later clock did not overwrite the moment it actually happened.
    expect((await claimRow(id))?.fulfilled_at).toBe(NOW);
  });

  it('a manual click after Continuity is told CONTINUITY, not MANUAL', async () => {
    const { id } = await makeClaim();
    await fulfilMirzabotClaimWithoutPayment(db, {
      claimId: id,
      actorEmail: ACTOR,
      actorRole: 'ADMIN',
      reason: REASON,
      mode: 'CONTINUITY',
      now: NOW,
    });

    const later = await fulfilMirzabotClaimWithoutPayment(db, {
      claimId: id,
      actorEmail: 'other@example.com',
      actorRole: 'REVIEWER',
      reason: REASON,
      mode: 'MANUAL',
      now: NOW + 1_000,
    });

    // The panel prints this word to explain who decided, and the answer is
    // whoever was first — not whoever asked last.
    expect(later.ok && later.mode).toBe('CONTINUITY');
    expect(later.ok && later.already).toBe(true);
    expect(await auditRows(id)).toHaveLength(1);
  });
});

describe('refusals write nothing at all', () => {
  it('refuses a fulfilment nobody explained', async () => {
    const { id } = await makeClaim();
    for (const reason of ['', '   ', ' ab ']) {
      const res = await fulfilMirzabotClaimWithoutPayment(db, {
        claimId: id,
        actorEmail: ACTOR,
        actorRole: 'ADMIN',
        reason,
        mode: 'MANUAL',
        now: NOW,
      });
      expect(res).toEqual({ ok: false, error: 'REASON_REQUIRED' });
    }
    expect((await claimRow(id))?.status).toBe('PENDING');
    expect(await auditRows(id)).toHaveLength(0);
  });

  it('404s a claim that does not exist', async () => {
    const res = await fulfilMirzabotClaimWithoutPayment(db, {
      claimId: 'no-such-claim',
      actorEmail: ACTOR,
      actorRole: 'ADMIN',
      reason: REASON,
      mode: 'MANUAL',
      now: NOW,
    });
    expect(res).toEqual({ ok: false, error: 'CLAIM_NOT_FOUND' });
  });

  it('will not reach across into another source system', async () => {
    // This is the Mirzabot fulfilment. A claim that belongs to something else
    // is not merely ineligible, it is not this function's row to touch.
    const { id } = await makeClaim({ source: 'HUB' });
    const res = await fulfilMirzabotClaimWithoutPayment(db, {
      claimId: id,
      actorEmail: ACTOR,
      actorRole: 'ADMIN',
      reason: REASON,
      mode: 'MANUAL',
      now: NOW,
    });
    expect(res).toEqual({ ok: false, error: 'CLAIM_NOT_FOUND' });
    expect((await claimRow(id))?.status).toBe('PENDING');
    expect(await auditRows(id)).toHaveLength(0);
  });

  it('refuses a claim the bank already confirmed', async () => {
    const { id } = await makeClaim({ status: 'VERIFIED' });
    const res = await fulfilMirzabotClaimWithoutPayment(db, {
      claimId: id,
      actorEmail: ACTOR,
      actorRole: 'ADMIN',
      reason: REASON,
      mode: 'MANUAL',
      now: NOW,
    });
    expect(res).toEqual({ ok: false, error: 'CLAIM_ALREADY_VERIFIED' });
    expect((await claimRow(id))?.status).toBe('VERIFIED');
    expect(await auditRows(id)).toHaveLength(0);
  });

  it('refuses a claim that is already finished with', async () => {
    for (const status of ['REJECTED', 'FAKE_RECEIPT', 'EXPIRED']) {
      const { id } = await makeClaim({ status });
      const res = await fulfilMirzabotClaimWithoutPayment(db, {
        claimId: id,
        actorEmail: ACTOR,
        actorRole: 'ADMIN',
        reason: REASON,
        mode: 'MANUAL',
        now: NOW,
      });
      expect(res).toEqual({ ok: false, error: 'CLAIM_NOT_ELIGIBLE' });
      expect((await claimRow(id))?.status).toBe(status);
      expect(await auditRows(id)).toHaveLength(0);
    }
  });
});

describe('the legacy bot is told once, or not at all', () => {
  it('enqueues one notice carrying no transaction, because there is none', async () => {
    const { id, externalOrderId } = await makeClaim();

    await fulfilMirzabotClaimWithoutPayment(db, {
      claimId: id,
      actorEmail: ACTOR,
      actorRole: 'ADMIN',
      reason: REASON,
      mode: 'MANUAL',
      enqueueWebhook: true,
      now: NOW,
    });

    const rows = await notices();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: fulfilmentEventId(id),
      event_type: 'PAYMENT_VERIFIED',
      status: 'PENDING',
      attempt_count: 0,
      next_attempt_at: NOW,
    });
    expect(JSON.parse(rows[0]!.payload_json)).toEqual({
      eventId: fulfilmentEventId(id),
      type: 'payment.verified',
      externalOrderId,
      mirzabotOrderId: externalOrderId.replace(/^mirzabot:test:/, ''),
      claimId: id,
      matchId: null,
      transactionId: null,
      expectedAmountIrr: AMOUNT,
      matchedAmountIrr: null,
      verificationMode: 'MANUAL_FULFILMENT',
      verifiedAt: NOW,
    });
  });

  it('says CONTINUITY when that is what happened', async () => {
    const { id } = await makeClaim();
    await fulfilMirzabotClaimWithoutPayment(db, {
      claimId: id,
      actorEmail: ACTOR,
      actorRole: 'ADMIN',
      reason: REASON,
      mode: 'CONTINUITY',
      enqueueWebhook: true,
      now: NOW,
    });
    expect(JSON.parse((await notices())[0]!.payload_json).verificationMode).toBe('CONTINUITY');
  });

  it('a retry does not ask the shop to deliver twice', async () => {
    const { id } = await makeClaim();
    const args = {
      claimId: id,
      actorEmail: ACTOR,
      actorRole: 'ADMIN',
      reason: REASON,
      mode: 'MANUAL' as const,
      enqueueWebhook: true,
      now: NOW,
    };
    await fulfilMirzabotClaimWithoutPayment(db, args);
    await fulfilMirzabotClaimWithoutPayment(db, args);
    expect(await notices()).toHaveLength(1);
  });

  it('stays out of the way when nobody asked', async () => {
    const { id } = await makeClaim();
    await fulfilMirzabotClaimWithoutPayment(db, {
      claimId: id,
      actorEmail: ACTOR,
      actorRole: 'ADMIN',
      reason: REASON,
      mode: 'MANUAL',
      now: NOW,
    });
    expect(await notices()).toEqual([]);
  });
});

/**
 * How many backends are stuck waiting for a lock in this database.
 *
 * The gate below needs to know that both writers have arrived at the UPDATE,
 * and a fixed sleep would either be too short on a loaded runner or waste time
 * on every green run.
 */
async function blockedWriters(): Promise<number> {
  const r = await db
    .prepare(
      `SELECT COUNT(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database()
          AND state = 'active'
          AND wait_event_type = 'Lock'`,
    )
    .first<{ n: number }>();
  return r?.n ?? 0;
}

async function waitForBlockedWriters(want: number): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if ((await blockedWriters()) >= want) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`only ${await blockedWriters()} writers reached the UPDATE, wanted ${want}`);
}

describe('exactly once, under an actual race', () => {
  it('two operators pressing together deliver once and audit once', async () => {
    const { id } = await makeClaim();

    /*
     * The lock is the point of this test, and it is here because the obvious
     * version of it proved nothing.
     *
     * `Promise.all` over two calls does NOT reliably produce the race this is
     * named after. Each call reads the claim before it writes, so the second
     * one usually finds `fulfilled_at` already set and returns at that early
     * check — the UPDATE's guards are never asked anything. Removing BOTH of
     * them (`status IN (…)` and `fulfilled_at IS NULL`) left the naive version
     * of this test green, which is the exact shape CLAUDE.md rule 6 is about:
     * it agreed with the code instead of testing it.
     *
     * So the row is pinned by a third connection until both callers have read
     * it as PENDING and queued their UPDATE behind the lock. Releasing it puts
     * both writes in flight against a row only one of them can still match.
     */
    const gate = await pool.connect();
    let a: Awaited<ReturnType<typeof fulfilMirzabotClaimWithoutPayment>>;
    let b: typeof a;
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT id FROM payment_claims WHERE id = $1 FOR UPDATE', [id]);

      const racing = Promise.all([
        fulfilMirzabotClaimWithoutPayment(db, {
          claimId: id,
          actorEmail: ACTOR,
          actorRole: 'ADMIN',
          reason: REASON,
          mode: 'MANUAL',
          enqueueWebhook: true,
          now: NOW,
        }),
        fulfilMirzabotClaimWithoutPayment(db, {
          claimId: id,
          actorEmail: 'other@example.com',
          actorRole: 'REVIEWER',
          reason: REASON,
          mode: 'MANUAL',
          enqueueWebhook: true,
          now: NOW,
        }),
      ]);

      await waitForBlockedWriters(2);
      await gate.query('ROLLBACK');
      [a, b] = await racing;
    } finally {
      gate.release();
    }

    // The tables first, because they are the evidence. The loser's UPDATE
    // matched nothing, and because the audit INSERT SELECTs from that UPDATE's
    // own RETURNING, it wrote nothing either — one delivery, one audit row, one
    // notice, whatever either call went on to answer.
    expect(await auditRows(id)).toHaveLength(1);
    expect(await notices()).toHaveLength(1);

    // Both callers are told yes — the claim they asked about is fulfilled.
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // And exactly one of them is told it was the one that did it.
    expect([a.ok && a.already, b.ok && b.already].sort()).toEqual([false, true]);

    const row = await claimRow(id);
    expect(row?.status).toBe('FULFILLED_UNRECONCILED');
    // One operator owns the delivery, and it is whichever one the database let
    // through — not the last to answer.
    expect([ACTOR, 'other@example.com']).toContain(row?.fulfilled_by);
  });
});
