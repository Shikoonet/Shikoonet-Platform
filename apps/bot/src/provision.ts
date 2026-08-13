/**
 * Turning a paid order into something the customer actually has.
 *
 * Until this file, an order reached PAID and stopped there. The money was
 * settled, the claim was verified, and nothing was delivered — the gap that
 * kept every new purchase on the PHP bot.
 *
 * A sweep, for the same reasons as `settle.ts`: the event that starts it
 * happens in another process, and work derived from rows survives a restart in
 * the middle of it.
 *
 * The order status carries the progress, so nothing is held in memory:
 *
 *     PAID ──claim──▶ PROVISIONING ──▶ COMPLETED
 *                          │
 *                          └──▶ FAILED (failure_reason says what a human must do)
 *
 * The claim into PROVISIONING is guarded on the previous status, so two sweeps
 * racing pick different orders and the same order is never provisioned twice.
 * A crash between claiming and finishing leaves the order in PROVISIONING;
 * `reclaimStalled` brings those back rather than stranding a paying customer,
 * and it is safe to do because asking the panel for the same username twice
 * returns the account that already exists (`remoteUsernameFor`).
 */

import type { D1Database } from '@shikoo/database';
import {
  adapterFor,
  remoteUsernameFor,
  type ProviderContext,
  type ProvisionRequest,
} from '@shikoo/domain';
import * as menu from './menu.js';
import type { Notification } from './settle.js';

/**
 * How long an order may sit in PROVISIONING before a later sweep takes it back.
 * Comfortably longer than the adapter's own timeout, so a slow panel is not
 * mistaken for a crashed sweep.
 */
const STALLED_MS = 5 * 60 * 1000;

interface PendingOrder {
  order_id: number;
  order_public_id: string;
  user_id: number;
  telegram_id: number | null;
  plan_id: number | null;
  plan_name: string | null;
  plan_attrs: Record<string, unknown> | null;
  volume_gb: string | number | null;
  duration_days: number | null;
  total_irr: number;
  product_name: string | null;
  provider_id: number | null;
  provider_code: string | null;
  provider_name: string | null;
  provider_kind: string | null;
  provider_base_url: string | null;
  provider_secret_ref: string | null;
  provider_config: Record<string, unknown> | null;
}

/**
 * Panel credentials, from the environment.
 *
 * `provisioning_providers.secret_ref` names a secret; it never holds one. So
 * the table stays safe to dump, log, and hand to a support agent, which is what
 * its schema comment promises. `PANEL_<REF>` is `username:password`, and only
 * the first colon splits so a password may contain one.
 */
export function credentialsFor(
  secretRef: string | null,
): { username: string; password: string } | null {
  if (!secretRef) return null;
  const raw = process.env[`PANEL_${secretRef.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  if (!raw) return null;
  const at = raw.indexOf(':');
  if (at <= 0) return null;
  return { username: raw.slice(0, at), password: raw.slice(at + 1) };
}

function toNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Orders that have been claimed but never finished — a sweep that died, a
 * process restarted mid-flight. Returning them to PAID lets the next pass pick
 * them up.
 */
async function reclaimStalled(db: D1Database, now: number): Promise<void> {
  await db
    .prepare(
      `UPDATE orders SET status = 'PAID', updated_at = now()
        WHERE status = 'PROVISIONING'
          AND updated_at < to_timestamp(?1 / 1000.0)`,
    )
    .bind(now - STALLED_MS)
    .run();
}

/**
 * Delivers every paid order that has nothing yet, and returns what the customer
 * is owed. Messages are returned rather than sent, for the reason they are
 * everywhere else here: a message that has left cannot be recalled by a
 * ROLLBACK.
 */
export async function provisionPaidOrders(
  db: D1Database,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  now: number = Date.now(),
): Promise<Notification[]> {
  await reclaimStalled(db, now);

  const { results } = await db
    .prepare(
      `SELECT o.id            AS order_id,
              o.public_id     AS order_public_id,
              o.user_id       AS user_id,
              u.telegram_id   AS telegram_id,
              o.plan_id       AS plan_id,
              o.total_irr     AS total_irr,
              pl.name         AS plan_name,
              pl.attrs        AS plan_attrs,
              pl.volume_gb    AS volume_gb,
              pl.duration_days AS duration_days,
              pr.name         AS product_name,
              pv.id           AS provider_id,
              pv.code         AS provider_code,
              pv.name         AS provider_name,
              pv.kind         AS provider_kind,
              pv.base_url     AS provider_base_url,
              pv.secret_ref   AS provider_secret_ref,
              pv.config       AS provider_config
         FROM orders o
         JOIN users u              ON u.id = o.user_id
         LEFT JOIN product_plans pl ON pl.id = o.plan_id
         LEFT JOIN products pr      ON pr.id = pl.product_id
         LEFT JOIN provisioning_providers pv ON pv.id = pr.provider_id
        WHERE o.status = 'PAID'
        ORDER BY o.id
        LIMIT 20`,
    )
    .all<PendingOrder>();

  const notifications: Notification[] = [];

  for (const row of results ?? []) {
    // Claim it. Guarded on PAID so a second sweep — or the same one running
    // twice — takes nothing.
    const claimed = await db
      .prepare(
        `UPDATE orders SET status = 'PROVISIONING', updated_at = now()
          WHERE id = ?1 AND status = 'PAID'`,
      )
      .bind(row.order_id)
      .run();
    if (claimed.meta.changes === 0) continue;

    const note = await deliver(db, row, fetchImpl, now);
    if (note !== null && row.telegram_id !== null) {
      notifications.push({ chatId: row.telegram_id, text: note });
    }
  }

  return notifications;
}

async function deliver(
  db: D1Database,
  row: PendingOrder,
  fetchImpl: typeof globalThis.fetch,
  now: number,
): Promise<string | null> {
  // An order whose plan or provider was deleted out from under it. The money is
  // real, so this is a person's problem, not a silent drop.
  if (row.plan_id === null || row.provider_id === null || row.provider_kind === null) {
    await fail(db, row.order_id, 'the plan or its provider no longer exists');
    return menu.serviceNeedsHelp(row.order_public_id);
  }

  const durationDays = row.duration_days;
  const request: ProvisionRequest = {
    username: remoteUsernameFor(row.telegram_id ?? row.user_id, row.order_public_id),
    volumeGb: toNumber(row.volume_gb),
    durationDays,
    note: `shikoo ${row.order_public_id}`,
    providerConfig: row.provider_config ?? {},
    planAttrs: row.plan_attrs ?? {},
    expiresAt: durationDays === null ? null : new Date(now + durationDays * 86_400_000),
  };

  const provider: ProviderContext = {
    id: row.provider_id,
    code: row.provider_code ?? String(row.provider_id),
    name: row.provider_name ?? 'panel',
    baseUrl: row.provider_base_url,
    credentials: credentialsFor(row.provider_secret_ref),
    config: row.provider_config ?? {},
    fetch: fetchImpl,
  };

  const result = await adapterFor(row.provider_kind).provision(request, provider);

  if (!result.ok) {
    if (result.retryable) {
      // Back to PAID so the next pass tries again. The customer is told nothing
      // yet — a panel that is briefly down is not news, and saying "there was a
      // problem" only to succeed a minute later is worse than silence.
      await db
        .prepare(`UPDATE orders SET status = 'PAID', updated_at = now() WHERE id = ?1`)
        .bind(row.order_id)
        .run();
      console.error(`[bot] order ${row.order_public_id} will retry: ${result.reason}`);
      return null;
    }
    await fail(db, row.order_id, result.reason);
    console.error(`[bot] order ${row.order_public_id} needs a human: ${result.reason}`);
    return menu.serviceNeedsHelp(row.order_public_id);
  }

  const expiresAt = request.expiresAt;
  await db.withSession(async (tx) => {
    // `order_id` is UNIQUE-free by design, so the guard is the SELECT plus the
    // fact that only one sweep can hold this order in PROVISIONING at a time.
    const already = await tx
      .prepare(`SELECT id FROM subscriptions WHERE order_id = ?1 LIMIT 1`)
      .bind(row.order_id)
      .first<{ id: number }>();
    if (!already) {
      await tx
        .prepare(
          `INSERT INTO subscriptions
             (public_id, user_id, order_id, plan_id, provider_id,
              provider_name_at_sale, plan_name_at_sale, price_irr,
              remote_ref, remote_username, subscription_url, volume_gb, duration_days,
              status, purchased_at, activated_at, expires_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9::jsonb, ?10, ?11, ?12, ?13,
                   'ACTIVE', now(), now(), ?14)`,
        )
        .bind(
          row.order_public_id,
          row.user_id,
          row.order_id,
          row.plan_id,
          row.provider_id,
          row.provider_name,
          row.plan_name ?? row.product_name ?? 'plan',
          row.total_irr,
          JSON.stringify(result.remoteRef),
          result.remoteUsername,
          // Stored, not re-fetched. The customer will ask for this link again
          // days from now, from a screen that must not make a network call.
          result.subscriptionUrl,
          toNumber(row.volume_gb),
          row.duration_days,
          expiresAt === null ? null : expiresAt.toISOString(),
        )
        .run();
    }
    await tx
      .prepare(
        `UPDATE orders SET status = 'COMPLETED', completed_at = now(), updated_at = now()
          WHERE id = ?1 AND status = 'PROVISIONING'`,
      )
      .bind(row.order_id)
      .run();
  });

  // A manual provider has no link to give. Promising one that does not exist is
  // worse than saying a person is finishing it.
  return result.subscriptionUrl === null
    ? menu.serviceBeingPrepared(row.order_public_id)
    : menu.serviceReady(result.subscriptionUrl, result.remoteUsername, expiresAt);
}

async function fail(db: D1Database, orderId: number, reason: string): Promise<void> {
  await db
    .prepare(
      `UPDATE orders SET status = 'FAILED', failure_reason = ?2, updated_at = now()
        WHERE id = ?1 AND status = 'PROVISIONING'`,
    )
    .bind(orderId, reason)
    .run();
}
