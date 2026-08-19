/**
 * Telling the legacy bot that a payment is good, and not losing that fact.
 *
 * The notice is enqueued into `webhook_deliveries` inside the same transaction
 * that verifies the claim (see `verifyMirzabotClaim`), so by the time anything
 * here runs the intent is already durable. This file is only the courier: it
 * takes rows that are due, tries them, and writes down what happened. A crash
 * at any point costs a retry, never an order.
 *
 * The table has been in the schema since migration 0004 with exactly these
 * columns — `attempt_count`, `next_attempt_at`, PENDING/DELIVERED/FAILED/DEAD —
 * and nothing had ever written a row to it.
 */

import type { D1Database } from '@shikoo/database';
import type { MirzabotVerifiedWebhook } from '@shikoo/contracts';
import { MIRZABOT_CLAIMS_PATH } from '@shikoo/contracts';

export interface WebhookEnv {
  MIRZABOT_WEBHOOK_URL?: string;
  MIRZABOT_INTEGRATION_HMAC_SECRET?: string;
  MIRZABOT_INTEGRATION_ID?: string;
  AUTO_FULFILLMENT_ENABLED?: string;
}

/**
 * How long one delivery attempt may take.
 *
 * `fetch` has no timeout of its own. Without this a legacy bot that accepts the
 * connection and then stops talking holds the matcher open for as long as the
 * OS allows — and the matcher runs inside the request that ingests a bank SMS,
 * so the stall is paid by the next customer, not by us.
 */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/** Attempts before a notice stops being retried and starts needing a human. */
export const WEBHOOK_MAX_ATTEMPTS = 8;

/**
 * How long a claimed row stays invisible to other sweepers.
 *
 * Comfortably longer than `WEBHOOK_TIMEOUT_MS` so a slow-but-alive attempt is
 * never delivered twice, and short enough that a sweeper killed mid-attempt
 * gives the row back within a minute rather than at the next backoff step.
 */
export const WEBHOOK_LEASE_MS = 60_000;

/**
 * Backoff, doubling from a minute and capped at an hour.
 *
 * The failures this retries through are outages of somebody else's bot, which
 * last minutes rather than milliseconds; retrying faster would just spend the
 * attempt budget before anyone can fix anything.
 */
export function nextAttemptDelayMs(attemptCount: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attemptCount - 1), 3_600_000);
}

export async function deliverMirzabotVerifiedWebhook(
  env: WebhookEnv,
  payload: MirzabotVerifiedWebhook,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  // Not `ok: true`, which is what this said until 2026-08-19. Nothing was sent,
  // and the caller settles an ok outcome as DELIVERED — so with the flag off a
  // notice would have been marked delivered and never sent to anyone. It is
  // unreachable today because `flushWebhookDeliveries` returns before calling
  // this, but a guard that lies when it is reached is not a guard.
  if (env.AUTO_FULFILLMENT_ENABLED !== 'true') return { ok: false, error: 'fulfilment_paused' };
  const url = env.MIRZABOT_WEBHOOK_URL;
  const secret = env.MIRZABOT_INTEGRATION_HMAC_SECRET;
  const integrationId = env.MIRZABOT_INTEGRATION_ID ?? 'mirzabot-test';
  if (!url || !secret) return { ok: false, error: 'webhook_not_configured' };

  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000).toString();
  const bodyHash = await sha256Hex(body);
  const signPayload = `${ts}\nPOST\n/api/v1/integrations/payment-hub/verified\n${bodyHash}`;
  const signature = `sha256=${await hmacSha256Hex(secret, signPayload)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Integration-Id': integrationId,
        'X-Event-Id': payload.eventId,
        'X-Timestamp': ts,
        'X-Signature': signature,
      },
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch (err) {
    // A refused connection, a DNS failure and a timeout all land here, and all
    // three are worth retrying — which is the whole reason this is caught
    // rather than allowed to abort the verification that already committed.
    return { ok: false, error: err instanceof Error ? err.name : 'fetch_failed' };
  }
  if (!res.ok) return { ok: false, error: `http_${res.status}`, status: res.status };
  return { ok: true };
}

interface DeliveryRow {
  id: string;
  payload_json: string;
  attempt_count: number;
}

export interface FlushResult {
  attempted: number;
  delivered: number;
  failed: number;
  dead: number;
}

/**
 * Try every notice that is due, and record the outcome of each.
 *
 * Called after the matcher runs, so the common case — the legacy bot is up —
 * is delivered within the same request that verified the payment and the
 * queue stays empty. The retries are what the queue is actually for, and they
 * are driven by `runScheduledSweep` on its timer rather than by the matcher,
 * because a retry that waits for the next customer to pay is not a retry.
 *
 * ## `AUTO_FULFILLMENT_ENABLED` is a pause, not a disable — deliberately
 *
 * The flag stops delivery here. It does NOT stop `verifyMirzabotClaim` from
 * enqueueing, so notices accumulate while it is off and are sent when it comes
 * back on. That is the intended meaning and it was checked rather than assumed:
 * the legacy receiver keys a flag file by `eventId` and short-circuits a repeat
 * (`payment_hub.php:227`), and `DirectPayment` reports `already_fulfilled` for
 * an order that was settled some other way in the meantime — which the same
 * function accepts as success. So a backlog arriving late is deduplicated at
 * the far end rather than delivering anything twice.
 *
 * The alternative — not enqueueing while paused — throws away the record that a
 * verified payment was never announced, and no amount of turning the flag back
 * on recovers it. Between "an order is announced late" and "an order is never
 * announced at all", late wins.
 *
 * The backlog also does not arrive as a burst: `limit` rows per sweep, one
 * sweep a minute.
 *
 * Rows are claimed by the same statement that reads them, and the claim is a
 * write: `next_attempt_at` moves out to a lease, so a row in flight is not due
 * and a second sweeper passes over it. **That lease is the whole guard.** A
 * plain `SELECT` would not have been one — outside an explicit transaction each
 * statement commits alone, so `SELECT ... FOR UPDATE` releases its lock before
 * the caller has read anything and both sweepers would deliver.
 *
 * `SKIP LOCKED` is here for throughput, not for correctness: it lets a second
 * sweeper move on to other rows rather than block on ones being claimed.
 * Removing it was tried on 2026-08-18 and no test noticed — which is the honest
 * measure of what it does. Removing the lease, by contrast, hangs the
 * concurrency test. Do not let the phrase in the SQL stand in as evidence for
 * the guarantee above it.
 *
 * A sweeper killed mid-attempt strands nothing: the lease expires by the clock
 * and the row is picked up again.
 */
export async function flushWebhookDeliveries(
  db: D1Database,
  env: WebhookEnv,
  opts: { limit?: number; now?: number } = {},
): Promise<FlushResult> {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 20;
  const result: FlushResult = { attempted: 0, delivered: 0, failed: 0, dead: 0 };

  if (env.AUTO_FULFILLMENT_ENABLED !== 'true') return result;

  const { results } = await db
    .prepare(
      // `AS MATERIALIZED` is the fence that makes `limit` a limit.
      //
      // This was `WHERE id IN (SELECT … LIMIT ?2 …)`, and on 2026-08-19 a test
      // written for it returned EIGHT rows for a limit of three. A hand-run
      // probe of the same statement had returned three minutes earlier — same
      // SQL, same data, different plan — which is the whole point: the planner
      // may turn an uncorrelated subquery into a per-row SubPlan, and then the
      // limit bounds each execution instead of the batch. The bug was found
      // first in `claimBroadcastBatch`, where it meant one sweep claimed an
      // entire broadcast; here it means one sweep sends the whole outbox
      // ignoring `limit`, inside the request that ingests a bank SMS.
      //
      // A CTE marked MATERIALIZED is documented as an optimisation fence and is
      // evaluated exactly once regardless of the plan around it.
      `WITH due AS MATERIALIZED (
          SELECT id FROM webhook_deliveries
           WHERE status IN ('PENDING','FAILED')
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
           ORDER BY next_attempt_at NULLS FIRST
           LIMIT ?2
           FOR UPDATE SKIP LOCKED
        )
        UPDATE webhook_deliveries
           SET attempt_count = attempt_count + 1,
               last_attempt_at = ?1,
               next_attempt_at = ?1 + ?3
         WHERE id IN (SELECT id FROM due)
        RETURNING id, payload_json, attempt_count`,
    )
    .bind(now, limit, WEBHOOK_LEASE_MS)
    .all<DeliveryRow>();

  for (const row of results) {
    let payload: MirzabotVerifiedWebhook;
    try {
      payload = JSON.parse(row.payload_json) as MirzabotVerifiedWebhook;
    } catch {
      // Unparseable payload cannot become deliverable by waiting. Retrying it
      // would burn the budget and hide the rows that can still succeed.
      await settle(db, row.id, 'DEAD', now, 'unreadable_payload', null, null);
      result.dead += 1;
      continue;
    }

    result.attempted += 1;
    // Already incremented by the claiming UPDATE, so this is the attempt that
    // is about to happen — not the one before it.
    const attempt = row.attempt_count;
    const outcome = await deliverMirzabotVerifiedWebhook(env, payload);

    if (outcome.ok) {
      await settle(db, row.id, 'DELIVERED', now, null, 200, null);
      result.delivered += 1;
      continue;
    }

    if (attempt >= WEBHOOK_MAX_ATTEMPTS) {
      await settle(db, row.id, 'DEAD', now, outcome.error, outcome.status ?? null, null);
      result.dead += 1;
      continue;
    }

    await settle(
      db,
      row.id,
      'FAILED',
      now,
      outcome.error,
      outcome.status ?? null,
      now + nextAttemptDelayMs(attempt),
    );
    result.failed += 1;
  }

  return result;
}

/**
 * Write the outcome of one attempt, replacing the lease with a real verdict.
 *
 * `next_attempt_at` is set explicitly in every branch — including to NULL —
 * because the claim above pushed it out to a lease. Leaving it alone on a
 * terminal row would keep the lease as a phantom due date.
 */
async function settle(
  db: D1Database,
  id: string,
  status: 'DELIVERED' | 'FAILED' | 'DEAD',
  now: number,
  body: string | null,
  responseStatus: number | null,
  nextAttemptAt: number | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE webhook_deliveries
          SET status = ?2, last_attempt_at = ?3, last_response_body = ?4,
              last_response_status = ?5, next_attempt_at = ?6
        WHERE id = ?1`,
    )
    .bind(id, status, now, body, responseStatus, nextAttemptAt)
    .run();
}

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

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

export { MIRZABOT_CLAIMS_PATH };
