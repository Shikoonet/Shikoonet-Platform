import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import {
  MIRZABOT_CLAIMS_PATH,
  MIRZABOT_SOURCE,
  WAITING_TIMEOUT_MS,
  type MirzabotClaimPayload,
} from '@shikoo/contracts';
import { normalizeCardDigits, tomanToIrr } from '@shikoo/domain';
import {
  evaluateMirzabotGroup,
  recordMirzabotSuspect,
  clearMirzabotSuspect,
  verifyMirzabotClaim,
  type MirzabotClaimCandidate,
  type MirzabotDecision,
  type MirzabotTxCandidate,
} from '@shikoo/domain';
import { deliverMirzabotVerifiedWebhook, flushWebhookDeliveries } from './webhook.js';

export const MirzabotClaimBody = z
  .object({
    eventId: z.string().min(8).max(128),
    source: z.literal(MIRZABOT_SOURCE),
    orderId: z.string().min(1).max(200),
    telegramUserId: z.string().min(1).max(64),
    telegramUsername: z.string().max(128).optional(),
    amountToman: z.number().int().nonnegative(),
    expectedAmountIrr: z.number().int().nonnegative(),
    cardNumber: z.string().min(1).max(64),
    paidClickedAt: z.number().int().positive(),
    receiptSubmittedAt: z.number().int().positive(),
    receipt: z
      .object({
        telegramFileUniqueId: z.string().max(256).optional(),
      })
      .optional(),
  })
  .strict();

export interface MirzabotClaimResult {
  ok: true;
  claimId: string;
  externalOrderId: string;
  duplicateEvent: boolean;
  suspectReason: string | null;
  autoVerified: boolean;
  matchId?: string | undefined;
  transactionId?: string | undefined;
}

export type MirzabotWebhookEnv = Parameters<typeof deliverMirzabotVerifiedWebhook>[0];

export interface MirzabotMatchOpts {
  /** Whole integration switch. When false the matcher never touches D1. */
  enabled?: boolean;
  autoMatchEnabled: boolean;
  webhookEnv?: MirzabotWebhookEnv;
  now?: number;
}

function externalOrderId(orderId: string): string {
  return `mirzabot:test:${orderId}`;
}

interface ClaimPoolRow {
  id: string;
  status: string;
  external_order_id: string;
  expected_amount_irr: number;
  target_financial_account_id: string | null;
  paid_clicked_at: number | null;
  receipt_submitted_at: number | null;
  card_digits: string | null;
  card_mapping_count: number;
  mapped_account_id: string | null;
  mapped_account_status: string | null;
  order_already_verified: number;
}

/**
 * Load every pending Mirzabot claim for one amount, resolving each claim's
 * card→account mapping at read time so a card mapped after the claim arrived
 * is picked up on the next matcher run.
 */
async function loadClaimPool(db: D1Database, amountIrr: number): Promise<MirzabotClaimCandidate[]> {
  const rows = await db
    .prepare(
      `SELECT c.id, c.status, c.external_order_id, c.expected_amount_irr,
              c.target_financial_account_id, c.paid_clicked_at, c.receipt_submitted_at,
              c.card_digits,
              (SELECT COUNT(*) FROM payment_cards pc WHERE pc.card_digits = c.card_digits)
                AS card_mapping_count,
              (SELECT pc.financial_account_id FROM payment_cards pc
                WHERE pc.card_digits = c.card_digits LIMIT 1) AS mapped_account_id,
              (SELECT fa.status FROM payment_cards pc
                 JOIN financial_accounts fa ON fa.id = pc.financial_account_id
                WHERE pc.card_digits = c.card_digits LIMIT 1) AS mapped_account_status,
              EXISTS(
                SELECT 1 FROM reconciliation_matches m
                 WHERE m.payment_claim_id = c.id
                   AND m.status IN ('CONFIRMED','AUTO_VERIFIED')
              ) AS order_already_verified
       FROM payment_claims c
       WHERE c.source_system = ?1
         AND c.status IN ('PENDING','MATCH_SUGGESTED')
         AND c.expected_amount_irr = ?2`,
    )
    .bind(MIRZABOT_SOURCE, amountIrr)
    .all<ClaimPoolRow>();

  return (rows.results ?? []).map((r) => ({
    id: r.id,
    sourceSystem: MIRZABOT_SOURCE,
    status: r.status,
    externalOrderId: r.external_order_id,
    expectedAmountIrr: r.expected_amount_irr,
    targetFinancialAccountId: r.mapped_account_id ?? r.target_financial_account_id,
    paidClickedAt: r.paid_clicked_at,
    receiptSubmittedAt: r.receipt_submitted_at,
    accountStatus: (r.mapped_account_status as MirzabotClaimCandidate['accountStatus']) ?? null,
    cardMappingCount: r.card_digits ? r.card_mapping_count : r.target_financial_account_id ? 1 : 0,
    orderAlreadyVerified: r.order_already_verified === 1,
  }));
}

async function loadTxPool(
  db: D1Database,
  accountId: string,
  amountIrr: number,
): Promise<MirzabotTxCandidate[]> {
  const rows = await db
    .prepare(
      `SELECT t.id, t.direction, t.amount_irr, t.financial_account_id, t.bank_timestamp,
              t.processing_disposition,
              EXISTS(
                SELECT 1 FROM reconciliation_matches m
                 WHERE m.transaction_candidate_id = t.id
                   AND m.status IN ('CONFIRMED','AUTO_VERIFIED')
              ) AS consumed
       FROM transaction_candidates t
       WHERE t.financial_account_id = ?1
         AND t.direction = 'CREDIT'
         AND t.processing_disposition = 'ACTIONABLE'
         AND t.amount_irr = ?2`,
    )
    .bind(accountId, amountIrr)
    .all<{
      id: string;
      direction: string;
      amount_irr: number;
      financial_account_id: string;
      bank_timestamp: number | null;
      processing_disposition: string;
      consumed: number;
    }>();

  return (rows.results ?? []).map((r) => ({
    id: r.id,
    direction: r.direction,
    amountIrr: r.amount_irr,
    financialAccountId: r.financial_account_id,
    bankTimestamp: r.bank_timestamp,
    consumed: r.consumed === 1,
    processingDisposition: r.processing_disposition,
  }));
}

export interface MirzabotMatchRunResult {
  decisions: MirzabotDecision[];
  autoVerifiedClaimIds: string[];
}

/**
 * Run the authoritative matcher for one (account, amount) group and persist
 * the outcome. Called when a claim arrives and when a bank CREDIT is ingested.
 */
export async function runMirzabotMatching(
  db: D1Database,
  scope: { accountId: string; amountIrr: number },
  opts: MirzabotMatchOpts,
): Promise<MirzabotMatchRunResult> {
  const allClaims = await loadClaimPool(db, scope.amountIrr);
  const claims = allClaims.filter((c) => c.targetFinancialAccountId === scope.accountId);
  if (claims.length === 0) return { decisions: [], autoVerifiedClaimIds: [] };

  // Persist a card→account resolution that only became possible after the
  // claim was created, so the stored claim and the decision agree.
  for (const c of claims) {
    await db
      .prepare(
        `UPDATE payment_claims SET target_financial_account_id = ?2, updated_at = ?3
         WHERE id = ?1
           AND status IN ('PENDING','MATCH_SUGGESTED')
           AND (target_financial_account_id IS NULL OR target_financial_account_id != ?2)`,
      )
      .bind(c.id, scope.accountId, opts.now ?? Date.now())
      .run();
  }

  const txs = await loadTxPool(db, scope.accountId, scope.amountIrr);
  const decisions = evaluateMirzabotGroup(claims, txs, { now: opts.now ?? Date.now() });

  const autoVerifiedClaimIds: string[] = [];
  for (const decision of decisions) {
    if (decision.decision === 'AUTO_VERIFY' && opts.autoMatchEnabled && decision.transactionId) {
      const verified = await verifyMirzabotClaim(db, {
        claimId: decision.claimId,
        transactionId: decision.transactionId,
        mode: 'AUTO_VERIFIED',
        // The fulfilment notice is written by the same batch that verifies, so
        // it cannot be lost between the two. Delivery is attempted below.
        enqueueWebhook: opts.webhookEnv !== undefined,
      });
      if (verified.ok) {
        autoVerifiedClaimIds.push(decision.claimId);
      } else {
        // Lost a race, or a fact changed under us — never force the write.
        const reason =
          verified.error === 'TRANSACTION_ALREADY_CONSUMED'
            ? 'TRANSACTION_ALREADY_CONSUMED'
            : verified.error === 'CLAIM_ALREADY_VERIFIED'
              ? 'DUPLICATE_ORDER'
              : verified.error === 'AMOUNT_MISMATCH'
                ? 'AMOUNT_MISMATCH'
                : 'INTEGRATION_ERROR';
        await recordMirzabotSuspect(db, {
          claimId: decision.claimId,
          reason,
          metadata: { verifyError: verified.error, ...decision.diagnostics },
        });
      }
      continue;
    }
    if (decision.decision === 'WAIT') {
      await clearMirzabotSuspect(db, decision.claimId);
      continue;
    }
    if (decision.decision === 'SUGGEST') {
      await recordMirzabotSuspect(db, {
        claimId: decision.claimId,
        reason: decision.reason,
        metadata: decision.diagnostics,
      });
    }
  }

  // After the decisions, not between them: one sweep covers every notice this
  // run enqueued plus anything an earlier run could not deliver. A failure here
  // changes nothing — the notices are already durable, and the next run or the
  // next claim retries them.
  if (opts.webhookEnv) {
    await flushWebhookDeliveries(db, opts.webhookEnv, { now: opts.now ?? Date.now() });
  }

  return { decisions, autoVerifiedClaimIds };
}

/**
 * Re-run matching for claims whose 10-minute waiting period has elapsed.
 * Classifies genuinely no-evidence claims as NO_TRANSACTION_AFTER_10M; leaves
 * evidence-bearing claims in Needs Review. Idempotent.
 */
export async function finalizeExpiredMirzabotWaits(
  db: D1Database,
  opts: MirzabotMatchOpts,
): Promise<number> {
  if (opts.enabled === false) return 0;
  const now = opts.now ?? Date.now();
  const rows = await db
    .prepare(
      `SELECT DISTINCT c.target_financial_account_id AS account_id, c.expected_amount_irr AS amount
       FROM payment_claims c
       WHERE c.source_system = ?1
         AND c.status IN ('PENDING','MATCH_SUGGESTED')
         AND (c.suspect_reason IS NULL
              OR c.suspect_reason IN ('NO_TRANSACTION_AFTER_10M','NO_TRANSACTION'))
         AND c.target_financial_account_id IS NOT NULL
         AND COALESCE(c.receipt_submitted_at, c.paid_clicked_at) IS NOT NULL
         AND COALESCE(c.receipt_submitted_at, c.paid_clicked_at) + ?2 <= ?3
       LIMIT 50`,
    )
    .bind(MIRZABOT_SOURCE, WAITING_TIMEOUT_MS, now)
    .all<{ account_id: string; amount: number }>();

  for (const r of rows.results ?? []) {
    await runMirzabotMatching(db, { accountId: r.account_id, amountIrr: r.amount }, opts);
  }
  return (rows.results ?? []).length;
}

/** Re-run matching after a bank CREDIT lands. Returns whether Mirzabot owns this tx. */
export async function rematchMirzabotClaimsForCreditTx(
  db: D1Database,
  tx: {
    id: string;
    financial_account_id: string | null;
    amount_irr: number | null;
    direction: string;
    bank_timestamp: number | null;
    processing_disposition?: string;
  },
  opts: MirzabotMatchOpts,
): Promise<{ evaluatedClaims: number; autoVerifiedCount: number }> {
  if (opts.enabled === false) return { evaluatedClaims: 0, autoVerifiedCount: 0 };
  if (!tx.financial_account_id || tx.amount_irr == null || tx.direction !== 'CREDIT') {
    return { evaluatedClaims: 0, autoVerifiedCount: 0 };
  }
  if (tx.processing_disposition && tx.processing_disposition !== 'ACTIONABLE') {
    return { evaluatedClaims: 0, autoVerifiedCount: 0 };
  }

  await finalizeExpiredMirzabotWaits(db, opts);
  const run = await runMirzabotMatching(
    db,
    { accountId: tx.financial_account_id, amountIrr: tx.amount_irr },
    opts,
  );
  return {
    evaluatedClaims: run.decisions.length,
    autoVerifiedCount: run.autoVerifiedClaimIds.length,
  };
}

export async function handleMirzabotClaim(
  db: D1Database,
  body: MirzabotClaimPayload,
  opts: { autoMatchEnabled: boolean; webhookEnv?: MirzabotWebhookEnv; now?: number },
): Promise<MirzabotClaimResult> {
  // Settle older claims first, before this one joins the pool, so the sweep
  // never consumes the decision belonging to the claim being submitted.
  await finalizeExpiredMirzabotWaits(db, {
    autoMatchEnabled: opts.autoMatchEnabled,
    ...(opts.now != null ? { now: opts.now } : {}),
  });

  const existingEvent = await db
    .prepare('SELECT event_id FROM integration_events WHERE event_id = ?1')
    .bind(body.eventId)
    .first<{ event_id: string }>();
  if (existingEvent) {
    const claim = await db
      .prepare('SELECT id FROM payment_claims WHERE external_order_id = ?1')
      .bind(externalOrderId(body.orderId))
      .first<{ id: string }>();
    return {
      ok: true,
      claimId: claim?.id ?? '',
      externalOrderId: externalOrderId(body.orderId),
      duplicateEvent: true,
      suspectReason: null,
      autoVerified: false,
    };
  }

  const cardDigits = normalizeCardDigits(body.cardNumber);
  const expectedFromToman = tomanToIrr(body.amountToman);
  if (body.expectedAmountIrr !== expectedFromToman) {
    throw new Error('IRR_AMOUNT_MISMATCH');
  }

  let targetAccountId: string | null = null;
  if (cardDigits) {
    const cardRow = await db
      .prepare(
        `SELECT pc.financial_account_id
         FROM payment_cards pc
         WHERE pc.card_digits = ?1 LIMIT 1`,
      )
      .bind(cardDigits)
      .first<{ financial_account_id: string }>();
    if (cardRow) targetAccountId = cardRow.financial_account_id;
  }

  const now = opts.now ?? Date.now();
  const extId = externalOrderId(body.orderId);
  const existingClaim = await db
    .prepare('SELECT id, status FROM payment_claims WHERE external_order_id = ?1')
    .bind(extId)
    .first<{ id: string; status: string }>();

  const metadata = JSON.stringify({
    telegramUserId: body.telegramUserId,
    telegramUsername: body.telegramUsername ?? null,
    cardDigits: cardDigits ? `****${cardDigits.slice(-4)}` : null,
    receipt: body.receipt ?? null,
  });

  let claimId: string;
  let replayOfTerminalClaim = false;

  if (existingClaim) {
    claimId = existingClaim.id;
    // A settled order must never be re-opened by a replayed submission.
    replayOfTerminalClaim = ['VERIFIED', 'REJECTED', 'FAKE_RECEIPT', 'EXPIRED'].includes(
      existingClaim.status,
    );
    if (!replayOfTerminalClaim) {
      await db
        .prepare(
          `UPDATE payment_claims SET
             paid_clicked_at = ?2,
             receipt_submitted_at = ?3,
             card_digits = ?4,
             target_financial_account_id = COALESCE(?5, target_financial_account_id),
             metadata_json = ?6,
             updated_at = ?7
           WHERE id = ?1`,
        )
        .bind(
          claimId,
          body.paidClickedAt,
          body.receiptSubmittedAt,
          cardDigits,
          targetAccountId,
          metadata,
          now,
        )
        .run();
    }
  } else {
    claimId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO payment_claims (
           id, external_order_id, customer_reference, expected_amount_irr,
           target_financial_account_id, submitted_at, receipt_url_or_r2_key,
           source_system, metadata_json, status,
           paid_clicked_at, receipt_submitted_at, suspect_reason, suspect_metadata_json,
           card_digits, created_at, updated_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`,
      )
      .bind(
        claimId,
        extId,
        body.telegramUserId,
        body.expectedAmountIrr,
        targetAccountId,
        body.receiptSubmittedAt,
        body.receipt?.telegramFileUniqueId ?? null,
        MIRZABOT_SOURCE,
        metadata,
        'PENDING',
        body.paidClickedAt,
        body.receiptSubmittedAt,
        null,
        '{}',
        cardDigits,
        now,
        now,
      )
      .run();
  }

  await db
    .prepare(
      'INSERT INTO integration_events (event_id, source, external_order_id, processed_at) VALUES (?1,?2,?3,?4)',
    )
    .bind(body.eventId, MIRZABOT_SOURCE, extId, now)
    .run();

  if (replayOfTerminalClaim) {
    return {
      ok: true,
      claimId,
      externalOrderId: extId,
      duplicateEvent: false,
      suspectReason: 'DUPLICATE_ORDER',
      autoVerified: false,
    };
  }

  // The matcher owns every downstream decision, including the reason code.
  let autoVerified = false;
  if (targetAccountId) {
    const run = await runMirzabotMatching(
      db,
      { accountId: targetAccountId, amountIrr: body.expectedAmountIrr },
      {
        autoMatchEnabled: opts.autoMatchEnabled,
        ...(opts.webhookEnv ? { webhookEnv: opts.webhookEnv } : {}),
        now,
      },
    );
    autoVerified = run.autoVerifiedClaimIds.includes(claimId);
  } else {
    await recordMirzabotSuspect(db, {
      claimId,
      reason: 'UNMAPPED_CARD',
      metadata: { cardDigits: cardDigits ? `****${cardDigits.slice(-4)}` : null },
    });
  }

  // Report what was persisted rather than re-deriving it, so a decision that
  // failed at the write step cannot be reported as a success.
  const persisted = await db
    .prepare(
      `SELECT c.suspect_reason, m.id AS match_id, m.transaction_candidate_id
       FROM payment_claims c
       LEFT JOIN reconciliation_matches m
         ON m.payment_claim_id = c.id AND m.status IN ('CONFIRMED','AUTO_VERIFIED')
       WHERE c.id = ?1`,
    )
    .bind(claimId)
    .first<{
      suspect_reason: string | null;
      match_id: string | null;
      transaction_candidate_id: string | null;
    }>();

  return {
    ok: true,
    claimId,
    externalOrderId: extId,
    duplicateEvent: false,
    suspectReason: persisted?.suspect_reason ?? null,
    autoVerified,
    matchId: persisted?.match_id ?? undefined,
    transactionId: persisted?.transaction_candidate_id ?? undefined,
  };
}

export { MIRZABOT_CLAIMS_PATH };
