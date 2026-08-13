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

import type { D1Database } from '@shikoo/database';
import * as menu from './menu.js';
import { payReferralCommission } from './referral.js';
import { creditTopup } from './wallet.js';

export interface Notification {
  chatId: number;
  text: string;
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
 * Messages are returned rather than sent, for the same reason handlers return
 * their replies — a message that has left cannot be recalled by a ROLLBACK, so
 * sending belongs after the commit, in the caller.
 */
export async function settleVerifiedPayments(db: D1Database): Promise<Notification[]> {
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
        WHERE c.status = 'VERIFIED'
          AND p.status <> 'PAID'
        ORDER BY p.id
        LIMIT 100`,
    )
    .all<SettleRow>();

  const notifications: Notification[] = [];

  for (const row of results ?? []) {
    /** The deposit this sweep credited, so the customer is told the right thing. */
    let credited: number | null = null;
    const settled = await db.withSession(async (tx) => {
      // The money genuinely arrived, so the payment is paid whatever state the
      // order is in. Guarded on the old status so a concurrent sweep — or this
      // one running twice — settles it exactly once.
      const paid = await tx
        .prepare(`UPDATE payments SET status = 'PAID', updated_at = now()
                   WHERE id = ?1 AND status <> 'PAID'`)
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
          await payReferralCommission(tx, row.order_id);
        }
        if (moved.meta.changes === 0) {
          // Somebody paid for an order that is no longer waiting to be paid —
          // cancelled, expired, or already settled by another route. The payment
          // stays PAID because the money is real, and this is said out loud
          // rather than swallowed: it is a refund somebody has to make.
          console.error(
            `[bot] payment ${row.payment_public_id} verified against order ` +
              `${row.order_id}, which is ${row.order_status ?? 'missing'} — needs a human`,
          );
        }
      }
      return true;
    });

    if (settled && row.telegram_id !== null) {
      notifications.push({
        chatId: row.telegram_id,
        text:
          credited === null
            ? menu.paymentConfirmed(row.payment_public_id)
            : menu.walletToppedUp(credited),
      });
    }
  }

  return notifications;
}
