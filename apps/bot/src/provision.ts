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
import type { ReportKind } from '@shikoo/contracts';
import { randomUUID } from 'node:crypto';
import {
  adapterFor,
  isAutomated,
  groupIdsFor,
  legacyTrialSql,
  open,
  panelNoteFor,
  panelSecretKey,
  remoteUsernameFor,
  renewModeFor,
  USERNAME_SUFFIX_DEFAULT,
  USERNAME_SUFFIX_MAX,
  deliverableTrialFor,
  usernameShapeFor,
  splitCredential,
  generatePanelPassword,
  RESELLER_MAX_TOTAL_BYTES,
  resellerNote,
  resellerSaleFor,
  TIB,
  type AccountState,
  type PanelAdminWriteResult,
  type ProviderContext,
  type ProvisionOk,
  type ProvisionRequest,
  type ProvisionResult,
  wireguardConfsFromLinks,
} from '@shikoo/domain';
import { renewalPanelsFor } from './catalog.js';
import * as menu from './menu.js';
import type { InlineKeyboard } from './telegram.js';
import { enqueue, type AttachmentKind } from './notify.js';
import { subscriptionOnPanelForUser } from './owned.js';
import { actionsFor, tierFor } from './serviceActions.js';
import { deliverFromStock, failingSinceMs, STOCK_GRACE_MS, type StockDelivery } from './stock.js';
import { balanceFor, creditRenewalCashback, refundOrder, walletPaidOnOrder } from './wallet.js';
import { loadShopSettings } from './settings.js';
import { payReferralCommission, type CommissionRates } from './referral.js';
import { report } from './reports.js';
import { ownsPanelAdmin, panelLoginUrl, resellerAdapterFor } from './resellerPanel.js';
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
  telegram_username: string | null;
  /** Which price column the add-on buttons on the delivery screen read from. */
  is_reseller: boolean;
  reseller_tier: string | null;
  username_text: string | null;
  /** `bigint` arrives as a string from the driver on some paths; both are taken. */
  purchase_seq: string | number | null;
  plan_id: number | null;
  target_subscription_id: number | null;
  target_username: string | null;
  target_downgraded_at: string | null;
  target_groups_before: unknown;
  target_name: string | null;
  /** The plan the service was on before this order; null on a migrated row. */
  target_plan_id: number | null;
  target_volume_gb: number | null;
  target_expires_at: string | null;
  target_status: string | null;
  target_used_bytes: string | number | null;
  target_duration_days: number | null;
  plan_name: string | null;
  plan_attrs: Record<string, unknown> | null;
  product_attrs: Record<string, unknown> | null;
  /** The service's own topic in the reports group, or null for the kind's (0091). */
  product_thread_id: number | null;
  volume_gb: string | number | null;
  duration_days: number | null;
  user_limit: number | null;
  /** What a volume code added, frozen on the order at placement (0062). */
  bonus_volume_gb: string | number;
  total_irr: number;
  unit_price_irr: number;
  product_name: string | null;
  provider_id: number | null;
  provider_code: string | null;
  provider_name: string | null;
  provider_kind: string | null;
  provider_base_url: string | null;
  provider_secret_ref: string | null;
  provider_sealed: string | null;
  provider_config: Record<string, unknown> | null;
  /**
   * The name of the PLAN's panel row — the account's own for every renewal
   * but a tier change onto a sibling row (issue #271), where it is the tier
   * the customer just bought and the name «لوکیشن» should now show.
   */
  plan_provider_name: string | null;
  plan_provider_id: number | null;
  /** RESELLER_VOLUME: the franchise it adds terabytes to (0104). */
  target_reseller_id: number | null;
  /** RESELLER_VOLUME: the ledger total once this order was applied; NULL until then. */
  reseller_target_limit_bytes: string | number | null;
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
 * The plan's volume plus what a volume code added, to three decimals — the
 * precision of both columns and therefore of what the panel is asked for. An
 * unmetered plan stays unmetered: there is nothing to add to, and `checkCode`
 * refused the code on it anyway.
 */
function withBonus(planGb: number | null, bonus: string | number): number | null {
  if (planGb === null) return null;
  const extra = toNumber(bonus) ?? 0;
  return Math.round((planGb + extra) * 1000) / 1000;
}

/**
 * Orders that have been claimed but never finished — a sweep that died, a
 * process restarted mid-flight. Returning them to PAID lets the next pass pick
 * them up.
 *
 * One clock. `updated_at` is Postgres's `now()`, so the cut-off is too —
 * comparing it against this process's `Date.now()` (issue #181) reclaimed
 * too early or too late by however far the two machines disagree. Harmless
 * while the bot is a singleton on the database's own box; wrong the day it
 * is not, in the direction of selling one order twice.
 */
async function reclaimStalled(db: D1Database): Promise<void> {
  await db
    .prepare(
      `UPDATE orders SET status = 'PAID', updated_at = now()
        WHERE status = 'PROVISIONING'
          AND updated_at < now() - (?1 * interval '1 millisecond')`,
    )
    .bind(STALLED_MS)
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
  /** Sent as a photo, the text its caption. In practice the subscription link. */
  qrPayload?: string | null;
  /**
   * True only when this message hands a bought service to the customer.
   *
   * It gates the shop's delivery note, and it defaults to false rather than
   * true on purpose: `tell()` is the funnel for EVERY provisioning message —
   * the failure with its refund, «a person is finishing it», the trial that
   * was not available — and a note that says how to sign in belongs to none of
   * them. Appended to all of them, a refunded customer is told how to log into
   * the account they did not get. A message type added later says nothing
   * until it opts in.
   */
  sold?: boolean;
}

const say = (text: string): Delivered => ({ text });

/** `say`, for a message that hands over what was bought. See `Delivered.sold`. */
const handedOver = (text: string): Delivered => ({ text, sold: true });

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
      sold: true,
    };
  } catch (err) {
    log.error('provision.screen_failed', { ref: row.order_public_id }, err);
    return null;
  }
}

/**
 * The screen a shelf delivery ends on.
 *
 * A config link gets the same full card a panel delivery would — whether it
 * came from stock is ours to know. A password does not: the card is drawn from
 * the subscription row and never renders `remote_ref`, so replacing the
 * credential message with it would swallow the password. That message goes out
 * verbatim.
 */
async function stockedScreen(
  db: D1Database,
  row: PendingOrder,
  now: number,
  sold: StockDelivery,
): Promise<Delivered> {
  if (sold.credential) return handedOver(sold.text);
  return (await purchasedScreen(db, row, now)) ?? handedOver(sold.text);
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
  await db.withSession(async (tx) => {
    await enqueue(tx, {
      dedupeKey: `provision:${row.order_public_id}`,
      chatId,
      text: note.sold === true ? withDeliveryNote(note.text, row) : note.text,
      keyboard: note.keyboard ?? null,
      qrPayload: note.qrPayload ?? null,
    });
    // The shelf's papers — a config file, a tutorial video — after the
    // message, in the order they were filed (#377). One row each, keyed on
    // the attachment, so a file Telegram refuses is retried alone and the
    // service message is never sent twice for it. `NEW_PURCHASE` only: the
    // untold sweep rebuilds a renewal's screen with `sold: true` too, and a
    // customer renewing has had the papers since they first bought.
    if (note.sold !== true || row.order_kind !== 'NEW_PURCHASE' || row.plan_id === null) return;
    const { results } = await tx
      .prepare(`SELECT id, kind, file_id FROM shelf_attachments WHERE plan_id = ?1 ORDER BY id`)
      .bind(row.plan_id)
      .all<{ id: number; kind: AttachmentKind; file_id: string }>();
    // ponytail: a FAILED text row does not hold back its file rows; on a
    // Telegram hiccup a file may land before the retried text.
    for (const att of results ?? []) {
      await enqueue(tx, {
        dedupeKey: `provision:${row.order_public_id}:att:${att.id}`,
        chatId,
        text: '',
        file: { kind: att.kind, fileId: att.file_id },
      });
    }
  });
}

/** Long enough for a panel under load, short enough not to hold the sweep. */
const WIREGUARD_FETCH_MS = 10_000;

/**
 * The WireGuard configs, after the service message of a NEW purchase — each as
 * a QR picture the WireGuard app's camera reads, then the .conf file its
 * «Import» takes (Sam, 2026-09-22). The subscription link is still the
 * message above them; these are for the customer whose app wants a tunnel,
 * not a subscription.
 *
 * Asked of the panel here, once, rather than stored: the config carries the
 * account's private key, and the subscription URL that is stored already
 * yields it to whoever holds it. Keeping a second copy would add nothing but
 * a place to leak from. Fetched through the subscription URL, whose token is
 * the credential — no admin login, and the adapter is not involved.
 *
 * The gate is the panel's answer, not a setting. Only a PasarGuard account
 * can have `/links`, and one with no WireGuard host answers without a
 * `wireguard://` line, so a VLESS-only plan sends nothing and nobody has to
 * mark which plans are WireGuard ones.
 *
 * Never throws and never fails a delivery. The service is already the
 * customer's by the time this runs, and the subscription page still offers
 * the same config for download; a panel that does not answer costs the
 * convenience, not the sale. Nothing about the subscription is logged — the
 * URL is a credential, so a failure names the order and the status only.
 *
 * ponytail: asked once, straight after delivery. A panel that is down at
 * that moment means no config message, and the «untold» sweep that rebuilds
 * a lost service message does not ask again. Re-ask from that sweep, keyed
 * the same way, if customers turn up without their config.
 */
async function tellWireguard(
  db: D1Database,
  row: PendingOrder,
  note: Delivered,
  fetchImpl: typeof globalThis.fetch,
): Promise<void> {
  const chatId = row.telegram_id;
  // The same gate as the shelf's papers in `tell`, for the same reasons: a
  // renewing customer has had the config since they first bought.
  if (chatId === null || note.sold !== true || row.order_kind !== 'NEW_PURCHASE') return;
  try {
    const sub = await db
      .prepare(
        `SELECT s.subscription_url, pr.kind
           FROM subscriptions s
           JOIN provisioning_providers pr ON pr.id = s.provider_id
          WHERE s.order_id = ?1`,
      )
      .bind(row.order_id)
      .first<{ subscription_url: string | null; kind: string }>();
    if (sub?.subscription_url == null || sub.kind !== 'pasarguard') return;

    // `<subscription>/links`: every host of the account, one link per line.
    const url = new URL(sub.subscription_url);
    // The request carries the subscription token out and the private keys
    // back. Over plain HTTP both cross the network readable, so a panel set
    // up that way gets no config message — a warning says why, and the
    // customer still has the link (CodeRabbit on #427).
    if (url.protocol !== 'https:') {
      log.warn('provision.wireguard_unavailable', { ref: row.order_public_id, reason: 'not_https' });
      return;
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/links`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(WIREGUARD_FETCH_MS) });
    if (!res.ok) {
      log.warn('provision.wireguard_unavailable', { ref: row.order_public_id, status: res.status });
      return;
    }
    const confs = wireguardConfsFromLinks(await res.text());
    if (confs.length === 0) return;
    // One row per config, keyed on the order and its place in the panel's
    // list, so a sweep that runs twice queues each once and a file Telegram
    // refuses is retried alone.
    await db.withSession(async (tx) => {
      for (const [i, c] of confs.entries()) {
        await enqueue(tx, {
          dedupeKey: `provision:${row.order_public_id}:wg:${i}`,
          chatId,
          text: c.conf,
          qrPayload: c.conf,
          document: { name: c.fileName },
        });
      }
    });
  } catch (err) {
    // The name of the failure only: a fetch error can carry the URL.
    log.warn('provision.wireguard_unavailable', {
      ref: row.order_public_id,
      reason: err instanceof Error ? err.name : 'unknown',
    });
  }
}

/**
 * The shop's own words, appended to whatever the delivery produced.
 *
 * Set once on a service or on one of its plans — setup steps for a ChatGPT
 * account, where to point an OpenVPN client, a support handle. It rides in
 * `attrs`, so `planAttrsFor` gives a plan the power to override its service
 * and no migration was needed for either.
 *
 * Appended HERE rather than inside a message builder because this is the one
 * place every delivery passes through: the panel card, the shelf's config
 * message, the account's credentials, and the sweep that rebuilds a message
 * nobody received. Written in any one builder it would be missing from the
 * other four.
 *
 * After a blank line, always. `serviceReady` and `accountReady` both end on
 * something the customer copies — a link, a password — and anything on the
 * same line becomes part of what they copy.
 */
function withDeliveryNote(text: string, row: PendingOrder): string {
  const note = planAttrsFor(row)['delivery_note'];
  if (typeof note !== 'string' || note.trim() === '') return text;
  return `${text}\n\n${note.trim()}`;
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

  // COMPLETED, and a reseller's terabytes: there is no subscription to draw,
  // so without this the screen below would tell them a person is finishing it.
  if (row.order_kind === 'RESELLER_VOLUME') return say(await resellerVolumeNote(db, row, false));

  // COMPLETED as a reserve (0108): the service has not been touched, so its
  // card below would show the old period as if it were the renewal. The
  // sentence this order owed is the reserve's; its activation has its own.
  if (row.order_kind === 'RENEWAL') {
    const reserve = await db
      .prepare(`SELECT 1 AS reserved FROM renewal_reserves WHERE order_id = ?1`)
      .bind(row.order_id)
      .first<{ reserved: number }>();
    if (reserve) return say(menu.renewReserved(row.plan_name ?? row.product_name ?? row.target_name ?? 'سرویس'));
  }

  // COMPLETED. A shelved ACCOUNT has to be answered before the screen below,
  // for the reason `stockedScreen` exists: the card is drawn from the
  // subscription row and never renders `remote_ref`, so recovering a lost
  // message through it hands the customer their username, their expiry, and no
  // password — an account they paid for and cannot sign into. The card is
  // right for everything else, a shelved config included.
  const account = await db
    .prepare(
      `SELECT remote_username, remote_ref->>'secret' AS secret, duration_days
         FROM subscriptions
        WHERE order_id = ?1
          AND subscription_url IS NULL
          AND remote_ref->>'secret' IS NOT NULL
        ORDER BY id DESC
        LIMIT 1`,
    )
    .bind(row.order_id)
    .first<{ remote_username: string | null; secret: string; duration_days: number | null }>();
  if (account !== null) {
    return handedOver(
      menu.accountReady(
        account.remote_username ?? '',
        account.secret,
        account.duration_days,
        row.user_limit,
      ),
    );
  }

  // The screen if there is a service to show — a fresh purchase, a renewal, an
  // add-on all land here — and otherwise the honest answer for a manual
  // product, which is that a person is finishing it.
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

/**
 * What a `PendingOrder` is read with — shared by the delivery sweep and the
 * sweep that applies reserved renewals, so the two cannot disagree about which
 * panel an account lives on.
 *
 * A renewal's panel is the one the ACCOUNT lives on, not the one the plan's
 * product points at. They agree — the handler checks it before writing the
 * order — but the account is the thing being changed, so it is the account's
 * panel that decides where the call goes.
 */
const PENDING_COLUMNS = `o.id            AS order_id,
              o.public_id     AS order_public_id,
              o.status        AS order_status,
              o.user_id       AS user_id,
              o.kind          AS order_kind,
              o.quantity      AS quantity,
              o.username_text AS username_text,
              -- Which purchase of this customer's this order is, for
              -- «متن پنل + آیدی عددی + شمارهٔ خرید». Counted here rather than
              -- stored anywhere, and the shape of the count is the whole point.
              --
              -- NOT ROW_NUMBER() OVER (PARTITION BY o.user_id ORDER BY o.id),
              -- which is the obvious way to write this and is wrong: a window
              -- function runs AFTER the WHERE and the LIMIT 20 below, so it
              -- would number the rows inside this sweep's batch. A customer's
              -- second-ever purchase, arriving alone, would be «1» — the name
              -- their first account already has, and the adapter answers that
              -- with success and their old config.
              --
              -- A correlated subquery is evaluated per row against the whole
              -- table, which is the question actually being asked.
              (SELECT count(*) FROM orders o2
                WHERE o2.user_id = o.user_id
                  AND o2.kind = 'NEW_PURCHASE'
                  AND o2.id <= o.id)
              -- Plus what they bought from the PHP bot, which carries no order
              -- at all: the migration builds orders only from service_other,
              -- which is renewals and add-ons. Without this the first purchase
              -- made here would reuse the name of a migrated account.
              --
              -- A constant per customer, and that is what makes it safe: the
              -- only subscriptions with no order_id are the migrated ones --
              -- the shelf writes one — nothing updates that column, and the
              -- migration runs once, before this bot sells anything. Legacy
              -- rows appearing AFTER an order exists would move that order's
              -- number, so a second import into a live shop is the thing this
              -- must never see.
              + (SELECT count(*) FROM subscriptions s2
                  WHERE s2.user_id = o.user_id AND s2.order_id IS NULL)
                                                                  AS purchase_seq,
              u.telegram_id   AS telegram_id,
              u.username      AS telegram_username,
              u.is_reseller   AS is_reseller,
              u.reseller_tier AS reseller_tier,
              o.plan_id       AS plan_id,
              o.total_irr     AS total_irr,
              o.unit_price_irr AS unit_price_irr,
              o.target_subscription_id AS target_subscription_id,
              s.remote_username AS target_username,
              s.plan_name_at_sale AS target_name,
              s.plan_id       AS target_plan_id,
              s.volume_gb     AS target_volume_gb,
              s.expires_at    AS target_expires_at,
              -- What «both volume and time left» is judged on (hasBothLeft).
              s.status        AS target_status,
              s.used_bytes    AS target_used_bytes,
              s.duration_days AS target_duration_days,
              s.downgraded_at AS target_downgraded_at,
              s.groups_before_downgrade AS target_groups_before,
              pl.name         AS plan_name,
              pl.attrs        AS plan_attrs,
              pr.attrs        AS product_attrs,
              pr.report_thread_id AS product_thread_id,
              pl.volume_gb    AS volume_gb,
              pl.duration_days AS duration_days,
              pl.user_limit   AS user_limit,
              o.bonus_volume_gb AS bonus_volume_gb,
              pr.name         AS product_name,
              -- The order's OWN panel is last, and last is what makes it safe to
              -- add: only a trial and a reseller's volume (0104) set
              -- orders.provider_id, neither has a plan or a service to resolve
              -- a panel through, and for every other kind the column is NULL,
              -- so no existing row can change which panel it resolves to.
              COALESCE(spv.id, pv.id, opv.id)                     AS provider_id,
              COALESCE(spv.code, pv.code, opv.code)               AS provider_code,
              COALESCE(spv.name, pv.name, opv.name)               AS provider_name,
              COALESCE(spv.kind, pv.kind, opv.kind)               AS provider_kind,
              COALESCE(spv.base_url, pv.base_url, opv.base_url)   AS provider_base_url,
              COALESCE(spv.secret_ref, pv.secret_ref, opv.secret_ref) AS provider_secret_ref,
              -- Same COALESCE as the ref beside it: a renewal resolves against
              -- the ACCOUNT's panel, a new purchase against the plan's, a trial
              -- against the one it named.
              COALESCE(sps.sealed, ps.sealed, ops.sealed) AS provider_sealed,
              COALESCE(spv.config, pv.config, opv.config)         AS provider_config,
              pv.name                                             AS plan_provider_name,
              pv.id                                               AS plan_provider_id,
              o.target_reseller_id                                AS target_reseller_id,
              o.reseller_target_limit_bytes                       AS reseller_target_limit_bytes`;

const PENDING_FROM = `FROM orders o
         JOIN users u              ON u.id = o.user_id
         LEFT JOIN product_plans pl ON pl.id = o.plan_id
         LEFT JOIN products pr      ON pr.id = pl.product_id
         LEFT JOIN provisioning_providers pv ON pv.id = pr.provider_id
         LEFT JOIN provider_secrets ps ON ps.provider_id = pv.id
         LEFT JOIN subscriptions s  ON s.id = o.target_subscription_id
                                   AND s.user_id = o.user_id
         LEFT JOIN provisioning_providers spv ON spv.id = s.provider_id
         LEFT JOIN provider_secrets sps ON sps.provider_id = spv.id
         LEFT JOIN provisioning_providers opv ON opv.id = o.provider_id
         LEFT JOIN provider_secrets ops ON ops.provider_id = opv.id`;

export async function provisionPaidOrders(
  db: D1Database,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  now: number = Date.now(),
): Promise<number> {
  await reclaimStalled(db);

  const { results } = await db
    .prepare(
      `SELECT ${PENDING_COLUMNS}
         ${PENDING_FROM}
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
              -- An imported order was delivered, and its customer told, by the
              -- bot it was imported from; "nobody told them" is not a question
              -- this sweep can ask about it. The window below was believed to
              -- cover this and did not: the importer never set updated_at, so
              -- on 2026-09-16 all 10,920 imported orders looked "finished in
              -- the last 24 hours" and the production bot began greeting the
              -- shop's whole history, twenty customers a cycle.
              AND o.legacy_ref IS NULL
              -- Bounded, and the bound is what makes this safe to switch on at
              -- all: without it the first sweep would greet every customer
              -- served before the outbox existed.
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
    if (ended?.status === 'COMPLETED') {
      log.info('provision.delivered', { ref: row.order_public_id });
      /*
       * The reports group, in the topic for this kind of order.
       *
       * Read from the same `orders` status as the event above, so a report is
       * never sent for a delivery that did not happen — and OUTSIDE `deliver`'s
       * transactions, so a report that cannot be queued cannot roll a delivered
       * service back. `enqueue` dedupes on the order's public id, so a sweep
       * that runs twice produces one message.
       */
      const shop = await loadShopSettings(db);
      if (shop.reportChatId !== null && row.telegram_id !== null) {
        const [kind, text] = await reportFor(db, row, now);
        await db.withSession((tx) =>
          report(tx, shop, kind, row.order_public_id, text, row.product_thread_id),
        );
      }
    }

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
      await tellWireguard(db, row, note, fetchImpl);
      delivered += 1;
    }
  }

  return delivered;
}

/**
 * The account name for this order — the four-character shape Sam asked for,
 * lengthened only when this shop has already given that exact name to a
 * DIFFERENT order on the same panel.
 *
 * Four characters of the order id leave two of one customer's orders a
 * 1-in-65,536 chance of the same name. A collision is not silent: migration
 * 0051 refuses the second subscription row with 23505, `fail` runs, and the
 * customer's money comes back with «سرویس نیاز به بررسی دارد» — a paid order
 * lost to bad luck. So the name is checked against `subscriptions` first. A
 * row for THIS order is not a collision (a retry after a half-finished
 * provisioning must find its own account), and the set of other orders is
 * fixed by the time this one runs, so every retry lands on the same answer.
 * Only the order-suffixed modes reach the loop; `PANEL_TEXT_SEQ` ignores the
 * length and returns on the first pass.
 */
async function freeRemoteUsername(
  db: D1Database,
  row: PendingOrder,
  shape: ReturnType<typeof usernameShapeFor>,
): Promise<string> {
  const telegramId = row.telegram_id ?? row.user_id;
  let name = '';
  for (let len = USERNAME_SUFFIX_DEFAULT; len <= USERNAME_SUFFIX_MAX; len += 2) {
    const candidate = remoteUsernameFor(telegramId, row.order_public_id, shape, len);
    // A mode without a suffix (PANEL_TEXT_SEQ) gives the same name at every
    // length; nothing longer to try, and the check below already ran on it.
    if (candidate === name) break;
    name = candidate;
    const taken = await db
      .prepare(
        `SELECT 1 AS taken FROM subscriptions
          WHERE provider_id = ?1 AND remote_username = ?2 AND order_id IS DISTINCT FROM ?3
          LIMIT 1`,
      )
      .bind(row.provider_id, name, row.order_id)
      .first<{ taken: number }>();
    if (!taken) return name;
  }
  // Every length was taken. At ten characters the suffix is the whole public
  // id, which is unique per order, so this is reachable only by a stored row
  // that is not this shop's doing; the insert below (0051) refuses it loudly.
  return name;
}

async function deliver(
  db: D1Database,
  row: PendingOrder,
  fetchImpl: typeof globalThis.fetch,
  now: number,
): Promise<Delivered | null> {
  // A reseller's terabytes have no plan and no service either — they are more
  // `data_limit` on a panel ADMIN (#474) — so they are routed first too.
  if (row.order_kind === 'RESELLER_VOLUME') return deliverResellerVolume(db, row, fetchImpl, now);

  // An add-on carries no plan on purpose — it is gigabytes or days on an
  // account that already exists — so it is routed before the plan check below.
  if (row.order_kind === 'ADD_VOLUME' || row.order_kind === 'ADD_TIME') {
    return renew(db, row, fetchImpl, now, {
      kind: row.order_kind,
      quantity: row.quantity,
    });
  }

  /*
   * A trial has no plan and can never be given one: its size is the PANEL's
   * setting, and the panel is named by `orders.provider_id` rather than found
   * through a plan. Everything after this is the ordinary purchase path.
   *
   * Re-read here rather than trusted from the moment the customer tapped,
   * because those are two different transactions and an admin may have
   * switched the trial off in between. Failing is right when that happens —
   * nothing was charged, so there is nothing to refund, and handing out a
   * free account on a panel whose trial was just withdrawn is the wrong way
   * to be wrong.
   *
   * Either door — the shop button or the support bot — may have written it;
   * `deliverableTrialFor` answers for both.
   */
  const trial =
    row.order_kind === 'TRIAL' ? deliverableTrialFor(row.provider_config ?? {}) : null;
  if (trial !== null && !trial.enabled) {
    // `fail` gives the quota back, which is what makes «سهمیهٔ شما مصرف نشد»
    // in the message below a true sentence rather than a polite one.
    await fail(db, row.order_id, 'this panel no longer offers a trial');
    return say(menu.trialNotAvailable());
  }

  // An order whose plan or provider was deleted out from under it. The money is
  // real, so this is a person's problem, not a silent drop.
  if (
    (row.plan_id === null && trial === null) ||
    row.provider_id === null ||
    row.provider_kind === null
  ) {
    const refunded = await fail(db, row.order_id, 'the plan or its provider no longer exists');
    return say(menu.serviceNeedsHelp(row.order_public_id, refunded));
  }

  if (row.order_kind === 'RENEWAL') {
    return renew(db, row, fetchImpl, now);
  }

  // The commission rate, read before anything irreversible — the same
  // shape, for the same reason, as the cashback rate in renew(): a rate that
  // cannot be read costs one sweep, never the referrer's money.
  const shop = await loadShopSettings(db);
  if (!shop.fromDatabase) {
    await release(db, row, now);
    log.warn('provision.will_retry', {
      ref: row.order_public_id,
      reason: 'the commission rate could not be read',
    });
    return null;
  }

  /*
   * HOURS, not days, and that is why `duration_days` stays null on a trial.
   *
   * Legacy stores `time_usertest` in hours (`index.php:3063` adds `+N hours`)
   * while rendering it into a `{day}` placeholder one line later. Rounding 12
   * hours up to «1 روز» to fit an integer column would repeat exactly that
   * lie on our own screen, so the expiry is computed from the hours and the
   * day column is left empty. `expires_at` is what every screen reads.
   */
  const durationDays = trial === null ? row.duration_days : null;
  const volumeGb =
    trial === null ? withBonus(toNumber(row.volume_gb), row.bonus_volume_gb) : trial.volumeGb;
  const expiresAt =
    trial === null
      ? durationDays === null
        ? null
        : new Date(now + durationDays * 86_400_000)
      : new Date(now + trial.durationHours! * 3_600_000);
  const shape = // «روش ساخت نام کاربری». The suffix is still cut from the order's
    // public id in every mode, so every mode is still reproducible by a retry.
    usernameShapeFor(
        row.provider_config ?? {},
        row.telegram_username,
        row.username_text,
        // Only a purchase carries a purchase number.
        //
        // `purchase_seq` counts NEW_PURCHASE orders, so a TRIAL inherits the
        // number of whatever the customer bought last — and two trials share
        // one. On a panel set to PANEL_TEXT_SEQ that asks for the SAME account
        // name twice: the adapter finds the existing account and answers
        // `alreadyExisted`, the insert then hits
        // `idx_subscription_one_per_panel_account`, and the customer's trial
        // is refunded with «سرویس نیاز به بررسی دارد». Every time.
        //
        // Null is already the documented «could not count it» path and falls
        // back to the order's own public id, which is unique by construction.
        row.order_kind === 'NEW_PURCHASE' ? toNumber(row.purchase_seq) : null,
      );
  const request: ProvisionRequest = {
    username: await freeRemoteUsername(db, row, shape),
    volumeGb,
    durationDays,
    // What the admin reads on the panel: `5524701349 | mazuni_rezashon | buy`.
    note: panelNoteFor(
      row.telegram_id ?? row.user_id,
      row.telegram_username,
      trial === null ? 'buy' : 'usertest',
    ),
    providerConfig: row.provider_config ?? {},
    planAttrs: planAttrsFor(row),
    expiresAt,
    // A sale is held until the first connection (#325); a trial is not a sale.
    onHold: trial === null,
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

  // A kind with no automated adapter has no panel to ask — it has a shelf, and
  // ONLY a shelf. Bulk-bought accounts (OpenVPN, ai_account, spotify, …) are
  // delivered from stock on the first sweep, no grace: nothing is failing,
  // there is nothing to wait out. An empty shelf used to fall through to the
  // manual adapter, which marked the order COMPLETED and told the customer a
  // person was finishing it — money taken, no account, and a queue no screen
  // showed. Sam, 2026-09-15: «اگر اکانتی موجود نبود … پول نگیره». `place()`
  // now holds a row for every invoice, so a paid purchase reaching an empty
  // shelf is an order from before 0063 or a hand-edited shelf — and the honest
  // answer is the one a refusing panel gets: FAILED, refunded where the money
  // came from the wallet, and a person for the rest.
  if (!isAutomated(row.provider_kind) && row.order_kind === 'NEW_PURCHASE') {
    const sold = await deliverFromStock(db, row, now, true);
    if (sold !== null) return stockedScreen(db, row, now, sold);
    const refunded = await fail(db, row.order_id, 'shelf_empty');
    log.error('provision.failed', { ref: row.order_public_id, reason: 'shelf_empty', refunded });
    return say(menu.serviceNeedsHelp(row.order_public_id, refunded));
  }

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
      if (fromStock !== null) return stockedScreen(db, row, now, fromStock);
      // Back to PAID so the next pass tries again — and, once the outage has
      // gone on long enough, the customer hears about it. Both live in
      // `release`, which is the one funnel all three retryable exits pass
      // through; the first version of this put the notice here, which covered
      // the purchase path and left renewals and add-ons silent for ever.
      await release(db, row, now);
      log.warn('provision.will_retry', { ref: row.order_public_id, reason: result.reason });
      return null;
    }
    const refunded = await fail(db, row.order_id, result.reason);
    log.error('provision.failed', { ref: row.order_public_id, reason: result.reason, refunded });
    return say(menu.serviceNeedsHelp(row.order_public_id, refunded));
  }

  // The insert can now be REFUSED, and the refusal has to be caught here.
  //
  // Migration 0051 makes «one account on a panel belongs to one subscription» a
  // unique index, and an index is not a `DO NOTHING`: a second subscription for
  // the same `(provider_id, remote_username)` raises 23505 and this transaction
  // throws. Left to escape, that throw is not a loud failure — it is a silent
  // loop. The order stays PROVISIONING, `reclaimStalled` hands it back to PAID,
  // the next sweep computes the same name, and it is refused again, for ever,
  // with the customer's money taken and nothing on any screen.
  //
  // So it lands where every other unrecoverable provisioning failure lands:
  // `fail()`, which marks the order FAILED and refunds it in one transaction,
  // and the customer is told. The name collision is a bug in the shop's naming
  // — two orders that resolved to one account — and the money is not ours to
  // keep while somebody works out which.
  //
  // The `ON CONFLICT (order_id)` inside stays exactly as it is. It answers a
  // DIFFERENT question — «has this order already got a subscription» — and
  // widening it to swallow the new index would put the double sale back, silent
  // again, which is the whole thing 0051 exists to stop.
  try {
    await writeSubscription(
      db,
      row,
      result,
      // What was sold, snapshotted at the sale. A legacy row's plan and product
      // are the same string, so those are untouched; a tiered one needs both,
      // because the plan names inside «پلاتینیوم», «طلایی» and «معمولی» are
      // sizes and three services can hold the same size. The customer's
      // «سرویس های من» is keyed off this column, so without the service on it
      // two different levels list as the same line.
      trial === null
        ? menu.soldAs(row.product_name ?? '', row.plan_name ?? '')
        : menu.TRIAL_SERVICE_NAME,
      volumeGb,
      durationDays,
      expiresAt,
      referralRates(shop),
      result.held === true,
    );
  } catch (err) {
    if (!isDuplicatePanelAccount(err)) throw err;
    const refunded = await fail(db, row.order_id, 'this panel account already belongs to another subscription');
    log.error(
      'provision.duplicate_account',
      { ref: row.order_public_id, username: result.remoteUsername, refunded },
      err,
    );
    return say(menu.serviceNeedsHelp(row.order_public_id, refunded));
  }

  // A manual provider has no link to give. Promising one that does not exist is
  // worse than saying a person is finishing it.
  if (result.subscriptionUrl === null) return say(menu.serviceBeingPrepared(row.order_public_id));
  // The full service screen, with its buttons and its QR code. The three-line
  // `serviceReady` remains the fallback for the case the row cannot be read
  // back — the customer must get their link either way.
  return (
    (await purchasedScreen(db, row, now)) ??
    handedOver(
      menu.serviceReady(
        result.subscriptionUrl,
        result.remoteUsername,
        // A held account has no date yet — the panel stamps it at first use.
        result.held === true ? null : expiresAt,
      ),
    )
  );
}

/**
 * Whether a driver error is the panel-account index from 0051, and not some
 * other unique violation.
 *
 * Matched on the index NAME rather than on the error code alone: 23505 is also
 * what `public_id` and the one-subscription-per-order index raise, and refunding
 * a customer because their order was inserted twice would be the wrong answer
 * to the right code. `packages/db` carries the driver's message through with the
 * statement, which is what makes this readable at all.
 */
function isDuplicatePanelAccount(err: unknown): boolean {
  return String(err).includes('idx_subscription_one_per_panel_account');
}

/** The subscription row and the order's completion, in one transaction. */
async function writeSubscription(
  db: D1Database,
  row: PendingOrder,
  result: { remoteUsername: string; remoteRef: unknown; subscriptionUrl: string | null },
  planNameAtSale: string,
  volumeGb: number | null,
  durationDays: number | null,
  expiresAt: Date | null,
  commission: CommissionRates,
  /**
   * The account was created `on_hold` (#325): the row is ON_HOLD, has no
   * `activated_at`, and — the part that matters — no `expires_at`. The date
   * is not known until the customer connects; `now + days` would be a date
   * that is wrong by exactly as long as they wait, and «ours wins» in
   * `sync.ts` would then defend the wrong date forever. NULL is the honest
   * value, and `sync.ts` fills it from the panel once the panel has stamped
   * it — the same path the imported services take. `duration_days` still
   * says what was sold.
   */
  onHold = false,
): Promise<void> {
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
                   ?15, now(), CASE WHEN ?15 = 'ON_HOLD' THEN NULL ELSE now() END, ?14)
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
          planNameAtSale,
          row.total_irr,
          JSON.stringify(result.remoteRef),
          result.remoteUsername,
          // Stored, not re-fetched. The customer will ask for this link again
          // days from now, from a screen that must not make a network call.
          result.subscriptionUrl,
          volumeGb,
          durationDays,
          onHold ? null : expiresAt === null ? null : expiresAt.toISOString(),
          onHold ? 'ON_HOLD' : 'ACTIVE',
        )
        .run();
    }
    await complete(tx, row.order_id, commission);
  });
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
 * Putting a downgraded account back on what it was sold.
 *
 * ## Why a renewal needs no call here and an add-on does
 *
 * `adapter.renew` is already handed `groupIds` for a renewal — that was built
 * so renewing INTO a different tier moves the account onto the new tier's
 * groups — so a renewal has already undone the downgrade by the time this
 * runs, and all that is left is clearing the marker.
 *
 * An add-on is deliberately NOT given `groupIds`: it buys quota or days, not a
 * tier, and sending them would move an account somebody had placed by hand.
 * That exact carve-out is what leaves a downgraded service extended and still
 * throttled, so the add-on path makes the one extra call.
 *
 * ## Which groups
 *
 * What the account was on before the downgrade, when that was captured. When
 * it was not — the sweep moved the account and died before writing it down —
 * the plan's own groups, which is exactly what a fresh purchase of the same
 * plan would produce. Never an empty list: PasarGuard reads that as «no
 * group», which strips every inbound.
 *
 * Best effort about the PANEL call, and that is deliberate: a customer who has
 * just paid must not be told their renewal failed because the account is on the
 * wrong groups. The marker is a different question, and it used to be cleared
 * unconditionally — which was wrong in the one case that matters.
 *
 * `viaPanel` false means "the adapter already carried the groups". For a
 * renewal it usually has, but `groupIdsFor` answers undefined when neither the
 * plan nor the panel names any, and `renew` then omits `group_ids` from the PUT
 * on purpose (an empty array tells PasarGuard the account belongs to no group,
 * which strips every inbound). So on a panel that has `downgrade_group_ids` and
 * sells plans without groups, the renewal left the account sitting on the
 * downgrade groups — and clearing the marker erased the only record that it was
 * ever moved. A paid customer, permanently on the slow inbound, with nothing to
 * find them by.
 *
 * So the marker now goes only when a restore actually happened, or when there
 * was provably nothing to restore. Anything else leaves it standing, and the
 * next renewal tries again.
 */
async function restoreGroups(
  db: D1Database,
  row: PendingOrder,
  fetchImpl: typeof globalThis.fetch,
  /**
   * The adapter's own call already carried the groups, so the account is back
   * where it belongs and this only has to clear the marker.
   *
   * Passed rather than inferred from the order's kind, which is what it used to
   * be. «It is a renewal, so the PUT carried group_ids» is true only when there
   * were group ids to carry, and the caller is the one that knows.
   */
  alreadyRestored: boolean,
): Promise<void> {
  if (row.target_downgraded_at === null || row.target_subscription_id === null) return;

  let restored = alreadyRestored;
  if (!restored && row.target_username !== null && row.provider_kind !== null) {
    const stored = Array.isArray(row.target_groups_before)
      ? row.target_groups_before
          .map((v) => (typeof v === 'number' ? v : Number(v)))
          .filter((v) => Number.isSafeInteger(v) && v > 0)
      : [];
    const fallback = groupIdsFor({
      planAttrs: planAttrsFor(row),
      providerConfig: row.provider_config ?? {},
    });
    const groupIds =
      stored.length > 0
        ? stored
        : Array.isArray(fallback)
          ? fallback.map((v) => Number(v)).filter((v) => Number.isSafeInteger(v) && v > 0)
          : [];
    const adapter = adapterFor(row.provider_kind);
    if (adapter.act && groupIds.length > 0) {
      const result = await adapter.act(
        { kind: 'SET_GROUPS', username: row.target_username, groupIds },
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
      if (result.ok) restored = true;
      else {
        log.warn('downgrade.restore_refused', {
          ref: row.order_public_id,
          reason: result.reason,
        });
      }
    }
  }

  if (!restored) {
    // The marker stays, and that is the point of it staying. It is the only
    // record that this account was moved onto the downgrade groups, it is what
    // keeps `groups_before_downgrade` from being overwritten, and it is what
    // gives the next renewal something to try again with. Clearing it here —
    // which is what this function did until now — left a paying customer on
    // the downgrade inbound with nothing left to find them by.
    log.error('downgrade.restore_pending', {
      ref: row.order_public_id,
      subscription: row.target_subscription_id,
      consequence: 'the account is still on the downgrade groups',
    });
    return;
  }

  await db
    .prepare(
      `UPDATE subscriptions
          SET downgraded_at = NULL, groups_before_downgrade = NULL, updated_at = now()
        WHERE id = ?1`,
    )
    .bind(row.target_subscription_id)
    .run();
}

/**
 * A reseller's terabytes onto their panel admin (#474).
 *
 * ## Our row is the ledger, the panel is its mirror
 *
 * `reseller_accounts.data_limit_bytes` says what this reseller has bought, and
 * the order adds to it ONCE: under the row's lock, in the transaction that
 * stamps `orders.reseller_target_limit_bytes`, guarded on that stamp still
 * being NULL. Then the panel is told the ledger's CURRENT total — never the
 * number this order stamped.
 *
 * That is what makes every retry harmless. The first design read the panel's
 * limit, added the order and wrote the sum back; a FAILED order retried from
 * the dashboard after a newer order had landed would then have written its old
 * sum over the newer one and taken back volume that was paid for. Sending the
 * ledger's total instead means a retry can only ever repeat the latest figure.
 * A retryable failure keeps the stamp and the next attempt only mirrors; a
 * definite one goes through `fail()`, which gives the terabytes back to the
 * ledger in the same transaction and clears the stamp, so a retry applies
 * them afresh.
 *
 * ## A reseller with no panel yet
 *
 * PENDING: the first paid order creates the admin, under the name the
 * operator chose, with a random password nobody is shown — the reseller asks
 * for one with «🔑 رمز جدید». A 409 on a retried create is accepted only when
 * the admin carries this reseller's note AND Telegram id, i.e. only when it is
 * the one an earlier attempt made.
 *
 * Every check `checkReady` made before the order existed is made again here:
 * that one spared the reseller a transfer, this one is the guard.
 */
async function deliverResellerVolume(
  db: D1Database,
  row: PendingOrder,
  fetchImpl: typeof globalThis.fetch,
  now: number,
): Promise<Delivered | null> {
  const give = async (reason: string): Promise<Delivered> => {
    const refunded = await fail(db, row.order_id, reason);
    log.error('provision.failed', { ref: row.order_public_id, reason, refunded });
    return say(menu.serviceNeedsHelp(row.order_public_id, refunded));
  };
  const retryLater = async (reason: string): Promise<null> => {
    await release(db, row, now);
    log.warn('provision.will_retry', { ref: row.order_public_id, reason });
    return null;
  };
  const refused = (result: { reason: string; retryable: boolean }) =>
    result.retryable ? retryLater(result.reason) : give(result.reason);

  if (row.provider_id === null || row.provider_kind === null || row.target_reseller_id === null) {
    return give('the reseller order names no panel');
  }
  if (row.telegram_id === null) return give('the reseller has no Telegram id');
  const adapter = resellerAdapterFor(row.provider_kind);
  const sale = resellerSaleFor(row.provider_config ?? {});
  if (adapter === null) return give('this panel kind cannot sell reseller volume');
  if (sale === null) return give('this panel no longer sells to resellers');

  // The commission rates `complete()` needs, read before anything irreversible
  // for the same reason `deliver` reads them first. A reseller order pays no
  // commission (`referral.ts` pays on NEW_PURCHASE and RENEWAL only), but the
  // one function every COMPLETED passes through takes the rates.
  const shop = await loadShopSettings(db);
  if (!shop.fromDatabase) return retryLater('the commission rate could not be read');

  const account = await db
    .prepare(
      `SELECT id, status, panel_admin_username FROM reseller_accounts
        WHERE id = ?1 AND user_id = ?2`,
    )
    .bind(row.target_reseller_id, row.user_id)
    .first<{ id: number; status: string; panel_admin_username: string }>();
  if (!account || account.status === 'CLOSED') return give('the reseller account is closed');

  const provider: ProviderContext = {
    id: row.provider_id,
    code: row.provider_code ?? String(row.provider_id),
    name: row.provider_name ?? 'panel',
    baseUrl: row.provider_base_url,
    credentials: credentialsFor(row.provider_secret_ref, row.provider_sealed),
    config: row.provider_config ?? {},
    fetch: fetchImpl,
  };
  const username = account.panel_admin_username;
  const botLogin = provider.credentials?.username ?? null;

  // An admin that already exists is checked before its ledger moves, and its
  // own limit is what an unseeded ledger starts from.
  let seed: number | null = null;
  if (account.status !== 'PENDING') {
    const found = await adapter.getPanelAdmin(provider, username);
    if (!found.ok) return refused(found);
    if (found.admin === null) return give(`the panel has no admin named ${username}`);
    if (!ownsPanelAdmin(found.admin, row.telegram_id, sale, botLogin)) {
      return give(`admin ${username} is not provably this reseller's`);
    }
    if (found.admin.dataLimitBytes === null || found.admin.dataLimitBytes <= 0) {
      return give(`admin ${username} is unlimited on the panel`);
    }
    seed = found.admin.dataLimitBytes;
  } else if (sale.roleId === null) {
    return give('no reseller role is configured on this panel');
  }

  if (row.reseller_target_limit_bytes === null) {
    const bytes = Number(row.quantity) * TIB;
    const applied = await db.withSession(async (tx) => {
      if (seed !== null) {
        await tx
          .prepare(
            `UPDATE reseller_accounts SET data_limit_bytes = ?2, updated_at = now()
              WHERE id = ?1 AND data_limit_bytes IS NULL`,
          )
          .bind(account.id, seed)
          .run();
      }
      // The row lock this UPDATE takes is what puts two orders for one
      // reseller one behind the other. The ceiling keeps the total a number
      // JavaScript still reads back exactly.
      const total = await tx
        .prepare(
          `UPDATE reseller_accounts
              SET data_limit_bytes = COALESCE(data_limit_bytes, 0) + ?2, updated_at = now()
            WHERE id = ?1 AND COALESCE(data_limit_bytes, 0) + ?2 <= ?3
          RETURNING data_limit_bytes`,
        )
        .bind(account.id, bytes, RESELLER_MAX_TOTAL_BYTES)
        .first<{ data_limit_bytes: string | number }>();
      if (!total) return false;
      const stamped = await tx
        .prepare(
          `UPDATE orders SET reseller_target_limit_bytes = ?2, updated_at = now()
            WHERE id = ?1 AND status = 'PROVISIONING' AND reseller_target_limit_bytes IS NULL`,
        )
        .bind(row.order_id, total.data_limit_bytes)
        .run();
      // Another sweep owns this order now; everything above rolls back.
      if (stamped.meta.changes !== 1) throw new LostTheClaim(row.order_id);
      return true;
    });
    if (!applied) return give('the reseller total would pass the largest exact byte count');
  }

  // The mirror. Read back after every write, and sent again when the ledger
  // moved meanwhile — so a slow PUT from this order can never land after a
  // newer order's and leave the panel behind what was sold. Three rounds is
  // generous: a change here needs two sweeps delivering one reseller at once.
  let created = false;
  for (let round = 0; round < 3; round++) {
    const ledger = await db
      .prepare(`SELECT status, data_limit_bytes FROM reseller_accounts WHERE id = ?1`)
      .bind(account.id)
      .first<{ status: string; data_limit_bytes: string | number | null }>();
    const total = Number(ledger?.data_limit_bytes ?? NaN);
    if (!ledger || !Number.isSafeInteger(total) || total <= 0) {
      return give('the reseller ledger holds no volume to send');
    }
    let write: PanelAdminWriteResult;
    if (ledger.status === 'PENDING') {
      write = await adapter.createPanelAdmin(provider, {
        username,
        password: generatePanelPassword(),
        roleId: sale.roleId!,
        dataLimitBytes: total,
        telegramId: row.telegram_id,
        note: resellerNote(account.id),
      });
      if (!write.ok && write.conflict) {
        // Ours from an earlier attempt, or somebody else's — only the note and
        // the Telegram id together can tell.
        const found = await adapter.getPanelAdmin(provider, username);
        if (!found.ok) return refused(found);
        const mine =
          found.admin !== null &&
          found.admin.note === resellerNote(account.id) &&
          found.admin.telegramId === row.telegram_id;
        if (!mine) {
          return give(
            found.admin === null
              ? 'the panel refused the new admin (409) and has none by that name'
              : `the panel already has an admin named ${username}`,
          );
        }
        write = await adapter.setPanelAdmin(provider, username, { dataLimitBytes: total });
      }
      if (!write.ok) return refused(write);
      // Read back: a panel on SQLite creates an admin with NO role when the id
      // is wrong, and «created» would then hand a reseller an admin nobody can
      // check again.
      const back = await adapter.getPanelAdmin(provider, username);
      if (!back.ok) return refused(back);
      if (back.admin === null || !ownsPanelAdmin(back.admin, row.telegram_id, sale, botLogin)) {
        return give(`the admin created for ${username} does not carry the reseller role`);
      }
      await db
        .prepare(
          // The term from the sweep's own clock, not the database's: the
          // meter compares `expires_at` with ITS bound `now`, and two clocks
          // on one deadline is the drift `resellerMeter.ts` documents.
          `UPDATE reseller_accounts
              SET status = 'ACTIVE',
                  expires_at = COALESCE(expires_at,
                    CASE WHEN ?2::int IS NULL THEN NULL
                         ELSE to_timestamp(?3 / 1000.0) + make_interval(days => ?2::int) END),
                  updated_at = now()
            WHERE id = ?1 AND status = 'PENDING'`,
        )
        .bind(account.id, sale.termDays, now)
        .run();
      created = true;
    } else {
      write = await adapter.setPanelAdmin(provider, username, { dataLimitBytes: total });
      if (!write.ok) return refused(write);
    }
    const after = await db
      .prepare(`SELECT data_limit_bytes FROM reseller_accounts WHERE id = ?1`)
      .bind(account.id)
      .first<{ data_limit_bytes: string | number | null }>();
    if (Number(after?.data_limit_bytes ?? NaN) === total) break;
  }

  await complete(db, row.order_id, referralRates(shop));
  return say(await resellerVolumeNote(db, row, created));
}

/**
 * What a delivered reseller order tells the reseller — read from the rows, so
 * the sweep that finds a delivery nobody heard about says the same thing.
 */
async function resellerVolumeNote(
  db: D1Database,
  row: PendingOrder,
  created: boolean,
): Promise<string> {
  const account = await db
    .prepare(
      `SELECT ra.panel_admin_username, ra.data_limit_bytes,
              pv.base_url AS provider_base_url, pv.config AS provider_config
         FROM reseller_accounts ra
         JOIN provisioning_providers pv ON pv.id = ra.provider_id
        WHERE ra.id = ?1`,
    )
    .bind(row.target_reseller_id)
    .first<{
      panel_admin_username: string;
      data_limit_bytes: string | number | null;
      provider_base_url: string | null;
      provider_config: Record<string, unknown> | null;
    }>();
  return menu.resellerVolumeDone({
    publicId: row.order_public_id,
    username: account?.panel_admin_username ?? '',
    addedTb: Number(row.quantity),
    totalBytes: account?.data_limit_bytes === null ? null : Number(account?.data_limit_bytes),
    created,
    loginUrl: account ? panelLoginUrl(account) : null,
  });
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

  /*
   * The panel, asked here as well as in `deliver`.
   *
   * `deliver` routes an add-on to this function BEFORE its own «the plan or
   * its provider no longer exists» check, because an add-on legitimately has
   * no plan. That put a service whose panel row had been deleted on a path
   * with no provider guard at all: `adapterFor(null!)` fell through to the
   * manual adapter, which has no `renew`, and the branch below completed the
   * order with «a person is finishing it». The money was kept, the gigabytes
   * were never added, and no `failure_reason` recorded any of it.
   *
   * Failing is the same answer every other undeliverable order gets, and it
   * is the one that refunds.
   */
  if (row.provider_id === null || row.provider_kind === null) {
    const refunded = await fail(db, row.order_id, 'the panel this service lives on no longer exists');
    return say(menu.serviceNeedsHelp(row.order_public_id, refunded));
  }

  const serviceName = row.target_name ?? row.plan_name ?? row.product_name ?? 'سرویس';
  const adapter = adapterFor(row.provider_kind!);
  // An add-on always ADDs. RESET is a renewal's business — it hands the account
  // the plan again from zero — and applying it to "five more gigabytes" would
  // throw away everything the customer had left.
  //
  // A tier change — the plan on a sibling row of the same address (issue
  // #271) — is RESET whatever the row says: the new tier is given whole and
  // the old one's remainder burns. Sam's decision 2, 2026-09-17; the intro
  // under the tier list said so.
  const tierChange =
    addon === null && row.plan_provider_id !== null && row.plan_provider_id !== row.provider_id;
  // Asked again here, with the same rule the list used: the order carries no
  // panel snapshot, and between checkout and this sweep a product can be
  // moved to another panel from the dashboard. A plan whose row no longer
  // shares the account's address is not this account's tier any more.
  if (tierChange && !(await renewalPanelsFor(db, row.provider_id!)).includes(row.plan_provider_id!)) {
    const refunded = await fail(db, row.order_id, 'the plan is no longer on the panel this service lives on');
    return say(menu.serviceNeedsHelp(row.order_public_id, refunded));
  }
  const mode = tierChange ? 'RESET' : addon === null ? renewModeFor(row.provider_config ?? {}) : 'ADD';

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
  const shop = await loadShopSettings(db);
  if (!shop.fromDatabase) {
    await release(db, row, now);
    log.warn('provision.will_retry', {
      ref: row.order_public_id,
      reason: 'the cashback and commission rates could not be read',
    });
    return null;
  }
  // An add-on pays no cashback; it does pay the referrer, like any order.
  const renewCashbackPercent = addon === null ? shop.renewCashbackPercent : 0;

  if (!adapter.renew) {
    // A manual product, or a panel type nobody automated. The money is real and
    // the sale happened; what is outstanding is somebody's action.
    await complete(db, row.order_id, referralRates(shop));
    return say(menu.serviceBeingPrepared(row.order_public_id));
  }

  // Sam, 2026-09-26: «تمدید موقعی معنی پیدا می‌کنه که یا حجم تموم شده یا
  // زمان». With both still left, the renewal waits for this period to end
  // instead of burning what is left of it. Judged on our row, not the panel:
  // reserving then needs no panel at all, and a row the sync has not caught up
  // with yet corrects itself — `activateReserves` asks the panel within its
  // next round and applies it. Only where that sweep can see a quota run out
  // (`accountStates`); elsewhere a reserve would wait for the date alone.
  if (addon === null && adapter.accountStates && menu.hasBothLeft(targetOf(row), now)) {
    return reserveRenewal(db, row, shop, renewCashbackPercent, row.plan_name ?? row.product_name ?? serviceName);
  }

  const result = await applyOnPanel(db, row, fetchImpl, now, mode, addon);

  if (!result.ok) {
    if (result.retryable) {
      await release(db, row, now);
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
    /**
     * What the ROW ends up holding, which is what the customer is told.
     *
     * `GREATEST` below can keep our stored date instead of the panel's, and
     * before this the message still quoted the panel's — so the one case the
     * guard exists for was also the one case the screen disagreed with the
     * database. Read back rather than recomputed, so the two cannot drift.
     */
    let storedExpiry: Date | null = expiresAt;
    // Only what was bought. Writing the plan columns here would blank the
    // service's name and duration, because an add-on has no plan — and a
    // separate statement rather than a branch inside one, because the adapter
    // rejects a bound parameter the SQL never uses.
    await db.withSession(async (tx) => {
      const kept = await tx
        .prepare(
          // GREATEST, never a plain assignment, and the reason is the same one
          // sync.ts gives for COALESCE-ing the expiry: a panel clock that is
          // wrong must not be able to shorten what a customer paid for.
          //
          // The adapter answers an add-on with the account's expiry AS THE
          // PANEL HOLDS IT — for ADD_VOLUME it adds no days at all, so it hands
          // back exactly what it read. A shelf-delivered account is the case
          // where those two disagree by construction: stock.ts writes
          // now + duration_days on OUR row while the pre-made account on the
          // panel still carries whatever it was loaded with, often nothing.
          // Buying five gigabytes then moved the customer's expiry backwards,
          // or erased it, and their next ADD_TIME anchored from the past.
          //
          // GREATEST ignores a NULL argument, so a panel that names no date
          // leaves ours exactly as it was — which is what a missing answer
          // means. This belongs on the add-on statement alone: the RESET
          // renewal below is allowed to move the date, because that is what
          // renewing from zero is.
          `UPDATE subscriptions
              SET volume_gb      = COALESCE(?2, volume_gb),
                  expires_at     = GREATEST(?3::timestamptz, expires_at),
                  -- The adapter just sent «status: active» to the panel, so a
                  -- row the customer had switched off follows it (#366).
                  -- ON_HOLD stays: the panel kept that one held.
                  status         = CASE WHEN status = 'DISABLED' THEN 'ACTIVE' ELSE status END,
                  notify         = '{}'::jsonb,
                  last_synced_at = NULL,
                  updated_at     = now()
            WHERE id = ?1
          RETURNING expires_at`,
        )
        .bind(
          row.target_subscription_id,
          result.volumeGb ?? null,
          expiresAt === null ? null : expiresAt.toISOString(),
        )
        .first<{ expires_at: string | null }>();
      storedExpiry = kept?.expires_at == null ? null : new Date(kept.expires_at);
      await complete(tx, row.order_id, referralRates(shop));
    });
    return say(menu.addonApplied(addon.kind, addon.quantity, serviceName, storedExpiry));
  }

  let cashbackIrr: number | null = null;

  await db.withSession(async (tx) => {
    await writeRenewal(tx, row, mode, result, now, serviceName);
    await complete(tx, row.order_id, referralRates(shop));
    // In the same transaction as COMPLETED, so a renewal that ends up rolled
    // back cannot leave a customer credited for a service they did not get.
    cashbackIrr = await creditRenewalCashback(tx, row.order_id, renewCashbackPercent);
  });

  // The plan just written onto the row, not the one it was read with: a
  // customer who moved to another service was told the old one's name.
  // Changed only when both ids are known — a migrated row has none, and its
  // legacy name differs from the catalog's even on the same plan.
  const changed = row.target_plan_id !== null && row.target_plan_id !== row.plan_id;
  return say(
    menu.serviceRenewed(row.plan_name ?? row.product_name ?? serviceName, expiresAt, cashbackIrr, changed),
  );
}

/** The service a renewal points at, in the shape `menu.hasBothLeft` reads. */
function targetOf(row: PendingOrder) {
  return {
    status: row.target_status ?? '',
    volume_gb: toNumber(row.target_volume_gb),
    used_bytes: toNumber(row.target_used_bytes),
    expires_at: row.target_expires_at,
    duration_days: row.target_duration_days,
  };
}

/**
 * The panel half of a renewal, shared by a renewal applied now and a reserve
 * applied later (`activateReserves`): the request, the call, and — once it
 * landed — putting a downgraded account back on its groups. Nothing here
 * touches an order or money.
 */
async function applyOnPanel(
  db: D1Database,
  row: PendingOrder,
  fetchImpl: typeof globalThis.fetch,
  now: number,
  mode: ReturnType<typeof renewModeFor>,
  addon: Addon | null,
): Promise<ProvisionResult> {
  const adapter = adapterFor(row.provider_kind!);
  /*
   * The groups this renewal will actually send, computed once so two decisions
   * can be made from the same answer: what goes in the PUT, and whether
   * `restoreGroups` still has work to do afterwards.
   *
   * `renew` omits the key entirely when this is empty, because an empty array
   * tells PasarGuard the account belongs to no group. So «it is a renewal» is
   * not the same statement as «the groups were sent», and reading it as if it
   * were is what stranded a downgraded account on a paid renewal.
   */
  const rawGroupIds = groupIdsFor({
    planAttrs: planAttrsFor(row),
    providerConfig: row.provider_config ?? {},
  });
  const renewalGroupIds = addon === null ? rawGroupIds : undefined;
  const renewalCarriedGroups =
    addon === null && Array.isArray(rawGroupIds) && rawGroupIds.length > 0;

  const result = await adapter.renew!(
    {
      // Both callers have already refused a renewal with no account to point at.
      username: row.target_username!,
      // Zero on the dimension not being bought. In ADD mode zero means "add
      // nothing here" while null means "no limit" — the difference is what
      // stops an extra-volume purchase from removing an account's expiry.
      // A plain renewal carries the plan's volume plus what a volume code
      // added. An add-on never reads the plan (and its order holds 0 anyway).
      volumeGb:
        addon === null
          ? withBonus(toNumber(row.volume_gb), row.bonus_volume_gb)
          : addon.kind === 'ADD_VOLUME'
            ? addon.quantity
            : 0,
      durationDays:
        addon === null ? row.duration_days : addon.kind === 'ADD_TIME' ? addon.quantity : 0,
      // The order id stays in the note: the adapter reads it back to know this
      // extension was already applied (`marzban.ts`, `renew`).
      note: panelNoteFor(
        row.telegram_id ?? row.user_id,
        row.telegram_username,
        `${addon === null ? 'renew' : 'extra'} ${row.order_public_id}`,
      ),
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
      ...(addon === null ? { groupIds: renewalGroupIds } : {}),
      mode,
      renewFrom: new Date(now),
    },
    providerContextOf(row, fetchImpl),
  );

  // The service is live again, so it must not still be sitting on the groups
  // it was moved to when it ended. A renewal has already been sent the plan's
  // groups by the adapter; an add-on has not, and needs the call.
  if (result.ok) await restoreGroups(db, row, fetchImpl, renewalCarriedGroups);
  return result;
}

/**
 * The service row once a renewal has landed on the panel, and the snapshot of
 * what it was — written first, because the UPDATE overwrites what it falls
 * back on. Shared by a renewal applied now and a reserve applied later; no
 * order and no money, so each caller decides what else its transaction holds.
 */
async function writeRenewal(
  tx: D1DatabaseSession,
  row: PendingOrder,
  mode: ReturnType<typeof renewModeFor>,
  result: ProvisionOk,
  now: number,
  serviceName: string,
): Promise<void> {
  const expiresAt = result.expiresAt ?? null;
  await snapshotRenewal(tx, row.order_id, row.target_subscription_id!, mode, result.before, now);
  await tx
    .prepare(
      `UPDATE subscriptions
          SET plan_id           = ?2,
              plan_name_at_sale = ?3,
              -- The name of the row the plan lives on, for the «لوکیشن»
              -- line and the dashboard's «پنل» column: on a sibling row's
              -- plan (issue #271) the account stays under its own admin but
              -- was sold as the other tier, and both screens should say so.
              -- On the account's own row it is that row's current name —
              -- which an imported service never had: its text is the legacy
              -- location, and a renewal is the sale that brings it up to
              -- date (Sam, 2026-09-20).
              provider_name_at_sale = COALESCE(?8, provider_name_at_sale),
              duration_days     = ?4,
              volume_gb         = ?5,
              expires_at        = ?6,
              -- RESET zeroed the counter on the panel, so the stored figure
              -- must go with it or the service reads as exhausted until the
              -- next sync. ADD leaves it alone: the quota grew, the usage
              -- did not.
              --
              -- ADD_VOLUME_RESET_TIME is in the second group even though it
              -- restarts the clock, and it has to be: the adapter issues no
              -- POST /reset for it, for the reason spelled out there. This
              -- condition and that one are the same decision, and they must
              -- keep agreeing or our used_bytes and the panel's disagree
              -- until the next sync.
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
      row.plan_provider_name,
    )
    .run();
}

/**
 * Paid for while the service still had both volume and time (Sam,
 * 2026-09-26): the order becomes a sale now — COMPLETED, because the money
 * arrived now and every report counts a sale by `completed_at` — with its
 * referral commission and cashback, and the panel is left alone until
 * `activateReserves` finds the current period over.
 *
 * The insert is the guard. One waiting reserve per service is the partial
 * unique index in 0108, so a second renewal paid for the same service in the
 * same minute inserts nothing, and is failed and refunded here.
 */
async function reserveRenewal(
  db: D1Database,
  row: PendingOrder,
  shop: Parameters<typeof referralRates>[0],
  cashbackPercent: number,
  serviceName: string,
): Promise<Delivered> {
  let cashbackIrr: number | null = null;
  const reserved = await db.withSession(async (tx) => {
    const inserted = await tx
      .prepare(
        // The plan as it is sold today, frozen: the reserve may wait weeks,
        // and the plan can be edited from the dashboard meanwhile.
        `INSERT INTO renewal_reserves (order_id, subscription_id, volume_gb, duration_days)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT DO NOTHING
         RETURNING order_id`,
      )
      .bind(row.order_id, row.target_subscription_id, toNumber(row.volume_gb), row.duration_days)
      .first<{ order_id: number }>();
    if (!inserted) return false;
    await complete(tx, row.order_id, referralRates(shop));
    cashbackIrr = await creditRenewalCashback(tx, row.order_id, cashbackPercent);
    return true;
  });
  if (!reserved) {
    const refunded = await fail(db, row.order_id, 'this service already has a renewal waiting');
    log.warn('provision.reserve_taken', { ref: row.order_public_id, refunded });
    return say(menu.serviceNeedsHelp(row.order_public_id, refunded));
  }
  log.info('provision.reserved', { ref: row.order_public_id });
  return say(menu.renewReserved(serviceName, cashbackIrr));
}

/** How often `activateReserves` runs. Sam: «سریع», whether time or volume runs out. */
export const RESERVE_CHECK_MS = 30_000;

/**
 * The share of its quota a waiting service must have used, by the last sync,
 * before the sweep asks the panel about it directly.
 *
 * ponytail: a customer who burns through more than the last fifth of their
 * quota inside one sync interval is caught by the sync instead, up to ten
 * minutes late. Lower this and the panel is asked about more accounts.
 */
const RESERVE_NEAR_SHARE = 0.8;

/** Reserves looked at per round. */
const RESERVE_BATCH = 50;

type ReservedOrder = PendingOrder & {
  reserve_volume_gb: string | number | null;
  reserve_duration_days: number | null;
};

/** The panel's word that this account's period is over. */
function ranOut(state: AccountState, now: number): boolean {
  return (
    state.status === 'limited' ||
    state.status === 'expired' ||
    (state.limitBytes !== null && state.usedBytes !== null && state.usedBytes >= state.limitBytes) ||
    (state.expiresAtMs !== null && state.expiresAtMs <= now)
  );
}

/**
 * Applies every reserved renewal whose service has run out — volume or time,
 * whichever came first — as the plan was sold, from now (RESET, whatever the
 * panel's mode: Sam's decision 2).
 *
 * «Run out» is our own row first: the date is exact, and the synced usage is
 * at most one sync old. A service close to its quota by that usage, or never
 * synced, is read off the panel as it is now (`accountStates`), so a quota
 * that runs out between two syncs is seen within one round of this sweep.
 *
 * The order was COMPLETED when the reserve was made, so nothing here touches
 * money: no commission, no cashback, no second sale. `status = 'WAITING'` in
 * the UPDATE is the claim — a second pass over the same reserve changes
 * nothing, and a panel write retried after a crash is recognised by the
 * adapter from the order id in the account's note.
 */
export async function activateReserves(
  db: D1Database,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  now: number = Date.now(),
): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT ${PENDING_COLUMNS},
              rr.volume_gb     AS reserve_volume_gb,
              rr.duration_days AS reserve_duration_days
         ${PENDING_FROM}
         JOIN renewal_reserves rr ON rr.order_id = o.id
        WHERE rr.status = 'WAITING'
          AND (
                -- Out of time by our own date: nothing to ask.
                (s.expires_at IS NOT NULL AND s.expires_at <= to_timestamp(?1 / 1000.0))
                -- No longer a service that could be running.
             OR s.status NOT IN ('ACTIVE', 'ON_HOLD', 'DISABLED')
                -- Out of volume by the last sync, close to it, or never synced.
             OR (s.volume_gb > 0
                 AND (s.used_bytes IS NULL OR s.used_bytes >= s.volume_gb * ?2::numeric * ?3::numeric))
          )
          -- Run out by our own figures first. A reserve that is only close to
          -- its quota comes back every round until it runs out, and without
          -- this fifty of those filled the batch and a reserve whose date had
          -- passed never got into it (CodeRabbit on #488). One close to its
          -- quota that loses its place is caught once the sync says it ran out.
        ORDER BY ((s.expires_at IS NOT NULL AND s.expires_at <= to_timestamp(?1 / 1000.0))
                  OR s.status NOT IN ('ACTIVE', 'ON_HOLD', 'DISABLED')
                  OR (s.volume_gb > 0 AND s.used_bytes >= s.volume_gb * ?2::numeric)) DESC NULLS LAST,
                 rr.created_at
        LIMIT ?4`,
    )
    .bind(now, GB, RESERVE_NEAR_SHARE, RESERVE_BATCH)
    .all<ReservedOrder>();

  const due: ReservedOrder[] = [];
  const ask = new Map<number, ReservedOrder[]>();
  for (const row of results ?? []) {
    if (!menu.hasBothLeft(targetOf(row), now)) due.push(row);
    else if (row.provider_id !== null) ask.set(row.provider_id, [...(ask.get(row.provider_id) ?? []), row]);
  }
  for (const group of ask.values()) {
    const first = group[0]!;
    try {
      const states = await adapterFor(first.provider_kind!).accountStates?.(
        providerContextOf(first, fetchImpl),
        group.map((row) => row.target_username!),
      );
      for (const row of group) {
        const state = states?.get(row.target_username!);
        if (state && ranOut(state, now)) due.push(row);
      }
    } catch (err) {
      // A sealed credential that will not open. The next round asks again.
      log.error('reserve.check_failed', { panel: first.provider_code }, err);
    }
  }

  let applied = 0;
  // A panel that is not answering is not asked again this round: every
  // reserve on it would wait out the same timeout, inside the poll loop.
  const down = new Set<number | null>();
  for (const reserved of due) {
    if (down.has(reserved.provider_id)) continue;
    // The plan as it was sold, not as it reads today.
    const row: PendingOrder = {
      ...reserved,
      volume_gb: reserved.reserve_volume_gb,
      duration_days: reserved.reserve_duration_days,
    };
    const serviceName = row.plan_name ?? row.product_name ?? row.target_name ?? 'سرویس';
    let result: ProvisionResult;
    try {
      result =
        row.provider_kind === null || row.target_username === null
          ? { ok: false, reason: 'the service this reserve points at is no longer on a panel', retryable: false }
          : await applyOnPanel(db, row, fetchImpl, now, 'RESET', null);
    } catch (err) {
      log.error('reserve.failed', { ref: row.order_public_id, stage: 'panel' }, err);
      down.add(row.provider_id);
      continue;
    }
    if (!result.ok) {
      if (result.retryable) {
        down.add(row.provider_id);
        log.warn('reserve.will_retry', { ref: row.order_public_id, reason: result.reason });
        continue;
      }
      if (result.applied !== undefined && result.applied.length > 0) {
        await recordPartialRenewal(db, row, result.applied, result.reason);
      }
      const reason = result.reason;
      // The money stays a sale: the customer paid and is owed the renewal, by
      // a person now. FAILED is what a support search finds them by.
      await db.withSession(async (tx) => {
        const ended = await tx
          .prepare(
            `UPDATE renewal_reserves SET status = 'FAILED', failure_reason = ?2
              WHERE order_id = ?1 AND status = 'WAITING'`,
          )
          .bind(row.order_id, reason)
          .run();
        if (ended.meta.changes === 0 || row.telegram_id === null) return;
        await enqueue(tx, {
          dedupeKey: `reserve:${row.order_public_id}`,
          chatId: row.telegram_id,
          text: menu.serviceNeedsHelp(row.order_public_id),
        });
      });
      log.error('reserve.failed', { ref: row.order_public_id, reason });
      continue;
    }
    const landed: ProvisionOk = result;
    const done = await db.withSession(async (tx) => {
      const claimed = await tx
        .prepare(
          `UPDATE renewal_reserves SET status = 'APPLIED', applied_at = now()
            WHERE order_id = ?1 AND status = 'WAITING'`,
        )
        .bind(row.order_id)
        .run();
      if (claimed.meta.changes === 0) return false;
      await writeRenewal(tx, row, 'RESET', landed, now, serviceName);
      if (row.telegram_id !== null) {
        // The «خبرتان می‌کنیم» the reserve promised: the ordinary renewal
        // message, since this is the moment it became one.
        const changed = row.target_plan_id !== null && row.target_plan_id !== row.plan_id;
        await enqueue(tx, {
          dedupeKey: `reserve:${row.order_public_id}`,
          chatId: row.telegram_id,
          text: menu.serviceRenewed(serviceName, landed.expiresAt ?? null, null, changed),
        });
      }
      return true;
    });
    if (done) {
      applied += 1;
      log.info('reserve.applied', { ref: row.order_public_id });
    }
  }
  return applied;
}

/** The panel a `PendingOrder` resolves to, as the adapter is handed it. */
function providerContextOf(row: PendingOrder, fetchImpl: typeof globalThis.fetch): ProviderContext {
  return {
    id: row.provider_id!,
    code: row.provider_code ?? String(row.provider_id),
    name: row.provider_name ?? 'panel',
    baseUrl: row.provider_base_url,
    credentials: credentialsFor(row.provider_secret_ref, row.provider_sealed),
    config: row.provider_config ?? {},
    fetch: fetchImpl,
  };
}

const GB = 1024 ** 3;

/**
 * What the account was just before this renewal, and what the renewal burned
 * — one `renewal_snapshots` row (0096), for the dashboard's history and its
 * «برگرداندن».
 *
 * The panel's own figures when the adapter read them a moment ago; the row's
 * when it did not (a retry that found the renewal already applied), which are
 * at most one sync interval old. What burns follows the mode, and must keep
 * agreeing with `marzban.ts` `renew`: RESET zeroes the counter and restarts
 * the clock, so the unused volume and the remaining time go; the mode that
 * keeps volume loses only the time; ADD loses nothing. An unmetered account
 * has no unused volume to lose. A held account's time is the days it was
 * waiting to start (#325).
 *
 * `ON CONFLICT DO NOTHING`: one row per order, and a retried order keeps the
 * first — the one written before anything had changed.
 */
async function snapshotRenewal(
  tx: D1DatabaseSession,
  orderId: number,
  subscriptionId: number,
  mode: ReturnType<typeof renewModeFor>,
  before:
    | { usedBytes: number | null; limitBytes: number | null; expireMs: number | null; heldMs: number | null }
    | undefined,
  now: number,
): Promise<void> {
  const stored = await tx
    .prepare(
      `SELECT plan_name_at_sale, used_bytes, volume_gb, expires_at
         FROM subscriptions WHERE id = ?1`,
    )
    .bind(subscriptionId)
    .first<{
      plan_name_at_sale: string | null;
      used_bytes: number | string | null;
      volume_gb: number | string | null;
      expires_at: string | null;
    }>();
  const storedGb = stored?.volume_gb == null ? null : Number(stored.volume_gb);
  const used = before
    ? before.usedBytes
    : stored?.used_bytes == null
      ? null
      : Number(stored.used_bytes);
  const limit = before ? before.limitBytes : storedGb !== null && storedGb > 0 ? Math.round(storedGb * GB) : null;
  const expireMs = before
    ? before.expireMs
    : stored?.expires_at == null
      ? null
      : Date.parse(stored.expires_at);
  const leftMs =
    before?.heldMs != null ? before.heldMs : expireMs === null ? 0 : Math.max(0, expireMs - now);
  const lostBytes = mode === 'RESET' && limit !== null ? Math.max(0, limit - (used ?? 0)) : 0;
  const lostMs = mode === 'ADD' ? 0 : leftMs;
  await tx
    .prepare(
      `INSERT INTO renewal_snapshots
         (order_id, subscription_id, mode, plan_name_before, used_bytes_before,
          limit_bytes_before, expires_at_before, lost_bytes, lost_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7::timestamptz, ?8, ?9)
       ON CONFLICT (order_id) DO NOTHING`,
    )
    .bind(
      orderId,
      subscriptionId,
      mode,
      stored?.plan_name_at_sale ?? null,
      used,
      limit,
      expireMs === null ? null : new Date(expireMs).toISOString(),
      lostBytes,
      Math.round(lostMs),
    )
    .run();
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
 *
 * Not silent to the CUSTOMER, though, once the outage has gone on long enough —
 * see `tellIfWaitingTooLong`. It belongs here rather than at the call sites
 * because this is the single funnel all three retryable exits pass through, and
 * putting it at one of them is what left the other two silent for ever.
 */
async function release(db: D1Database, row: PendingOrder, now: number): Promise<void> {
  await db
    .prepare(
      `UPDATE orders SET status = 'PAID', updated_at = now()
        WHERE id = ?1 AND status = 'PROVISIONING'`,
    )
    .bind(row.order_id)
    .run();
  await tellIfWaitingTooLong(db, row, now);
}

/**
 * Tells a customer, once, that the order they paid for is still being worked
 * on.
 *
 * Silence is right for a blip and wrong for an outage, and nothing used to draw
 * the line. Saying «there was a problem» and then succeeding a minute later is
 * worse than saying nothing — that is why this path is quiet, and it stays
 * quiet for the first ten minutes. What it had no answer for was the panel that
 * does not come back: the customer has paid, has nothing, and hears nothing at
 * all, with no way to tell being queued from being forgotten. That is the worst
 * thing this bot can do to somebody.
 *
 * Past the shelf's own grace, so on a purchase it fires only when the shelf has
 * ALSO had its chance and could not help. `failingSinceMs` is the clock the
 * shelf already keeps; on a renewal nothing else stamps it, so the first call
 * here starts it and every later one reads it back.
 *
 * ONCE. The dedupe key is the order, so the sweep may run for a week and the
 * customer is told a single time. The delivery message that follows carries its
 * own key — `provision:<id>` against this one's `provision:<id>:waiting` — and
 * is not blocked by it. The same distinction means an operator retry, which
 * supersedes on the exact key `provision:<id>`, leaves this row alone: the
 * notice is once per order for the life of the order, retries included.
 *
 * NOT for a TRIAL. Routing leaves a purchase and a trial on the first exit, and
 * this message says «پرداخت شما ثبت شده» — so sending it to somebody who paid
 * nothing states something false about money, which is the one thing this bot
 * must never do. Reassuring a waiting trial customer would need its own line
 * that promises nothing about payment; a free account arriving late is a much
 * smaller problem than a paid one. The kind check comes FIRST so a trial is not
 * even stamped: `deliverFromStock` bails for a trial before stamping, and
 * calling `failingSinceMs` here unconditionally would have started writing a
 * column nothing on that path reads.
 *
 * Best-effort by construction — a failure here must not stop the retry that is
 * the actual remedy.
 */
async function tellIfWaitingTooLong(
  db: D1Database,
  row: PendingOrder,
  now: number,
): Promise<void> {
  if (row.order_kind === 'TRIAL' || row.telegram_id === null) return;
  const failingSince = await failingSinceMs(db, row.order_id);
  if (failingSince === null || now - failingSince < STOCK_GRACE_MS) return;
  await db
    .withSession((tx) =>
      enqueue(tx, {
        dedupeKey: `provision:${row.order_public_id}:waiting`,
        chatId: row.telegram_id!,
        text: menu.serviceStillWorking(row.order_public_id),
      }),
    )
    .catch((err: unknown) => {
      log.warn('provision.waiting_note_unsent', { ref: row.order_public_id }, err);
    });
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
 * Moves a claimed order to COMPLETED, or gives up the whole transaction —
 * and pays whoever referred the customer, in that same transaction.
 *
 * The `WHERE status = 'PROVISIONING'` was here before; what was missing is
 * anyone reading the answer. A transition that changed no rows returned exactly
 * like one that changed a row, so the sweep that lost the race still wrote its
 * subscription and still told the customer.
 *
 * The commission moved here from settlement on 2026-09-12 (issue #181, Sam's
 * call). Paid at PAID, a delivery that then failed refunded the buyer and
 * left the referrer paid for a sale that never happened; nothing clawed it
 * back. Legacy pays at payment time (`function.php:939`) — this is a
 * deliberate departure, the same one `creditRenewalCashback` already made.
 * Every route to COMPLETED passes through here, so it is paid once, on a
 * delivered order, whatever the customer paid with.
 */
/**
 * The group's report for a delivered order — mirzabot's template for that
 * kind, filled with what mirzabot fills it with.
 *
 * Read AFTER delivery and outside its transactions, like the send that
 * follows: the config username is the row `deliver` wrote, the balances are
 * the customer's wallet now and what this order took from it, and a report
 * that cannot be built must not roll a delivered service back.
 */
async function reportFor(
  db: D1Database,
  row: PendingOrder,
  now: number,
): Promise<readonly [ReportKind, string]> {
  const telegramId = row.telegram_id as number;
  const delivered = await db
    .prepare(
      `SELECT remote_username, volume_gb, duration_days
         FROM subscriptions WHERE order_id = ?1 ORDER BY id DESC LIMIT 1`,
    )
    .bind(row.order_id)
    .first<{ remote_username: string | null; volume_gb: number | null; duration_days: number | null }>();
  const config = delivered?.remote_username ?? row.target_username ?? '';
  const panel = row.provider_name ?? '';
  const balanceAfter = await balanceFor(db, row.user_id);
  const balanceBefore = balanceAfter + (await walletPaidOnOrder(db, row.order_id));
  const totalIrr = Number(row.total_irr);

  switch (row.order_kind) {
    case 'TRIAL': {
      const who = await db
        .prepare(`SELECT first_name FROM users WHERE id = ?1`)
        .bind(row.user_id)
        .first<{ first_name: string | null }>();
      return [
        'reporttest',
        menu.trialReport({
          telegramId,
          username: row.telegram_username,
          config,
          name: who?.first_name ?? null,
          panel,
          days: delivered?.duration_days ?? row.duration_days,
          volumeGb: numberOrNull(delivered?.volume_gb ?? row.volume_gb),
          tracking: row.order_public_id,
          tier: row.reseller_tier,
          atMs: now,
        }),
      ];
    }
    case 'NEW_PURCHASE': {
      // «📌 خرید اول کاربر» when no earlier paid order exists for them —
      // legacy's `$countinvoice <= 1`. A PHP-bot trial is no more a purchase
      // than ours is (`bought.ts`).
      const earlier = await db
        .prepare(
          `SELECT count(*)::int AS n FROM orders
            WHERE user_id = ?1 AND id <> ?2
              AND kind NOT IN ('WALLET_TOPUP', 'TRIAL', 'RESELLER_VOLUME')
              AND status IN ('PAID', 'PROVISIONING', 'COMPLETED')
              AND NOT ${legacyTrialSql('orders')}`,
        )
        .bind(row.user_id, row.order_id)
        .first<{ n: number }>();
      return [
        'buyreport',
        menu.purchaseReport({
          firstPurchase: (earlier?.n ?? 0) === 0,
          telegramId,
          username: row.telegram_username,
          config,
          panel,
          days: delivered?.duration_days ?? row.duration_days,
          plan: row.plan_name ?? row.product_name ?? '',
          volumeGb: numberOrNull(delivered?.volume_gb ?? row.volume_gb),
          balanceBeforeIrr: balanceBefore,
          balanceAfterIrr: balanceAfter,
          tracking: row.order_public_id,
          tier: row.reseller_tier,
          priceIrr: Number(row.unit_price_irr) * Number(row.quantity ?? 1),
          finalPriceIrr: totalIrr,
          atMs: now,
        }),
      ];
    }
    case 'ADD_VOLUME':
      return [
        'otherservice',
        menu.addVolumeReport({
          telegramId,
          volumeGb: numberOrNull(row.volume_gb) ?? 0,
          priceIrr: totalIrr,
          config,
          balanceBeforeIrr: balanceBefore,
        }),
      ];
    case 'RESELLER_VOLUME': {
      // «Renewals and add-ons on a service that already exists» is the topic
      // it fits: a panel admin getting more of what it already has. Not a
      // topic of its own — the group is laid out exactly as mirzabot's.
      const account = await db
        .prepare(
          `SELECT name, panel_admin_username, data_limit_bytes FROM reseller_accounts WHERE id = ?1`,
        )
        .bind(row.target_reseller_id)
        .first<{ name: string; panel_admin_username: string; data_limit_bytes: string | number | null }>();
      return [
        'otherservice',
        menu.resellerVolumeReport({
          telegramId,
          username: row.telegram_username,
          name: account?.name ?? '',
          panelAdmin: account?.panel_admin_username ?? '',
          panel,
          addedTb: Number(row.quantity),
          totalBytes: account?.data_limit_bytes == null ? null : Number(account.data_limit_bytes),
          priceIrr: totalIrr,
          tracking: row.order_public_id,
          atMs: now,
        }),
      ];
    }
    case 'ADD_TIME':
      return [
        'otherservice',
        menu.addTimeReport({
          telegramId,
          days: row.duration_days ?? 0,
          priceIrr: totalIrr,
          config,
        }),
      ];
    default:
      return [
        'otherservice',
        menu.renewalReport({
          telegramId,
          username: row.telegram_username,
          config,
          panel,
          // `row` was read before renew() rewrote the subscription, so the
          // target_name is still the plan the customer renewed FROM.
          previousPlan: row.target_name,
          plan: row.plan_name ?? row.target_name ?? row.product_name ?? '',
          volumeGb: numberOrNull(row.volume_gb),
          days: row.duration_days,
          priceIrr: totalIrr,
          balanceBeforeIrr: balanceBefore,
          atMs: now,
        }),
      ];
  }
}

/** The shop's two referral rates, in the shape `payReferralCommission` takes. */
function referralRates(shop: {
  commissionPercent: number;
  renewalCommissionPercent: number;
}): CommissionRates {
  return { first: shop.commissionPercent, renewal: shop.renewalCommissionPercent };
}

function numberOrNull(v: string | number | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(v);
}

async function complete(
  tx: D1Database | D1DatabaseSession,
  orderId: number,
  commission: CommissionRates,
): Promise<void> {
  const done = await tx
    .prepare(
      `UPDATE orders SET status = 'COMPLETED', completed_at = now(), updated_at = now()
        WHERE id = ?1 AND status = 'PROVISIONING'`,
    )
    .bind(orderId)
    .run();
  if (done.meta.changes !== 1) throw new LostTheClaim(orderId);
  const paid = await payReferralCommission(tx as D1DatabaseSession, orderId, commission);
  if (paid === null) return;
  // «🎁 گزارش پورسانت ها» — `function.php:1083`, the two Telegram ids and
  // the clock, in the transaction that paid it.
  const ids = await tx
    .prepare(
      `SELECT b.telegram_id AS buyer, r.telegram_id AS referrer
         FROM orders o
         JOIN users b ON b.id = o.user_id
         JOIN users r ON r.id = b.referred_by
        WHERE o.id = ?1`,
    )
    .bind(orderId)
    .first<{ buyer: number | null; referrer: number | null }>();
  if (!ids || ids.buyer === null || ids.referrer === null) return;
  await report(
    tx as D1DatabaseSession,
    await loadShopSettings(tx),
    'porsantreport',
    `commission:${orderId}`,
    menu.commissionReport({
      amountIrr: paid,
      referrerTelegramId: ids.referrer,
      buyerTelegramId: ids.buyer,
      atMs: Date.now(),
    }),
  );
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

    /*
     * A trial that failed gives the customer their free account back.
     *
     * `refundOrder` cannot do it: a trial has no payment behind it, so it
     * finds nothing and answers null — correctly. What the customer actually
     * spent is a number on their own row, and without this the shop keeps it
     * for a service that never arrived.
     *
     * One statement, joined on the order, so it fires for a TRIAL and for
     * nothing else — a branch here would be a second place to remember which
     * kinds are free. In the same transaction as the status change, guarded by
     * the same `changes === 0` check above, so two sweeps racing cannot both
     * give it back.
     *
     * GREATEST(..., 0) because the counter is unsigned in meaning if not in
     * type, and a negative one would hand out free accounts for ever.
     */
    await tx
      .prepare(
        `UPDATE users u
            SET test_quota_used = GREATEST(u.test_quota_used - 1, 0), updated_at = now()
           FROM orders o
          WHERE o.id = ?1 AND o.user_id = u.id AND o.kind = 'TRIAL'`,
      )
      .bind(orderId)
      .run();

    /*
     * A reseller order that failed gives its terabytes back to the ledger, and
     * forgets it ever applied them (#474).
     *
     * Same shape as the trial above: one statement joined on the order, so it
     * moves nothing for any other kind, and only when the stamp says the
     * terabytes were added. Clearing the stamp in the same transaction is what
     * lets the dashboard's retry (FAILED → PAID) apply them again from
     * scratch instead of mirroring a total that no longer includes them.
     *
     * A ledger that falls back to nothing is NULL rather than zero — the
     * column's CHECK is `> 0`, and a PENDING reseller with nothing bought has
     * no volume, not a volume of zero.
     */
    await tx
      .prepare(
        `UPDATE reseller_accounts ra
            SET data_limit_bytes = CASE
                  WHEN ra.data_limit_bytes - o.quantity::bigint * ?2 > 0
                  THEN ra.data_limit_bytes - o.quantity::bigint * ?2 END,
                updated_at = now()
           FROM orders o
          WHERE o.id = ?1 AND o.kind = 'RESELLER_VOLUME'
            AND o.reseller_target_limit_bytes IS NOT NULL
            AND ra.id = o.target_reseller_id`,
      )
      .bind(orderId, TIB)
      .run();
    await tx
      .prepare(
        `UPDATE orders SET reseller_target_limit_bytes = NULL
          WHERE id = ?1 AND kind = 'RESELLER_VOLUME'`,
      )
      .bind(orderId)
      .run();

    return refundOrder(tx, orderId);
  });
}
