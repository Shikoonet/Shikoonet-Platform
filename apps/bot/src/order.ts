/**
 * Turning "I want this" into a row.
 *
 * Two rules govern everything here.
 *
 * The price is read from the database inside the same transaction that writes
 * the order. It never comes from `callback_data`, never from a message, never
 * from anything the customer can influence. What they choose is WHICH plan;
 * what it costs is not theirs to send.
 *
 * A repeated tap does not become a second order. Mirzabot writes a fresh
 * invoice per attempt, which is why production carries unpaid invoice rows
 * nobody can tell apart. Here an open order for the same plan at the same price
 * is handed back instead — the customer sees the order they already have, which
 * is also what they expect.
 */

import { randomBytes } from 'node:crypto';
import type { D1DatabaseSession } from '@shikoo/database';
import type { CatalogPlan } from './catalog.js';
import { priceForUser } from './money.js';

export interface PlacedOrder {
  publicId: string;
  totalIrr: number;
  /** True when this returned an order the customer already had. */
  reused: boolean;
}

/**
 * Ten hex characters, the shape production already uses for `payments.public_id`
 * ('b5baf9f689'), so support staff read one format everywhere. Collisions are
 * caught by the UNIQUE index rather than assumed away.
 */
function newPublicId(): string {
  return randomBytes(5).toString('hex');
}

export async function placeOrder(
  tx: D1DatabaseSession,
  userId: number,
  plan: CatalogPlan,
  discountPercent: number,
): Promise<PlacedOrder> {
  const price = priceForUser(plan.priceIrr, discountPercent);

  // Same plan, same price, still waiting to be paid. A price change makes the
  // old order stale, so it is left alone and a new one is written instead —
  // quietly charging yesterday's price is worse than a duplicate row.
  const open = await tx
    .prepare(
      `SELECT public_id, total_irr
         FROM orders
        WHERE user_id = ?1
          AND plan_id = ?2
          AND total_irr = ?3
          AND status = 'AWAITING_PAYMENT'
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .bind(userId, plan.planId, price.totalIrr)
    .first<{ public_id: string; total_irr: number }>();
  if (open) {
    return { publicId: open.public_id, totalIrr: open.total_irr, reused: true };
  }

  const row = await tx
    .prepare(
      `INSERT INTO orders
         (public_id, user_id, kind, plan_id, quantity,
          unit_price_irr, discount_irr, total_irr, status)
       VALUES (?1, ?2, 'NEW_PURCHASE', ?3, 1, ?4, ?5, ?6, 'AWAITING_PAYMENT')
       RETURNING public_id, total_irr`,
    )
    .bind(newPublicId(), userId, plan.planId, price.unitPriceIrr, price.discountIrr, price.totalIrr)
    .first<{ public_id: string; total_irr: number }>();
  if (!row) throw new Error('order insert returned no row');

  return { publicId: row.public_id, totalIrr: row.total_irr, reused: false };
}
