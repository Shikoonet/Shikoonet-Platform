/**
 * One Telegram update in, database writes and outgoing replies out.
 *
 * The shape of this file is the whole point of migration 0006. Everything that
 * touches the database happens inside ONE transaction that begins by claiming
 * `update_id`. If the claim loses, the update was already handled and nothing
 * runs. If anything after the claim throws, the claim rolls back with it and
 * Telegram's redelivery gets a real second attempt. There is no window in which
 * an update counts as handled but its effects are missing.
 *
 * Replies are returned, not sent. Sending is not transactional — a message that
 * has left cannot be un-sent by a ROLLBACK — so the caller sends only after the
 * transaction commits. The cost is the narrow case of a commit whose reply then
 * fails to send: the user sees silence, the database stays correct. That is the
 * right way round for a system that moves money.
 *
 * Button presses arrive here too, and they are treated as what they are:
 * unauthenticated input. `decode()` narrows the payload to a closed set of
 * actions, and every id it yields is re-checked against the database — catalog
 * rows through catalog.ts, customer-owned rows through owned.ts. Nothing is
 * trusted because a button was drawn for it.
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';
import {
  extraPricingFor,
  isAutomated,
  renewAllowed,
  renewModeFor,
  verifyMirzabotClaim,
  verifyMirzabotClaimWithoutTransaction,
} from '@shikoo/domain';
import { permissionsOf, type AdminPermission } from '@shikoo/contracts';
import {
  adminFor,
  audit,
  can,
  type BotAdmin,
  candidateTransactions,
  claimById,
  claimsAwaitingReview,
  countClaimsAwaitingReview,
  rejectClaim,
} from './admin.js';
import { actOnService } from './actions.js';
import { type Callback, decode, encode } from './callback.js';
import type { CatalogPlan } from './catalog.js';
import { panelsForUser, plansOnPanel, purchasablePlan } from './catalog.js';
import {
  checkCode,
  type DiscountCode,
  discountFor,
  redeem,
  redeemGift,
  redemptionOnOpenOrder,
} from './discount.js';
import { loadBotContent } from './botContent.js';
import * as menu from './menu.js';
import { priceForUser } from './money.js';
import {
  newPublicId,
  placeAddonOrder,
  placeOrder,
  placeRenewalOrder,
  placeTopupOrder,
} from './order.js';
import { clientApps, helpArticle, helpArticles } from './content.js';
import {
  claimReferrer,
  payReferralCommission,
  referralLink,
  referralSummary,
  referrerFromPayload,
} from './referral.js';
import { applyForReseller, hasOpenRequest } from './reseller.js';
import {
  DEFAULT_SHOP_SETTINGS,
  loadShopSettings,
  settingIs,
  settingText,
  type ShopSettings,
} from './settings.js';
import {
  countRenewableForUser,
  countSubscriptionsForUser,
  orderForUser,
  renewableForUser,
  renewableForUserById,
  subscriptionOnPanelForUser,
  subscriptionsForUser,
  type OwnedSubscriptionOnPanel,
} from './owned.js';
import { checkoutFor, recordPaidClick, recordReceipt } from './payment.js';
import {
  balanceFor,
  entriesFor,
  spendOnOrder,
  topupAmount,
  topupNeededIrr,
  topupPresetsIrr,
} from './wallet.js';
import type {
  InlineKeyboard,
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramUpdate,
} from './telegram.js';

export interface Reply {
  chatId: number;
  text: string;
  keyboard?: InlineKeyboard;
  /** Replaces this message instead of sending a new one, so a menu does not
   *  leave a trail of dead screens behind it. */
  editMessageId?: number;
  /** A Telegram `file_id` to send as a photo, with `text` as its caption.
   *  Only the receipt uses this, and only towards an admin. */
  photo?: string;
}

export type HandleStatus =
  /** Claimed and acted on. */
  | 'processed'
  /** Already claimed by an earlier delivery; nothing ran. */
  | 'duplicate'
  /** Claimed, but there was nothing here for us — an unknown command, an
   *  unrecognised callback, a non-message update, or a blocked user. */
  | 'ignored';

export interface HandleOutcome {
  status: HandleStatus;
  replies: Reply[];
}

const IGNORED: HandleOutcome = { status: 'ignored', replies: [] };

/**
 * The shop's switches for the update being handled.
 *
 * Module-level for the same reason `menu.ts` keeps its wording that way, and
 * safe for the same reason: `poll.ts` awaits each `handleUpdate` in a plain
 * `for` loop, so one update finishes before the next begins. If that ever
 * becomes concurrent this becomes shared mutable state between customers and
 * must be threaded through instead.
 */
let SHOP: ShopSettings = DEFAULT_SHOP_SETTINGS;

/**
 * Whether this service gets panel buttons, and which way the on/off one points.
 *
 * Null for a manual product, for a row whose panel was deleted, and for one the
 * panel never named — there is nothing to call in any of those, and a button
 * that cannot work is worse than no button.
 */
function actionsFor(
  service: OwnedSubscriptionOnPanel,
  tier: menu.CustomerTier = 'f',
): menu.ServiceActions | null {
  if (!service.provider_kind || !service.provider_base_url || !service.remote_username) return null;
  if (!isAutomated(service.provider_kind)) return null;
  // REMOVED, FAILED, PENDING_PAYMENT: nothing to revoke and nothing to switch.
  if (service.status !== 'ACTIVE' && service.status !== 'DISABLED') return null;
  const pricing = extraPricingFor(service.provider_config ?? {}, tier);
  return {
    id: service.id,
    disabled: service.status === 'DISABLED',
    // A panel that prices an add-on can still be a shop that does not sell it.
    // Production has had both of these switched off for years while our bot
    // drew the buttons anyway.
    volumeIrrPerGb: SHOP.sellsExtraVolume ? pricing.volumeIrrPerGb : null,
    timeIrrPerDay: SHOP.sellsExtraTime ? pricing.timeIrrPerDay : null,
    canSwitch: SHOP.allowsServiceSwitch,
  };
}

/**
 * Which price column this customer is charged from.
 *
 * The legacy `agent` field is three tiers and we carry one flag, so a reseller
 * reads the reseller column and everybody else the ordinary one. `n2` exists in
 * the data and is priced identically to `n` on every live panel, so nothing is
 * lost by not having a third flag yet.
 */
function tierFor(user: Caller): menu.CustomerTier {
  return user.is_reseller ? 'n' : 'f';
}

/** Built by hand rather than by object literal: `exactOptionalPropertyTypes`
 *  rejects an explicit `undefined`, and every caller here has optional halves. */
function reply(
  chatId: number,
  text: string,
  keyboard?: InlineKeyboard,
  editMessageId?: number,
): Reply {
  return {
    chatId,
    text,
    ...(keyboard === undefined ? {} : { keyboard }),
    ...(editMessageId === undefined ? {} : { editMessageId }),
  };
}

export async function handleUpdate(
  db: D1Database,
  update: TelegramUpdate,
  // Injected so a test can answer for the panel. The service buttons are the
  // only handlers that leave the process.
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<HandleOutcome> {
  // The admin's wording and keyboard, before anything is drawn. Cached for
  // thirty seconds and falling back to the code's defaults, so this cannot
  // fail the update — see `botContent.ts`. Outside the session because it is a
  // read of shop-wide configuration, not of this customer's data.
  // Both are shop-wide configuration read outside the session, both fall back
  // to what the code ships, and neither can fail the update.
  //
  // In series rather than in parallel: `Texts` needs to know whether the shop
  // has custom emoji on before it decides whether to keep the markup in an
  // override or strip it to the fallback emoji. Both are cached for thirty
  // seconds, so this is one extra round trip twice a minute, not per update.
  const shop = await loadShopSettings(db);
  const content = await loadBotContent(db, Date.now(), shop.customEmoji);
  menu.applyContent(content);
  SHOP = shop;

  return db.withSession(async (tx) => {
    const claim = await tx
      .prepare(`INSERT INTO telegram_updates (update_id) VALUES (?1) ON CONFLICT DO NOTHING`)
      .bind(update.update_id)
      .run();
    if (claim.meta.changes === 0) {
      return { status: 'duplicate', replies: [] };
    }

    if (update.callback_query) {
      return handleCallback(tx, update.callback_query, fetchImpl);
    }

    const message = update.message;
    // Claimed on purpose: we have genuinely seen this update, and re-fetching it
    // would produce the same nothing.
    if (!message?.from) {
      return IGNORED;
    }

    // A receipt is a photo, and a photo has no `text`. Every other handler in
    // this file reads `text`, so before this line a picture fell through all of
    // them and was thrown away — which is exactly where the admin's evidence
    // was going.
    const photo = message.photo?.at(-1);
    if (photo) return handleReceipt(tx, message, photo.file_id);

    if (!message.text) {
      return IGNORED;
    }

    if (command(message.text) === '/start') {
      return handleStart(tx, message);
    }
    // The one command that is not for customers. It answers nothing at all to
    // anyone who is not in `admins` — not "you are not an admin", which would
    // confirm the command exists.
    if (command(message.text) === '/panel') {
      const admin = message.from ? await adminFor(tx, message.from.id) : null;
      if (!admin) return IGNORED;
      // An admin is a customer row too, and every screen after this one needs
      // it: the callback handler reads `users` before it does anything, and the
      // session the review flow keeps is keyed by `users.id`. Found by walking
      // it — `/panel` opened and then every button said "press /start".
      await upsertUser(tx, message.from!);
      const waiting = await countClaimsAwaitingReview(tx);
      return {
        status: 'processed',
        replies: [
          reply(
            message.chat.id,
            menu.adminHome(waiting),
            menu.adminMenu(waiting, permissionsOf(admin.role, admin.permissions)),
          ),
        ],
      };
    }
    // Everything else typed is an answer to something the bot asked, and what
    // it asked is in the session — never in the message.
    return handleTypedAnswer(tx, message);
  });
}

/** `/start@some_bot payload` -> `/start`. */
function command(text: string): string | null {
  const first = text.trim().split(/\s+/)[0];
  if (first === undefined || !first.startsWith('/')) return null;
  return first.split('@')[0] ?? null;
}

interface Caller {
  id: number;
  status: string;
  is_reseller: boolean;
  discount_percent: number;
}

/**
 * The customer row for whoever sent this, created if it is their first message.
 *
 * Upsert rather than SELECT-then-INSERT: two messages cannot race into two rows
 * for one telegram_id, because the unique index decides, not this code.
 */
async function upsertUser(
  tx: D1DatabaseSession,
  from: { id: number; username?: string | undefined },
): Promise<Caller> {
  const user = await tx
    .prepare(
      `INSERT INTO users (telegram_id, username, registered_at, last_seen_at)
       VALUES (?1, ?2, now(), now())
       ON CONFLICT (telegram_id) DO UPDATE
         SET username = EXCLUDED.username,
             last_seen_at = now(),
             updated_at = now()
       RETURNING id, status, is_reseller, discount_percent`,
    )
    .bind(from.id, from.username ?? null)
    .first<Caller>();
  if (!user) throw new Error('user upsert returned no row');
  return user;
}

/**
 * A photo from a customer is a payment receipt.
 *
 * There is nothing else a customer can usefully send this bot as a picture, and
 * the alternative — a step the customer must be in — is what the legacy bot
 * does and how it loses them: its step is cleared by any other tap, and a
 * receipt that arrives afterwards is dropped without a word to anybody.
 *
 * A blocked customer is recorded as seen and told nothing, exactly as /start
 * treats them.
 */
async function handleReceipt(
  tx: D1DatabaseSession,
  message: TelegramMessage,
  fileId: string,
): Promise<HandleOutcome> {
  const from = message.from;
  if (!from) return IGNORED;
  const user = await upsertUser(tx, from);
  if (user.status === 'BLOCKED') return IGNORED;

  const result = await recordReceipt(tx, user.id, fileId);
  const say = (text: string): HandleOutcome => ({
    status: 'processed',
    replies: [reply(message.chat.id, text)],
  });
  switch (result.outcome) {
    case 'received':
      return say(menu.receiptReceived(result.publicId));
    case 'replaced':
      return say(menu.RECEIPT_REPLACED);
    case 'settled':
      return say(menu.RECEIPT_SETTLED);
    case 'none':
      return say(menu.RECEIPT_NOTHING_WAITING);
  }
}

async function handleStart(
  tx: D1DatabaseSession,
  message: TelegramMessage,
): Promise<HandleOutcome> {
  const from = message.from;
  if (!from) return IGNORED;

  // Upsert rather than SELECT-then-INSERT: two customers cannot race into two
  // rows for one telegram_id, because the unique index decides, not this code.
  //
  // `lang` is deliberately not set from `from.language_code`. Production says
  // why: 11,240 customers are 'fa' and exactly one is 'en', while plenty of them
  // run Telegram in English — the phone's locale does not predict the language a
  // customer wants to be sold in. The legacy bot reads language_code too and
  // likewise never assigns it; language is an explicit choice in the menu. The
  // column defaults to 'fa'.
  const user = await upsertUser(tx, from);

  // A blocked customer is still recorded as seen — that is what `last_seen_at`
  // is for — but gets no reply and no session.
  if (user.status === 'BLOCKED') {
    return IGNORED;
  }

  // /start is the reset button: whatever half-finished flow the customer was in
  // is abandoned, which is exactly what they expect it to do.
  await tx
    .prepare(
      `INSERT INTO bot_sessions (user_id, step, data, updated_at)
       VALUES (?1, NULL, '{}'::jsonb, now())
       ON CONFLICT (user_id) DO UPDATE
         SET step = NULL, data = '{}'::jsonb, updated_at = now()`,
    )
    .bind(user.id)
    .run();

  // `/start 42` is somebody arriving on a referral link. The payload is
  // untrusted and is only ever used as a row id: `claimReferrer` refuses it
  // unless it names a real, different customer, and refuses it outright if this
  // customer already has a referrer — the first link wins, always.
  const referrer = referrerFromPayload(message.text!.trim().split(/\s+/)[1]);
  const claimed =
    referrer === null ? false : await claimReferrer(tx, user.id, referrer);

  return {
    status: 'processed',
    replies: [
      reply(
        message.chat.id,
        claimed ? `${menu.REFERRAL_WELCOME}\n\n${menu.WELCOME}` : menu.WELCOME,
        menu.mainMenu(user.is_reseller),
      ),
    ],
  };
}

/** The largest add-on one purchase may be. */
export const ADDON_MAX = 1000;

/**
 * A number typed in answer to «چند گیگابایت؟».
 *
 * Everything here is checked again from the database: which service, whose it
 * is, and what the panel charges. The session carries the id, not the price —
 * a session that carried a price would be a price the customer's own row could
 * be made to disagree with.
 */
interface Session {
  step: string;
  data: Record<string, unknown>;
}

/**
 * A typed message that is not a command.
 *
 * Which question it answers is decided by `bot_sessions.step` — a row scoped to
 * the user — and never by the text. A customer who was asked nothing gets
 * nothing: an unprompted message is ignored rather than guessed at.
 */
async function handleTypedAnswer(
  tx: D1DatabaseSession,
  message: TelegramMessage,
): Promise<HandleOutcome> {
  const from = message.from;
  if (!from) return IGNORED;
  const user = await tx
    .prepare(
      `SELECT id, status, is_reseller, discount_percent FROM users WHERE telegram_id = ?1`,
    )
    .bind(from.id)
    .first<Caller>();
  if (!user || user.status === 'BLOCKED') return IGNORED;

  const row = await tx
    .prepare(`SELECT step, data FROM bot_sessions WHERE user_id = ?1`)
    .bind(user.id)
    .first<{ step: string | null; data: Record<string, unknown> | null }>();
  const session: Session = { step: row?.step ?? '', data: row?.data ?? {} };

  if (session.step.startsWith('addon:')) return handleAddonAmount(tx, message, user, session);
  if (session.step === 'code') return handleDiscountCode(tx, message, user, session);
  if (session.step === 'coder') return handleRenewalCode(tx, message, user, session);
  if (session.step === 'gift') return handleGiftCode(tx, message, user);
  if (session.step === 'agent') return handleResellerRequest(tx, message, user);
  return IGNORED;
}

/** Clears the question, once it has been answered in a way that ends the flow. */
async function clearSession(tx: D1DatabaseSession, userId: number): Promise<void> {
  await tx
    .prepare(`UPDATE bot_sessions SET step = NULL, data = '{}'::jsonb, updated_at = now()
               WHERE user_id = ?1`)
    .bind(userId)
    .run();
}

/** Asks a question and remembers that it was asked. */
async function ask(
  tx: D1DatabaseSession,
  userId: number,
  step: string,
  data: Record<string, unknown>,
): Promise<void> {
  await tx
    .prepare(
      `INSERT INTO bot_sessions (user_id, step, data, updated_at)
       VALUES (?1, ?2, ?3::jsonb, now())
       ON CONFLICT (user_id) DO UPDATE
         SET step = EXCLUDED.step, data = EXCLUDED.data, updated_at = now()`,
    )
    .bind(userId, step, JSON.stringify(data))
    .run();
}

async function handleAddonAmount(
  tx: D1DatabaseSession,
  message: TelegramMessage,
  user: Caller,
  session: Session,
): Promise<HandleOutcome> {
  const kind = session.step === 'addon:ADD_VOLUME' ? 'ADD_VOLUME' : 'ADD_TIME';
  const subscriptionId = Number(session.data['subscriptionId']);
  if (!Number.isSafeInteger(subscriptionId)) return IGNORED;

  const reply = (text: string, keyboard?: InlineKeyboard): HandleOutcome => ({
    status: 'processed',
    replies: [{ chatId: message.chat.id, text, ...(keyboard ? { keyboard } : {}) }],
  });

  // Persian digits are what a Persian keyboard produces, so they are accepted
  // and normalised rather than rejected as "not a number".
  const typed = message.text!.trim().replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  if (!/^[0-9]+$/.test(typed)) return reply(menu.ADDON_NOT_A_NUMBER);
  const quantity = Number(typed);
  if (quantity <= 0) return reply(menu.ADDON_NOT_A_NUMBER);
  if (quantity > ADDON_MAX) return reply(menu.addonTooMuch(ADDON_MAX));

  const service = await subscriptionOnPanelForUser(tx, user.id, subscriptionId);
  if (!service) return reply(menu.SERVICE_GONE, menu.myServicesMenu([], Date.now(), 1, 1));
  const actions = actionsFor(service, tierFor(user));
  const unit =
    kind === 'ADD_VOLUME' ? (actions?.volumeIrrPerGb ?? null) : (actions?.timeIrrPerDay ?? null);
  if (unit === null) return reply(menu.ACTION_UNSUPPORTED, menu.serviceDetailMenu());

  const placed = await placeAddonOrder(
    tx,
    user.id,
    service.id,
    kind,
    quantity,
    unit,
    user.discount_percent,
  );
  if (!placed) {
    await clearSession(tx, user.id);
    return reply(menu.ORDER_NOT_PAYABLE, menu.serviceDetailMenu());
  }
  const checkout = await checkoutFor(tx, user.id, placed.id, placed.totalIrr, newPublicId());
  if (!checkout) return reply(menu.NO_CARD_AVAILABLE, menu.afterPaidMenu());
  if (checkout.claimed) return reply(menu.paidAlready(checkout.publicId), menu.afterPaidMenu());

  // The step is cleared here and not before: a customer who typed something
  // unusable is still in the flow and can simply type again.
  await clearSession(tx, user.id);

  return reply(
    menu.addonCheckout(
      placed.publicId,
      kind,
      quantity,
      service.plan_name_at_sale,
      placed.totalIrr,
      checkout.cardDigits,
      checkout.cardHolder,
    ),
    menu.checkoutMenu(placed.id, placed.totalIrr, checkout.cardDigits, {
      balanceIrr: await balanceFor(tx, user.id),
      totalIrr: placed.totalIrr,
    }),
  );
}

/**
 * A discount code typed against a plan.
 *
 * Nothing is decided here that is not decided again at `order`. What the
 * session keeps is the CODE, never the discount: a stored amount is an amount
 * the plan's own price can be changed out from under, and the customer would
 * then pay a total the catalog no longer agrees with.
 */
async function handleDiscountCode(
  tx: D1DatabaseSession,
  message: TelegramMessage,
  user: Caller,
  session: Session,
): Promise<HandleOutcome> {
  const planId = Number(session.data['planId']);
  if (!Number.isSafeInteger(planId)) return IGNORED;
  const answer = (text: string, keyboard?: InlineKeyboard): HandleOutcome => ({
    status: 'processed',
    replies: [{ chatId: message.chat.id, text, ...(keyboard ? { keyboard } : {}) }],
  });

  // Read again rather than trusted from the session: between asking and
  // answering, the plan can have been hidden or repriced.
  const plan = await purchasablePlan(tx, user.id, planId);
  if (!plan) return answer(menu.PLAN_GONE, menu.planMenu([]));

  const price = priceForUser(plan.priceIrr, user.discount_percent);
  const check = await checkCode(
    tx,
    user.id,
    user.is_reseller,
    message.text!,
    {
      kind: 'BUY',
      priceIrr: price.totalIrr,
      productId: plan.productId,
      providerId: plan.providerId,
    },
    Date.now(),
  );
  if (!check.ok) {
    // The question stays open: the customer mistyped and can type again.
    return answer(
      menu.DISCOUNT_REFUSED[check.reason] ?? menu.DISCOUNT_REFUSED['UNKNOWN_CODE']!,
      menu.planDetailMenu(plan),
    );
  }

  await ask(tx, user.id, 'code:held', { planId, code: check.code.code });
  const applied = { code: check.code.code, discountIrr: check.discountIrr };
  return answer(
    `${menu.discountApplied(check.code.code, check.discountIrr)}\n\n${menu.planDetail(plan, price, applied)}`,
    menu.planDetailMenu(plan, applied),
  );
}

/**
 * A discount code typed against a service being renewed.
 *
 * The plan comes after the code here, so the product scope cannot be checked
 * yet and `productId` goes in as null. Everything that CAN be checked is —
 * including that the code is for renewals — and the rest happens at `rord`,
 * where the plan is finally known.
 */
async function handleRenewalCode(
  tx: D1DatabaseSession,
  message: TelegramMessage,
  user: Caller,
  session: Session,
): Promise<HandleOutcome> {
  const subscriptionId = Number(session.data['subscriptionId']);
  if (!Number.isSafeInteger(subscriptionId)) return IGNORED;
  const answer = (text: string, keyboard?: InlineKeyboard): HandleOutcome => ({
    status: 'processed',
    replies: [{ chatId: message.chat.id, text, ...(keyboard ? { keyboard } : {}) }],
  });

  const service = await renewableForUserById(tx, user.id, subscriptionId);
  if (!service) return answer(menu.RENEWAL_GONE, menu.renewMenu([], Date.now(), 1, 1));

  const check = await checkCode(
    tx,
    user.id,
    user.is_reseller,
    message.text!,
    { kind: 'RENEW', priceIrr: 0, productId: null, providerId: service.provider_id },
    Date.now(),
  );
  if (!check.ok) {
    return answer(
      menu.DISCOUNT_REFUSED[check.reason] ?? menu.DISCOUNT_REFUSED['UNKNOWN_CODE']!,
      menu.promptMenu(encode('rnw', subscriptionId)),
    );
  }
  await ask(tx, user.id, 'coder:held', { subscriptionId, code: check.code.code });
  const plans = await plansOnPanel(tx, user.id, service.provider_id);
  return answer(
    menu.discountHeldForRenewal(check.code.code),
    menu.renewPlanMenu(service.id, plans, user.discount_percent, check.code.code),
  );
}

/**
 * The code held against a renewal, re-checked now that the plan is known.
 *
 * This is where the product scope finally gets tested — the one check
 * `handleRenewalCode` could not make.
 */
async function heldRenewalCode(
  tx: D1DatabaseSession,
  user: Caller,
  subscriptionId: number,
  plan: CatalogPlan,
  priceIrr: number,
): Promise<{ code: DiscountCode; discountIrr: number } | null> {
  const row = await tx
    .prepare(`SELECT step, data FROM bot_sessions WHERE user_id = ?1`)
    .bind(user.id)
    .first<{ step: string | null; data: Record<string, unknown> | null }>();
  if (row?.step !== 'coder:held') return null;
  const data = row.data ?? {};
  if (Number(data['subscriptionId']) !== subscriptionId) return null;
  const typed = data['code'];
  if (typeof typed !== 'string') return null;

  const check = await checkCode(
    tx,
    user.id,
    user.is_reseller,
    typed,
    { kind: 'RENEW', priceIrr, productId: plan.productId, providerId: plan.providerId },
    Date.now(),
  );
  if (check.ok) return { code: check.code, discountIrr: check.discountIrr };
  if (
    check.reason === 'ALREADY_USED' &&
    check.code &&
    (await redemptionOnOpenOrder(tx, check.code.id, user.id, plan.planId))
  ) {
    return { code: check.code, discountIrr: discountFor(check.code, priceIrr) };
  }
  return null;
}

/** The code a renewal screen should show as held, if any. */
async function heldRenewalName(
  tx: D1DatabaseSession,
  userId: number,
  subscriptionId: number,
): Promise<string | null> {
  const row = await tx
    .prepare(`SELECT step, data FROM bot_sessions WHERE user_id = ?1`)
    .bind(userId)
    .first<{ step: string | null; data: Record<string, unknown> | null }>();
  if (row?.step !== 'coder:held') return null;
  if (Number(row.data?.['subscriptionId']) !== subscriptionId) return null;
  const typed = row.data?.['code'];
  return typeof typed === 'string' ? typed : null;
}

/** The text of a reseller application. */
async function handleResellerRequest(
  tx: D1DatabaseSession,
  message: TelegramMessage,
  user: Caller,
): Promise<HandleOutcome> {
  const said = (text: string, keyboard: InlineKeyboard): HandleOutcome => ({
    status: 'processed',
    replies: [{ chatId: message.chat.id, text, keyboard }],
  });
  const result = await applyForReseller(tx, user.id, user.is_reseller, message.text!);
  if (result === 'EMPTY') {
    // The question stays open — they can simply type again.
    return said(menu.RESELLER_REQUEST_EMPTY, menu.promptMenu(encode('menu')));
  }
  await clearSession(tx, user.id);
  const answer =
    result === 'FILED'
      ? menu.RESELLER_REQUEST_FILED
      : result === 'ALREADY_PENDING'
        ? menu.RESELLER_REQUEST_OPEN
        : menu.ALREADY_RESELLER;
  return said(answer, menu.mainMenu(user.is_reseller));
}

/** A gift code typed at the wallet. The credit itself is `redeemGift`. */
async function handleGiftCode(
  tx: D1DatabaseSession,
  message: TelegramMessage,
  user: Caller,
): Promise<HandleOutcome> {
  const result = await redeemGift(tx, user.id, user.is_reseller, message.text!, Date.now());
  if (!result.ok) {
    return {
      status: 'processed',
      replies: [
        {
          chatId: message.chat.id,
          text: menu.DISCOUNT_REFUSED[result.reason] ?? menu.DISCOUNT_REFUSED['UNKNOWN_CODE']!,
          keyboard: menu.walletMenu(),
        },
      ],
    };
  }
  await clearSession(tx, user.id);
  return {
    status: 'processed',
    replies: [
      {
        chatId: message.chat.id,
        text: menu.giftCredited(result.amountIrr, await balanceFor(tx, user.id)),
        keyboard: menu.walletMenu(),
      },
    ],
  };
}

/**
 * The code the customer is holding against this plan, if any, re-checked.
 *
 * Held in the session as a string and validated on every screen that shows a
 * price, so a code that expired or ran out between typing it and pressing
 * "order" simply stops applying instead of being honoured from memory.
 */
async function heldCode(
  tx: D1DatabaseSession,
  user: Caller,
  plan: CatalogPlan,
  priceIrr: number,
): Promise<{ code: DiscountCode; discountIrr: number } | null> {
  const row = await tx
    .prepare(`SELECT step, data FROM bot_sessions WHERE user_id = ?1`)
    .bind(user.id)
    .first<{ step: string | null; data: Record<string, unknown> | null }>();
  if (row?.step !== 'code:held') return null;
  const data = row.data ?? {};
  if (Number(data['planId']) !== plan.planId) return null;
  const typed = data['code'];
  if (typeof typed !== 'string') return null;

  const check = await checkCode(
    tx,
    user.id,
    user.is_reseller,
    typed,
    { kind: 'BUY', priceIrr, productId: plan.productId, providerId: plan.providerId },
    Date.now(),
  );
  if (check.ok) return { code: check.code, discountIrr: check.discountIrr };
  // Their own redemption, on an order they have not paid for, is this order.
  if (
    check.reason === 'ALREADY_USED' &&
    check.code &&
    (await redemptionOnOpenOrder(tx, check.code.id, user.id, plan.planId))
  ) {
    return { code: check.code, discountIrr: discountFor(check.code, priceIrr) };
  }
  return null;
}

/** How many payments one review screen lists. */
const CLAIMS_PER_PAGE = 6;

/**
 * Which permission each admin action needs.
 *
 * `apx` and `rej` are here even though they only write a pending decision to
 * `bot_sessions`: an operator who cannot confirm has no business being asked to,
 * and refusing at the button is a clearer answer than refusing at the end.
 *
 * `cnf` is absent because it carries no verb of its own — what it confirms is
 * whatever was asked for, so it is checked against the pending decision instead.
 * A single permission on `cnf` would be either too weak (a rejecter confirming
 * an approve-without-transaction) or too strong.
 */
const ACTION_PERMISSIONS: Record<string, readonly AdminPermission[]> = {
  clm: ['claims.view'],
  clv: ['claims.view'],
  apv: ['claims.approve'],
  apx: ['claims.approve_without_tx'],
  rej: ['claims.reject'],
  // Any one of these gets `cnf` through the door — an operator who can decide
  // nothing has nothing to confirm. Which decision it actually is gets checked
  // again below, against the session, because the two can differ.
  cnf: ['claims.reject', 'claims.approve_without_tx'],
};

/** What `cnf` is really doing, once the pending decision is known. */
const DECISION_PERMISSION: Record<'APPROVE_NO_TX' | 'REJECT', AdminPermission> = {
  APPROVE_NO_TX: 'claims.approve_without_tx',
  REJECT: 'claims.reject',
};

/**
 * The admin panel's callbacks, after `admins` has already said yes.
 *
 * The claim being worked on lives in `bot_sessions` rather than in the button:
 * a claim id and a transaction id are both UUIDs and the two together do not
 * fit in Telegram's 64 bytes. It is re-read and re-checked on every step, so
 * the session is a convenience, never an authority.
 */
async function handleAdmin(
  tx: D1DatabaseSession,
  admin: BotAdmin,
  action: Callback,
  screen: (text: string, keyboard?: InlineKeyboard) => HandleOutcome,
  telegramId: number,
  /** Where a message that is not the screen goes. Not assumed equal to the
   *  Telegram id, even though in a private chat it is. */
  chatId: number,
): Promise<HandleOutcome> {
  const allowed = permissionsOf(admin.role, admin.permissions);

  const home = async (): Promise<HandleOutcome> => {
    const waiting = await countClaimsAwaitingReview(tx);
    return screen(menu.adminHome(waiting), menu.adminMenu(waiting, allowed));
  };

  /** Refuses, writes it down, and puts the operator back on a screen they own. */
  const refuse = async (...permissions: AdminPermission[]): Promise<HandleOutcome> => {
    await audit(tx, admin, 'claim.action.refused', 'payment_claim', action.ref ?? '-', {
      reason: `role ${admin.role} may not ${permissions.join(' or ')}`,
    });
    return screen(
      menu.ADMIN_NOT_ALLOWED,
      menu.adminMenu(await countClaimsAwaitingReview(tx), allowed),
    );
  };

  /** The claim this admin is looking at, re-read every time. */
  const currentClaim = async () => {
    const userId = await adminSessionUser(tx, telegramId);
    if (userId === null) return null;
    const row = await tx
      .prepare(`SELECT step, data FROM bot_sessions WHERE user_id = ?1`)
      .bind(userId)
      .first<{ step: string | null; data: Record<string, unknown> | null }>();
    if (row?.step !== 'admin:claim') return null;
    const id = row.data?.['claimId'];
    return typeof id === 'string' ? await claimById(tx, id) : null;
  };

  /** Remembers which confirmable action was asked for, keeping the claim. */
  const askToConfirm = async (
    decision: 'APPROVE_NO_TX' | 'REJECT',
    text: string,
  ): Promise<HandleOutcome> => {
    const claim = await currentClaim();
    const userId = await adminSessionUser(tx, telegramId);
    if (!claim || userId === null) return screen(menu.CLAIM_GONE, menu.adminMenu(0, allowed));
    await ask(tx, userId, 'admin:claim', { claimId: claim.id, decision });
    return screen(text, menu.confirmMenu());
  };

  const showList = async (page: number): Promise<HandleOutcome> => {
    const total = await countClaimsAwaitingReview(tx);
    if (total === 0) return screen(menu.NO_CLAIMS, menu.adminMenu(0, allowed));
    const pages = Math.max(1, Math.ceil(total / CLAIMS_PER_PAGE));
    const at = Math.min(Math.max(page, 1), pages);
    const claims = await claimsAwaitingReview(tx, CLAIMS_PER_PAGE, (at - 1) * CLAIMS_PER_PAGE);
    return screen(menu.claimList(at, pages, total), menu.claimListMenu(claims, at, pages));
  };

  const showClaim = async (claimId: string): Promise<HandleOutcome> => {
    const claim = await claimById(tx, claimId);
    if (!claim || !['PENDING', 'MATCH_SUGGESTED'].includes(claim.status)) {
      return screen(menu.CLAIM_GONE, menu.adminMenu(await countClaimsAwaitingReview(tx), allowed));
    }
    const candidates = await candidateTransactions(tx, claim.id);
    await rememberClaim(tx, telegramId, claim.id);
    const out = screen(menu.claimDetail(claim, candidates), menu.claimDetailMenu(candidates, allowed));
    if (!claim.receipt_url_or_r2_key) return out;
    // The receipt goes first, as its own message. The detail screen replaces
    // itself in place on every press and a photo cannot be edited into a text
    // message — and an operator about to decide where somebody's money goes
    // should be looking at the document, not at a line saying one exists.
    return {
      ...out,
      replies: [
        { chatId, text: menu.ADMIN_RECEIPT_CAPTION, photo: claim.receipt_url_or_r2_key },
        ...out.replies,
      ],
    };
  };

  // Reading a claim is not deciding one, and neither is drawing the button.
  //
  // `adminFor` proves the sender is an admin; it does not say which. `role` used
  // to be read exactly once in this whole function, inside `audit()`, to
  // translate SUPPORT into the dashboard's REVIEWER — so a SUPPORT operator
  // marking an order paid with no bank transaction behind it was written down
  // faithfully and never stopped. A record is not a guard.
  //
  // That gap was shut with one condition over four action names. This is its
  // generalisation: the same question, per action, answered from the row rather
  // than from a hard-coded role. `callback_data` is a field anyone can post, so
  // this runs whether or not the button was ever drawn.
  const needed = ACTION_PERMISSIONS[action.action];
  if (needed !== undefined && !needed.some((p) => can(admin, p))) return refuse(...needed);

  switch (action.action) {
    case 'pnl':
      return home();

    case 'clm':
      return showList(action.id ?? 1);

    case 'clv':
      return action.ref === undefined ? IGNORED : showClaim(action.ref);

    case 'apv': {
      if (action.ref === undefined) return IGNORED;
      const claim = await currentClaim();
      if (!claim) return screen(menu.CLAIM_GONE, menu.adminMenu(0, allowed));
      // `verifyMirzabotClaim` is the only path allowed to settle one of these.
      // It re-checks the account, the amount and both sides being unconsumed,
      // and writes through the partial unique indexes that stop one bank
      // transaction paying for two orders.
      const result = await verifyMirzabotClaim(tx as unknown as D1Database, {
        claimId: claim.id,
        transactionId: action.ref,
        mode: 'ADMIN_APPROVED',
        actorEmail: null,
      });
      if (!result.ok) {
        await audit(tx, admin, 'claim.approve.failed', 'payment_claim', claim.id, {
          reason: result.error,
        });
        return screen(menu.claimNotApproved(result.error), menu.adminMenu(0, allowed));
      }
      await audit(tx, admin, 'claim.approve', 'payment_claim', claim.id, {
        after: { transactionId: action.ref, amountIrr: claim.expected_amount_irr },
      });
      await clearAdminSession(tx, telegramId);
      return screen(
        menu.claimApproved(claim.expected_amount_irr),
        menu.adminMenu(await countClaimsAwaitingReview(tx), allowed),
      );
    }

    case 'apx':
      return askToConfirm('APPROVE_NO_TX', menu.CONFIRM_APPROVE_WITHOUT_TX);

    case 'rej':
      return askToConfirm('REJECT', menu.CONFIRM_REJECT);

    case 'cnf': {
      const pending = await pendingDecision(tx, telegramId);
      const claim = await currentClaim();
      if (!claim || pending === null) return screen(menu.CLAIM_GONE, menu.adminMenu(0, allowed));
      // Checked here rather than at the top: `cnf` means whatever the session
      // says it means. An operator whose permission was taken away while the
      // confirmation screen was open is refused now, not carried through by a
      // decision they were allowed to ask for a minute ago.
      const forDecision = DECISION_PERMISSION[pending];
      if (!can(admin, forDecision)) return refuse(forDecision);
      if (pending === 'REJECT') {
        const done = await rejectClaim(tx, claim.id);
        if (!done) return screen(menu.CLAIM_GONE, menu.adminMenu(0, allowed));
        await audit(tx, admin, 'claim.reject', 'payment_claim', claim.id, {
          after: { amountIrr: claim.expected_amount_irr },
        });
        await clearAdminSession(tx, telegramId);
        return screen(
          menu.claimRejected(claim.expected_amount_irr),
          menu.adminMenu(await countClaimsAwaitingReview(tx), allowed),
        );
      }
      const result = await verifyMirzabotClaimWithoutTransaction(
        tx as unknown as D1Database,
        { claimId: claim.id, actorEmail: null },
      );
      if (!result.ok) {
        await audit(tx, admin, 'claim.approve.failed', 'payment_claim', claim.id, {
          reason: result.error,
        });
        return screen(menu.claimNotApproved(result.error), menu.adminMenu(0, allowed));
      }
      await audit(tx, admin, 'claim.approve.no_transaction', 'payment_claim', claim.id, {
        after: { amountIrr: claim.expected_amount_irr },
        reason: 'settled without a bank transaction',
      });
      await clearAdminSession(tx, telegramId);
      return screen(
        menu.claimApproved(claim.expected_amount_irr),
        menu.adminMenu(await countClaimsAwaitingReview(tx), allowed),
      );
    }

    default:
      return IGNORED;
  }
}

/** An admin is a customer too — the session row is keyed by `users.id`. */
async function adminSessionUser(tx: D1DatabaseSession, telegramId: number): Promise<number | null> {
  const row = await tx
    .prepare(`SELECT id FROM users WHERE telegram_id = ?1`)
    .bind(telegramId)
    .first<{ id: number }>();
  return row?.id ?? null;
}

async function rememberClaim(
  tx: D1DatabaseSession,
  telegramId: number,
  claimId: string,
): Promise<void> {
  const userId = await adminSessionUser(tx, telegramId);
  if (userId === null) return;
  await ask(tx, userId, 'admin:claim', { claimId });
}

/** Which of the two confirmable actions was asked for, if either. */
async function pendingDecision(
  tx: D1DatabaseSession,
  telegramId: number,
): Promise<'APPROVE_NO_TX' | 'REJECT' | null> {
  const userId = await adminSessionUser(tx, telegramId);
  if (userId === null) return null;
  const row = await tx
    .prepare(`SELECT data FROM bot_sessions WHERE user_id = ?1`)
    .bind(userId)
    .first<{ data: Record<string, unknown> | null }>();
  const decision = row?.data?.['decision'];
  return decision === 'APPROVE_NO_TX' || decision === 'REJECT' ? decision : null;
}

async function clearAdminSession(tx: D1DatabaseSession, telegramId: number): Promise<void> {
  const userId = await adminSessionUser(tx, telegramId);
  if (userId !== null) await clearSession(tx, userId);
}

async function handleCallback(
  tx: D1DatabaseSession,
  query: TelegramCallbackQuery,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<HandleOutcome> {
  const action = decode(query.data);
  if (!action) return IGNORED;

  // A callback can arrive without its message: Telegram drops the message from
  // the update once it is old enough. The private chat id equals the user id,
  // so there is always somewhere to answer — just not always something to edit.
  const chatId = query.message?.chat.id ?? query.from.id;
  const editId = query.message?.message_id;
  const screen = (text: string, keyboard?: InlineKeyboard): HandleOutcome => ({
    status: 'processed',
    replies: [reply(chatId, text, keyboard, editId)],
  });

  const user = await tx
    .prepare(
      `UPDATE users SET last_seen_at = now(), updated_at = now()
        WHERE telegram_id = ?1
        RETURNING id, status, is_reseller, discount_percent`,
    )
    .bind(query.from.id)
    .first<Caller>();
  // No row means this customer never pressed /start — or never existed, which is
  // what a forged callback looks like. Both get the same nudge and nothing else.
  if (!user) {
    return { status: 'ignored', replies: [reply(chatId, menu.NOT_REGISTERED)] };
  }
  if (user.status === 'BLOCKED') return IGNORED;

  switch (action.action) {
    case 'menu':
      return screen(menu.MENU_TITLE, menu.mainMenu(user.is_reseller));

    case 'soon':
      return screen(menu.SOON, menu.mainMenu(user.is_reseller));

    case 'buy': {
      const panels = await panelsForUser(tx, user.id);
      if (panels.length === 0) {
        return screen(menu.SHOP_EMPTY, menu.mainMenu(user.is_reseller));
      }
      return screen(menu.CHOOSE_PANEL, menu.panelMenu(panels));
    }

    case 'panel': {
      if (action.id === undefined) return IGNORED;
      const plans = await plansOnPanel(tx, user.id, action.id);
      if (plans.length === 0) {
        // Either the panel emptied out between two taps, or it was never
        // theirs to open. One answer for both.
        return screen(menu.PANEL_EMPTY, menu.planMenu([]));
      }
      return screen(menu.CHOOSE_PLAN, menu.planMenu(plans, user.discount_percent));
    }

    case 'plan': {
      if (action.id === undefined) return IGNORED;
      const plan = await purchasablePlan(tx, user.id, action.id);
      if (!plan) return screen(menu.PLAN_GONE, menu.planMenu([]));
      const price = priceForUser(plan.priceIrr, user.discount_percent);
      const held = await heldCode(tx, user, plan, price.totalIrr);
      const applied = held ? { code: held.code.code, discountIrr: held.discountIrr } : null;
      return screen(menu.planDetail(plan, price, applied), menu.planDetailMenu(plan, applied));
    }

    case 'dsc': {
      if (action.id === undefined) return IGNORED;
      // Checked here as well: a forged `dsc` for a hidden plan must not open a
      // flow that ends in an order for it.
      const plan = await purchasablePlan(tx, user.id, action.id);
      if (!plan) return screen(menu.PLAN_GONE, menu.planMenu([]));
      await ask(tx, user.id, 'code', { planId: plan.planId });
      return screen(menu.ASK_DISCOUNT_CODE, menu.promptMenu(encode('plan', plan.planId)));
    }

    case 'dsx': {
      if (action.id === undefined) return IGNORED;
      const plan = await purchasablePlan(tx, user.id, action.id);
      if (!plan) return screen(menu.PLAN_GONE, menu.planMenu([]));
      await clearSession(tx, user.id);
      const price = priceForUser(plan.priceIrr, user.discount_percent);
      return screen(
        `${menu.DISCOUNT_TAKEN_OFF}\n\n${menu.planDetail(plan, price)}`,
        menu.planDetailMenu(plan),
      );
    }

    case 'gft': {
      await ask(tx, user.id, 'gift', {});
      return screen(menu.ASK_GIFT_CODE, menu.promptMenu(encode('wal')));
    }

    // --- the admin panel -----------------------------------------------
    // Every one of these asks `admins` first. A customer who forges `clv:<id>`
    // is ignored exactly as they would be for any unknown callback.
    case 'pnl':
    case 'clm':
    case 'clv':
    case 'apv':
    case 'apx':
    case 'rej':
    case 'cnf': {
      const admin = await adminFor(tx, query.from.id);
      if (!admin) return IGNORED;
      return handleAdmin(tx, admin, action, screen, query.from.id, chatId);
    }

    case 'sup': {
      // The handle is the admin's own setting, not a constant in our source —
      // production runs `statussupportpv = onpvsupport` with `id_support` set,
      // and both can change without a deploy.
      const handle = (await settingIs(tx, 'bot', 'statussupportpv', 'onpvsupport'))
        ? await settingText(tx, 'bot', 'id_support')
        : null;
      return screen(
        handle === null ? menu.SUPPORT_UNAVAILABLE : menu.supportScreen(handle),
        menu.mainMenu(user.is_reseller),
      );
    }

    case 'hlp': {
      if (action.id !== undefined) {
        const article = await helpArticle(tx, action.id);
        if (!article) return screen(menu.HELP_EMPTY, menu.mainMenu(user.is_reseller));
        return screen(
          menu.helpArticleScreen(article.title, article.body),
          menu.helpMenu([], (await clientApps(tx)).length > 0),
        );
      }
      const articles = await helpArticles(tx);
      const apps = await clientApps(tx);
      if (articles.length === 0 && apps.length === 0) {
        return screen(menu.HELP_EMPTY, menu.mainMenu(user.is_reseller));
      }
      return screen(menu.CHOOSE_HELP, menu.helpMenu(articles, apps.length > 0));
    }

    case 'app': {
      const apps = await clientApps(tx);
      if (apps.length === 0) return screen(menu.APPS_EMPTY, menu.mainMenu(user.is_reseller));
      return screen(menu.appsScreen(apps), menu.helpMenu([], false));
    }

    case 'ref': {
      const username = await settingText(tx, 'bot', 'username');
      if (username === null) {
        // Nothing here is worth showing without a link that works.
        return screen(menu.SOON, menu.mainMenu(user.is_reseller));
      }
      const summary = await referralSummary(tx, user.id);
      return screen(
        menu.referralScreen(
          referralLink(username, user.id),
          summary.invited,
          summary.earnedIrr,
          SHOP.commissionPercent,
        ),
        menu.referralMenu(),
      );
    }

    case 'agr': {
      // Both answers before the question: a reseller has nothing to apply for,
      // and somebody already waiting does not need to write it out twice.
      if (user.is_reseller) return screen(menu.ALREADY_RESELLER, menu.mainMenu(true));
      if (await hasOpenRequest(tx, user.id)) {
        return screen(menu.RESELLER_REQUEST_OPEN, menu.mainMenu(false));
      }
      await ask(tx, user.id, 'agent', {});
      return screen(menu.ASK_RESELLER_REQUEST, menu.promptMenu(encode('menu')));
    }

    case 'order': {
      if (action.id === undefined) return IGNORED;
      // The same visibility check the list used, run again. Reaching this point
      // is not evidence that a button was ever offered for this plan.
      const plan = await purchasablePlan(tx, user.id, action.id);
      if (!plan) return screen(menu.PLAN_GONE, menu.planMenu([]));
      // The code is checked once more, here, in the transaction that writes the
      // order and the redemption together. Two taps cannot both spend it: the
      // second `redeem` writes no row, and the order is placed at full price.
      const listed = priceForUser(plan.priceIrr, user.discount_percent);
      const held = await heldCode(tx, user, plan, listed.totalIrr);
      const placed = await placeOrder(
        tx,
        user.id,
        plan,
        user.discount_percent,
        held?.discountIrr ?? 0,
      );
      // A total of zero is refused rather than written. The code is left
      // unredeemed on purpose: nothing was bought with it.
      if (!placed) return screen(menu.ORDER_NOT_PAYABLE, menu.planDetailMenu(plan));
      // Not cleared afterwards, deliberately: the held code is what lets a
      // second tap re-price the same plan the same way and land back on the
      // order that already exists. `/start` and «برداشتن کد» clear it.
      if (held) await redeem(tx, held.code.id, user.id, placed.id, held.discountIrr);
      const checkout = await checkoutFor(tx, user.id, placed.id, placed.totalIrr, newPublicId());
      if (!checkout) {
        return screen(menu.NO_CARD_AVAILABLE, menu.afterPaidMenu());
      }
      if (checkout.claimed) {
        return screen(menu.paidAlready(checkout.publicId), menu.afterPaidMenu());
      }
      return screen(
        menu.checkout(
          placed.publicId,
          plan,
          placed.totalIrr,
          checkout.cardDigits,
          checkout.cardHolder,
        ),
        menu.checkoutMenu(placed.id, placed.totalIrr, checkout.cardDigits, {
          balanceIrr: await balanceFor(tx, user.id),
          totalIrr: placed.totalIrr,
        }),
      );
    }

    case 'mine': {
      // The page is untrusted and needs no check: it becomes an OFFSET into a
      // query that is already scoped to this customer, so the worst a forged
      // page can do is show them nothing.
      const total = await countSubscriptionsForUser(tx, user.id);
      if (total === 0) {
        return screen(menu.MY_SERVICES_EMPTY, menu.mainMenu(user.is_reseller));
      }
      const pages = Math.ceil(total / menu.SERVICES_PER_PAGE);
      const page = Math.min(action.id ?? 1, pages);
      const services = await subscriptionsForUser(
        tx,
        user.id,
        menu.SERVICES_PER_PAGE,
        (page - 1) * menu.SERVICES_PER_PAGE,
      );
      return screen(
        menu.myServicesTitle(total, page, pages),
        menu.myServicesMenu(services, Date.now(), page, pages),
      );
    }

    case 'sub': {
      if (action.id === undefined) return IGNORED;
      // Straight through owned.ts. This is the exact lookup Mirzabot does by id
      // alone on the `subscriptionurl_` button, which hands any customer any
      // other customer's config — BUGS-FOR-ADMIN.md item 8.
      const service = await subscriptionOnPanelForUser(tx, user.id, action.id);
      if (!service) return screen(menu.SERVICE_GONE, menu.myServicesMenu([], Date.now(), 1, 1));
      return screen(
        menu.serviceDetail(service, Date.now()),
        menu.serviceDetailMenu(actionsFor(service, tierFor(user))),
      );
    }

    case 'xv':
    case 'xt': {
      if (action.id === undefined) return IGNORED;
      const service = await subscriptionOnPanelForUser(tx, user.id, action.id);
      if (!service) return screen(menu.SERVICE_GONE, menu.myServicesMenu([], Date.now(), 1, 1));
      const actions = actionsFor(service, tierFor(user));
      const kind = action.action === 'xv' ? 'ADD_VOLUME' : 'ADD_TIME';
      const unit =
        kind === 'ADD_VOLUME' ? (actions?.volumeIrrPerGb ?? null) : (actions?.timeIrrPerDay ?? null);
      // The button is only drawn when there is a price, but the button is not
      // what decides — a forged callback lands here too.
      if (unit === null) return screen(menu.ACTION_UNSUPPORTED, menu.serviceDetailMenu());
      // The amount is typed, not tapped, so the flow has to survive the gap.
      // `bot_sessions` is where that lives, and it is scoped to the user row —
      // the service id in it was already checked for ownership just above.
      await tx
        .prepare(
          `INSERT INTO bot_sessions (user_id, step, data, updated_at)
           VALUES (?1, ?2, ?3::jsonb, now())
           ON CONFLICT (user_id) DO UPDATE
             SET step = EXCLUDED.step, data = EXCLUDED.data, updated_at = now()`,
        )
        .bind(user.id, `addon:${kind}`, JSON.stringify({ subscriptionId: service.id }))
        .run();
      return screen(menu.askAddonAmount(kind, unit), menu.confirmRevokeMenu(service.id).slice(1));
    }

    case 'rvk': {
      if (action.id === undefined) return IGNORED;
      const service = await subscriptionOnPanelForUser(tx, user.id, action.id);
      if (!service) return screen(menu.SERVICE_GONE, menu.myServicesMenu([], Date.now(), 1, 1));
      if (!actionsFor(service)) {
        return screen(menu.ACTION_UNSUPPORTED, menu.serviceDetailMenu());
      }
      return screen(menu.CONFIRM_REVOKE, menu.confirmRevokeMenu(action.id));
    }

    case 'rvk2':
    case 'off':
    case 'on': {
      if (action.id === undefined) return IGNORED;
      const kind = action.action === 'rvk2' ? 'REVOKE' : action.action === 'on' ? 'ENABLE' : 'DISABLE';
      const outcome = await actOnService(tx, user.id, action.id, kind, fetchImpl);
      if (outcome.status === 'GONE') {
        return screen(menu.SERVICE_GONE, menu.myServicesMenu([], Date.now(), 1, 1));
      }
      if (outcome.status === 'UNSUPPORTED') {
        return screen(menu.ACTION_UNSUPPORTED, menu.serviceDetailMenu());
      }
      if (outcome.status === 'FAILED') {
        return screen(
          menu.actionFailed(outcome.reason),
          menu.serviceDetailMenu(actionsFor(outcome.service)),
        );
      }
      // The service is redrawn under the message, so the customer sees the new
      // state rather than being told about it and left on a stale screen.
      const detail = menu.serviceDetail(outcome.service, Date.now());
      const said =
        kind === 'REVOKE'
          ? outcome.subscriptionUrl === null
            ? menu.actionFailed(menu.ACTION_FAILED_NO_LINK)
            : menu.linkReplaced(outcome.subscriptionUrl)
          : menu.serviceSwitched(kind === 'ENABLE');
      return screen(`${said}\n\n${detail}`, menu.serviceDetailMenu(actionsFor(outcome.service)));
    }

    case 'renew': {
      const total = await countRenewableForUser(tx, user.id);
      if (total === 0) {
        return screen(menu.NOTHING_TO_RENEW, menu.mainMenu(user.is_reseller));
      }
      const pages = Math.ceil(total / menu.SERVICES_PER_PAGE);
      const page = Math.min(action.id ?? 1, pages);
      const services = await renewableForUser(
        tx,
        user.id,
        menu.SERVICES_PER_PAGE,
        (page - 1) * menu.SERVICES_PER_PAGE,
      );
      return screen(
        menu.CHOOSE_SERVICE_TO_RENEW,
        menu.renewMenu(services, Date.now(), page, pages),
      );
    }

    case 'rnw': {
      if (action.id === undefined) return IGNORED;
      const service = await renewableForUserById(tx, user.id, action.id);
      if (!service) return screen(menu.RENEWAL_GONE, menu.renewMenu([], Date.now(), 1, 1));
      if (!renewAllowed(service.provider_config ?? {})) {
        return screen(menu.RENEWAL_CLOSED, menu.afterPaidMenu());
      }
      // The plans on the panel this service already lives on, through the same
      // visibility rule the shop uses. The plan it was originally sold under is
      // gone for roughly half of the migrated services, so offering only that
      // would tell most customers their service cannot be renewed.
      const plans = await plansOnPanel(tx, user.id, service.provider_id);
      if (plans.length === 0) {
        return screen(menu.NO_RENEWAL_PLAN, menu.afterPaidMenu());
      }
      return screen(
        menu.renewIntro(service, renewModeFor(service.provider_config ?? {}), Date.now()),
        menu.renewPlanMenu(
          service.id,
          plans,
          user.discount_percent,
          await heldRenewalName(tx, user.id, service.id),
        ),
      );
    }

    case 'dsr': {
      if (action.id === undefined) return IGNORED;
      // Ownership first, like every other id off a button.
      const service = await renewableForUserById(tx, user.id, action.id);
      if (!service) return screen(menu.RENEWAL_GONE, menu.renewMenu([], Date.now(), 1, 1));
      await ask(tx, user.id, 'coder', { subscriptionId: service.id });
      return screen(menu.ASK_DISCOUNT_CODE, menu.promptMenu(encode('rnw', service.id)));
    }

    case 'dxr': {
      if (action.id === undefined) return IGNORED;
      const service = await renewableForUserById(tx, user.id, action.id);
      if (!service) return screen(menu.RENEWAL_GONE, menu.renewMenu([], Date.now(), 1, 1));
      await clearSession(tx, user.id);
      const plans = await plansOnPanel(tx, user.id, service.provider_id);
      return screen(
        `${menu.DISCOUNT_TAKEN_OFF}\n\n${menu.renewIntro(service, renewModeFor(service.provider_config ?? {}), Date.now())}`,
        menu.renewPlanMenu(service.id, plans, user.discount_percent),
      );
    }

    case 'rord': {
      if (action.id === undefined || action.id2 === undefined) return IGNORED;
      // Both ids came off a button, so both are checked again: the service
      // against its owner, the plan against the same rule the list used.
      const service = await renewableForUserById(tx, user.id, action.id);
      if (!service) return screen(menu.RENEWAL_GONE, menu.renewMenu([], Date.now(), 1, 1));
      if (!renewAllowed(service.provider_config ?? {})) {
        return screen(menu.RENEWAL_CLOSED, menu.afterPaidMenu());
      }
      const plan = await purchasablePlan(tx, user.id, action.id2);
      // A plan from another panel is not a renewal of THIS service, whatever
      // the button said. Checking the provider is what stops a cheap plan on
      // one panel being used to extend an expensive service on another.
      if (!plan || plan.providerId !== service.provider_id) {
        return screen(menu.PLAN_GONE, menu.afterPaidMenu());
      }
      const listed = priceForUser(plan.priceIrr, user.discount_percent);
      const held = await heldRenewalCode(tx, user, service.id, plan, listed.totalIrr);
      const placed = await placeRenewalOrder(
        tx,
        user.id,
        plan,
        user.discount_percent,
        service.id,
        held?.discountIrr ?? 0,
      );
      if (!placed) return screen(menu.ORDER_NOT_PAYABLE, menu.serviceDetailMenu());
      // Same rule as a purchase: the redemption is written in the transaction
      // that writes the order, and the held code stays put so a second tap
      // re-prices identically and lands on the order that already exists.
      if (held) await redeem(tx, held.code.id, user.id, placed.id, held.discountIrr);
      const checkout = await checkoutFor(tx, user.id, placed.id, placed.totalIrr, newPublicId());
      if (!checkout) {
        return screen(menu.NO_CARD_AVAILABLE, menu.afterPaidMenu());
      }
      if (checkout.claimed) {
        return screen(menu.paidAlready(checkout.publicId), menu.afterPaidMenu());
      }
      return screen(
        menu.renewCheckout(
          placed.publicId,
          service.plan_name_at_sale,
          plan,
          placed.totalIrr,
          checkout.cardDigits,
          checkout.cardHolder,
          held ? { code: held.code.code, discountIrr: held.discountIrr } : null,
        ),
        menu.checkoutMenu(placed.id, placed.totalIrr, checkout.cardDigits, {
          balanceIrr: await balanceFor(tx, user.id),
          totalIrr: placed.totalIrr,
        }),
      );
    }

    case 'paid': {
      if (action.id === undefined) return IGNORED;
      // The order id came off a button, so it is checked against its owner
      // before anything is written. A forged id belongs to nobody.
      const order = await orderForUser(tx, user.id, action.id);
      if (!order) return screen(menu.ORDER_GONE, menu.afterPaidMenu());
      const result = await recordPaidClick(tx, user.id, order.id, query.from.id);
      switch (result.outcome) {
        case 'claimed':
          return screen(menu.paidRecorded(result.publicId), menu.afterPaidMenu());
        case 'already':
          return screen(menu.paidAlready(result.publicId), menu.afterPaidMenu());
        case 'expired':
          return screen(menu.ORDER_EXPIRED, menu.afterPaidMenu());
        case 'none':
          return screen(menu.ORDER_GONE, menu.afterPaidMenu());
      }
    }

    case 'wal': {
      const [balance, entries] = await Promise.all([
        balanceFor(tx, user.id),
        entriesFor(tx, user.id, WALLET_HISTORY),
      ]);
      return screen(menu.walletHome(balance, entries), menu.walletMenu());
    }

    case 'top':
      return screen(
        menu.chooseTopupAmount(SHOP.topupMinIrr, SHOP.topupMaxIrr),
        menu.topupMenu(topupPresetsIrr(SHOP.topupMinIrr, SHOP.topupMaxIrr)),
      );

    case 'tp': {
      if (action.id === undefined) return IGNORED;
      // The button carries which choice was pressed, not how much it is worth.
      // An id that is not one of ours buys nothing. Resolved against the same
      // presets the buttons were drawn from, so a limit changed between the two
      // taps cannot turn a stale index into an amount the shop refuses.
      const amount = topupAmount(action.id, topupPresetsIrr(SHOP.topupMinIrr, SHOP.topupMaxIrr));
      if (amount === null) return IGNORED;
      return topup(tx, user.id, amount, screen);
    }

    case 'tpo': {
      if (action.id === undefined) return IGNORED;
      const order = await orderForUser(tx, user.id, action.id);
      if (!order) return screen(menu.ORDER_GONE, menu.afterPaidMenu());
      // Recomputed from the order and the balance as they are now. The amount
      // is never taken from the button, because a customer could name their own.
      const needed = topupNeededIrr(
        order.total_irr,
        await balanceFor(tx, user.id),
        SHOP.topupMinIrr,
      );
      if (needed === null) return screen(menu.MENU_TITLE, menu.mainMenu(user.is_reseller));
      return topup(tx, user.id, needed, screen);
    }

    case 'wpay': {
      if (action.id === undefined) return IGNORED;
      const order = await orderForUser(tx, user.id, action.id);
      if (!order || order.status !== 'AWAITING_PAYMENT') {
        return screen(menu.ORDER_GONE, menu.afterPaidMenu());
      }
      const spent = await spendOnOrder(tx, user.id, order.id, order.total_irr);
      if (spent === 'INSUFFICIENT') {
        return screen(menu.WALLET_TOO_LITTLE, menu.walletMenu());
      }
      // The money is ours now, so the order is paid and the provisioning sweep
      // owns it from here. A WALLET payment row is written so the sale reads
      // the same as any other in the reports.
      await tx
        .prepare(
          `UPDATE orders SET status = 'PAID', updated_at = now()
            WHERE id = ?1 AND status = 'AWAITING_PAYMENT'`,
        )
        .bind(order.id)
        .run();
      // Paying from the balance is a purchase like any other, so it earns the
      // referrer the same commission a card-to-card payment does. Both paths
      // call the same function, which is what stops the two disagreeing.
      await payReferralCommission(tx, order.id, SHOP.commissionPercent);
      await tx
        .prepare(
          // On the PAID-per-order index from 0016, not on `public_id`: that one
          // is minted fresh on every call, so the conflict it named could never
          // happen and the clause protected nothing. Naming the real index
          // turns a racing second press into a no-op instead of an exception.
          `INSERT INTO payments
             (public_id, user_id, order_id, amount_irr, method, status, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, 'WALLET', 'PAID', now(), now())
           ON CONFLICT (order_id) WHERE order_id IS NOT NULL AND status = 'PAID'
           DO NOTHING`,
        )
        .bind(newPublicId(), user.id, order.id, order.total_irr)
        .run();
      return screen(
        menu.walletPaid(order.public_id, await balanceFor(tx, user.id)),
        menu.afterPaidMenu(),
      );
    }
  }
}

/** How many movements the wallet screen shows. Enough to explain a balance. */
const WALLET_HISTORY = 8;

/**
 * Turns a chosen amount into an order and a card to pay it into.
 *
 * Shared by the two ways a deposit starts — a preset button and "top up what
 * this order still needs" — so both produce the same row and the same screen.
 */
async function topup(
  tx: D1DatabaseSession,
  userId: number,
  amountIrr: number,
  screen: (text: string, keyboard?: InlineKeyboard) => HandleOutcome,
): Promise<HandleOutcome> {
  const placed = await placeTopupOrder(tx, userId, amountIrr);
  // Unreachable today — `placeTopupOrder` already throws on a non-positive
  // amount and no discount touches a deposit — but the floor is in `place()`
  // for every caller, so this branch exists rather than a non-null assertion
  // that would become a lie the day deposits gain a discount.
  if (!placed) return screen(menu.ORDER_NOT_PAYABLE, menu.walletMenu());
  const checkout = await checkoutFor(tx, userId, placed.id, placed.totalIrr, newPublicId());
  if (!checkout) return screen(menu.NO_CARD_AVAILABLE, menu.walletMenu());
  if (checkout.claimed) return screen(menu.paidAlready(checkout.publicId), menu.afterPaidMenu());
  return screen(
    menu.topupCheckout(placed.publicId, placed.totalIrr, checkout.cardDigits, checkout.cardHolder),
    menu.checkoutMenu(placed.id, placed.totalIrr, checkout.cardDigits),
  );
}

