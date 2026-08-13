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
import { decode } from './callback.js';
import { panelsForUser, plansOnPanel, purchasablePlan } from './catalog.js';
import * as menu from './menu.js';
import { priceForUser } from './money.js';
import { newPublicId, placeOrder } from './order.js';
import {
  countSubscriptionsForUser,
  orderForUser,
  subscriptionForUser,
  subscriptionsForUser,
} from './owned.js';
import { checkoutFor, recordPaidClick } from './payment.js';
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

export async function handleUpdate(db: D1Database, update: TelegramUpdate): Promise<HandleOutcome> {
  return db.withSession(async (tx) => {
    const claim = await tx
      .prepare(`INSERT INTO telegram_updates (update_id) VALUES (?1) ON CONFLICT DO NOTHING`)
      .bind(update.update_id)
      .run();
    if (claim.meta.changes === 0) {
      return { status: 'duplicate', replies: [] };
    }

    if (update.callback_query) {
      return handleCallback(tx, update.callback_query);
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
    return IGNORED;
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

async function handleCallback(
  tx: D1DatabaseSession,
  query: TelegramCallbackQuery,
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
        menu.checkoutMenu(placed.id),
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
      const service = await subscriptionForUser(tx, user.id, action.id);
      if (!service) return screen(menu.SERVICE_GONE, menu.myServicesMenu([], Date.now(), 1, 1));
      return screen(menu.serviceDetail(service, Date.now()), menu.serviceDetailMenu());
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
  }
}
