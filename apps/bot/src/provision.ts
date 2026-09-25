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
  type ProviderContext,
  type ProvisionRequest,
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
  /** Sent as a photo before the text. In practice the subscription link. */
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

export async function provisionPaidOrders(
  db: D1Database,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  now: number = Date.now(),
): Promise<number> {
  await reclaimStalled(db);

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
              -- add: a trial is the only kind that sets orders.provider_id, and
              -- for every other kind the column is NULL, so no existing row can
              -- change which panel it resolves to.
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
              pv.id                                               AS plan_provider_id
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
         LEFT JOIN provisioning_providers opv ON opv.id = o.provider_id
         LEFT JOIN provider_secrets ops ON ops.provider_id = opv.id
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

  const result = await adapter.renew(
    {
      username: row.target_username,
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

  // The service is live again, so it must not still be sitting on the groups
  // it was moved to when it ended. A renewal has already been sent the plan's
  // groups by the adapter; an add-on has not, and needs the call.
  await restoreGroups(db, row, fetchImpl, renewalCarriedGroups);

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
    // Before the UPDATE below overwrites the row it falls back on.
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
            WHERE user_id = ?1 AND id <> ?2 AND kind NOT IN ('WALLET_TOPUP', 'TRIAL')
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

    return refundOrder(tx, orderId);
  });
}
