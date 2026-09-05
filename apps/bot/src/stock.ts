/**
 * Selling from the shelf.
 *
 * The shelf plays two parts, told apart by `immediate`:
 *
 * - For automated panels it is the outage escape. `provisionPaidOrders` handles
 *   an unreachable panel by putting the order back to PAID and trying again
 *   later. That is right for a blip and wrong for an outage: the customer has
 *   paid, and nothing arrives until the panel returns. So configs made in
 *   advance are handed out when the panel has been refusing an order for longer
 *   than `STOCK_GRACE_MS`. The shelf is refilled by hand and it is finite,
 *   which is the whole reason for the grace period — a thirty-second hiccup
 *   must not empty it.
 *
 * - For kinds with no automated adapter (ai_account, spotify, manual, …) it is
 *   the delivery itself: bulk-bought accounts wait on the shelf and the first
 *   sweep after payment hands one over, no grace — there is no panel that might
 *   come back. An empty shelf simply falls through to the manual path, exactly
 *   what those kinds did before the shelf existed.
 *
 * Only for a NEW_PURCHASE. A renewal has to extend the account the customer
 * already has, on the panel it already lives on; a different account would give
 * them a second service and quietly lose the first. See `renew()`.
 *
 * Once-only is the database's job, not this file's:
 *   - the claiming UPDATE moves exactly one AVAILABLE row to USED, and
 *     `idx_stock_one_row_per_order` refuses a second row for the same order;
 *   - it runs inside the same transaction as the subscription insert and the
 *     order's move to COMPLETED, so a failure anywhere puts the config back on
 *     the shelf instead of losing it.
 */

import type { D1Database } from '@shikoo/database';
import * as menu from './menu.js';
import { createLogger } from '@shikoo/domain';

const log = createLogger('bot');

/**
 * How long an order must have been failing before it may take from the shelf.
 *
 * Ten minutes is longer than a restart or a certificate renewal and shorter
 * than a person notices an outage and reaches a keyboard.
 */
export const STOCK_GRACE_MS = 10 * 60 * 1000;

export interface StockOrder {
  order_id: number;
  order_public_id: string;
  order_kind: string;
  user_id: number;
  plan_id: number | null;
  plan_name: string | null;
  product_name: string | null;
  provider_name: string | null;
  total_irr: number;
  /** `numeric` comes back as a string from some drivers; the column takes both. */
  volume_gb: string | number | null;
  duration_days: number | null;
}

interface StockRow {
  id: number;
  provider_id: number;
  provider_name: string | null;
  remote_username: string;
  remote_ref: Record<string, unknown> | null;
  subscription_url: string | null;
  secret: string | null;
}

export interface StockDelivery {
  text: string;
  /** True when `text` carries a password — it must reach the customer verbatim,
   * not be replaced by a drawn card that never renders `remote_ref`. */
  credential: boolean;
}

/**
 * Records that the panel refused this order, and answers how long it has been
 * refusing. The first failure is kept because every retry rewrites
 * `updated_at`, which would make the order look new forever.
 */
async function failingSinceMs(db: D1Database, orderId: number): Promise<number | null> {
  const row = await db
    .prepare(
      `UPDATE orders
          SET provision_first_failed_at = COALESCE(provision_first_failed_at, now())
        WHERE id = ?1
        RETURNING (EXTRACT(EPOCH FROM provision_first_failed_at) * 1000)::bigint AS since_ms`,
    )
    .bind(orderId)
    .first<{ since_ms: number }>();
  return row?.since_ms ?? null;
}

/**
 * Hands the order a ready config, or returns null to leave it retrying.
 *
 * Null covers every "not now": the wrong kind of order, a grace period that has
 * not elapsed, an empty shelf. The caller treats all of them the same way, so
 * they do not need telling apart here.
 */
export async function deliverFromStock(
  db: D1Database,
  row: StockOrder,
  now: number,
  immediate = false,
): Promise<StockDelivery | null> {
  // `deliver()` routes a renewal away before the panel call, so today this is
  // belt and braces — and it stays, because the day someone wires the shelf
  // into `renew()` the failure is a customer losing a service they paid for.
  if (row.order_kind !== 'NEW_PURCHASE' || row.plan_id === null) return null;

  // The immediate path is for kinds with no panel behind them: nothing has
  // failed, so nothing must be stamped as failing, and there is no outage to
  // wait out.
  if (!immediate) {
    const since = await failingSinceMs(db, row.order_id);
    if (since === null || now - since < STOCK_GRACE_MS) return null;
  }

  const expiresAt =
    row.duration_days === null ? null : new Date(now + row.duration_days * 86_400_000);

  let taken: StockRow | null = null;
  await db.withSession(async (tx) => {
    // SKIP LOCKED so two sweeps take two different configs rather than one
    // waiting on the other; the status guard is what makes each one at-most-once.
    taken =
      (await tx
        .prepare(
          `UPDATE provisioning_stock s
              SET status = 'USED', order_id = ?2, used_at = now()
            WHERE s.id = (SELECT id FROM provisioning_stock
                           WHERE plan_id = ?1 AND status = 'AVAILABLE'
                           ORDER BY id
                           LIMIT 1
                           FOR UPDATE SKIP LOCKED)
            RETURNING s.id, s.provider_id, s.remote_username, s.remote_ref, s.subscription_url,
                      s.secret`,
        )
        .bind(row.plan_id, row.order_id)
        .first<StockRow>()) ?? null;
    if (taken === null) return;

    const stock: StockRow = taken;
    const providerName = await tx
      .prepare(`SELECT name FROM provisioning_providers WHERE id = ?1`)
      .bind(stock.provider_id)
      .first<{ name: string }>();

    await tx
      .prepare(
        `INSERT INTO subscriptions
           (public_id, user_id, order_id, plan_id, provider_id,
            provider_name_at_sale, plan_name_at_sale, price_irr,
            remote_ref, remote_username, subscription_url, volume_gb, duration_days,
            status, purchased_at, activated_at, expires_at, note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9::jsonb, ?10, ?11, ?12, ?13,
                 'ACTIVE', now(), now(), ?14, ?15)`,
      )
      .bind(
        row.order_public_id,
        row.user_id,
        row.order_id,
        row.plan_id,
        stock.provider_id,
        providerName?.name ?? row.provider_name ?? 'panel',
        row.plan_name ?? row.product_name ?? 'plan',
        row.total_irr,
        // The secret rides along in remote_ref so support can find it months
        // later. It is delivered in the Telegram message and never logged.
        JSON.stringify({
          ...(stock.remote_ref ?? {}),
          ...(stock.secret === null ? {} : { secret: stock.secret }),
        }),
        stock.remote_username,
        stock.subscription_url,
        row.volume_gb,
        row.duration_days,
        expiresAt === null ? null : expiresAt.toISOString(),
        // Named so support can tell a shelf config from a panel-issued one
        // months later, when the panel has no record of this order.
        `from stock #${stock.id}`,
      )
      .run();

    const moved = await tx
      .prepare(
        `UPDATE orders SET status = 'COMPLETED', completed_at = now(), updated_at = now()
          WHERE id = ?1 AND status = 'PROVISIONING'`,
      )
      .bind(row.order_id)
      .run();
    // Somebody else moved the order while we were writing. Undo the whole thing
    // — including the config leaving the shelf — rather than sell it to nobody.
    if (moved.meta.changes !== 1) throw new Error(`order ${row.order_public_id} left PROVISIONING`);
  });

  if (taken === null) return null;
  const sold: StockRow = taken;
  log.info('stock.filled', { ref: row.order_public_id, stock_id: sold.id });
  // A link wins when a row somehow carries both: it is self-serve and the
  // password is still in remote_ref for support to hand over.
  if (sold.subscription_url !== null) {
    return {
      text: menu.serviceReady(sold.subscription_url, sold.remote_username, expiresAt),
      credential: false,
    };
  }
  return {
    // The CHECK constraint says a URL-less row has a secret.
    text: menu.accountReady(sold.remote_username, sold.secret ?? '', expiresAt),
    credential: true,
  };
}
