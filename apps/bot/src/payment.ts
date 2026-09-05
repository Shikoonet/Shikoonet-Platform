/**
 * Card-to-card checkout: which card the customer is told to pay into, and what
 * happens when they say they have paid.
 *
 * Two rows come out of this file and they belong to different owners. The
 * `payments` row is ours — the bot's record of a checkout attempt, including the
 * card as plain text, because a receipt must stay truthful about where the money
 * was sent even after that card is removed. The `payment_claims` row belongs to
 * the reconciliation hub: it is what the review screen lists and what the
 * auto-verification engine matches a bank SMS against.
 *
 * `source_system` is MIRZABOT on both bots' claims on purpose. It names the
 * card-to-card protocol, not the bot that opened the claim — the decision engine,
 * every dashboard query, and the exclusion in `matching.ts` that keeps the
 * generic scorer away from these claims all key off that one value. Which bot
 * opened it is readable from `external_order_id`, whose prefix is `shikoo:` here
 * and `mirzabot:` for the PHP bot.
 */

import { randomUUID } from 'node:crypto';
import { MIRZABOT_SOURCE, RECEIPT_FILE_ID, storedReceipt } from '@shikoo/contracts';
import type { D1DatabaseSession } from '@shikoo/database';
import { fulfilMirzabotClaimWithoutPayment, readContinuityMode } from '@shikoo/domain';

export interface CheckoutPayment {
  publicId: string;
  amountIrr: number;
  cardDigits: string;
  cardHolder: string | null;
  /** Already told us they paid; the button is spent. */
  claimed: boolean;
}

/**
 * How far a card's cursor advances per assignment, before its weight divides
 * it. Large enough that integer division still has resolution at the maximum
 * weight of 20 (the smallest step is 50,000), small enough that a bigint never
 * comes close to running out.
 *
 * It is the SMALL of the two steps. A deposit advances the same cursor a
 * thousand times as far, from the trigger in `0029_card_queue_moves_on_money`.
 * The ratio between them is the whole design and neither number means anything
 * alone — change one and change the other.
 */
const ROTATION_STEP = 1_000_000;

/**
 * The next ACTIVE card to hand out, marked as assigned in the same statement.
 *
 * Weighted round-robin over a virtual clock. Each card carries a cursor; the
 * smallest cursor is taken and advanced by ROTATION_STEP/weight. A card with
 * weight 3 advances a third as far per turn, so it comes up three times as
 * often — the ratio is exactly the weight ratio.
 *
 * It also cannot become exclusive, which is the part the head admin actually
 * asked for. The cursor of the card just picked strictly increases, so after a
 * finite number of turns it passes every other card and their turn comes. That
 * is a property worth testing rather than asserting, and `pay.test.ts` does.
 *
 * This replaced a plain `ORDER BY last_assigned_at NULLS FIRST`, which had the
 * opposite behaviour: a freshly added card has NULL there, so it won EVERY
 * checkout until it had been used more recently than all the others.
 *
 * `idx_payment_cards_rotation` covers this read. SKIP LOCKED is what makes two
 * simultaneous checkouts take two different cards instead of queueing behind
 * one row, and it is why this needs no lease table — the legacy bot keeps
 * leases in the PHP repo, and none of that complexity buys anything here.
 *
 * This is only HALF of what moves a card through the queue, and the smaller
 * half. Most checkouts are abandoned, so if being shown were the only thing
 * that advanced a card, the cards that actually RECEIVED money would be a fixed
 * subset rather than a rotation — measured on a pool of 30, ten of them took
 * everything. A verified deposit advances the same cursor by a thousand
 * assignments, and it does so from a trigger on `payment_claims` rather than
 * from here, because a claim reaches VERIFIED down three code paths plus the
 * live PHP bot. See `migrations/0029_card_queue_moves_on_money.sql`.
 */
export async function rotateCard(
  tx: D1DatabaseSession,
  now: number,
): Promise<{
  card_digits: string;
  holder_name: string | null;
  financial_account_id: string;
} | null> {
  return tx
    .prepare(
      `UPDATE payment_cards
          SET rotation_cursor  = rotation_cursor + ?1 / display_weight,
              last_assigned_at = ?2
        WHERE id = (
          SELECT pc.id FROM payment_cards pc
           JOIN financial_accounts fa ON fa.id = pc.financial_account_id
           WHERE pc.status = 'ACTIVE'
             -- The ACCOUNT has to be live too, and it did not used to be asked.
             --
             -- Sam switched every account off on 2026-09-03 and the bot kept
             -- handing out a card: the picker read payment_cards.status and
             -- nothing else, so «غیرفعال‌کردن» on the accounts screen stopped the
             -- account appearing in «آمار مالی» and did not stop customers being
             -- told to pay into it. Money kept arriving somewhere the panel had
             -- been told to retire, and the balances screen — which filters
             -- fa.active = 1 AND fa.status = 'ACTIVE' — could not show it.
             --
             -- Both columns, because they are different switches and each has a
             -- state that must not receive money: active = 0 is the operator's
             -- own off, PENDING is an account ingest invented from an unknown
             -- SMS and nobody has claimed, MUTED is one somebody deliberately
             -- quieted, and DECLINED is one already refused. The same pair
             -- analyticsRoutes uses, so the money screen and the checkout
             -- cannot disagree about which accounts are in service.
             AND fa.active = 1
             AND fa.status = 'ACTIVE'
           ORDER BY pc.rotation_cursor, pc.id
           LIMIT 1
           FOR UPDATE OF pc SKIP LOCKED
        )
        RETURNING card_digits, holder_name, financial_account_id`,
    )
    .bind(ROTATION_STEP, now)
    .first<{ card_digits: string; holder_name: string | null; financial_account_id: string }>();
}

/**
 * The checkout for one order. Called every time the order screen is drawn, and
 * deliberately idempotent: a customer who taps back and forth must keep seeing
 * the SAME card, or they pay into one card and we look for the money on another.
 *
 * Returns null when no card is free to hand out. That is a real state — every
 * card disabled, or every row locked by a simultaneous checkout — and it is the
 * caller's job to say so rather than to show a checkout with no destination.
 *
 * Also null for an order with nothing to pay. A checkout at zero opens a claim
 * with `expected_amount_irr = 0`, and auto-verification matches on the exact
 * amount with no tolerance — so no bank transfer that ever arrives can settle
 * it and the order waits in AWAITING_PAYMENT for good. `place()` refuses to
 * write such an order now; this covers the one it cannot, a row that predates
 * that floor. Silent, because the order screen already has a way to say the
 * checkout could not be drawn.
 */
export async function checkoutFor(
  tx: D1DatabaseSession,
  userId: number,
  orderId: number,
  totalIrr: number,
  publicId: string,
  now: number = Date.now(),
): Promise<CheckoutPayment | null> {
  if (!Number.isSafeInteger(totalIrr) || totalIrr <= 0) return null;

  const existing = await tx
    .prepare(
      `SELECT public_id, amount_irr, assigned_card_number, assigned_card_name, status
         FROM payments
        WHERE order_id = ?1 AND user_id = ?2
          AND status IN ('PENDING', 'AWAITING_REVIEW')
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .bind(orderId, userId)
    .first<{
      public_id: string;
      amount_irr: number;
      assigned_card_number: string | null;
      assigned_card_name: string | null;
      status: string;
    }>();
  if (existing?.assigned_card_number) {
    return {
      publicId: existing.public_id,
      amountIrr: existing.amount_irr,
      cardDigits: existing.assigned_card_number,
      cardHolder: existing.assigned_card_name,
      claimed: existing.status === 'AWAITING_REVIEW',
    };
  }

  const card = await rotateCard(tx, now);
  if (!card) return null;

  // `ON CONFLICT DO NOTHING` against `idx_payments_one_open_per_order` (0022).
  //
  // The read above is a fast path, not a guard: two calls arriving together both
  // find nothing and both arrive here. Without the index they would each insert,
  // and the order would carry two open checkouts with two different card
  // numbers — the customer pays into the one on their screen and the claim is
  // opened against the other, which auto-verification then refuses because the
  // account does not match. Real money, correct receipt, stuck in review.
  //
  // The loser gets no row back and re-reads, so both callers leave with the same
  // card. Not an error: from the customer's side this is one checkout drawn
  // twice, which is the ordinary case of tapping back and forth.
  const row = await tx
    .prepare(
      `INSERT INTO payments
         (public_id, user_id, order_id, amount_irr, method, status,
          assigned_card_number, assigned_card_name, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'CARD_TO_CARD', 'PENDING', ?5, ?6, now(), now())
       ON CONFLICT (order_id) WHERE order_id IS NOT NULL
                                AND status IN ('PENDING', 'AWAITING_REVIEW')
       DO NOTHING
       RETURNING public_id, amount_irr`,
    )
    .bind(publicId, userId, orderId, totalIrr, card.card_digits, card.holder_name)
    .first<{ public_id: string; amount_irr: number }>();

  if (!row) {
    // Somebody else won. Read what they wrote rather than inventing a second
    // answer — and if it is somehow gone by now, say "no checkout" instead of
    // guessing, because the alternative is showing a card nothing is recorded
    // against.
    const won = await tx
      .prepare(
        `SELECT public_id, amount_irr, assigned_card_number, assigned_card_name, status
           FROM payments
          WHERE order_id = ?1 AND status IN ('PENDING', 'AWAITING_REVIEW')
          LIMIT 1`,
      )
      .bind(orderId)
      .first<{
        public_id: string;
        amount_irr: number;
        assigned_card_number: string | null;
        assigned_card_name: string | null;
        status: string;
      }>();
    if (!won?.assigned_card_number) return null;
    return {
      publicId: won.public_id,
      amountIrr: won.amount_irr,
      cardDigits: won.assigned_card_number,
      cardHolder: won.assigned_card_name,
      claimed: won.status === 'AWAITING_REVIEW',
    };
  }

  return {
    publicId: row.public_id,
    amountIrr: row.amount_irr,
    cardDigits: card.card_digits,
    cardHolder: card.holder_name,
    claimed: false,
  };
}

export type PaidResult =
  /** The claim was opened by this press. */
  | { outcome: 'claimed'; publicId: string }
  /** They had already told us; the earlier claim stands. */
  | { outcome: 'already'; publicId: string }
  /** No open checkout to claim — the order was never at the payment step. */
  | { outcome: 'none' }
  /** The invoice ran out before they pressed it. The card on it may be stale. */
  | { outcome: 'expired' };

/**
 * "I have paid."
 *
 * Records the moment, because it anchors the ±5 minute window the auto-matcher
 * compares a bank SMS against, and opens the claim the review screen lists.
 *
 * Pressing twice cannot open two claims: `payment_claims.external_order_id` is
 * UNIQUE and the conflict is left to the database. Holding that in application
 * code would mean a check and an insert with a gap between them, and two taps
 * arrive inside that gap often enough to matter.
 */
export async function recordPaidClick(
  tx: D1DatabaseSession,
  userId: number,
  orderId: number,
  telegramId: number,
  now: number = Date.now(),
): Promise<PaidResult> {
  // The order is locked before anything else is read, and this is the only
  // reason the expiry sweep is safe. `expire.ts` cannot ask "has anybody said
  // they paid" in the same statement that expires the order — a write blocked
  // on a row re-checks that row and nothing joined to it — so it locks its
  // candidates first. A press arriving after that lock waits here and then sees
  // EXPIRED; a press already holding this lock makes the sweep skip the order
  // entirely. Without the lock both sides read a world where the other has not
  // happened yet, and the result is a claim against an expired order: money
  // that verifies onto an order `settle.ts` will never advance.
  //
  // Deliberately not filtered on status. Anything other than EXPIRED falls
  // through to the payment lookup below, which has always been what decides
  // 'already' from 'none'.
  const order = await tx
    .prepare(`SELECT status FROM orders WHERE id = ?1 FOR UPDATE`)
    .bind(orderId)
    .first<{ status: string }>();
  if (order?.status === 'EXPIRED') return { outcome: 'expired' };

  const payment = await tx
    .prepare(
      `SELECT id, public_id, amount_irr, assigned_card_number, status
         FROM payments
        WHERE order_id = ?1 AND user_id = ?2
          AND status IN ('PENDING', 'AWAITING_REVIEW')
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .bind(orderId, userId)
    .first<{
      id: number;
      public_id: string;
      amount_irr: number;
      assigned_card_number: string | null;
      status: string;
    }>();
  if (!payment) return { outcome: 'none' };
  if (payment.status === 'AWAITING_REVIEW') {
    return { outcome: 'already', publicId: payment.public_id };
  }

  // The card resolves to the account the money should land in. A card nobody
  // mapped yet leaves this null on purpose — the claim still opens, the engine
  // reports UNMAPPED_CARD, and an admin sees a payment they can act on. Dropping
  // the claim instead would lose a customer's money into silence.
  const account = payment.assigned_card_number
    ? await tx
        .prepare(`SELECT financial_account_id FROM payment_cards WHERE card_digits = ?1 LIMIT 1`)
        .bind(payment.assigned_card_number)
        .first<{ financial_account_id: string }>()
    : null;

  await tx
    .prepare(`UPDATE payments SET status = 'AWAITING_REVIEW', updated_at = now() WHERE id = ?1`)
    .bind(payment.id)
    .run();

  const claimId = randomUUID();
  const inserted = await tx
    .prepare(
      `INSERT INTO payment_claims
         (id, external_order_id, customer_reference, expected_amount_irr,
          target_financial_account_id, card_digits, submitted_at, paid_clicked_at,
          source_system, metadata_json, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, 'PENDING', ?7, ?7)
       ON CONFLICT (external_order_id) DO NOTHING`,
    )
    .bind(
      claimId,
      `shikoo:${payment.public_id}`,
      String(telegramId),
      payment.amount_irr,
      account?.financial_account_id ?? null,
      payment.assigned_card_number,
      now,
      MIRZABOT_SOURCE,
      JSON.stringify({ telegramUserId: String(telegramId), bot: 'shikoo' }),
    )
    .run();

  return inserted.meta.changes === 0
    ? { outcome: 'already', publicId: payment.public_id }
    : { outcome: 'claimed', publicId: payment.public_id };
}

export type ReceiptResult =
  /** Attached, and it is the first one for this claim. */
  | { outcome: 'received'; publicId: string }
  /** Attached, replacing an earlier one. The waiting window did not move. */
  | { outcome: 'replaced'; publicId: string }
  /** Nothing of theirs is waiting for a receipt. */
  | { outcome: 'none' }
  /** There is a claim, but it has already been decided. */
  | { outcome: 'settled'; publicId: string };

/**
 * Attaches a receipt photo to whatever the customer is waiting on.
 *
 * No session, no step, no button to press first. A photo from a customer with
 * one claim under review can only be about that claim, and asking them to press
 * something before sending it is how the legacy bot lost receipts — its
 * `cart_to_cart_user` step is cleared by any other tap, and the picture that
 * arrives afterwards is dropped without a word.
 *
 * The claim keeps the handle, never the picture. Nothing is downloaded, so a
 * receipt costs no storage and no egress, and the admin sees the original
 * rather than a copy of one. A Continuity claim still accepts that evidence
 * after the order has moved: it was delivered, but it remains unreconciled and
 * the receipt is exactly what the later review needs. Continuity starts here,
 * after that evidence exists — pressing «پرداخت کردم» only opens the claim and
 * must never release an account on the strength of a button press alone.
 *
 * `receipt_submitted_at` is stamped ONCE. It is the anchor for the ten minutes
 * the matcher will keep waiting for a bank SMS before it gives up, and a
 * customer who could move it by sending another photo could hold their claim
 * out of the manual queue for as long as they liked. The newest picture is kept
 * — that is the evidence the admin should be looking at — and the clock is not
 * restarted by it.
 */
export async function recordReceipt(
  tx: D1DatabaseSession,
  userId: number,
  fileId: string,
  now: number = Date.now(),
  /** True when it arrived with «Send as File» and must be sent back as one. */
  isDocument = false,
): Promise<ReceiptResult> {
  // Validated before the prefix is added, so the guard still sees exactly what
  // Telegram sent and a crafted `doc:` inside a handle cannot become one.
  if (!RECEIPT_FILE_ID.test(fileId)) return { outcome: 'none' };
  const stored = storedReceipt(fileId, isDocument);

  const claim = await tx
    .prepare(
      `SELECT c.id, c.status, p.public_id
         FROM payments p
         JOIN payment_claims c ON c.external_order_id = 'shikoo:' || p.public_id
        WHERE p.user_id = ?1
          AND (p.status = 'AWAITING_REVIEW'
               OR (p.status = 'PAID' AND c.status = 'FULFILLED_UNRECONCILED'))
        ORDER BY p.updated_at DESC, p.id DESC
        LIMIT 1`,
    )
    .bind(userId)
    .first<{ id: string; status: string; public_id: string }>();
  if (!claim) return { outcome: 'none' };

  // The status is checked in the statement, not above it. A claim verified
  // between the read and the write must not take a receipt: the money is
  // settled, the row is history, and quietly stamping it would make the audit
  // trail disagree with what happened. FULFILLED_UNRECONCILED is deliberately
  // different: the product moved but the evidence question is still open.
  const updated = await tx
    .prepare(
      `UPDATE payment_claims
          SET receipt_url_or_r2_key = ?2,
              receipt_submitted_at  = COALESCE(receipt_submitted_at, ?3),
              updated_at            = ?3
        WHERE id = ?1
          AND status IN ('PENDING', 'MATCH_SUGGESTED', 'FULFILLED_UNRECONCILED')
      RETURNING receipt_submitted_at`,
    )
    .bind(claim.id, stored, now)
    .first<{ receipt_submitted_at: number }>();
  if (!updated) return { outcome: 'settled', publicId: claim.public_id };

  /*
   * The current bot writes claims directly to Postgres, so this is its
   * Continuity boundary: a valid receipt has been attached and the order may
   * now be released without waiting for bank evidence. Keeping it in the same
   * transaction as the receipt means a failed fulfilment cannot acknowledge a
   * picture that did not actually unlock the order.
   *
   * A replacement receipt for an already fulfilled claim reaches this branch
   * too. `fulfilMirzabotClaimWithoutPayment` deliberately treats that as an
   * idempotent success, preserving the first actor, reason and timestamp.
   */
  const mode = await readContinuityMode(tx, now);
  if (mode.mode === 'CONTINUITY') {
    const fulfilled = await fulfilMirzabotClaimWithoutPayment(tx, {
      claimId: claim.id,
      actorEmail: mode.activatedBy ?? 'continuity',
      actorRole: 'SYSTEM',
      reason: mode.reason ?? 'continuity mode',
      mode: 'CONTINUITY',
      now,
    });
    if (!fulfilled.ok) {
      throw new Error(`continuity fulfil failed: ${fulfilled.error}`);
    }
  }

  return updated.receipt_submitted_at === now
    ? { outcome: 'received', publicId: claim.public_id }
    : { outcome: 'replaced', publicId: claim.public_id };
}

/** The receipt an admin is about to look at, if the customer sent one. */
export async function receiptFor(tx: D1DatabaseSession, claimId: string): Promise<string | null> {
  const row = await tx
    .prepare(`SELECT receipt_url_or_r2_key FROM payment_claims WHERE id = ?1`)
    .bind(claimId)
    .first<{ receipt_url_or_r2_key: string | null }>();
  return row?.receipt_url_or_r2_key ?? null;
}
