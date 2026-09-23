/**
 * A transfer that is not the invoice's amount goes to the customer's wallet.
 *
 * Sam, 2026-09-23: «اگر مبلغی که باید پرداخت می‌کرده با شابلون مغایرت داشت
 * بهش بگه و پولی که واریز کرده بفرسته توی کیف پولش». Two customers that day
 * typed the Toman figure into a banking app that asks for Rial and sent a
 * tenth of the price. The matcher only ever reads deposits of the invoice's
 * exact amount (`loadTxPool`), so it saw nothing, the claim went to «بررسی»
 * as «no transaction after 10 minutes», and the money sat in «واریزی‌ها» for
 * an operator to connect by hand.
 *
 * The template is the invoice. An exact amount verifies as it always did;
 * this runs only after the matcher has given up on one
 * (`NO_TRANSACTION_AFTER_10M`), and credits the one transfer that is plainly
 * this customer's:
 *
 *   - on the claim's account, within the auto-match window of «پرداخت کردم»,
 *     and not yet spent on anything (`INCOME_TX_WHERE`);
 *   - no invoice on that account in the day before asked for exactly that
 *     amount — otherwise it may be somebody else's correct payment, early,
 *     late or hand-delivered;
 *   - the only such transfer for this claim, and no other open claim on the
 *     account was pressed near it.
 *
 * Anything short of that stays where it was, for a person. A wrong guess here
 * is a stranger's money in this customer's wallet; a missed one is an
 * operator's click.
 *
 * The claim closes as EXPIRED, not REJECTED — nobody decided the customer
 * did not pay; the money was answered for. The order and its invoice close
 * the way `expire.ts` closes them, in the same transaction as the credit,
 * and the customer is told once, in the invoice's place when it is still
 * standing: both amounts, bold, and to top up the rest and pay from the
 * wallet.
 */

import { randomUUID } from 'node:crypto';
import type { D1Database } from '@shikoo/database';
import { AUTO_MATCH_MAX_TIME_DELTA_MS, MIRZABOT_SOURCE } from '@shikoo/contracts';
import { creditDepositInSession, INCOME_TX_WHERE } from '@shikoo/domain';
import * as menu from './menu.js';
import { enqueue } from './notify.js';
import { refundOrder } from './wallet.js';

/** How far back an invoice for the transfer's exact amount makes it somebody else's. */
const OTHER_INVOICE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const BATCH = 50;

interface Candidate {
  claim_id: string;
  payment_id: number;
  tx_id: string;
}

export async function creditWrongAmounts(db: D1Database, now: number = Date.now()): Promise<number> {
  const { results } = await db
    .prepare(
      `WITH due AS (
         SELECT c.id AS claim_id, c.target_financial_account_id AS account_id,
                c.paid_clicked_at AS clicked, c.expected_amount_irr AS expected,
                p.id AS payment_id
           FROM payment_claims c
           JOIN payments p ON c.external_order_id = 'shikoo:' || p.public_id
                          AND p.status = 'AWAITING_REVIEW'
          WHERE c.source_system = ?1
            AND c.status IN ('PENDING','MATCH_SUGGESTED')
            AND c.suspect_reason = 'NO_TRANSACTION_AFTER_10M'
            AND c.target_financial_account_id IS NOT NULL
            AND c.paid_clicked_at IS NOT NULL
       ),
       pairs AS (
         SELECT d.claim_id, d.payment_id, d.account_id, t.id AS tx_id, t.bank_timestamp AS at
           FROM due d
           JOIN transaction_candidates t
             ON t.financial_account_id = d.account_id
            AND t.bank_timestamp BETWEEN d.clicked - ?2 AND d.clicked + ?2
            AND t.amount_irr > 0
          WHERE ${INCOME_TX_WHERE}
            -- Also what keeps an exact amount out: the customer's own invoice
            -- asks for exactly that, and the matcher owns it.
            AND NOT EXISTS (
              SELECT 1 FROM payments p2
                JOIN payment_cards pc ON pc.card_digits = p2.assigned_card_number
               WHERE pc.financial_account_id = t.financial_account_id
                 AND p2.amount_irr = t.amount_irr
                 AND p2.created_at >  to_timestamp((t.bank_timestamp - ?3) / 1000.0)
                 AND p2.created_at <= to_timestamp((t.bank_timestamp + ?2) / 1000.0))
       )
       SELECT pr.claim_id, pr.payment_id, pr.tx_id
         FROM pairs pr
        WHERE (SELECT count(*) FROM pairs x WHERE x.claim_id = pr.claim_id) = 1
          AND NOT EXISTS (
            SELECT 1 FROM payment_claims c2
             WHERE c2.id <> pr.claim_id
               AND c2.status IN ('PENDING','MATCH_SUGGESTED','FULFILLED_UNRECONCILED')
               AND c2.target_financial_account_id = pr.account_id
               AND c2.paid_clicked_at BETWEEN pr.at - ?2 AND pr.at + ?2)
        LIMIT ?4`,
    )
    .bind(MIRZABOT_SOURCE, AUTO_MATCH_MAX_TIME_DELTA_MS, OTHER_INVOICE_LOOKBACK_MS, BATCH)
    .all<Candidate>();

  let credited = 0;
  for (const c of results ?? []) {
    if (await creditOne(db, c, now)) credited++;
  }
  return credited;
}

async function creditOne(db: D1Database, c: Candidate, now: number): Promise<boolean> {
  return db.withSession(async (tx) => {
    // Claim first, as `verifyMirzabotClaim` does, so the two cannot deadlock
    // and whichever is second finds the claim already closed.
    const claim = await tx
      .prepare(
        `SELECT id FROM payment_claims
          WHERE id = ?1 AND status IN ('PENDING','MATCH_SUGGESTED') FOR UPDATE`,
      )
      .bind(c.claim_id)
      .first<{ id: string }>();
    if (!claim) return false;

    const order = await tx
      .prepare(
        `SELECT o.id, o.public_id, o.total_irr, o.user_id, u.telegram_id,
                p.amount_irr AS expected_irr, p.invoice_message_id
           FROM payments p
           JOIN orders o ON o.id = p.order_id
           JOIN users u ON u.id = o.user_id
          WHERE p.id = ?1 AND p.status = 'AWAITING_REVIEW' AND o.status = 'AWAITING_PAYMENT'
          FOR UPDATE OF p, o`,
      )
      .bind(c.payment_id)
      .first<{
        id: number;
        public_id: string;
        total_irr: number;
        user_id: number;
        telegram_id: number;
        expected_irr: number;
        invoice_message_id: number | null;
      }>();
    if (!order) return false;

    const reason = `wrong amount for invoice ${order.public_id}`;
    const credit = await creditDepositInSession(tx, {
      transactionId: c.tx_id,
      userId: order.user_id,
      actorEmail: 'system',
      reason,
      message: null,
    });
    if (!credit.ok) return false;

    await tx
      .prepare(`UPDATE payment_claims SET status = 'EXPIRED', updated_at = ?2 WHERE id = ?1`)
      .bind(c.claim_id, now)
      .run();
    // `invoice_message_id` let go here: the message stops being an invoice,
    // and the outbox refuses to edit one that still is (`isLiveInvoice`).
    await tx
      .prepare(
        `UPDATE payments SET status = 'EXPIRED', invoice_message_id = NULL, updated_at = now()
          WHERE id = ?1`,
      )
      .bind(c.payment_id)
      .run();
    await tx
      .prepare(`UPDATE orders SET status = 'EXPIRED', updated_at = now() WHERE id = ?1`)
      .bind(order.id)
      .run();
    await tx
      .prepare(
        `UPDATE provisioning_stock SET status = 'AVAILABLE', order_id = NULL
          WHERE order_id = ?1 AND status = 'RESERVED'`,
      )
      .bind(order.id)
      .run();
    // What the invoice took from the balance comes back too (#317), so the
    // balance the customer is told is all of it.
    await refundOrder(tx, order.id, 'wrong amount paid');

    const wallet = await tx
      .prepare(`SELECT balance_irr FROM wallets WHERE user_id = ?1`)
      .bind(order.user_id)
      .first<{ balance_irr: number | string }>();
    const balanceIrr = Number(wallet?.balance_irr ?? 0);

    await enqueue(tx, {
      dedupeKey: `wrong-amount:${order.public_id}`,
      chatId: order.telegram_id,
      text: menu.wrongAmountCredited({
        expectedIrr: Number(order.expected_irr),
        paidIrr: credit.amountIrr,
        balanceIrr,
        shortIrr: Number(order.total_irr) - balanceIrr,
      }),
      editMessageId: order.invoice_message_id,
    });

    await tx
      .prepare(
        `INSERT INTO audit_logs
           (id, actor_email, actor_role, action, entity_type, entity_id,
            before_json, after_json, reason, created_at)
         VALUES (?1, NULL, 'SYSTEM', 'transaction.credited_to_wallet', 'TRANSACTION', ?2,
                 ?3::text, ?4::text, ?5, ?6)`,
      )
      .bind(
        randomUUID(),
        c.tx_id,
        JSON.stringify({ claimId: c.claim_id, invoice: order.public_id, expectedIrr: order.expected_irr }),
        JSON.stringify({ userId: order.user_id, amountIrr: credit.amountIrr, balanceIrr }),
        reason,
        now,
      )
      .run();
    return true;
  });
}
