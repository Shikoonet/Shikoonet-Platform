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
import { extraPricingFor, isAutomated, renewAllowed, renewModeFor } from '@shikoo/domain';
import { actOnService } from './actions.js';
import { decode } from './callback.js';
import { panelsForUser, plansOnPanel, purchasablePlan } from './catalog.js';
import * as menu from './menu.js';
import { priceForUser } from './money.js';
import {
  newPublicId,
  placeAddonOrder,
  placeOrder,
  placeRenewalOrder,
  placeTopupOrder,
} from './order.js';
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
import { checkoutFor, recordPaidClick } from './payment.js';
import {
  balanceFor,
  entriesFor,
  spendOnOrder,
  topupAmount,
  topupNeededIrr,
  TOPUP_AMOUNTS_IRR,
  TOPUP_MAX_IRR,
  TOPUP_MIN_IRR,
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
    volumeIrrPerGb: pricing.volumeIrrPerGb,
    timeIrrPerDay: pricing.timeIrrPerDay,
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
    if (!message?.text || !message.from) {
      return IGNORED;
    }

    if (command(message.text) === '/start') {
      return handleStart(tx, message);
    }
    // The one flow that needs a typed answer: how many gigabytes, how many days.
    return handleAddonAmount(tx, message);
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

  return {
    status: 'processed',
    replies: [reply(message.chat.id, menu.WELCOME, menu.mainMenu(user.is_reseller))],
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
async function handleAddonAmount(
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

  const session = await tx
    .prepare(`SELECT step, data FROM bot_sessions WHERE user_id = ?1`)
    .bind(user.id)
    .first<{ step: string | null; data: Record<string, unknown> | null }>();
  const step = session?.step ?? '';
  if (!step.startsWith('addon:')) return IGNORED;
  const kind = step === 'addon:ADD_VOLUME' ? 'ADD_VOLUME' : 'ADD_TIME';
  const subscriptionId = Number(session?.data?.['subscriptionId']);
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
  const checkout = await checkoutFor(tx, user.id, placed.id, placed.totalIrr, newPublicId());
  if (!checkout) return reply(menu.NO_CARD_AVAILABLE, menu.afterPaidMenu());
  if (checkout.claimed) return reply(menu.paidAlready(checkout.publicId), menu.afterPaidMenu());

  // The step is cleared here and not before: a customer who typed something
  // unusable is still in the flow and can simply type again.
  await tx
    .prepare(`UPDATE bot_sessions SET step = NULL, data = '{}'::jsonb, updated_at = now()
               WHERE user_id = ?1`)
    .bind(user.id)
    .run();

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
    menu.checkoutMenu(placed.id, {
      balanceIrr: await balanceFor(tx, user.id),
      totalIrr: placed.totalIrr,
    }),
  );
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
      return screen(menu.planDetail(plan, price), menu.planDetailMenu(plan));
    }

    case 'order': {
      if (action.id === undefined) return IGNORED;
      // The same visibility check the list used, run again. Reaching this point
      // is not evidence that a button was ever offered for this plan.
      const plan = await purchasablePlan(tx, user.id, action.id);
      if (!plan) return screen(menu.PLAN_GONE, menu.planMenu([]));
      const placed = await placeOrder(tx, user.id, plan, user.discount_percent);
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
        menu.checkoutMenu(placed.id, {
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
            ? menu.actionFailed('پنل لینک جدیدی برنگرداند')
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
      const placed = await placeRenewalOrder(tx, user.id, plan, user.discount_percent, service.id);
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
        ),
        menu.checkoutMenu(placed.id, {
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
        menu.chooseTopupAmount(TOPUP_MIN_IRR, TOPUP_MAX_IRR),
        menu.topupMenu(TOPUP_AMOUNTS_IRR),
      );

    case 'tp': {
      if (action.id === undefined) return IGNORED;
      // The button carries which choice was pressed, not how much it is worth.
      // An id that is not one of ours buys nothing.
      const amount = topupAmount(action.id);
      if (amount === null) return IGNORED;
      return topup(tx, user.id, amount, screen);
    }

    case 'tpo': {
      if (action.id === undefined) return IGNORED;
      const order = await orderForUser(tx, user.id, action.id);
      if (!order) return screen(menu.ORDER_GONE, menu.afterPaidMenu());
      // Recomputed from the order and the balance as they are now. The amount
      // is never taken from the button, because a customer could name their own.
      const needed = topupNeededIrr(order.total_irr, await balanceFor(tx, user.id));
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
      await tx
        .prepare(
          `INSERT INTO payments
             (public_id, user_id, order_id, amount_irr, method, status, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, 'WALLET', 'PAID', now(), now())
           ON CONFLICT (public_id) DO NOTHING`,
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
  const checkout = await checkoutFor(tx, userId, placed.id, placed.totalIrr, newPublicId());
  if (!checkout) return screen(menu.NO_CARD_AVAILABLE, menu.walletMenu());
  if (checkout.claimed) return screen(menu.paidAlready(checkout.publicId), menu.afterPaidMenu());
  return screen(
    menu.topupCheckout(placed.publicId, placed.totalIrr, checkout.cardDigits, checkout.cardHolder),
    menu.checkoutMenu(placed.id),
  );
}

