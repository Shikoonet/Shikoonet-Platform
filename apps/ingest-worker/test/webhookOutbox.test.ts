/**
 * The courier: what happens to a fulfilment notice after it is enqueued.
 *
 * `verifyMirzabotClaim` guarantees the notice exists (proved in
 * `packages/domain/test/integration/mirzabotVerify.pg.test.ts`). Everything
 * here is about not losing it afterwards: retrying a bot that is down, backing
 * off rather than hammering it, giving up loudly instead of silently, and never
 * asking it to fulfil one order twice.
 *
 * Needs DATABASE_URL (`pnpm sim:up`).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deliverMirzabotVerifiedWebhook,
  flushWebhookDeliveries,
  nextAttemptDelayMs,
  WEBHOOK_LEASE_MS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_TIMEOUT_MS,
  type WebhookEnv,
} from '../src/integrations/webhook.js';
import { runScheduledSweep } from '../src/index.js';
import { env, pool } from './helpers/env.js';

const NOW = 1_786_000_000_000;

const ON: WebhookEnv = {
  AUTO_FULFILLMENT_ENABLED: 'true',
  MIRZABOT_WEBHOOK_URL: 'https://legacy.example.com/api/v1/integrations/payment-hub/verified',
  MIRZABOT_INTEGRATION_HMAC_SECRET: 'test-secret',
  MIRZABOT_INTEGRATION_ID: 'mirzabot-test',
};

const db = env.DB;

async function enqueue(id: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const payload = {
    eventId: id,
    type: 'payment.verified',
    externalOrderId: `mirzabot:test:${id}`,
    mirzabotOrderId: id,
    claimId: `claim-${id}`,
    matchId: `match-${id}`,
    transactionId: `tx-${id}`,
    expectedAmountIrr: 1_000_000,
    matchedAmountIrr: 1_000_000,
    verificationMode: 'AUTO_VERIFIED',
    verifiedAt: NOW,
  };
  await db
    .prepare(
      `INSERT INTO webhook_deliveries
         (id, event_type, payload_json, attempt_count, status, next_attempt_at)
       VALUES (?1, 'PAYMENT_VERIFIED', ?2, ?3, ?4, ?5)`,
    )
    .bind(
      id,
      (overrides.payload_json as string) ?? JSON.stringify(payload),
      (overrides.attempt_count as number) ?? 0,
      (overrides.status as string) ?? 'PENDING',
      (overrides.next_attempt_at as number | null) ?? null,
    )
    .run();
}

async function row(id: string): Promise<{
  status: string;
  attempt_count: number;
  next_attempt_at: number | null;
  last_response_status: number | null;
  last_response_body: string | null;
}> {
  const r = await db
    .prepare(
      `SELECT status, attempt_count, next_attempt_at, last_response_status, last_response_body
         FROM webhook_deliveries WHERE id = ?1`,
    )
    .bind(id)
    .first<{
      status: string;
      attempt_count: number;
      next_attempt_at: number | null;
      last_response_status: number | null;
      last_response_body: string | null;
    }>();
  if (!r) throw new Error(`no delivery row ${id}`);
  return r;
}

beforeEach(async () => {
  await db.prepare(`DELETE FROM webhook_deliveries`).run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await pool.end();
});

describe('delivering a fulfilment notice', () => {
  it('marks a notice delivered and stops asking', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));
    await enqueue('n1');

    const res = await flushWebhookDeliveries(db, ON, { now: NOW });

    expect(res).toMatchObject({ attempted: 1, delivered: 1, failed: 0, dead: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const r = await row('n1');
    expect(r.status).toBe('DELIVERED');
    expect(r.attempt_count).toBe(1);
    // Explicitly cleared: the claim above pushed it out to a lease, and a
    // DELIVERED row with a future due date would be swept again for ever.
    expect(r.next_attempt_at).toBeNull();
  });

  it('keeps a notice and schedules a retry when the legacy bot is down', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 503 }));
    await enqueue('n2');

    const res = await flushWebhookDeliveries(db, ON, { now: NOW });

    expect(res).toMatchObject({ attempted: 1, delivered: 0, failed: 1, dead: 0 });
    const r = await row('n2');
    expect(r.status).toBe('FAILED');
    expect(r.attempt_count).toBe(1);
    expect(r.last_response_status).toBe(503);
    expect(r.next_attempt_at).toBe(NOW + nextAttemptDelayMs(1));
  });

  it('survives a network error rather than losing the notice', async () => {
    // A refused connection used to propagate out of the matcher. The claim was
    // already committed by then, so the throw only lost the notice.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await enqueue('n3');

    const res = await flushWebhookDeliveries(db, ON, { now: NOW });

    expect(res).toMatchObject({ failed: 1 });
    expect((await row('n3')).status).toBe('FAILED');
  });

  it('does not retry before the backoff has elapsed', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }));
    await enqueue('n4', { status: 'FAILED', attempt_count: 2, next_attempt_at: NOW + 10_000 });

    const res = await flushWebhookDeliveries(db, ON, { now: NOW });

    expect(res.attempted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await row('n4')).attempt_count).toBe(2);
  });

  it('gives up loudly after the last attempt instead of retrying for ever', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('gone', { status: 410 }));
    await enqueue('n5', { attempt_count: WEBHOOK_MAX_ATTEMPTS - 1 });

    const res = await flushWebhookDeliveries(db, ON, { now: NOW });

    expect(res).toMatchObject({ dead: 1, failed: 0 });
    const r = await row('n5');
    expect(r.status).toBe('DEAD');
    expect(r.attempt_count).toBe(WEBHOOK_MAX_ATTEMPTS);
    expect(r.next_attempt_at).toBeNull();
    expect(r.last_response_body).toBe('http_410');
  });

  it('does not wait for a payload it can never parse', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }));
    await enqueue('n6', { payload_json: 'not json' });

    const res = await flushWebhookDeliveries(db, ON, { now: NOW });

    expect(res).toMatchObject({ dead: 1, attempted: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await row('n6')).status).toBe('DEAD');
  });

  it('claims no more than the limit it was given', async () => {
    // Pinned after the same statement shape was found broken elsewhere on
    // 2026-08-19: `claimBroadcastBatch` wrote its claim as
    // `UPDATE … FROM (SELECT … LIMIT n)`, the planner re-executed that subquery
    // once per candidate row, and the limit bounded each re-execution instead
    // of the batch — one sweep took the whole queue.
    //
    // This one is written as a single-column `IN` on the primary key, which
    // does bound. Measured rather than argued, because "the planner will hash
    // it" is the kind of claim that is true until it is not.
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }));
    for (let i = 0; i < 8; i++) await enqueue(`lim${i}`);

    const res = await flushWebhookDeliveries(db, ON, { now: NOW, limit: 3 });

    expect(res.attempted).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const left = await db
      .prepare(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE status = 'PENDING'`)
      .first<{ n: number }>();
    expect(left?.n).toBe(5);
  });

  it('claims a row before delivering it, so a second sweeper skips it', async () => {
    // The lease. Two ingest processes sweep the same queue; the guard is that
    // claiming and reading are one statement, so the second finds nothing due.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      // While the first sweep is mid-flight, a second one must find nothing.
      const concurrent = await flushWebhookDeliveries(db, ON, { now: NOW });
      expect(concurrent.attempted).toBe(0);
      return new Response('', { status: 200 });
    });
    await enqueue('n7');

    const res = await flushWebhookDeliveries(db, ON, { now: NOW });
    expect(res).toMatchObject({ delivered: 1 });
  });

  it('hands a stranded row back after the lease, not after the backoff', async () => {
    // A sweeper killed mid-attempt leaves a claimed row behind. It has to
    // become due again on its own, or one crash strands an order permanently.
    await enqueue('n8', { attempt_count: 1, next_attempt_at: NOW + WEBHOOK_LEASE_MS });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }));

    expect((await flushWebhookDeliveries(db, ON, { now: NOW })).attempted).toBe(0);
    expect((await flushWebhookDeliveries(db, ON, { now: NOW + WEBHOOK_LEASE_MS })).attempted).toBe(
      1,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('touches nothing at all while auto-fulfilment is switched off', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await enqueue('n9');

    const res = await flushWebhookDeliveries(
      db,
      { ...ON, AUTO_FULFILLMENT_ENABLED: 'false' },
      { now: NOW },
    );

    expect(res).toEqual({ attempted: 0, delivered: 0, failed: 0, dead: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await row('n9')).status).toBe('PENDING');
  });

  it('gives one attempt a deadline', async () => {
    // `fetch` has no timeout of its own, and this sweep runs inside the request
    // that ingests a bank SMS.
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }));
    await enqueue('n10');

    await flushWebhookDeliveries(db, ON, { now: NOW });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(WEBHOOK_TIMEOUT_MS).toBeLessThan(WEBHOOK_LEASE_MS);
  });
});

describe('the scheduled sweep', () => {
  it('retries a due notice when no new claim ever arrives', async () => {
    // The outage this closes. The matcher was the only thing that flushed, and
    // `finalizeExpiredMirzabotWaits` returns without running it when no group is
    // due — so on a quiet night a notice that failed at 03:00 waited for the
    // next customer to pay before anyone tried again. What it is holding is a
    // paid order the legacy bot has not been told to fulfil.
    //
    // Nothing here creates a claim, a transaction or a payment: an empty
    // database is precisely the condition under which the bug appeared.
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }));
    await enqueue('sweep1', { status: 'FAILED', attempt_count: 1, next_attempt_at: NOW - 1 });

    await runScheduledSweep({ ...env, ...ON });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await row('sweep1')).status).toBe('DELIVERED');
  });

  it('leaves a paused notice alone, and says so by not sending it', async () => {
    // The flag is a pause, not a disable: the row stays PENDING and keeps its
    // attempt budget, so turning fulfilment back on delivers it rather than
    // finding it burnt or gone. See the note above `flushWebhookDeliveries`.
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await enqueue('sweep2', { next_attempt_at: NOW - 1 });

    await runScheduledSweep({ ...env, ...ON, AUTO_FULFILLMENT_ENABLED: 'false' });

    expect(fetchMock).not.toHaveBeenCalled();
    const after = await row('sweep2');
    expect(after.status).toBe('PENDING');
    expect(after.attempt_count).toBe(0);
  });

  it('never reports a notice delivered that was not sent', async () => {
    // `deliverMirzabotVerifiedWebhook` used to answer `ok` when fulfilment was
    // paused, and an ok outcome is settled as DELIVERED — a notice marked sent
    // that nobody ever received. Unreachable through `flushWebhookDeliveries`,
    // which returns first; asserted directly because the lie was in the guard.
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const out = await deliverMirzabotVerifiedWebhook({ ...ON, AUTO_FULFILLMENT_ENABLED: 'false' }, {
      eventId: 'e1',
    } as never);

    expect(out.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the backoff', () => {
  it('doubles from a minute and stops at an hour', () => {
    expect(nextAttemptDelayMs(1)).toBe(60_000);
    expect(nextAttemptDelayMs(2)).toBe(120_000);
    expect(nextAttemptDelayMs(3)).toBe(240_000);
    expect(nextAttemptDelayMs(WEBHOOK_MAX_ATTEMPTS)).toBe(3_600_000);
  });
});
