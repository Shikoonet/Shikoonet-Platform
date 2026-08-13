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
import { MIRZABOT_SOURCE } from '@shikoo/contracts';
import type { D1DatabaseSession } from '@shikoo/database';

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
 */
export async function rotateCard(
  tx: D1DatabaseSession,
  now: number,
): Promise<{ card_digits: string; holder_name: string | null; financial_account_id: string } | null> {
  return tx
    .prepare(
      `UPDATE payment_cards
          SET rotation_cursor  = rotation_cursor + ?1 / display_weight,
              last_assigned_at = ?2
        WHERE id = (
          SELECT id FROM payment_cards
           WHERE status = 'ACTIVE'
           ORDER BY rotation_cursor, id
           LIMIT 1
           FOR UPDATE SKIP LOCKED
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
 */
export async function checkoutFor(
  tx: D1DatabaseSession,
  userId: number,
  orderId: number,
  totalIrr: number,
  publicId: string,
  now: number = Date.now(),
): Promise<CheckoutPayment | null> {
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

  const row = await tx
    .prepare(
      `INSERT INTO payments
         (public_id, user_id, order_id, amount_irr, method, status,
          assigned_card_number, assigned_card_name, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'CARD_TO_CARD', 'PENDING', ?5, ?6, now(), now())
       RETURNING public_id, amount_irr`,
    )
    .bind(publicId, userId, orderId, totalIrr, card.card_digits, card.holder_name)
    .first<{ public_id: string; amount_irr: number }>();
  if (!row) throw new Error('payment insert returned no row');

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
  | { outcome: 'none' };

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
      randomUUID(),
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
