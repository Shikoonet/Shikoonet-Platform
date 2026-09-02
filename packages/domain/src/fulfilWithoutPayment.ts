/**
 * Deliver a purchase the bank has not confirmed, exactly once.
 *
 * ## Why this is not `verifyMirzabotClaimWithoutTransaction`
 *
 * That function still exists and still does its job: an operator resolving a
 * *suspect* claim asserts the payment really arrived and the row becomes
 * `VERIFIED`. This one makes the opposite assertion — nobody has evidence yet,
 * deliver anyway — and so it must not be spelled the same way. Every revenue
 * query in the app filters `status = 'VERIFIED'`; writing that word here would
 * move the shop's income figure on the strength of a screenshot.
 *
 * So this writes `FULFILLED_UNRECONCILED`, which means: the customer has the
 * product, and the money is still owed an explanation. `0043` adds the status
 * and the columns; `state.ts` gives it its one exit.
 *
 * ## Exactly once, and where that is actually enforced
 *
 * Not here, and not in the button. The guarantee is three database facts:
 *
 *   1. The UPDATE carries `status IN ('PENDING','MATCH_SUGGESTED') AND
 *      fulfilled_at IS NULL`. Two admins pressing together, a double click, or
 *      a client retry after a timeout all run the same statement; the first
 *      matches one row and the rest match none. `changes` is the answer, and it
 *      comes from Postgres, not from a variable in this process.
 *   2. The fulfilment notice's id is derived from the claim, so the insert
 *      collides with itself on the primary key instead of asking the shop to
 *      deliver twice. Same trick as `verifiedEventId`, same reason.
 *   3. Both are in one `batch()`, which is a real transaction — so a claim
 *      cannot be marked delivered while the notice that delivers it is lost,
 *      and the audit row cannot survive a fulfilment that rolled back.
 *
 * The race against the SMS matcher falls out of (1): if the matcher verified
 * first the status is already `VERIFIED` and this refuses; if this ran first
 * the matcher finds `FULFILLED_UNRECONCILED` and treats it as reconciliation,
 * which delivers nothing. See `mirzabotVerify.ts`.
 */

import type { D1Database } from '@shikoo/database';
import { MIRZABOT_SOURCE, type MirzabotVerifiedWebhook } from '@shikoo/contracts';

/** How a claim came to be delivered without evidence. */
export type FulfilmentMode = 'MANUAL' | 'CONTINUITY';

export type FulfilFailure =
  | 'CLAIM_NOT_FOUND'
  | 'CLAIM_NOT_ELIGIBLE'
  | 'CLAIM_ALREADY_VERIFIED'
  | 'REASON_REQUIRED';

export type FulfilResult =
  | {
      ok: true;
      claimId: string;
      mode: FulfilmentMode;
      /**
       * True when this call found the work already done and changed nothing.
       *
       * A retry is a success, not a conflict: the caller asked for the claim to
       * be fulfilled and it is. Returning 409 here would teach the panel to show
       * an error for the one case that is completely fine, and would make a
       * timed-out client retry look like a failure to the operator.
       */
      already: boolean;
      externalOrderId: string;
      expectedAmountIrr: number;
    }
  | { ok: false; error: FulfilFailure };

/**
 * The id the fulfilment notice gets, and why it is safe to write twice.
 *
 * Derived from the claim alone — there is no transaction, which is the whole
 * point — so every retry of every kind produces the same primary key and the
 * legacy bot is asked to fulfil one order once.
 */
export function fulfilmentEventId(claimId: string): string {
  return `fulfilled-${claimId}`;
}

const ELIGIBLE = new Set(['PENDING', 'MATCH_SUGGESTED']);

interface Row {
  id: string;
  status: string;
  source_system: string;
  external_order_id: string;
  expected_amount_irr: number;
  fulfilled_at: number | null;
  fulfilment_mode: string | null;
}

export async function fulfilMirzabotClaimWithoutPayment(
  db: D1Database,
  args: {
    claimId: string;
    actorEmail: string;
    actorRole: string;
    reason: string;
    mode: FulfilmentMode;
    /** Enqueue the legacy bot's fulfilment notice in the same transaction. */
    enqueueWebhook?: boolean;
    requestId?: string | null;
    now?: number;
  },
): Promise<FulfilResult> {
  const reason = args.reason.trim();
  // Required by the route AND by here. The column is nullable because 350
  // historical rows predate it, so this is the only place that can refuse a
  // fulfilment nobody explained.
  if (reason.length < 3) return { ok: false, error: 'REASON_REQUIRED' };

  const claim = await read(db, args.claimId);
  if (!claim || claim.source_system !== MIRZABOT_SOURCE)
    return { ok: false, error: 'CLAIM_NOT_FOUND' };

  // Asked before the write only to give a good error. The write below is what
  // actually decides, because anything read here can change before it runs.
  if (claim.fulfilled_at !== null) return done(claim, args.mode, true);
  if (claim.status === 'VERIFIED') return { ok: false, error: 'CLAIM_ALREADY_VERIFIED' };
  if (!ELIGIBLE.has(claim.status)) return { ok: false, error: 'CLAIM_NOT_ELIGIBLE' };

  const now = args.now ?? Date.now();
  const eventId = fulfilmentEventId(claim.id);

  const statements = [
    db
      .prepare(
        `UPDATE payment_claims
            SET status = 'FULFILLED_UNRECONCILED',
                fulfilment_mode = ?2,
                fulfilled_at = ?3,
                fulfilled_by = ?4,
                fulfilment_reason = ?5,
                suspect_reason = NULL,
                updated_at = ?3
          WHERE id = ?1
            AND status IN ('PENDING','MATCH_SUGGESTED')
            AND fulfilled_at IS NULL`,
      )
      .bind(claim.id, args.mode, now, args.actorEmail, reason),
    db
      .prepare(
        `INSERT INTO audit_logs
           (id, actor_email, actor_role, action, entity_type, entity_id,
            before_json, after_json, reason, request_id, created_at)
         VALUES (?1, ?2, ?3, ?4, 'CLAIM', ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(
        crypto.randomUUID(),
        args.actorEmail,
        args.actorRole,
        args.mode === 'CONTINUITY' ? 'claim.continuity_fulfilled' : 'claim.manual_fulfilled',
        claim.id,
        JSON.stringify({ status: claim.status }),
        JSON.stringify({ status: 'FULFILLED_UNRECONCILED', fulfilmentMode: args.mode }),
        reason,
        args.requestId ?? null,
        now,
      ),
  ];

  if (args.enqueueWebhook) {
    const payload: MirzabotVerifiedWebhook = {
      eventId,
      type: 'payment.verified',
      externalOrderId: claim.external_order_id,
      mirzabotOrderId: claim.external_order_id.replace(/^mirzabot:test:/, ''),
      claimId: claim.id,
      matchId: null,
      transactionId: null,
      expectedAmountIrr: claim.expected_amount_irr,
      matchedAmountIrr: null,
      verificationMode: args.mode === 'CONTINUITY' ? 'CONTINUITY' : 'MANUAL_FULFILMENT',
      verifiedAt: now,
    };
    statements.push(
      db
        .prepare(
          `INSERT INTO webhook_deliveries
             (id, event_type, payload_json, attempt_count, status, next_attempt_at)
           VALUES (?1, 'PAYMENT_VERIFIED', ?2, 0, 'PENDING', ?3)
           ON CONFLICT (id) DO NOTHING`,
        )
        .bind(eventId, JSON.stringify(payload), now),
    );
  }

  const results = await db.batch(statements);
  // `batch()` is one transaction, so this is the claim UPDATE's own row count —
  // 1 means this call is the one that fulfilled it, 0 means somebody else got
  // there between the read above and the write, and the audit row rolled back
  // with it rather than recording a fulfilment that never happened.
  const changed = results[0]?.meta?.changes ?? 0;
  if (changed === 0) {
    const after = await read(db, args.claimId);
    if (after?.fulfilled_at != null) return done(after, args.mode, true);
    if (after?.status === 'VERIFIED') return { ok: false, error: 'CLAIM_ALREADY_VERIFIED' };
    return { ok: false, error: 'CLAIM_NOT_ELIGIBLE' };
  }

  return done(claim, args.mode, false);
}

async function read(db: D1Database, claimId: string): Promise<Row | null> {
  return await db
    .prepare(
      `SELECT id, status, source_system, external_order_id, expected_amount_irr,
              fulfilled_at, fulfilment_mode
         FROM payment_claims WHERE id = ?1`,
    )
    .bind(claimId)
    .first<Row>();
}

function done(claim: Row, requested: FulfilmentMode, already: boolean): FulfilResult {
  return {
    ok: true,
    claimId: claim.id,
    // The mode that actually landed, not the one this caller asked for. A
    // manual click arriving after Continuity already fulfilled the row must not
    // be told the row is MANUAL — the panel prints this word to explain who
    // decided, and the answer is whoever was first.
    mode: (claim.fulfilment_mode as FulfilmentMode | null) ?? requested,
    already,
    externalOrderId: claim.external_order_id,
    expectedAmountIrr: claim.expected_amount_irr,
  };
}
