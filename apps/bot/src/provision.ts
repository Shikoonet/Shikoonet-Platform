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
  renewModeFor,
  type ProviderContext,
  type ProvisionRequest,
} from '@shikoo/domain';
import * as menu from './menu.js';
import type { InlineKeyboard } from './telegram.js';
import { enqueue } from './notify.js';
import { subscriptionOnPanelForUser } from './owned.js';
import { actionsFor, tierFor } from './serviceActions.js';
import { deliverFromStock } from './stock.js';
import { creditRenewalCashback, refundOrder } from './wallet.js';
import { loadShopSettings } from './settings.js';

/**
 * How long an order may sit in PROVISIONING before a later sweep takes it back.
 * Comfortably longer than the adapter's own timeout, so a slow panel is not
 * mistaken for a crashed sweep.
 */
const STALLED_MS = 5 * 60 * 1000;

interface PendingOrder {
  order_id: number;
  order_public_id: string;
  order_kind: string;
  /** Gigabytes or days on an add-on; 1 on everything else. */
  quantity: number;
  user_id: number;
  telegram_id: number | null;
  /** Which price column the add-on buttons on the delivery screen read from. */
  is_reseller: boolean;
  plan_id: number | null;
  target_subscription_id: number | null;
  target_username: string | null;
  target_name: string | null;
  target_volume_gb: number | null;
  target_expires_at: string | null;
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
 * What a finished order sends the customer.
 *
 * Was a bare string until 2026-08-19, when the delivery message stopped being
 * a line of text and became the service screen — which has buttons, and a QR
 * code of the subscription link ahead of it. Every other exit here still
 * returns only text, and `say` is what keeps those unchanged.
 */
export interface Delivered {
  text: string;
  keyboard?: InlineKeyboard | null;
  /** Sent as a photo before the text. In practice the subscription link. */
  qrPayload?: string | null;
}

const say = (text: string): Delivered => ({ text });

/**
 * The screen a completed purchase ends on.
 *
 * Reads the subscription the delivery just wrote rather than being handed it,
 * so the fresh-from-the-panel path and the from-the-shelf path produce the
 * same screen without either knowing about the other. Returns null when the
 * order produced no subscription row — a manual product, or a delivery that
 * only half-happened — and the caller falls back to the plain message.
 */
async function purchasedScreen(
  db: D1Database,
  row: PendingOrder,
  now: number,
): Promise<Delivered | null> {
  const sub = await db
    .prepare(`SELECT id FROM subscriptions WHERE order_id = ?1 ORDER BY id DESC LIMIT 1`)
    .bind(row.order_id)
    .first<{ id: number }>();
  if (!sub) return null;
  const service = await subscriptionOnPanelForUser(db, row.user_id, sub.id);
  if (!service) return null;
  const shop = await loadShopSettings(db);
  return {
    text: menu.serviceReadyCard(service, now),
    keyboard: menu.serviceDetailMenu(actionsFor(service, shop, tierFor(row))),
    qrPayload: service.subscription_url,
  };
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
): Promise<number> {
  await reclaimStalled(db, now);

  const { results } = await db
    .prepare(
      // A renewal's panel is the one the ACCOUNT lives on, not the one the
      // plan's product points at. They agree — the handler checks it before
      // writing the order — but the account is the thing being changed, so it
      // is the account's panel that decides where the call goes.
      `SELECT o.id            AS order_id,
              o.public_id     AS order_public_id,
              o.user_id       AS user_id,
              o.kind          AS order_kind,
              o.quantity      AS quantity,
              u.telegram_id   AS telegram_id,
              u.is_reseller   AS is_reseller,
              o.plan_id       AS plan_id,
              o.total_irr     AS total_irr,
              o.target_subscription_id AS target_subscription_id,
              s.remote_username AS target_username,
              s.plan_name_at_sale AS target_name,
              s.volume_gb     AS target_volume_gb,
              s.expires_at    AS target_expires_at,
              pl.name         AS plan_name,
              pl.attrs        AS plan_attrs,
              pl.volume_gb    AS volume_gb,
              pl.duration_days AS duration_days,
              pr.name         AS product_name,
              COALESCE(spv.id, pv.id)                 AS provider_id,
              COALESCE(spv.code, pv.code)             AS provider_code,
              COALESCE(spv.name, pv.name)             AS provider_name,
              COALESCE(spv.kind, pv.kind)             AS provider_kind,
              COALESCE(spv.base_url, pv.base_url)     AS provider_base_url,
              COALESCE(spv.secret_ref, pv.secret_ref) AS provider_secret_ref,
              COALESCE(spv.config, pv.config)         AS provider_config
         FROM orders o
         JOIN users u              ON u.id = o.user_id
         LEFT JOIN product_plans pl ON pl.id = o.plan_id
         LEFT JOIN products pr      ON pr.id = pl.product_id
         LEFT JOIN provisioning_providers pv ON pv.id = pr.provider_id
         LEFT JOIN subscriptions s  ON s.id = o.target_subscription_id
                                   AND s.user_id = o.user_id
         LEFT JOIN provisioning_providers spv ON spv.id = s.provider_id
        WHERE o.status = 'PAID'
          -- A deposit is money in, not a thing out: it has no plan, so the
          -- plan_id IS NULL guard below would fail it and tell the customer
          -- their service needs help. settleVerifiedPayments completes those
          -- itself and they never reach PAID — this is the second lock on the
          -- same door, because relying on the order two sweeps run in is not a
          -- guarantee.
          AND o.kind <> 'WALLET_TOPUP'
        ORDER BY o.id
        LIMIT 20`,
    )
    .all<PendingOrder>();

  let delivered = 0;

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
      // ponytail: enqueued just after `deliver` commits rather than inside its
      // transaction. `deliver` and `renew` reach a customer-visible message
      // from eight different exits across four transactions, and threading the
      // enqueue through all of them means editing the refund path — so the
      // narrow crash window between those two commits is accepted, knowingly,
      // and it is a local insert wide rather than a network round-trip wide.
      // What this DOES close is the failure that actually happens: a send that
      // Telegram refuses. Close the rest by moving the enqueue into each exit,
      // or by sweeping for COMPLETED/FAILED orders with no notification row.
      const chatId = row.telegram_id;
      await db.withSession((tx) =>
        enqueue(tx, {
          // One message per order: every path that produces one is terminal
          // (COMPLETED or FAILED), and the retryable path deliberately says
          // nothing at all.
          dedupeKey: `provision:${row.order_public_id}`,
          chatId,
          text: note.text,
          keyboard: note.keyboard ?? null,
          qrPayload: note.qrPayload ?? null,
        }),
      );
      delivered += 1;
    }
  }

  return delivered;
}

async function deliver(
  db: D1Database,
  row: PendingOrder,
  fetchImpl: typeof globalThis.fetch,
  now: number,
): Promise<Delivered | null> {
  // An add-on carries no plan on purpose — it is gigabytes or days on an
  // account that already exists — so it is routed before the plan check below.
  if (row.order_kind === 'ADD_VOLUME' || row.order_kind === 'ADD_TIME') {
    return renew(db, row, fetchImpl, now, {
      kind: row.order_kind,
      quantity: row.quantity,
    });
  }

  // An order whose plan or provider was deleted out from under it. The money is
  // real, so this is a person's problem, not a silent drop.
  if (row.plan_id === null || row.provider_id === null || row.provider_kind === null) {
    const refunded = await fail(db, row.order_id, 'the plan or its provider no longer exists');
    return say(menu.serviceNeedsHelp(row.order_public_id, refunded));
  }

  if (row.order_kind === 'RENEWAL') {
    return renew(db, row, fetchImpl, now);
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
      // Retrying forever is only acceptable while the panel might come back
      // soon. Past that, the shelf finishes the order — see `stock.ts` for why
      // it waits first and why a renewal may not use it.
      const fromStock = await deliverFromStock(db, row, now);
      // The shelf writes the same subscription row a panel would, so the
      // customer gets the same screen. Whether their config came from stock is
      // ours to know and theirs not to be told.
      if (fromStock !== null) return (await purchasedScreen(db, row, now)) ?? say(fromStock);
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
    const refunded = await fail(db, row.order_id, result.reason);
    console.error(`[bot] order ${row.order_public_id} needs a human: ${result.reason}`);
    return say(menu.serviceNeedsHelp(row.order_public_id, refunded));
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
  if (result.subscriptionUrl === null) return say(menu.serviceBeingPrepared(row.order_public_id));
  // The full service screen, with its buttons and its QR code. The three-line
  // `serviceReady` remains the fallback for the case the row cannot be read
  // back — the customer must get their link either way.
  return (
    (await purchasedScreen(db, row, now)) ??
    say(menu.serviceReady(result.subscriptionUrl, result.remoteUsername, expiresAt))
  );
}

/**
 * Extending a service the customer already has.
 *
 * Separate from `deliver` rather than a branch inside it, because almost
 * nothing is shared: no new subscription row is written, no new account is
 * created, and the operation is not naturally repeatable — thirty days added
 * twice is sixty. The order status is what keeps it to once, and the adapter
 * carries a second guard of its own (the order id in the account's note).
 */
interface Addon {
  kind: 'ADD_VOLUME' | 'ADD_TIME';
  quantity: number;
}

async function renew(
  db: D1Database,
  row: PendingOrder,
  fetchImpl: typeof globalThis.fetch,
  now: number,
  addon: Addon | null = null,
): Promise<Delivered | null> {
  // The subscription is joined on `user_id = o.user_id`, so a NULL here also
  // covers a renewal order pointed at somebody else's service.
  if (row.target_subscription_id === null || row.target_username === null) {
    const refunded = await fail(db, row.order_id, 'the service this renewal points at no longer exists');
    return say(menu.serviceNeedsHelp(row.order_public_id, refunded));
  }

  const serviceName = row.target_name ?? row.plan_name ?? row.product_name ?? 'سرویس';
  const adapter = adapterFor(row.provider_kind!);
  // An add-on always ADDs. RESET is a renewal's business — it hands the account
  // the plan again from zero — and applying it to "five more gigabytes" would
  // throw away everything the customer had left.
  const mode = addon === null ? renewModeFor(row.provider_config ?? {}) : 'ADD';

  if (!adapter.renew) {
    // A manual product, or a panel type nobody automated. The money is real and
    // the sale happened; what is outstanding is somebody's action.
    await complete(db, row.order_id);
    return say(menu.serviceBeingPrepared(row.order_public_id));
  }

  // The cashback rate is read here, before the panel call, and that placement
  // is the whole of the fix.
  //
  // A renewal pays the shop's percentage back into the customer's wallet, and
  // `loadShopSettings` answers a failed read with the shipped defaults — where
  // that percentage is 0. Read after the panel had already extended the
  // account, one unreadable settings row finalised the renewal with no
  // cashback, and nothing looks at a COMPLETED order again: the customer paid,
  // got their days, and quietly lost the five percent they were owed.
  //
  // Read here, the same failure costs one sweep. Nothing irreversible has
  // happened yet, so the order goes back to PAID and the next pass does the
  // whole thing properly. An add-on pays no cashback, so it does not wait on
  // this.
  let renewCashbackPercent = 0;
  if (addon === null) {
    const shop = await loadShopSettings(db);
    if (!shop.fromDatabase) {
      await db
        .prepare(`UPDATE orders SET status = 'PAID', updated_at = now() WHERE id = ?1`)
        .bind(row.order_id)
        .run();
      console.error(
        `[bot] renewal ${row.order_public_id} will retry: the cashback rate could not be read`,
      );
      return null;
    }
    renewCashbackPercent = shop.renewCashbackPercent;
  }

  const result = await adapter.renew(
    {
      username: row.target_username,
      // Zero on the dimension not being bought. In ADD mode zero means "add
      // nothing here" while null means "no limit" — the difference is what
      // stops an extra-volume purchase from removing an account's expiry.
      volumeGb: addon === null ? toNumber(row.volume_gb) : addon.kind === 'ADD_VOLUME' ? addon.quantity : 0,
      durationDays: addon === null ? row.duration_days : addon.kind === 'ADD_TIME' ? addon.quantity : 0,
      note: `shikoo ${row.order_public_id}`,
      providerConfig: row.provider_config ?? {},
      planAttrs: row.plan_attrs ?? {},
      mode,
      renewFrom: new Date(now),
    },
    {
      id: row.provider_id!,
      code: row.provider_code ?? String(row.provider_id),
      name: row.provider_name ?? 'panel',
      baseUrl: row.provider_base_url,
      credentials: credentialsFor(row.provider_secret_ref),
      config: row.provider_config ?? {},
      fetch: fetchImpl,
    },
  );

  if (!result.ok) {
    if (result.retryable) {
      await db
        .prepare(`UPDATE orders SET status = 'PAID', updated_at = now() WHERE id = ?1`)
        .bind(row.order_id)
        .run();
      console.error(`[bot] renewal ${row.order_public_id} will retry: ${result.reason}`);
      return null;
    }
    const refunded = await fail(db, row.order_id, result.reason);
    console.error(`[bot] renewal ${row.order_public_id} needs a human: ${result.reason}`);
    return say(menu.serviceNeedsHelp(row.order_public_id, refunded));
  }

  const expiresAt = result.expiresAt ?? null;
  if (addon !== null) {
    // Only what was bought. Writing the plan columns here would blank the
    // service's name and duration, because an add-on has no plan — and a
    // separate statement rather than a branch inside one, because the adapter
    // rejects a bound parameter the SQL never uses.
    await db.withSession(async (tx) => {
      await tx
        .prepare(
          `UPDATE subscriptions
              SET volume_gb      = COALESCE(?2, volume_gb),
                  expires_at     = ?3,
                  notify         = '{}'::jsonb,
                  last_synced_at = NULL,
                  updated_at     = now()
            WHERE id = ?1`,
        )
        .bind(
          row.target_subscription_id,
          result.volumeGb ?? null,
          expiresAt === null ? null : expiresAt.toISOString(),
        )
        .run();
      await tx
        .prepare(
          `UPDATE orders SET status = 'COMPLETED', completed_at = now(), updated_at = now()
            WHERE id = ?1 AND status = 'PROVISIONING'`,
        )
        .bind(row.order_id)
        .run();
    });
    return say(menu.addonApplied(addon.kind, addon.quantity, serviceName, expiresAt));
  }

  let cashbackIrr: number | null = null;

  await db.withSession(async (tx) => {
    await tx
      .prepare(
        `UPDATE subscriptions
            SET plan_id           = ?2,
                plan_name_at_sale = ?3,
                duration_days     = ?4,
                volume_gb         = ?5,
                expires_at        = ?6,
                -- RESET zeroed the counter on the panel, so the stored figure
                -- must go with it or the service reads as exhausted until the
                -- next sync. ADD leaves it alone: the quota grew, the usage
                -- did not.
                used_bytes        = CASE WHEN ?7 THEN 0 ELSE used_bytes END,
                -- The warning sweep has already told this customer their
                -- service was running out. It is not, any more.
                notify            = '{}'::jsonb,
                -- Ask the panel again sooner rather than trusting the figures
                -- above until the interval is up.
                last_synced_at    = NULL,
                status            = 'ACTIVE',
                updated_at        = now()
          WHERE id = ?1`,
      )
      .bind(
        row.target_subscription_id,
        row.plan_id,
        row.plan_name ?? row.product_name ?? serviceName,
        row.duration_days,
        result.volumeGb ?? null,
        expiresAt === null ? null : expiresAt.toISOString(),
        mode === 'RESET',
      )
      .run();
    await tx
      .prepare(
        `UPDATE orders SET status = 'COMPLETED', completed_at = now(), updated_at = now()
          WHERE id = ?1 AND status = 'PROVISIONING'`,
      )
      .bind(row.order_id)
      .run();
    // In the same transaction as COMPLETED, so a renewal that ends up rolled
    // back cannot leave a customer credited for a service they did not get.
    cashbackIrr = await creditRenewalCashback(tx, row.order_id, renewCashbackPercent);
  });

  return say(menu.serviceRenewed(serviceName, expiresAt, cashbackIrr));
}

async function complete(db: D1Database, orderId: number): Promise<void> {
  await db
    .prepare(
      `UPDATE orders SET status = 'COMPLETED', completed_at = now(), updated_at = now()
        WHERE id = ?1 AND status = 'PROVISIONING'`,
    )
    .bind(orderId)
    .run();
}

/**
 * Ends an order that cannot be delivered, and returns any credit it consumed.
 *
 * The refund is only for a payment made from the wallet. Card-to-card money sits
 * in a bank account and giving it back is a person's decision; wallet credit is
 * ours to hold, and holding it for a service that failed is keeping the
 * customer's money. Returns what was put back so the customer can be told.
 */
async function fail(db: D1Database, orderId: number, reason: string): Promise<number | null> {
  // Both statements or neither.
  //
  // They used to be two autocommits, and the window between them had no way
  // back: the order was already FAILED, so the credit that paid for it was
  // simply gone. Nothing sweeps a FAILED order — `reclaimStalled` only picks up
  // PROVISIONING — so no later cycle would have found it, and the customer is
  // not even told, because the message is built from this function's return.
  // A process killed mid-deploy is enough.
  //
  // The idempotency key already stopped a double refund. What it could not do
  // is produce the missing one.
  return db.withSession(async (tx) => {
    const ended = await tx
      .prepare(
        `UPDATE orders SET status = 'FAILED', failure_reason = ?2, updated_at = now()
          WHERE id = ?1 AND status = 'PROVISIONING'`,
      )
      .bind(orderId, reason)
      .run();
    // Guarded on this sweep being the one that ended it, so two sweeps racing
    // cannot both refund. The idempotency key would stop the second anyway; this
    // keeps the message honest as well as the ledger.
    if (ended.meta.changes === 0) return null;
    return refundOrder(tx, orderId);
  });
}
