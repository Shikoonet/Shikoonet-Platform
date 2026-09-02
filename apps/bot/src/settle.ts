/**
 * What happens after the money is confirmed.
 *
 * The reconciliation hub decides that a claim is VERIFIED — from a bank SMS
 * matched automatically, or from an admin approving it by hand. Neither of those
 * paths knows anything about orders, and they should not: the hub settles
 * claims, this file settles sales. The join between the two worlds is
 * `external_order_id`, which carries our payment's public id.
 *
 * Runs on a sweep rather than as a callback, because the deciding event happens
 * in another process entirely. A sweep also survives a restart in the middle of
 * one: the work to do is derived from the rows, never from anything held in
 * memory.
 */

import { randomUUID } from 'node:crypto';
import type { D1Database, D1DatabaseSession } from '@shikoo/database';
import * as menu from './menu.js';
import { enqueue } from './notify.js';
import { payReferralCommission } from './referral.js';
import { loadShopSettings } from './settings.js';
import { creditTopup } from './wallet.js';
import { createLogger } from '@shikoo/domain';

const log = createLogger('bot');

/**
 * A payment that arrived for an order nobody can apply it to.
 *
 * `SYSTEM` is already in the `actor_role` CHECK — this is the case that column
 * was reserved for. `entity_type`/`entity_id` are the payment rather than the
 * order, because the payment is the thing holding money and the order may not
 * exist at all.
 *
 * ponytail: an audit row, not an incident table with severity, an owner and a
 * resolution state. Nothing has ever needed to mark one of these resolved, and
 * inventing the workflow before anyone has worked one is guessing at what they
 * would want it to do. What the row must not be is lost, and it is not.
 */
async function recordIncident(tx: D1DatabaseSession, row: SettleRow): Promise<void> {
  await tx
    .prepare(
      `INSERT INTO audit_logs
         (id, actor_email, actor_role, action, entity_type, entity_id,
          before_json, after_json, reason, created_at)
       VALUES (?1, NULL, 'SYSTEM', 'PAYMENT_NEEDS_REFUND', 'payment', ?2,
               NULL, ?3::text, ?4, ?5)`,
    )
    .bind(
      randomUUID(),
      row.payment_public_id,
      JSON.stringify({
        orderId: row.order_id,
        orderStatus: row.order_status ?? 'missing',
        orderKind: row.order_kind,
        amountIrr: row.order_total_irr,
        userId: row.order_user_id,
      }),
      'payment verified against an order that was no longer awaiting payment',
      Date.now(),
    )
    .run();
}

interface SettleRow {
  payment_id: number;
  payment_public_id: string;
  order_id: number | null;
  order_status: string | null;
  order_kind: string | null;
  order_total_irr: number | null;
  order_user_id: number | null;
  telegram_id: number | null;
}

/**
 * Marks every verified-but-unsettled payment as paid, moves its order along,
 * and returns the messages the customer is owed.
 *
 * Idempotent by construction: each UPDATE carries the status it expects, so a
 * second sweep matches nothing. Nothing is remembered between runs.
 *
 * Messages are enqueued rather than sent, for the same reason handlers return
 * their replies — a message that has left cannot be recalled by a ROLLBACK, so
 * sending belongs after the commit. What is new since 2026-08-18 is that the
 * enqueue happens **inside** the transaction that settles the payment: the
 * customer being owed the news is part of the same fact as the payment being
 * paid, and the send is a separate, retryable step (`notify.ts`).
 */
export async function settleVerifiedPayments(db: D1Database): Promise<number> {
  // Read once per sweep rather than per payment: it is shop-wide configuration
  // and it is cached anyway, but a sweep of fifty payments should not ask fifty
  // times.
  //
  // `fromDatabase` is false only when this process has never once read the
  // settings — `loadShopSettings` serves the last good read otherwise — so it
  // means "the shop's rules are unknown", not "they are stale". Commission is
  // money out of the shop's wallet and cannot be taken back, so an unknown rate
  // waits for the next sweep rather than guessing at the shipped ten per cent.
  // The comment here used to argue the opposite, on the grounds that paying
  // something beats paying nothing; the third option — paying in a minute — was
  // not considered, and it is strictly better than both.
  //
  // Same shape as `provision.ts:494`, which reached this conclusion first for
  // renewal cashback. One situation, one answer, in both places now.
  const shop = await loadShopSettings(db);
  if (!shop.fromDatabase) {
    log.warn('settle.waiting', { reason: 'the commission rate has never been read' });
    return 0;
  }
  const { commissionPercent } = shop;
  /*
   * `FULFILLED_UNRECONCILED` is swept alongside `VERIFIED` for the reason the
   * status exists: the shop decided to deliver, so delivery must actually
   * happen. It is the claim's evidence that is provisional, never the
   * customer's product.
   *
   * Adding it cannot double-settle. The guard is `p.status <> 'PAID'` here plus
   * the guarded UPDATE below, so when the claim is later reconciled and becomes
   * `VERIFIED`, this sweep finds the payment already PAID and matches nothing.
   * One claim, two statuses over its life, one settlement.
   */
  const { results } = await db
    .prepare(
      `SELECT p.id            AS payment_id,
              p.public_id     AS payment_public_id,
              p.order_id      AS order_id,
              o.status        AS order_status,
              o.kind          AS order_kind,
              o.total_irr     AS order_total_irr,
              o.user_id       AS order_user_id,
              u.telegram_id   AS telegram_id
         FROM payment_claims c
         JOIN payments p ON ('shikoo:' || p.public_id) = c.external_order_id
         LEFT JOIN orders o ON o.id = p.order_id
         LEFT JOIN users  u ON u.id = p.user_id
        WHERE c.status IN ('VERIFIED', 'FULFILLED_UNRECONCILED')
          AND p.status <> 'PAID'
        ORDER BY p.id
        LIMIT 100`,
    )
    .all<SettleRow>();

  let settledCount = 0;

  for (const row of results ?? []) {
    /** The deposit this sweep credited, so the customer is told the right thing. */
    let credited: number | null = null;
    const settled = await db.withSession(async (tx) => {
      // The money genuinely arrived, so the payment is paid whatever state the
      // order is in. Guarded on the old status so a concurrent sweep — or this
      // one running twice — settles it exactly once.
      const paid = await tx
        .prepare(
          `UPDATE payments SET status = 'PAID', updated_at = now()
                   WHERE id = ?1 AND status <> 'PAID'`,
        )
        .bind(row.payment_id)
        .run();
      if (paid.meta.changes === 0) return false;

      if (row.order_id !== null) {
        // A deposit has nothing to provision, so it finishes here rather than
        // going to PAID. Two reasons, and either alone would be enough: the
        // provisioning sweep takes every PAID order and fails any without a
        // plan, and a deposit that sat in PAID would be money the customer
        // cannot see in their balance.
        const isTopup = row.order_kind === 'WALLET_TOPUP';
        const moved = await tx
          .prepare(
            isTopup
              ? `UPDATE orders SET status = 'COMPLETED', completed_at = now(), updated_at = now()
                  WHERE id = ?1 AND status = 'AWAITING_PAYMENT'`
              : `UPDATE orders SET status = 'PAID', updated_at = now()
                  WHERE id = ?1 AND status = 'AWAITING_PAYMENT'`,
          )
          .bind(row.order_id)
          .run();
        if (moved.meta.changes === 1 && isTopup) {
          // Same transaction as the status move, so the balance and the order
          // can never disagree. The credit is idempotent on its own key too, so
          // it survives this running twice for any other reason.
          if (row.order_user_id === null || row.order_total_irr === null) {
            throw new Error(`top-up order ${row.order_id} has no user or no amount`);
          }
          await creditTopup(tx, row.order_user_id, row.order_id, row.order_total_irr);
          credited = row.order_total_irr;
        }
        if (moved.meta.changes === 1 && !isTopup) {
          // Whoever brought this customer is paid here, in the same transaction
          // that made the order real — not in a sweep that could run against an
          // order that later turned out not to be paid at all.
          await payReferralCommission(tx, row.order_id, commissionPercent);
        }
        if (moved.meta.changes === 0) {
          // Somebody paid for an order that is no longer waiting to be paid —
          // cancelled, expired, or already settled by another route. The payment
          // stays PAID because the money is real, and this is a refund somebody
          // has to make.
          //
          // Written to `audit_logs` and not only to stdout. A log line is the
          // one record in this system that rotates away, and what it is holding
          // here is a customer's money with nobody assigned to it. The row is
          // durable, append-only, carries the amount and the order's state at
          // the moment it happened, and is reachable by the entity index the
          // dashboard already uses.
          //
          // In the same transaction as the settlement it belongs to, so a
          // rollback cannot leave the incident recorded for a payment that was
          // never settled, or settle one without recording it.
          await recordIncident(tx, row);
          log.error('settle.failed', {
            ref: row.payment_public_id,
            order_status: row.order_status ?? 'missing',
          });
        }
      }

      // Inside the transaction, on purpose. If this insert fails the payment
      // is not marked paid either, and the next sweep picks the row up again —
      // which is recoverable. A payment marked paid with no message owed is
      // not: nothing would ever produce it a second time.
      if (row.telegram_id !== null) {
        await enqueue(tx, {
          // The payment's public id, so this sweep running twice — or two
          // sweeps overlapping — enqueues one message.
          dedupeKey: `settle:${row.payment_public_id}`,
          chatId: row.telegram_id,
          text:
            credited === null
              ? menu.paymentConfirmed(row.payment_public_id)
              : menu.walletToppedUp(credited),
        });
      }
      return true;
    });

    if (settled) settledCount += 1;
  }

  return settledCount;
}
