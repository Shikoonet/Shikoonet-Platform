/**
 * Put a delivery that failed back into the queue that already knows how to do it.
 *
 * ## Why this exists
 *
 * `provisionPaidOrders` is a durable outbox: PAID is «owed», PROVISIONING is
 * «somebody is on it», COMPLETED and FAILED are terminal. `reclaimStalled`
 * rescues an order abandoned mid-flight, and the sweep re-reads PAID for ever,
 * so a panel that is briefly down costs nothing.
 *
 * FAILED is the one state with no way out. `fail()` writes it for the failures
 * that waiting cannot fix — a panel with no credentials, a plan whose provider
 * was deleted — and its own comment says why that is right: «Configuration
 * cannot fix itself, so it goes to a person instead.» What was missing is the
 * second half of that sentence. The person had nowhere to go: no sweep reads
 * FAILED, so once an order landed there the customer had paid and no operator
 * action existed that could serve them.
 *
 * On 2026-09-02 that cost a real staging purchase. Order `7aba76bc57` was paid,
 * approved by hand, and failed on a panel whose credentials had never been set
 * in that environment. The money was preserved and the customer was told so;
 * the order then sat FAILED with no way back.
 *
 * ## Why this is one statement
 *
 * The same reason `fulfilWithoutPayment.ts` is: the audit row is SELECTed *from*
 * the UPDATE's own RETURNING, so it cannot describe a transition that did not
 * happen. Two operators double-clicking produce one requeue and one audit row,
 * and the loser writes nothing at all — decided by the database, not by reading
 * a row first and hoping it does not move.
 *
 * ## What makes a retry safe
 *
 * Nothing here delivers anything. It moves the order back to PAID and lets the
 * existing sweep do the work, which is what keeps exactly-once intact:
 *
 *   - the sweep claims with `UPDATE … WHERE id = ?1 AND status = 'PAID'`, so
 *     only one worker ever owns an attempt;
 *   - `complete()` is guarded on PROVISIONING and raises `LostTheClaim` when it
 *     changes no row, rolling the loser's subscription write back;
 *   - `idx_subscriptions_one_per_order` (migration 0027) is UNIQUE on
 *     `order_id`, so a second entitlement is refused by the schema rather than
 *     by anybody's care;
 *   - the refund ledger row is keyed `order:<id>:refund`, so a refund cannot
 *     happen twice either.
 *
 * The idempotency key is the order's own `public_id` and its FAILED state — not
 * a retry id minted per click. Clicking twice is the same request twice, and the
 * second one is told the truth about what the first did.
 *
 * ## The one thing a retry must never do
 *
 * Resurrect an order whose money already went back. `fail()` refunds wallet
 * credit; card-to-card money stays in the bank and is a person's decision. An
 * order that was refunded and then re-delivered is a service given away, so the
 * `NOT EXISTS` below is part of the guard and not a nicety.
 */

import type { D1Database } from '@shikoo/database';

/** What happened, from the caller's point of view. */
export type RetryOutcome =
  /** This call moved the order back into the queue. */
  | 'QUEUED'
  /** The service is already delivered. A repeat click, and not an error. */
  | 'ALREADY_DELIVERED'
  /** Already queued or already being worked on — by an earlier click or the sweep. */
  | 'IN_PROGRESS'
  /** Terminal: the money went back, so delivering now would be giving it away. */
  | 'REFUNDED'
  /** No order with that number. */
  | 'NOT_FOUND';

export interface RetryProvisioningArgs {
  orderPublicId: string;
  actorEmail: string;
  actorRole: string;
  requestId?: string | null;
  now?: number;
}

export interface RetryProvisioningResult {
  outcome: RetryOutcome;
  orderPublicId: string;
  /** The reason the last attempt failed, for the operator to read. Null once cleared. */
  failureReason: string | null;
}

interface OrderRow {
  id: number;
  public_id: string;
  status: string;
  failure_reason: string | null;
  refunded: boolean;
}

async function read(db: D1Database, publicId: string): Promise<OrderRow | null> {
  return await db
    .prepare(
      `SELECT o.id, o.public_id, o.status, o.failure_reason,
              EXISTS (SELECT 1 FROM wallet_entries w
                       WHERE w.order_id = o.id AND w.kind = 'REFUND') AS refunded
         FROM orders o WHERE o.public_id = ?1`,
    )
    .bind(publicId)
    .first<OrderRow>();
}

/** How a row that is not being requeued should be described. */
function explain(row: OrderRow | null, publicId: string): RetryProvisioningResult {
  if (row === null) return { outcome: 'NOT_FOUND', orderPublicId: publicId, failureReason: null };
  const base = { orderPublicId: row.public_id, failureReason: row.failure_reason };
  if (row.status === 'COMPLETED') return { ...base, outcome: 'ALREADY_DELIVERED' };
  if (row.status === 'PAID' || row.status === 'PROVISIONING')
    return { ...base, outcome: 'IN_PROGRESS' };
  // FAILED and still here means the guard that refused it was the refund one.
  if (row.status === 'FAILED' && row.refunded) return { ...base, outcome: 'REFUNDED' };
  return { ...base, outcome: 'NOT_FOUND' };
}

export async function retryOrderProvisioning(
  db: D1Database,
  args: RetryProvisioningArgs,
): Promise<RetryProvisioningResult> {
  const now = args.now ?? Date.now();

  // Read first only to give a good answer and to carry the previous reason into
  // the audit row. The write below is what actually decides — anything read here
  // can change before it runs.
  const before = await read(db, args.orderPublicId);
  if (before === null)
    return { outcome: 'NOT_FOUND', orderPublicId: args.orderPublicId, failureReason: null };

  const moved = await db
    .prepare(
      `WITH requeued AS (
         UPDATE orders AS o
            SET status = 'PAID', failure_reason = NULL, updated_at = now()
          WHERE o.public_id = ?1
            AND o.status = 'FAILED'
            AND NOT EXISTS (SELECT 1 FROM wallet_entries w
                             WHERE w.order_id = o.id AND w.kind = 'REFUND')
         RETURNING o.id, o.public_id
       ),
       -- The delivery outbox dedupes on one key per order, and the failure
       -- message already holds it. Left alone, the «your service is ready»
       -- message this retry exists to produce would be silently swallowed by
       -- ON CONFLICT (dedupe_key) DO NOTHING, and the customer would be served
       -- without ever being told. The old notice keeps its row and its history;
       -- only its key steps aside, and it does so only for an order this
       -- statement actually moved.
       superseded AS (
         UPDATE bot_notifications AS n
            SET dedupe_key = n.dedupe_key || ':attempt:' || n.id::text
           FROM requeued r
          WHERE n.dedupe_key = 'provision:' || r.public_id
         RETURNING n.id
       )
       INSERT INTO audit_logs
         (id, actor_email, actor_role, action, entity_type, entity_id,
          before_json, after_json, reason, request_id, created_at)
       SELECT ?2, ?3, ?4, 'order.provisioning_retried', 'ORDER', r.public_id,
              json_build_object('status', 'FAILED', 'failureReason', ?5::text)::text,
              json_build_object('status', 'PAID')::text,
              ?6, ?7, ?8
         FROM requeued r`,
    )
    .bind(
      args.orderPublicId,
      crypto.randomUUID(),
      args.actorEmail,
      args.actorRole,
      before.failure_reason,
      'operator asked for the preparation to be tried again',
      args.requestId ?? null,
      now,
    )
    .run();

  // The audit INSERT's row count, which by construction is the UPDATE's.
  if ((moved.meta.changes ?? 0) === 0) return explain(await read(db, args.orderPublicId), args.orderPublicId);

  return {
    outcome: 'QUEUED',
    orderPublicId: before.public_id,
    failureReason: before.failure_reason,
  };
}
