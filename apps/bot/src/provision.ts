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

import type { D1Database, D1DatabaseSession } from '@shikoo/database';
import { randomUUID } from 'node:crypto';
import {
  adapterFor,
  groupIdsFor,
  open,
  panelSecretKey,
  remoteUsernameFor,
  renewModeFor,
  splitCredential,
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
import { createLogger } from '@shikoo/domain';

const log = createLogger('bot');

/**
 * How long an order may sit in PROVISIONING before a later sweep takes it back.
 * Comfortably longer than the adapter's own timeout, so a slow panel is not
 * mistaken for a crashed sweep.
 */
const STALLED_MS = 5 * 60 * 1000;

interface PendingOrder {
  order_id: number;
  order_public_id: string;
  /** PAID for an order to deliver; COMPLETED or FAILED for one still owed its message. */
  order_status: string;
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
  product_attrs: Record<string, unknown> | null;
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
  provider_sealed: string | null;
  provider_config: Record<string, unknown> | null;
}

/**
 * Panel credentials — from the sealed row if there is one, otherwise the
 * environment.
 *
 * `provisioning_providers` still holds no secret, which is what its schema
 * comment promises and why it stays safe to dump. What changed on 2026-08-23 is
 * that a credential may now also live sealed in `provider_secrets`, so a panel
 * can be added from «مدیریت پنل‌ها» instead of by editing the bot's environment
 * and redeploying it.
 *
 * THE SEALED ROW WINS. Not the environment, and the order is the whole point: an
 * operator who changes a panel's password in the dashboard has to see that
 * change take effect. If a stale `PANEL_<REF>` left over from before could
 * shadow it, the panel would keep failing to log in and the screen would keep
 * saying the password was saved.
 *
 * THE ENVIRONMENT STAYS. Every panel wired before this migration resolves that
 * way and must keep working across the deploy that introduces the table —
 * `PANEL_TEST_PANEL` on the practice box is exactly that case. It is the
 * fallback, not the default.
 *
 * `username:password` in both paths, split on the FIRST colon only so a
 * password may contain one.
 */
export function credentialsFor(
  secretRef: string | null,
  sealed?: string | null,
): { username: string; password: string } | null {
  if (sealed) {
    // A row that will not open is NOT the same as no credential, and they must
    // not take the same path: returning null here would send the order down the
    // «panel has no credentials» branch and refund a customer over what is
    // actually a wrong PANEL_SECRET_KEY. Let it throw — the caller logs it and
    // the order stays retryable.
    const raw = open(sealed, panelSecretKey());
    return splitCredential(raw);
  }
  if (!secretRef) return null;
  const raw = process.env[`PANEL_${secretRef.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  if (!raw) return null;
  return splitCredential(raw);
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
  // Every failure in here is the same answer: fall back to the plain message.
  //
  // This runs AFTER the transaction that marked the order COMPLETED, and the
  // caller has no try/catch — so before this catch existed, a database hiccup
  // in one of these three reads threw past the enqueue and the customer was
  // told nothing at all. They had paid, the panel had delivered, and the only
  // message about it was lost to build a nicer version of it. A screen with
  // fewer buttons is a cosmetic loss; a silent delivery is the failure this
  // whole outbox exists to prevent.
  try {
    const sub = await db
      .prepare(`SELECT id FROM subscriptions WHERE order_id = ?1 ORDER BY id DESC LIMIT 1`)
      .bind(row.order_id)
      .first<{ id: number }>();
    // A renewal or an add-on writes no new subscription; it changes the one the
    // order points at, and that is the service worth showing. Null on a fresh
    // purchase, so this changes nothing for the caller it was written for.
    const subscriptionId = sub?.id ?? row.target_subscription_id;
    if (subscriptionId === null) return null;
    const service = await subscriptionOnPanelForUser(db, row.user_id, subscriptionId);
    if (!service) return null;
    const shop = await loadShopSettings(db);
    return {
      text: menu.serviceReadyCard(service, now),
      keyboard: menu.serviceDetailMenu(actionsFor(service, shop, tierFor(row))),
      qrPayload: service.subscription_url,
    };
  } catch (err) {
    log.error('provision.screen_failed', { ref: row.order_public_id }, err);
    return null;
  }
}

/**
 * How far back the sweep will look for an order nobody was told about.
 *
 * Long enough to cover a bot that was down overnight, short enough that it can
 * never reach an order served before `bot_notifications` existed — or one the
 * data migration carries in from MySQL with its original timestamps. Both of
 * those would be greeted with a delivery message years late.
 */
const UNTOLD_WINDOW_HOURS = 24;

/**
 * Queues the one message an order gets.
 *
 * `provision:<public_id>` is the key, so the delivery path and the sweep that
 * catches what it dropped cannot both send: whichever gets there first wins and
 * the other is a no-op. A customer with no chat is written nowhere rather than
 * queued to nobody.
 */
async function tell(db: D1Database, row: PendingOrder, note: Delivered): Promise<void> {
  const chatId = row.telegram_id;
  if (chatId === null) return;
  await db.withSession((tx) =>
    enqueue(tx, {
      dedupeKey: `provision:${row.order_public_id}`,
      chatId,
      text: note.text,
      keyboard: note.keyboard ?? null,
      qrPayload: note.qrPayload ?? null,
    }),
  );
}

/**
 * What to say about an order that ended while nobody was listening.
 *
 * Rebuilt from the database rather than remembered, because the process that
 * knew is the one that died. Every branch below reads; none of them calls a
 * panel, refunds anything or writes a subscription — the work is done, and this
 * is only the sentence about it.
 */
async function untoldNote(
  db: D1Database,
  row: PendingOrder,
  now: number,
): Promise<Delivered | null> {
  if (row.order_status === 'FAILED') {
    // The refund is a ledger row with a key made of the order id, so the exact
    // amount the customer got back is still on record — which is the one number
    // `serviceNeedsHelp` needs and the one a guess must not get wrong.
    const back = await db
      .prepare(`SELECT amount_irr FROM wallet_entries WHERE idempotency_key = ?1`)
      .bind(`order:${row.order_id}:refund`)
      .first<{ amount_irr: number }>();
    return say(menu.serviceNeedsHelp(row.order_public_id, back ? Number(back.amount_irr) : null));
  }

  // COMPLETED. The screen if there is a service to show — a fresh purchase, a
  // renewal, an add-on all land here — and otherwise the honest answer for a
  // manual product, which is that a person is finishing it.
  return (
    (await purchasedScreen(db, row, now)) ?? say(menu.serviceBeingPrepared(row.order_public_id))
  );
}

/**
 * Delivers every paid order that has nothing yet, and returns what the customer
 * is owed. Messages are returned rather than sent, for the reason they are
 * everywhere else here: a message that has left cannot be recalled by a
 * ROLLBACK.
 */
/**
 * The settings a purchase sends, with the service's underneath the plan's.
 *
 * Three levels now decide what a panel is asked for, and they are the three an
 * admin actually sets: the PANEL's default, the SERVICE — پلاتینیوم, طلایی —
 * and one PLAN inside it. `pick()` in the adapter already reads plan over
 * panel; flattening the service in here puts it between them without teaching
 * every adapter about a third source.
 *
 * This is what makes a tier a tier. Before it, `group_ids` lived only on the
 * panel and on a plan, so every service on one panel provisioned into the same
 * group and a panel could sell exactly one level — which is precisely the shape
 * the shop was stuck in.
 *
 * A key present but null on the plan does NOT fall through, on purpose: an
 * admin who cleared one plan's groups means that plan sends none, not that it
 * goes back to inheriting. `pick()` reads null the same way one level up.
 */
function planAttrsFor(row: {
  plan_attrs: Record<string, unknown> | null;
  product_attrs: Record<string, unknown> | null;
}): Record<string, unknown> {
  return { ...(row.product_attrs ?? {}), ...(row.plan_attrs ?? {}) };
}

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
              o.status        AS order_status,
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
              pr.attrs        AS product_attrs,
              pl.volume_gb    AS volume_gb,
              pl.duration_days AS duration_days,
              pr.name         AS product_name,
              COALESCE(spv.id, pv.id)                 AS provider_id,
              COALESCE(spv.code, pv.code)             AS provider_code,
              COALESCE(spv.name, pv.name)             AS provider_name,
              COALESCE(spv.kind, pv.kind)             AS provider_kind,
              COALESCE(spv.base_url, pv.base_url)     AS provider_base_url,
              COALESCE(spv.secret_ref, pv.secret_ref) AS provider_secret_ref,
              -- Same COALESCE as the ref beside it: a renewal resolves against
              -- the ACCOUNT's panel, a new purchase against the plan's.
              COALESCE(sps.sealed, ps.sealed) AS provider_sealed,
              COALESCE(spv.config, pv.config)         AS provider_config
         FROM orders o
         JOIN users u              ON u.id = o.user_id
         LEFT JOIN product_plans pl ON pl.id = o.plan_id
         LEFT JOIN products pr      ON pr.id = pl.product_id
         LEFT JOIN provisioning_providers pv ON pv.id = pr.provider_id
         LEFT JOIN provider_secrets ps ON ps.provider_id = pv.id
         LEFT JOIN subscriptions s  ON s.id = o.target_subscription_id
                                   AND s.user_id = o.user_id
         LEFT JOIN provisioning_providers spv ON spv.id = s.provider_id
         LEFT JOIN provider_secrets sps ON sps.provider_id = spv.id
        WHERE
          -- A deposit is money in, not a thing out: it has no plan, so the
          -- plan_id IS NULL guard below would fail it and tell the customer
          -- their service needs help. settleVerifiedPayments completes those
          -- itself and they never reach PAID — this is the second lock on the
          -- same door, because relying on the order two sweeps run in is not a
          -- guarantee. It also has no message of its own, so it must stay out
          -- of the second branch below or every deposit gets one.
              o.kind <> 'WALLET_TOPUP'
          AND (
            o.status = 'PAID'

            -- Or: it ended, and the customer was never told.
            --
            -- The order is made terminal in one transaction and the message is
            -- queued in the next, so a process that dies between them — or an
            -- enqueue that throws — leaves somebody who paid with a delivered
            -- service and no word about it. Nothing else would ever find them:
            -- reclaimStalled only picks up PROVISIONING, and this sweep only
            -- read PAID.
            --
            -- Absence of the row IS the evidence, which holds because nothing
            -- prunes bot_notifications. If that ever changes, its retention has
            -- to stay longer than the window below.
            OR (
              o.status IN ('COMPLETED', 'FAILED')
              AND u.telegram_id IS NOT NULL
              -- Bounded, and the bound is what makes this safe to switch on at
              -- all: without it the first sweep would greet every customer
              -- served before the outbox existed, and every order the data
              -- migration carries over from MySQL.
              AND o.updated_at >= to_timestamp(?1 / 1000.0) - make_interval(hours => ?2)
              AND NOT EXISTS (
                SELECT 1 FROM bot_notifications n
                 WHERE n.dedupe_key = 'provision:' || o.public_id
              )
            )
          )
        ORDER BY o.id
        LIMIT 20`,
    )
    .bind(now, UNTOLD_WINDOW_HOURS)
    .all<PendingOrder>();

  let delivered = 0;

  for (const row of results ?? []) {
    // Already finished, and only ever owed its message. Nothing here calls a
    // panel, refunds anything, or writes a subscription: the work happened, and
    // the only thing missing is that somebody was told about it.
    if (row.order_status !== 'PAID') {
      const owed = await untoldNote(db, row, now);
      if (owed !== null) {
        await tell(db, row, owed);
        log.warn('provision.late_message', { ref: row.order_public_id });
        delivered += 1;
      }
      continue;
    }

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

    let note;
    try {
      note = await deliver(db, row, fetchImpl, now);
    } catch (err) {
      // One order must not stop the sweep. Before this, an exception here left
      // every paid order behind it unserved until the next tick — and with a
      // poison order, for ever. `LostTheClaim` is the ordinary case and is not
      // worth a stack trace: it means another sweep finished this order, which
      // is the outcome the claim exists to produce.
      if (err instanceof LostTheClaim) {
        log.warn('provision.raced', { ref: row.order_public_id });
      } else {
        log.error('provision.failed', { ref: row.order_public_id, stage: 'mid-delivery' }, err);
      }
      continue;
    }
    // The terminal success event, read back after every transaction in
    // `deliver` has committed.
    //
    // Not logged inside `complete()`, which is where it would be shorter: the
    // renewal path credits cashback *after* `complete()` in the same
    // transaction, so a failure there rolls the COMPLETED back and an event
    // announced from inside would be a delivery that never happened. The
    // repository already has that lesson written down twice — a message that
    // has left cannot be recalled by a ROLLBACK.
    //
    // With `provision.failed` beside it, the two terminal outcomes of an
    // attempt are both events an operator can find by the order number the
    // customer was given.
    const ended = await db
      .prepare(`SELECT status FROM orders WHERE id = ?1`)
      .bind(row.order_id)
      .first<{ status: string }>();
    if (ended?.status === 'COMPLETED') log.info('provision.delivered', { ref: row.order_public_id });

    if (note !== null && row.telegram_id !== null) {
      // Still enqueued just after `deliver` commits rather than inside its
      // transaction — `deliver` and `renew` reach a customer-visible message
      // from eight exits across four transactions, and the richest of those
      // messages is read back out of the row the same transaction just wrote,
      // so moving the insert inside would put three reads that are allowed to
      // fail inside a transaction that must not.
      //
      // The window is closed from the other end instead, by the branch at the
      // top of this loop: whatever is terminal and has no message gets one on
      // the next pass. Two cheap mechanisms rather than one careful one.
      await tell(db, row, note);
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
    planAttrs: planAttrsFor(row),
    expiresAt: durationDays === null ? null : new Date(now + durationDays * 86_400_000),
  };

  const provider: ProviderContext = {
    id: row.provider_id,
    code: row.provider_code ?? String(row.provider_id),
    name: row.provider_name ?? 'panel',
    baseUrl: row.provider_base_url,
    credentials: credentialsFor(row.provider_secret_ref, row.provider_sealed),
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
      await release(db, row.order_id);
      log.warn('provision.will_retry', { ref: row.order_public_id, reason: result.reason });
      return null;
    }
    const refunded = await fail(db, row.order_id, result.reason);
    log.error('provision.failed', { ref: row.order_public_id, reason: result.reason, refunded });
    return say(menu.serviceNeedsHelp(row.order_public_id, refunded));
  }

  const expiresAt = request.expiresAt;
  await db.withSession(async (tx) => {
    // The guard is in the statement, not in a read before it. It used to be a
    // SELECT and a comment arguing that only one sweep can hold an order in
    // PROVISIONING — true of the claim, and not true across `reclaimStalled`,
    // which hands a slow sweep's order to a second one while the first is still
    // inside its panel call. Both then found nothing and both inserted.
    // Migration 0027 makes that impossible; this is the statement that leans on
    // it.
    {
      await tx
        .prepare(
          `INSERT INTO subscriptions
             (public_id, user_id, order_id, plan_id, provider_id,
              provider_name_at_sale, plan_name_at_sale, price_irr,
              remote_ref, remote_username, subscription_url, volume_gb, duration_days,
              status, purchased_at, activated_at, expires_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9::jsonb, ?10, ?11, ?12, ?13,
                   'ACTIVE', now(), now(), ?14)
           ON CONFLICT (order_id) WHERE order_id IS NOT NULL DO NOTHING`,
        )
        .bind(
          row.order_public_id,
          row.user_id,
          row.order_id,
          row.plan_id,
          row.provider_id,
          row.provider_name,
          // What was sold, snapshotted at the sale. A legacy row's plan and
          // product are the same string, so those are untouched; a tiered one
          // needs both, because the plan names inside «پلاتینیوم», «طلایی» and
          // «معمولی» are sizes and three services can hold the same size. The
          // customer's «سرویس های من» is keyed off this column, so without the
          // service on it two different levels list as the same line.
          menu.soldAs(row.product_name ?? '', row.plan_name ?? ''),
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
    await complete(tx, row.order_id);
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
 * A renewal that moved the panel and then could not finish.
 *
 * The customer is refunded and told it failed, which is right — but their
 * account is not where it was, and no panel API accepts a used-traffic figure,
 * so nothing here can put it back. What this can do is stop it being invisible:
 * the order's `failure_reason` says why it stopped, never what it had already
 * done.
 *
 * Best effort on purpose. A record that could abort the refund would be worse
 * than no record.
 */
async function recordPartialRenewal(
  db: D1Database,
  row: PendingOrder,
  applied: string[],
  reason: string,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO audit_logs
           (id, actor_email, actor_role, action, entity_type, entity_id,
            before_json, after_json, reason, created_at)
         VALUES (?1, NULL, 'SYSTEM', 'RENEWAL_HALF_APPLIED', 'order', ?2,
                 NULL, ?3::text, ?4, ?5)`,
      )
      .bind(
        randomUUID(),
        row.order_public_id,
        JSON.stringify({
          applied,
          username: row.target_username,
          panel: row.provider_code,
          subscriptionId: row.target_subscription_id,
          userId: row.user_id,
        }),
        reason,
        Date.now(),
      )
      .run();
  } catch (err) {
    log.error('provision.half_applied', { ref: row.order_public_id }, err);
  }
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
    const refunded = await fail(
      db,
      row.order_id,
      'the service this renewal points at no longer exists',
    );
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
      await release(db, row.order_id);
      log.warn('provision.will_retry', {
        ref: row.order_public_id,
        reason: 'the cashback rate could not be read',
      });
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
      volumeGb:
        addon === null ? toNumber(row.volume_gb) : addon.kind === 'ADD_VOLUME' ? addon.quantity : 0,
      durationDays:
        addon === null ? row.duration_days : addon.kind === 'ADD_TIME' ? addon.quantity : 0,
      note: `shikoo ${row.order_public_id}`,
      providerConfig: row.provider_config ?? {},
      planAttrs: planAttrsFor(row),
      /*
       * The tier being renewed into — for a renewal, and never for an add-on.
       *
       * Renewing from a DIFFERENT service is already legal (`handle.ts` only
       * requires the same panel), and for a first-timers-only tier it is the
       * only way out: that service disappears from its own renewal list the
       * moment the customer owns anything. The panel account kept whatever
       * groups it was created with, so the customer paid the new tier's price
       * and went on receiving the old tier's inbounds. Nothing said so.
       *
       * An add-on buys quota or days, not a tier, and `mode` cannot make the
       * distinction — `renewModeFor` answers 'ADD' for ordinary renewals in
       * some shops. So the caller, which knows, decides.
       */
      ...(addon === null
        ? {
            groupIds: groupIdsFor({
              planAttrs: planAttrsFor(row),
              providerConfig: row.provider_config ?? {},
            }),
          }
        : {}),
      mode,
      renewFrom: new Date(now),
    },
    {
      id: row.provider_id!,
      code: row.provider_code ?? String(row.provider_id),
      name: row.provider_name ?? 'panel',
      baseUrl: row.provider_base_url,
      credentials: credentialsFor(row.provider_secret_ref, row.provider_sealed),
      config: row.provider_config ?? {},
      fetch: fetchImpl,
    },
  );

  if (!result.ok) {
    if (result.retryable) {
      await release(db, row.order_id);
      log.warn('provision.will_retry', { ref: row.order_public_id, reason: result.reason });
      return null;
    }
    // Half-done on the panel: the account was changed and the order was not.
    // Written down before the order is failed, because after that the only
    // trace is `failure_reason`, which says why it stopped and not what it had
    // already done. Same shape as `settle.ts`'s PAYMENT_NEEDS_REFUND — an audit
    // row rather than an incident table, for the same reason.
    if (result.applied !== undefined && result.applied.length > 0) {
      await recordPartialRenewal(db, row, result.applied, result.reason);
    }
    const refunded = await fail(db, row.order_id, result.reason);
    log.error('provision.failed', {
      ref: row.order_public_id,
      reason: result.reason,
      refunded,
      renewal: true,
    });
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
      await complete(tx, row.order_id);
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
    await complete(tx, row.order_id);
    // In the same transaction as COMPLETED, so a renewal that ends up rolled
    // back cannot leave a customer credited for a service they did not get.
    cashbackIrr = await creditRenewalCashback(tx, row.order_id, renewCashbackPercent);
  });

  return say(menu.serviceRenewed(serviceName, expiresAt, cashbackIrr));
}

/**
 * Hands a claimed order back for the next pass.
 *
 * `AND status = 'PROVISIONING'` is the whole of it, and it was missing until
 * 2026-08-19: the three retryable exits wrote PAID by id alone. An order this
 * sweep no longer owns — reclaimed by `reclaimStalled` and finished by another
 * sweep, or ended by `fail` — was dragged back out of its terminal state and
 * sold again. Releasing is only meaningful from the state this sweep put it in,
 * so that is the state it is guarded on.
 *
 * Silent when it changes nothing. Losing the claim is not an error: it means
 * somebody else finished the work, which is the outcome we wanted anyway.
 */
async function release(db: D1Database, orderId: number): Promise<void> {
  await db
    .prepare(
      `UPDATE orders SET status = 'PAID', updated_at = now()
        WHERE id = ?1 AND status = 'PROVISIONING'`,
    )
    .bind(orderId)
    .run();
}

/**
 * Thrown when an order moved out from under this sweep.
 *
 * Not an error in the sense that something is broken — it is two sweeps racing
 * and one of them losing, which the claim is designed to allow. What it must
 * not do is let the loser go on to write a subscription row and tell the
 * customer their service is ready, because the winner is doing that already.
 * Raised inside the transaction so everything the loser wrote rolls back.
 */
class LostTheClaim extends Error {
  constructor(orderId: number) {
    super(`order ${orderId} is no longer PROVISIONING — another sweep owns it`);
    this.name = 'LostTheClaim';
  }
}

/**
 * Moves a claimed order to COMPLETED, or gives up the whole transaction.
 *
 * The `WHERE status = 'PROVISIONING'` was here before; what was missing is
 * anyone reading the answer. A transition that changed no rows returned exactly
 * like one that changed a row, so the sweep that lost the race still wrote its
 * subscription and still told the customer.
 */
async function complete(tx: D1Database | D1DatabaseSession, orderId: number): Promise<void> {
  const done = await tx
    .prepare(
      `UPDATE orders SET status = 'COMPLETED', completed_at = now(), updated_at = now()
        WHERE id = ?1 AND status = 'PROVISIONING'`,
    )
    .bind(orderId)
    .run();
  if (done.meta.changes !== 1) throw new LostTheClaim(orderId);
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
