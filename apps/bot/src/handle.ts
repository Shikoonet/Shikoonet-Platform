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
  CUSTOMER_NAME_MAX,
  extraBoundsFor,
  renewAllowed,
  renewModeFor,
  sanitiseUsernamePart,
} from '@shikoo/domain';
import { actOnService } from './actions.js';
import { decode, encode } from './callback.js';
import type { CatalogCategory, CatalogPlan } from './catalog.js';
import {
  categoriesForUser,
  plansInProduct,
  tariffForUser,
  plansOnPanel,
  productsForUser,
  purchasablePlan,
  type TrialPanel,
  trialPanelsForUser,
} from './catalog.js';
import {
  checkCode,
  type DiscountCode,
  discountFor,
  redeem,
  redeemGift,
  redemptionOnOpenOrder,
} from './discount.js';
import { loadBotContent } from './botContent.js';
import { acceptRules, gateFor, type GateVerdict, type MembershipApi } from './gate.js';
import * as menu from './menu.js';
import { IRR_PER_TOMAN, priceForUser } from './money.js';
import {
  newPublicId,
  placeAddonOrder,
  placeOrder,
  placeRenewalOrder,
  placeTopupOrder,
  placeTrialOrder,
} from './order.js';
import { clientApps, helpArticle, helpArticles } from './content.js';
import { blockForSpam, overSpamLimit } from './spam.js';
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
  lockOrderForUser,
  orderForUser,
  renewableForUser,
  renewableForUserById,
  subscriptionOnPanelForUser,
  subscriptionsForUser,
} from './owned.js';
import {
  customEmojiIn,
  emojiById,
  rememberEmoji,
  setButtonEmoji,
  storedEmoji,
} from './emoji.js';
import { actionsFor, tierFor } from './serviceActions.js';
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
  ReplyKeyboard,
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
  /** The same, for a receipt the customer sent with «Send as File». Telegram
   *  keeps the two id spaces apart and refuses each other's handles, so which
   *  one this is has to be decided here rather than discovered on send. */
  document?: string;
  /** A string to render as a QR image and upload, with `text` as its caption.
   *  Unlike `photo` there is no `file_id`: the picture is made for this reply
   *  and exists nowhere else. */
  qrOf?: string;
  /**
   * The keyboard under the chat, when this message is meant to set it.
   *
   * `/start` and the moment an onboarding gate opens carry it. A message may
   * hold one `reply_markup`, so this and `keyboard` are exclusive —
   * `sendMessage` refuses both rather than dropping one.
   */
  replyKeyboard?: ReplyKeyboard;
}

export type HandleStatus =
  /** Claimed and acted on. */
  | 'processed'
  /** Already claimed by an earlier delivery; nothing ran. */
  | 'duplicate'
  /** Claimed, but there was nothing here for us — an unknown command, an
   *  unrecognised callback, a non-message update, or a blocked user. */
  | 'ignored';

/** A message to take out of the chat. */
export interface Deletion {
  chatId: number;
  messageId: number;
}

export interface HandleOutcome {
  status: HandleStatus;
  replies: Reply[];
  /**
   * Messages to remove once the replies are out.
   *
   * The shop's screens are edited in place, so a button press has never left a
   * trail. What did: everything TYPED. A discount code, a wallet amount, the
   * name for a new account — each one is a message from the customer plus an
   * answer from the bot, and after three of them the screen the customer is
   * meant to be looking at is somewhere up the scrollback.
   *
   * So a typed answer now edits the screen that ASKED, and the question and the
   * customer's own message are listed here. In a private chat a bot may delete
   * both, which is what makes «one live screen» possible rather than aspirational.
   *
   * Best-effort by contract: `poll.ts` logs a refusal and carries on. A message
   * Telegram will not delete — older than 48 hours, or already gone — is not a
   * reason to fail an update that has already committed.
   */
  deletes?: Deletion[];
}

const IGNORED: HandleOutcome = { status: 'ignored', replies: [] };

/**
 * Whether this update came from a one-to-one chat with a customer.
 *
 * A callback query carries its own message, and a button pressed on a message
 * the bot posted into a group arrives with that group as its chat — so both
 * halves are checked rather than only `update.message`.
 *
 * Absent means private: see `MessageSchema` in `telegram.ts` for why the field
 * is optional. A callback query with no message at all is private too — it can
 * only come from an inline result, which has no chat to be public.
 */
function isPrivateChat(update: TelegramUpdate): boolean {
  const chat = update.callback_query?.message?.chat ?? update.message?.chat;
  return chat?.type === undefined || chat.type === 'private';
}

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

/**
 * Loads the shop's wording, keyboards and switches into the module bindings
 * every screen is drawn from.
 *
 * Called before an update is handled AND before the sweeps run, because both
 * of them send the customer sentences the shop is allowed to have rewritten.
 * While this lived only inside `handleUpdate`, a bot that restarted overnight
 * and settled a payment or expired an invoice before anyone pressed anything
 * spoke in the wording the code ships — the shop's own words arriving only
 * once some unrelated customer happened to say hello.
 *
 * Cached for thirty seconds and falling back to the defaults, so it cannot
 * fail what it precedes — see `botContent.ts`. Outside any session, because it
 * is shop-wide configuration rather than one customer's data.
 *
 * In series rather than in parallel: `Texts` needs to know whether the shop has
 * custom emoji on before it decides whether to keep the markup in an override
 * or strip it to the fallback emoji.
 */
export async function refreshShopContent(db: D1Database): Promise<void> {
  const shop = await loadShopSettings(db);
  const content = await loadBotContent(db, Date.now(), shop.customEmoji);
  menu.applyContent(content);
  SHOP = shop;
}

export async function handleUpdate(
  db: D1Database,
  update: TelegramUpdate,
  // Injected so a test can answer for the panel. The service buttons are the
  // only handlers that leave the process.
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  // The one call the gate makes back to Telegram mid-update. Optional because
  // the gate fails open without it, which is the same answer it gives when
  // Telegram refuses — see `gate.ts`.
  api?: MembershipApi,
): Promise<HandleOutcome> {
  // Before the database is touched at all, because this bot is about to be put
  // in a group.
  //
  // Nothing below distinguishes a chat: `chatId` is read the same way whatever
  // it is, `upsertUser` would write a customer row for anybody who typed in the
  // group, and every reply goes back to `message.chat.id` — so adding the bot
  // to the reports group would draw customer menus into it and mint customers
  // out of whoever spoke. It has never happened only because the bot has never
  // been in a group, which is not a guarantee, and the report topics are about
  // to make it one.
  //
  // Ignored rather than claimed: no `telegram_updates` row, no session, no
  // write. A redelivery of the same group message is ignored again for the same
  // reason, so there is nothing to remember.
  if (!isPrivateChat(update)) return IGNORED;

  await refreshShopContent(db);

  return db.withSession(async (tx) => {
    const claim = await tx
      .prepare(`INSERT INTO telegram_updates (update_id) VALUES (?1) ON CONFLICT DO NOTHING`)
      .bind(update.update_id)
      .run();
    if (claim.meta.changes === 0) {
      return { status: 'duplicate', replies: [] };
    }

    // The shop's closed sign, before anything else reads a button.
    //
    // `setting.Bot_Status` has been switchable from the legacy admin panel for
    // years and this bot sold straight through it. Here rather than per
    // handler, because "closed" that a forged `callback_data` walks past is not
    // closed — `index.php:405` guards the same single point.
    //
    // Admins are exempt, which is what makes it usable rather than a kill
    // switch: the cutover window is an announced pause where the shop stops
    // selling and the people running it still need to walk every screen.
    //
    // The update stays claimed. It really was seen, and re-fetching it would
    // produce the same closed sign for ever.
    const from = update.callback_query?.from ?? update.message?.from;
    const chatId = update.callback_query?.message?.chat.id ?? update.message?.chat.id;

    // Asked at most once per update. Three guards below exempt admins and each
    // used to ask the database again; the answer cannot change inside one
    // update, and this is the hottest path in the bot.
    let adminAnswer: boolean | undefined;
    const isAdmin = async (): Promise<boolean> => {
      adminAnswer ??= from ? await isActiveAdmin(tx, from.id) : false;
      return adminAnswer;
    };

    if (!SHOP.open && from && chatId !== undefined && !(await isAdmin())) {
      return {
        status: 'processed',
        replies: [
          {
            chatId,
            text: menu.SHOP_CLOSED,
            // A closed sign replaces the screen, not the app's navigation.
            // This also installs the bar for a customer whose first visit
            // happens while the shop is paused.
            replyKeyboard: menu.homeReplyMenu(),
          },
        ],
      };
    }

    // The flood guard, above everything a customer can reach — the same place
    // `index.php:307` puts it, and for the same reason the closed sign is here:
    // a limit that only guards one command is walked past by any button press.
    //
    // Counted even for an update we are about to ignore. Thirty-five forged
    // `callback_data` posts a minute are the flood this exists to stop, and
    // deciding first whether we would have answered would exempt exactly them.
    //
    // Admins are exempt from the counter, not just from the block: an admin
    // walking the panel fast is the ordinary way this bot is operated.
    if (from && !(await isAdmin()) && (await overSpamLimit(from.id, update.update_id))) {
      const user = await upsertUser(tx, from);
      const blocked = await blockForSpam(tx, {
        userId: user.id,
        telegramId: from.id,
        updateId: update.update_id,
        reportChatId: SHOP.reportChatId,
        reportThreadId: SHOP.reportTopics.otherreport,
      });
      // Told once, at the moment it happens. Every message after this one is
      // ignored in silence, which is what the per-handler checks already do.
      return blocked && chatId !== undefined
        ? { status: 'processed', replies: [reply(chatId, menu.SPAM_BLOCKED)] }
        : IGNORED;
    }

    // Channel membership and the shop's rules, at the same single point and for
    // the same reason: `index.php:393` and `:410` sit above the dispatch too, so
    // the live bot re-asks on every update rather than only on /start. A gate
    // that only guards one command is walked past by any button press, and
    // `callback_data` is a field anyone can post.
    //
    // Three things are let through. The two buttons the gate itself draws —
    // otherwise the screen is a dead end that can only ask again. And /start,
    // which runs the gate itself a few lines later, after it has recorded the
    // session reset and the referral the customer arrived on: gating it here
    // would throw away the referrer of everyone who arrives on a link and is not
    // yet in the channel.
    const action = update.callback_query ? decode(update.callback_query.data)?.action : null;
    const isStart = update.message?.text !== undefined && command(update.message.text) === '/start';

    // A receipt goes through the gate, because it is not a purchase — it is the
    // recovery path of one that already happened.
    //
    // The customer has sent money to a card. If they left the channel in the
    // meantime, or Telegram's membership call is having a bad minute (and
    // `gate.ts` fails open only for OUR errors, not for a truthful "not a
    // member"), the gate would refuse the one message that proves they paid.
    // They cannot be helped through it either: the screen says "join the
    // channel", and joining is not what is wrong.
    //
    // Nothing is granted by letting it past. `handleReceipt` looks for a
    // payment that is actually waiting and answers RECEIPT_NOTHING_WAITING
    // when there is none, so a non-member with no order learns nothing and
    // gets nothing — the gate still stands in front of every way to start one.
    const carriesReceipt =
      update.message?.photo !== undefined ||
      (update.message?.document !== undefined && isReceiptFile(update.message.document.mime_type));

    if (
      from &&
      chatId !== undefined &&
      action !== 'chk' &&
      action !== 'acc' &&
      !isStart &&
      !carriesReceipt
    ) {
      const gated = (await isAdmin()) ? null : await gateFor(tx, api, from.id, SHOP.requiresRules);
      if (gated) return gateScreen(chatId, gated);
    }

    if (update.callback_query) {
      return handleCallback(tx, update.callback_query, fetchImpl, api);
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
    if (photo) return handleReceipt(tx, message, photo.file_id, false);

    // «Send as File» — the same receipt, uncompressed, which is exactly what
    // somebody sending a bank slip taps. It arrives as a `document` and used to
    // fall through every handler below and be dropped without a word, which is
    // the failure this file's own header attributes to the legacy bot.
    const document = message.document;
    if (document) {
      if (!isReceiptFile(document.mime_type)) {
        // Told, not ignored. A customer who sent the wrong thing and heard
        // nothing assumes it arrived — and then waits for a service.
        return {
          status: 'processed',
          replies: [reply(message.chat.id, menu.RECEIPT_WRONG_FILE)],
        };
      }
      return handleReceipt(tx, message, document.file_id, true);
    }

    if (!message.text) {
      return IGNORED;
    }

    if (command(message.text) === '/start') {
      return handleStart(tx, message, api);
    }
    // Everything else typed is an answer to something the bot asked, and what
    // it asked is in the session — never in the message.
    return handleTypedAnswer(tx, message);
  });
}

/**
 * Whichever door the customer is standing behind, drawn.
 *
 * `retried` is the difference between «عضو شوید» and «هنوز عضویت شما تایید
 * نشد» — pressing the button and getting the identical sentence back reads as a
 * bot that ignored the press.
 */
function gateScreen(
  chatId: number,
  gated: NonNullable<GateVerdict>,
  retried = false,
): HandleOutcome {
  return {
    status: 'processed',
    replies: [
      gated.kind === 'channels'
        ? reply(chatId, menu.gateChannels(retried), menu.gateChannelsMenu(gated.missing))
        : reply(chatId, menu.GATE_RULES, menu.gateRulesMenu()),
    ],
  };
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
  /**
   * The reseller LEVEL, or null for an ordinary customer.
   *
   * Separate from `is_reseller` because the two answer different questions:
   * the flag decides what this person may SEE (`products.resellers_only`), the
   * level decides what they PAY. `tierFor` reads this one.
   */
  reseller_tier: string | null;
  /**
   * What `priceForUser` is fed — already the LEVEL's percentage when they are
   * on one. See `DISCOUNT_PERCENT`: it is not the raw column.
   */
  discount_percent: number;
  /**
   * Whether `admins` holds an active row for this Telegram id.
   *
   * Only the main menu reads it, to decide whether to draw «پنل مدیریت». It is
   * NOT what lets an admin action through — every one of those calls `adminFor`
   * again and re-reads the row, because `callback_data` is a field anyone can
   * post and the admin actions are the ones worth forging.
   *
   * Read in the statement that loads the customer rather than in a second
   * query: the two are then one snapshot, and no caller can draw the menu
   * having forgotten to ask.
   */
  is_admin: boolean;
}

/** Same expression in both places a `Caller` is loaded, so they cannot drift. */
/**
 * Whether this customer may see the bot's ADMIN surfaces.
 *
 * `admins.role` is one of OWNER, ADMIN, SUPPORT, and this predicate reads it —
 * which it did not until 2026-09-03. Sam: «ایموجی پریمیوم برای همه نشان داده
 * می‌شود، فقط باید برای ادمین‌ها و owner باشد.» Support staff were in the table,
 * so support staff were being offered a screen that reshapes the shop's
 * keyboard for every customer.
 *
 * ## Narrower than `isActiveAdmin`, on purpose
 *
 * That function stays as it is, and the two now mean different things:
 *
 *   `isActiveAdmin`  — may WALK the shop past its own guards: the closed sign,
 *                      the flood counter, the join-the-channel gate. Support
 *                      answering a customer at 2am needs all three.
 *   `IS_ADMIN` here  — may CHANGE what every customer sees.
 *
 * Collapsing them into one flag is what produced the report. Reading a role
 * column that has existed since `0001` is what fixes it.
 */
const IS_ADMIN = `EXISTS (
  SELECT 1 FROM admins a
   WHERE a.telegram_id = ?1 AND a.active AND a.role IN ('OWNER', 'ADMIN')
 ) AS is_admin`;

/**
 * The percentage `priceForUser` is fed, in the one expression all three
 * `Caller` loads share — written once here for the same reason `IS_ADMIN`
 * above it is.
 *
 * The LEVEL wins outright. A reseller is priced by their tier and their own
 * `discount_percent` is left untouched on the row, which is what they go back
 * to the moment they stop being one. That is the whole reason this is a read
 * and not a copy: `POST /customers/:id/discount` writes that column directly,
 * and `migrate.ts` rewrites it from legacy `pricediscount` on every import run.
 *
 * `is_reseller` is asked FIRST and a NULL tier means level one — the same rule
 * `tierFor` applies, written here in SQL because these two must agree. The flag
 * is set in several places and any of them could omit a level; reading the flag
 * first means such a row is priced as the reseller they are rather than as an
 * ordinary customer. Clearing the flag ends tier pricing immediately, even if
 * the column still holds a level.
 *
 * A scalar subquery rather than a LEFT JOIN because two of the three loads are
 * `INSERT … RETURNING` and `UPDATE … RETURNING`, which cannot join. All three
 * name the table `users` unaliased, so one string drops into all three.
 *
 * NO bind parameters, deliberately: the adapter closes parameter gaps, so a
 * `?n` in here would renumber `IS_ADMIN`'s `?1` and silently ask whether the
 * customer's username is an active admin.
 *
 * ## One of the three loads cannot be tested, and is written this way anyway
 *
 * `upsertUser`'s copy is dead weight for pricing today: its three callers end
 * in the main menu or a receipt, and neither renders a price, so no assertion
 * can tell the two expressions apart there. The other two are covered —
 * `handleCallback`'s by `reseller-tier.test.ts` and `handleTypedAnswer`'s by
 * the add-on case in `addon.test.ts`, both checked by removing this expression
 * and watching them go red.
 *
 * It uses the constant regardless, because the alternative is a
 * `Caller.discount_percent` that means the level's price from two producers and
 * the personal one from the third. That trap springs on the day somebody puts a
 * priced screen behind `/start`, and it springs silently.
 */
const DISCOUNT_PERCENT = `COALESCE(
         (SELECT t.discount_percent FROM reseller_tiers t
           WHERE users.is_reseller AND t.code = COALESCE(users.reseller_tier, 'n')),
         users.discount_percent) AS discount_percent`;

/**
 * The customer row for whoever sent this, created if it is their first message.
 *
 * Upsert rather than SELECT-then-INSERT: two messages cannot race into two rows
 * for one telegram_id, because the unique index decides, not this code.
 */
/**
 * The same shape comes back for a new customer and a returning one. `/start`
 * installs the navigation bar for both, so there is no longer a second menu
 * policy hiding in whether the INSERT or UPDATE branch happened to run.
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
       RETURNING id, status, is_reseller, reseller_tier, ${DISCOUNT_PERCENT}, ${IS_ADMIN}`,
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
/**
 * Whether a file a customer sent can be a payment receipt.
 *
 * An image because that is a photo sent uncompressed, and a PDF because that is
 * what a banking app exports. Everything else — a video, an archive, an APK —
 * is not a receipt, and accepting one would put a file an operator cannot read
 * in front of them at the moment they decide about money.
 *
 * A missing `mime_type` is refused rather than assumed. The field is optional in
 * Telegram's API, so its absence says nothing, and "unknown" is not "image".
 */
function isReceiptFile(mimeType: string | undefined): boolean {
  return mimeType !== undefined && (/^image\//i.test(mimeType) || mimeType === 'application/pdf');
}

async function handleReceipt(
  tx: D1DatabaseSession,
  message: TelegramMessage,
  fileId: string,
  isDocument: boolean,
): Promise<HandleOutcome> {
  const from = message.from;
  if (!from) return IGNORED;
  const user = await upsertUser(tx, from);

  // Recorded before the block is consulted, on purpose.
  //
  // A customer who has already sent money to a card and is then blocked -- by
  // the flood guard above, or by an admin -- would otherwise have the one
  // message that proves they paid dropped in silence. The money is in the bank,
  // `expireUnpaidOrders` kills the invoice, and every way of asking what
  // happened is ignored too. That is the worst outcome this bot can produce.
  //
  // Nothing is granted by recording it, which is the same reason the membership
  // gate lets a receipt past: `recordReceipt` attaches evidence to a payment
  // that is ALREADY waiting and answers `none` when there is none. An operator
  // still decides. A blocked customer cannot start a payment to attach one to.
  const result = await recordReceipt(tx, user.id, fileId, Date.now(), isDocument);

  // The silence is kept for the case it was written for. A blocked customer
  // with nothing waiting gets no answer at all, so the block still costs a
  // flooder every reply it used to -- they can send pictures into the void.
  if (user.status === 'BLOCKED' && result.outcome === 'none') return IGNORED;
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
  api?: MembershipApi,
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
  //
  // Read BEFORE the reset, because the reset is what forgets it. The screen id
  // is the message the abandoned flow was living on — a half-written invoice, a
  // question nobody answered — and «abandoned» is only true once it is off the
  // customer's chat as well as out of the session. Otherwise `/start` leaves
  // the wreck of the last attempt sitting above the fresh welcome, still
  // showing buttons that now belong to nothing.
  const parked = await tx
    .prepare(`SELECT data FROM bot_sessions WHERE user_id = ?1`)
    .bind(user.id)
    .first<{ data: Record<string, unknown> | null }>();
  const openScreen = screenOf({ step: '', data: parked?.data ?? {} });

  // Built here rather than at the return, because there are TWO returns and the
  // gated one is the easier to forget — which is exactly what happened, and
  // what review caught. A customer who has not joined the channel yet is the
  // one most likely to press /start again and again, so leaving the wreck on
  // THEIR chat is the worst place to leave it.
  const tidy: Deletion[] = [
    { chatId: message.chat.id, messageId: message.message_id },
    ...(openScreen === undefined ? [] : [{ chatId: message.chat.id, messageId: openScreen }]),
  ];

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
  const claimed = referrer === null ? false : await claimReferrer(tx, user.id, referrer);

  // The gate runs here rather than above the dispatch, and only for /start.
  // Everything before this line is what the customer's arrival MEANS — the
  // session reset, and who invited them — and none of it can be recovered by
  // asking again once they have joined the channel. The live bot loses exactly
  // that: `index.php:450` has to dig the referrer back out of a scratch column
  // afterwards, because its own gate returned before recording it.
  //
  // Admins are exempt, as they are for the closed sign and at the single point.
  if (!(await isActiveAdmin(tx, from.id))) {
    const gated = await gateFor(tx, api, from.id, SHOP.requiresRules);
    if (gated) return { ...gateScreen(message.chat.id, gated), deletes: tidy };
  }

  // The navigation bar goes UNDER the chat here, not under the message.
  //
  // Sam, 2026-09-04: «می‌خوام همیشه این navbar زیر ربات باشه». It is one
  // persistent «بازگشت به منوی اصلی» row rather than a second copy of the
  // whole shop menu: screens keep their own inline buttons, and the row remains
  // the stable way out of every one of them.
  //
  // Sent on EVERY `/start`, not only on the INSERT branch. That is both the
  // upgrade path for existing chats and the repair path when Telegram has lost
  // or replaced a keyboard. After this message Telegram keeps it until another
  // reply keyboard replaces it; this bot never does.
  return {
    status: 'processed',
    replies: [
      {
        chatId: message.chat.id,
        text: claimed ? `${menu.REFERRAL_WELCOME}\n\n${menu.WELCOME}` : menu.WELCOME,
        replyKeyboard: menu.homeReplyMenu(),
      },
      // Telegram accepts only one `reply_markup` on a message. The welcome
      // above installs the chat-wide navigation bar; this second message is
      // deliberately last, so the live screen at the bottom of the chat is the
      // shop's main menu rather than the setup message.
      reply(message.chat.id, menu.MENU_TITLE, menu.mainMenu(user)),
    ],
    // Sam, 2026-09-04: «می‌خوام داخل چت خیلی تمیز باشه و چت‌های قدیمی پاک بشه».
    //
    // Two messages go, and neither is one the customer will look for later: the
    // «/start» they just typed, and the screen the abandoned flow was on. What
    // is NOT deleted is every earlier welcome — those are separate visits, and
    // a bot that reaches back through somebody's history erasing its own past
    // is a different thing from one that tidies up after itself.
    //
    // Best-effort by construction: `poll.ts` runs deletes after the replies and
    // swallows their failures, so a message Telegram will no longer delete —
    // older than 48 hours, already gone — costs a log line and nothing else.
    deletes: tidy,
  };
}

/**
 * The largest add-on one purchase may be when the panel names no ceiling.
 *
 * A panel's own `maxvolume` / `maxtime` win over this — see `extraBoundsFor`.
 * This is what a panel that has never had them set gets, and it is the bound
 * the bot has always applied.
 */
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
      `SELECT id, status, is_reseller, reseller_tier, ${DISCOUNT_PERCENT}, ${IS_ADMIN}
         FROM users WHERE telegram_id = ?1`,
    )
    .bind(from.id)
    .first<Caller>();
  if (!user || user.status === 'BLOCKED') return IGNORED;

  const row = await tx
    .prepare(`SELECT step, data FROM bot_sessions WHERE user_id = ?1`)
    .bind(user.id)
    .first<{ step: string | null; data: Record<string, unknown> | null }>();
  const session: Session = { step: row?.step ?? '', data: row?.data ?? {} };

  // The fixed way home (or a button from the full keyboard installed by the
  // previous release), pressed from under the chat.
  //
  // A bottom-keyboard button arrives as an ordinary text message, so this has to
  // be asked BEFORE the session — and asking it first is also what makes those
  // buttons cancel: pressing «خرید» while the bot is waiting for a discount code
  // means the customer has left, and treating their press as the answer to a
  // question they walked away from is the one reading that is certainly wrong.
  const pressed = menu.actionForReplyLabel(user, message.text ?? '');
  if (pressed !== null) {
    await clearSession(tx, user.id);
    return withCleanChat(await handleMenuAction(tx, pressed, from.id), message, session);
  }

  if (session.step.startsWith('addon:')) {
    return withCleanChat(await handleAddonAmount(tx, message, user, session), message, session);
  }
  if (session.step === 'code') {
    return withCleanChat(await handleDiscountCode(tx, message, user, session), message, session);
  }
  if (session.step === 'coder') {
    return withCleanChat(await handleRenewalCode(tx, message, user, session), message, session);
  }
  if (session.step === 'gift') {
    return withCleanChat(await handleGiftCode(tx, message, user), message, session);
  }
  if (session.step === 'topup') {
    return withCleanChat(await handleTopupAmount(tx, message, user), message, session);
  }
  if (session.step === 'agent') {
    return withCleanChat(await handleResellerRequest(tx, message, user), message, session);
  }
  if (session.step === 'uname') {
    return withCleanChat(await handleCustomerName(tx, message, user, session), message, session);
  }
  if (session.step === 'emoji') {
    return withCleanChat(await handlePremiumEmoji(tx, message, user, session), message, session);
  }
  return IGNORED;
}

/**
 * A message an admin sent so the bot could read a premium emoji off it.
 *
 * This is the whole reason the flow asks for a MESSAGE rather than a link or a
 * pack name: Telegram attaches `custom_emoji_id` to the entity, so the id comes
 * from the same service that will later be asked to draw it. Nothing is typed
 * and nothing is guessed.
 *
 * The admin check is repeated here even though the prompt is only reachable
 * from an admin-only button. The session is a row keyed on the user, and a
 * customer whose admin rights were revoked between the question and the answer
 * would otherwise still be answering it.
 */
async function handlePremiumEmoji(
  tx: D1DatabaseSession,
  message: TelegramMessage,
  user: Caller,
  session: Session,
): Promise<HandleOutcome> {
  const reply = (text: string, keyboard: InlineKeyboard): HandleOutcome => ({
    status: 'processed',
    replies: [{ chatId: message.chat.id, text, keyboard }],
  });
  if (!user.is_admin) {
    await clearSession(tx, user.id);
    return reply(menu.MENU_TITLE, menu.mainMenu(user));
  }

  const found = customEmojiIn(message);
  if (found.length === 0) {
    // The question stays open: an admin who sent an ordinary emoji can try
    // again without walking back through the menu.
    return reply(menu.EMOJI_NONE_FOUND, menu.promptMenu(encode('emj')));
  }

  const added = await rememberEmoji(tx, found);
  const slot = Number(session.data['slot']);
  await clearSession(tx, user.id);
  const have = await storedEmoji(tx);

  // Back to the button the admin came from, so the emoji they just gave the bot
  // is one tap from being on it. «افزودن» pressed from the first screen has no
  // slot, and lands on the button list instead.
  const target = Number.isSafeInteger(slot)
    ? menu.mainMenuButtons().find((b) => b.slot === slot)
    : undefined;
  return target
    ? reply(
        menu.emojiForButton(target.label, have.length, { added }),
        menu.emojiForButtonMenu(target.slot, have),
      )
    : reply(menu.emojiAdded(added, have.length), menu.emojiHomeMenu(menu.mainMenuButtons()));
}

/**
 * Opens the screen a bottom-keyboard button names.
 *
 * A synthetic callback rather than a second dispatch. Every rule that guards a
 * button press — the block check, the closed sign, «this customer never pressed
 * /start» — lives in `handleCallback`, and a bottom keyboard that reached the
 * screens by another road would be a second door into the same building with
 * nobody checking it. Legacy has exactly that shape and it is why its «closed»
 * switch was walkable.
 *
 * No `message` on the query, deliberately. `handleCallback` reads
 * `query.message?.message_id` as the screen to EDIT, and the only message here
 * is the customer's own — which no bot may edit. Leaving it out makes the reply
 * a fresh message, which is what a press from under the chat should produce.
 */
async function handleMenuAction(
  tx: D1DatabaseSession,
  action: string,
  telegramId: number,
): Promise<HandleOutcome> {
  return handleCallback(tx, {
    // Never answered: `poll.ts` only clears the spinner for a real
    // `callback_query`, and there is no spinner on a bottom-keyboard press.
    id: `reply:${action}`,
    // The TELEGRAM id, not the chat id. They are the same number in a private
    // chat and this bot has only private chats — but `handleCallback` looks the
    // customer up by this field, so passing the one that happens to match is
    // how a shop that ever gains a group chat finds out the hard way.
    from: { id: telegramId },
    data: action,
  });
}

/**
 * Turns a typed answer into an edit of the screen that asked, and takes the
 * typing out of the chat.
 *
 * One place rather than seven. Every handler above builds its own reply, and
 * teaching each of them to edit and to delete would be seven chances to forget
 * — with a failure nobody would report, because a stray message in a chat is
 * not a bug anyone opens a ticket about. It is just the shop looking untidy for
 * ever.
 *
 * Three rules, and each has a reason it is not the obvious thing:
 *
 *   * only the FIRST reply to this customer's own chat becomes the edit. A
 *     handler may also write to an admin — `handleResellerRequest` does — and
 *     that message belongs in the admin's chat as a new one.
 *   * a reply carrying a picture is left alone. `editMessageText` cannot turn a
 *     text message into a photo, so an edit would simply be refused.
 *   * the customer's own message is deleted whether or not there was a screen
 *     to edit. It is the half that piles up fastest, and it is theirs — a
 *     receipt is the one thing that is kept, and that path never reaches here.
 */
function withCleanChat(
  outcome: HandleOutcome,
  message: TelegramMessage,
  session: Session,
): HandleOutcome {
  if (outcome.status === 'ignored') return outcome;
  const screen = screenOf(session);
  let edited = false;
  const replies = outcome.replies.map((reply) => {
    if (
      edited ||
      screen === undefined ||
      reply.chatId !== message.chat.id ||
      reply.photo !== undefined ||
      reply.document !== undefined ||
      reply.qrOf !== undefined ||
      reply.editMessageId !== undefined
    ) {
      return reply;
    }
    edited = true;
    return { ...reply, editMessageId: screen };
  });
  return {
    ...outcome,
    replies,
    deletes: [
      ...(outcome.deletes ?? []),
      { chatId: message.chat.id, messageId: message.message_id },
    ],
  };
}

/**
 * Is this Telegram id an active admin?
 *
 * All that is left of `admins` inside the bot. The panel that used to read the
 * row's role and permissions lives in the dashboard now; these two callers only
 * ever asked whether the row exists — an admin does not see «فروشگاه بسته است»
 * and is not held at the join-the-channel gate.
 *
 * Kept as a question about the database rather than a cached flag on the user
 * row, because switching an admin off has to take effect on the next update and
 * not on their next `/start`.
 */
async function isActiveAdmin(db: D1DatabaseSession, telegramId: number): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS ok FROM admins WHERE telegram_id = ?1 AND active`)
    .bind(telegramId)
    .first<{ ok: number }>();
  return row !== null;
}

/** Clears the question, once it has been answered in a way that ends the flow. */
async function clearSession(tx: D1DatabaseSession, userId: number): Promise<void> {
  await tx
    .prepare(
      `UPDATE bot_sessions SET step = NULL, data = '{}'::jsonb, updated_at = now()
               WHERE user_id = ?1`,
    )
    .bind(userId)
    .run();
}

/** Asks a question and remembers that it was asked. */
async function ask(
  tx: D1DatabaseSession,
  userId: number,
  step: string,
  data: Record<string, unknown>,
  /**
   * The message the question was asked ON, so the answer can be written back
   * into it instead of below it.
   *
   * Carried in the session rather than passed around, because the two halves
   * happen in different updates: the question is a button press and the answer
   * is a typed message, and nothing else survives between them. A step that
   * does not know its screen still works — `screenOf` answers undefined and the
   * reply is sent as a new message, exactly as it was before.
   */
  screenId?: number,
): Promise<void> {
  await tx
    .prepare(
      `INSERT INTO bot_sessions (user_id, step, data, updated_at)
       VALUES (?1, ?2, ?3::jsonb, now())
       ON CONFLICT (user_id) DO UPDATE
         SET step = EXCLUDED.step, data = EXCLUDED.data, updated_at = now()`,
    )
    .bind(userId, step, JSON.stringify(screenId === undefined ? data : { ...data, screen: screenId }))
    .run();
}

/** The message a question was asked on, when the session remembers one. */
function screenOf(session: Session): number | undefined {
  const raw = session.data['screen'];
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
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

  const service = await subscriptionOnPanelForUser(tx, user.id, subscriptionId);
  if (!service) return reply(menu.SERVICE_GONE, menu.myServicesMenu([], Date.now(), 1, 1));
  const actions = actionsFor(service, SHOP, tierFor(user));
  const unit =
    kind === 'ADD_VOLUME' ? (actions?.volumeIrrPerGb ?? null) : (actions?.timeIrrPerDay ?? null);
  if (unit === null) return reply(menu.ACTION_UNSUPPORTED, menu.serviceDetailMenu());

  // The bounds are the PANEL's, so they are checked after it is loaded and
  // after «this panel does not sell that» above — otherwise a panel that sells
  // no extra volume would answer «کمترین مقدار ۱۰ است» to somebody who cannot
  // buy any amount at all.
  //
  // The range check used to sit above, on the typed digits alone, which is why
  // this reads as a move rather than an addition.
  const bounds = extraBoundsFor(service.provider_config ?? {});
  const min = kind === 'ADD_VOLUME' ? bounds.minVolumeGb : bounds.minTimeDays;
  const max = (kind === 'ADD_VOLUME' ? bounds.maxVolumeGb : bounds.maxTimeDays) ?? ADDON_MAX;
  if (min !== null && quantity < min) return reply(menu.addonTooLittle(min));
  if (quantity > max) return reply(menu.addonTooMuch(max));

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
    menu.checkoutMenu(
      placed.id,
      placed.totalIrr,
      checkout.cardDigits,
      { balanceIrr: await balanceFor(tx, user.id), totalIrr: placed.totalIrr },
      SHOP.showsCopyButtons,
    ),
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

  await ask(tx, user.id, 'code:held', { planId, code: check.code.code }, screenOf(session));
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
  await ask(tx, user.id, 'coder:held', { subscriptionId, code: check.code.code }, screenOf(session));
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
/**
 * Placing the order and drawing the invoice — extracted so there is ONE way in.
 *
 * `case 'order'` reaches it from the button, and `handleCustomerName` reaches it
 * again once the customer has typed a name. Two copies of this would be two
 * places to forget the held discount code, which is the drift `planScreen`'s own
 * comment warns about.
 */
async function placeOrderScreen(
  tx: D1DatabaseSession,
  user: Caller,
  plan: CatalogPlan,
  screen: (text: string, keyboard?: InlineKeyboard) => HandleOutcome,
  /** The message `screen` writes onto, so the typed name can land back on it. */
  screenId?: number,
  /**
   * The customer pressed «خودکار انتخاب کن!» — ask nothing, name nothing.
   *
   * Only the `auto` button sets it, and it does not reach into what a name IS:
   * the order is written with `username_text` null, exactly as it would be for
   * a panel that never asks, and `remoteUsernameFor` names a CUSTOMER_TEXT
   * order with no text after its own order id. So «خودکار» is not a second
   * naming rule to keep in step with the first — it is the absence of the
   * first, which the provisioning path already had an answer for.
   */
  auto = false,
): Promise<HandleOutcome> {
  /*
   * The one edge into an order, which is why the prompt is here and not beside
   * the discount-code step it otherwise resembles.
   *
   * That step is OPTIONAL: `planDetailMenu` draws «خرید» beside «کد تخفیف», so
   * a customer reaches `order` having never entered it. Mirroring its placement
   * would place orders with no name on a panel configured to ask for one — the
   * setting saved, reported, and inert, which is the failure `panelRoutes`
   * refuses for PANEL_TEXT.
   */
  const chosenName =
    plan.usernameMode === 'CUSTOMER_TEXT' ? await heldName(tx, user.id, plan.planId) : null;
  if (plan.usernameMode === 'CUSTOMER_TEXT' && chosenName === null && !auto) {
    await ask(tx, user.id, 'uname', { planId: plan.planId }, screenId);
    return screen(menu.ASK_ACCOUNT_NAME, menu.askAccountNameMenu(plan.planId));
  }

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
    chosenName,
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
    menu.checkoutMenu(
      placed.id,
      placed.totalIrr,
      checkout.cardDigits,
      { balanceIrr: await balanceFor(tx, user.id), totalIrr: placed.totalIrr },
      SHOP.showsCopyButtons,
    ),
  );
}

/**
 * The name this customer has already given for this plan, or null.
 *
 * A copy of `heldRenewalName` in everything but the two names it reads, and for
 * the same reason: the answer is held in the session between the moment it is
 * typed and the moment the order is written.
 *
 * Scoped to the plan, so a name chosen for one service is not silently spent on
 * another the customer opened afterwards.
 */
async function heldName(
  tx: D1DatabaseSession,
  userId: number,
  planId: number,
): Promise<string | null> {
  const row = await tx
    .prepare(`SELECT step, data FROM bot_sessions WHERE user_id = ?1`)
    .bind(userId)
    .first<{ step: string | null; data: Record<string, unknown> | null }>();
  if (row?.step !== 'uname:held') return null;
  if (Number(row.data?.['planId']) !== planId) return null;
  const typed = row.data?.['name'];
  return typeof typed === 'string' ? typed : null;
}

/**
 * «اسم اکانتت را بنویس» — the answer, in the middle of a purchase.
 *
 * Unusable input RE-ASKS and leaves the step open, which is
 * `handleDiscountCode`'s own pattern. It matters more here than there:
 * `sanitiseUsernamePart` strips everything outside `[a-z0-9_]`, so Persian
 * reduces to nothing — and Persian is what most customers of a Persian shop
 * will type first. Falling through to a default would be the panel setting
 * doing nothing, one customer at a time.
 *
 * What is stored is the SANITISED string, so `orders.username_text` holds
 * exactly what the panel will be asked for and no screen can promise a name the
 * panel will not give.
 */
async function handleCustomerName(
  tx: D1DatabaseSession,
  message: TelegramMessage,
  user: Caller,
  session: Session,
): Promise<HandleOutcome> {
  const planId = Number(session.data['planId']);
  if (!Number.isSafeInteger(planId)) return IGNORED;

  const screen = (text: string, keyboard?: InlineKeyboard): HandleOutcome => ({
    status: 'processed',
    replies: [{ chatId: message.chat.id, text, ...(keyboard ? { keyboard } : {}) }],
  });

  // Re-checked rather than trusted from the moment the prompt was drawn: an
  // admin may have hidden the plan in between, and this is the same check the
  // button itself makes.
  const plan = await purchasablePlan(tx, user.id, planId);
  if (!plan) return screen(menu.PLAN_GONE, menu.planMenu([]));

  const clean = sanitiseUsernamePart((message.text ?? '').slice(0, CUSTOMER_NAME_MAX));
  if (clean === null) {
    // The question stays open — the customer mistyped and can type again.
    return screen(menu.ACCOUNT_NAME_REFUSED, menu.promptMenu(encode('plan', plan.planId)));
  }

  await ask(tx, user.id, 'uname:held', { planId, name: clean }, screenOf(session));
  // The screen the question was asked on, carried through: this call may ask
  // again (a second panel, a second name) and it has to land in the same place.
  return placeOrderScreen(tx, user, plan, screen, screenOf(session));
}

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
  return said(answer, menu.mainMenu(user));
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
 * A deposit the customer named themselves.
 *
 * The amount arrives as a message rather than in `callback_data`, which is the
 * point: the presets exist because a number the customer controls must not be
 * trusted, and a typed one is trusted no further. It is read in Toman — the
 * only unit a bank transfer has — converted once, and then checked against the
 * shop's own floor and ceiling, the same pair `index.php:4712` enforces.
 *
 * Refusing keeps the step open. A customer who typed the wrong thing types
 * again rather than starting from the wallet.
 */
async function handleTopupAmount(
  tx: D1DatabaseSession,
  message: TelegramMessage,
  user: Caller,
): Promise<HandleOutcome> {
  const reply = (text: string, keyboard: InlineKeyboard): HandleOutcome => ({
    status: 'processed',
    replies: [{ chatId: message.chat.id, text, keyboard }],
  });
  const back = menu.promptMenu(encode('top'));

  // Persian digits, and the separators a person types into a chat: `100,000`
  // and `۱۰۰٬۰۰۰` are both what somebody means by a hundred thousand.
  const typed = message
    .text!.trim()
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[,٬\s]/g, '');
  if (!/^[0-9]{1,12}$/.test(typed)) {
    return reply(menu.askTopupAmount(SHOP.topupMinIrr, SHOP.topupMaxIrr), back);
  }
  const amountIrr = Number(typed) * IRR_PER_TOMAN;
  if (!Number.isSafeInteger(amountIrr) || amountIrr <= 0) {
    return reply(menu.askTopupAmount(SHOP.topupMinIrr, SHOP.topupMaxIrr), back);
  }
  if (amountIrr < SHOP.topupMinIrr || amountIrr > SHOP.topupMaxIrr) {
    return reply(menu.topupOutOfRange(SHOP.topupMinIrr, SHOP.topupMaxIrr), back);
  }

  // Cleared only once the amount is usable, for the same reason the add-on step
  // clears late: an unusable answer leaves the customer inside the flow.
  await clearSession(tx, user.id);
  return topup(tx, user.id, amountIrr, (text, keyboard) => ({
    status: 'processed',
    replies: [{ chatId: message.chat.id, text, ...(keyboard ? { keyboard } : {}) }],
  }));
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

/**
 * One plan's page, with whatever discount code is being held against it.
 *
 * Two callbacks land here — `plan` from the plan list, and `prd` for a service
 * that has only one plan and therefore never draws a list. Written once because
 * the page is not just a render: it re-checks the held code against the price,
 * and a second copy of that check is a second place for it to go stale.
 */
async function planScreen(
  tx: D1DatabaseSession,
  user: Caller,
  plan: CatalogPlan,
  screen: (text: string, keyboard?: InlineKeyboard) => HandleOutcome,
): Promise<HandleOutcome> {
  const price = priceForUser(plan.priceIrr, user.discount_percent);
  const held = await heldCode(tx, user, plan, price.totalIrr);
  const applied = held ? { code: held.code.code, discountIrr: held.discountIrr } : null;
  return screen(menu.planDetail(plan, price, applied), menu.planDetailMenu(plan, applied));
}

/**
 * One category's price list.
 *
 * Two callbacks land here — `cat` from the category list, and `buy` for a shop
 * with only one category and therefore no list to draw. Written once for the
 * same reason `planScreen` is: a second copy of «a list of one is not a choice»
 * is a second place for the two to disagree about what the customer already
 * chose.
 */
/**
 * Taking the free account, once the panel is known.
 *
 * Nothing is drawn from the panel here and nothing is provisioned. The order
 * is written PAID and the ordinary sweep delivers it, which is what keeps a
 * trial on exactly the same path as a purchase — the same retry, the same
 * stall reclaim, the same service screen at the end. A trial that provisioned
 * inline would be a second delivery path, and the second one is always the one
 * that is missing a fix.
 *
 * `null` back means the quota is spent. It cannot mean anything else: the
 * panel was found in this customer's own list one line up.
 */
async function takeTrial(
  tx: D1DatabaseSession,
  user: Caller,
  panel: TrialPanel,
  screen: (text: string, keyboard?: InlineKeyboard) => HandleOutcome,
): Promise<HandleOutcome> {
  const placed = await placeTrialOrder(tx, user.id, panel.providerId, SHOP.trialQuotaPerUser);
  if (placed === null) return screen(menu.TRIAL_USED, menu.mainMenu(user));
  return screen(menu.TRIAL_ON_THE_WAY, menu.mainMenu(user));
}

async function categoryScreen(
  tx: D1DatabaseSession,
  user: Caller,
  category: CatalogCategory,
  screen: (text: string, keyboard?: InlineKeyboard) => HandleOutcome,
): Promise<HandleOutcome> {
  // The LEVEL, not the price list.
  //
  // A category holds services — «پلاتینیوم», «طلایی», «معمولی» — and each of
  // those holds its own sizes. Until 2026-08-27 this screen called
  // `plansInCategory` and drew every size of every service in one flat ladder,
  // which is precisely the shape `catalog.ts` says the service level exists to
  // remove: three tiers' worth of «۳۰ گیگ» rows interleaved by price, with
  // nothing on the button saying which tier a row belonged to.
  //
  // `prd:` and its screen were already built — only this call was missing.
  const services = await productsForUser(tx, user.id, undefined, category.categoryId);
  if (services.length === 0) return screen(menu.CATEGORY_EMPTY, menu.categoryMenu([]));
  if (services.length > 1) {
    return screen(menu.categoryPlans(category.name), menu.productMenu(services));
  }

  // A list of one is not a choice — the same rule the category list follows one
  // level up. A category holding a single service opens that service's prices
  // directly, and a service holding a single price opens the price. Every
  // catalogue migrated from the PHP bot is one service per category with one
  // plan in it, so for those customers this collapses to exactly the two
  // screens they have today.
  const only = services[0]!;
  const plans = await plansInProduct(tx, user.id, only.productId);
  if (plans.length === 0) return screen(menu.CATEGORY_EMPTY, menu.categoryMenu([]));
  if (plans.length === 1) return planScreen(tx, user, plans[0]!, screen);
  return screen(
    menu.choosePlan(only.name, plans, user.discount_percent),
    menu.planMenu(plans, user.discount_percent, SHOP.planButtonTemplate),
  );
}

async function handleCallback(
  tx: D1DatabaseSession,
  query: TelegramCallbackQuery,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  api?: MembershipApi,
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
        RETURNING id, status, is_reseller, reseller_tier, ${DISCOUNT_PERCENT}, ${IS_ADMIN}`,
    )
    .bind(query.from.id)
    .first<Caller>();
  // No row means this customer never pressed /start — or never existed, which is
  // what a forged callback looks like. Both get the same nudge and nothing else.
  if (!user) {
    return { status: 'ignored', replies: [reply(chatId, menu.NOT_REGISTERED)] };
  }
  // «پرداخت کردم» is the other half of the receipt path above, and it is let
  // through for the same reason: it records a claim against an order the
  // customer already owns. `orderForUser` re-checks the owner, so a forged id
  // belongs to nobody, and the button that comes back leads to the main menu,
  // which a blocked customer is still refused. Nothing else is opened.
  if (user.status === 'BLOCKED' && action.action !== 'paid') return IGNORED;

  switch (action.action) {
    // The two buttons the gate draws, and the only ones it lets past. Both end
    // by re-running the gate rather than by trusting the press: «عضو شدم» is a
    // customer's claim about Telegram, not evidence from it, and accepting the
    // rules while still outside the channel must land back on the channel.
    //
    // A fresh message rather than an edit. The customer just came back from the
    // channel and their last screen may be several messages up, and an edit of
    // an unchanged screen is refused by Telegram outright.
    case 'chk':
    case 'acc': {
      if (action.action === 'acc') await acceptRules(tx, query.from.id);
      // No admin exemption here, unlike the two places the gate is imposed. An
      // admin is never shown these buttons — the gate that draws them exempts
      // them — so the only way to arrive is by pressing one on purpose, and the
      // honest answer to that is the same one everybody else gets. An exemption
      // no test could reach is a claim, not a guard.
      const gated = await gateFor(tx, api, query.from.id, SHOP.requiresRules);
      if (gated) return gateScreen(chatId, gated, action.action === 'chk');
      const opening = action.action === 'acc' ? `${menu.GATE_RULES_ACCEPTED}\n\n` : '';
      return {
        status: 'processed',
        replies: [
          {
            chatId,
            text: `${opening}${menu.WELCOME}`,
            // The gate screen needed its inline join/accept button, so this is
            // the first message that can install the permanent row.
            replyKeyboard: menu.homeReplyMenu(),
          },
          // Same two-markup hand-off as `/start`: the persistent row is now
          // installed, and the main menu remains the last visible message.
          reply(chatId, menu.MENU_TITLE, menu.mainMenu(user)),
        ],
      };
    }

    case 'menu':
      return screen(menu.MENU_TITLE, menu.mainMenu(user));

    case 'soon':
      return screen(menu.SOON, menu.mainMenu(user));

    case 'buy': {
      // Categories, not panels and not services. A customer's first question is
      // which KIND of thing they want, and the panel that delivers it is named
      // on the plan's own page. The legacy shop asked location-first because a
      // legacy panel WAS a level — five `marzban_panel` rows on one PasarGuard
      // differing only in `inbounds` — and a service carrying its own groups
      // retires that reason along with the extra tap.
      //
      // A service list sat here until 2026-08-26 and its problem was that a
      // service is a TIER: it has no single price, so the screen could only
      // show names and the customer chose blind. A category groups priced rows,
      // so the very next screen is payable amounts.
      const categories = await categoriesForUser(tx, user.id);
      if (categories.length === 0) {
        return screen(menu.SHOP_EMPTY, menu.mainMenu(user));
      }
      // A list of one is not a choice — the same rule the plan list has always
      // applied. One category means the shop has no kinds, only prices, so the
      // customer meets them on the first tap instead of after a pointless one.
      if (categories.length === 1) {
        return categoryScreen(tx, user, categories[0]!, screen);
      }
      return screen(menu.CHOOSE_CATEGORY, menu.categoryMenu(categories));
    }

    case 'tst': {
      // The list is rebuilt on every tap rather than trusted from the one that
      // drew the buttons, and that is what makes the id in `callback_data`
      // safe to use: a panel this customer may not see is not in the list, so
      // `find` answers undefined and they get the same «no trial» screen as
      // somebody who never had one offered. The id never selects a row.
      const panels = await trialPanelsForUser(tx, user.id);
      if (panels.length === 0) return screen(menu.TRIAL_NONE, menu.mainMenu(user));
      if (action.id === undefined) {
        // A list of one is not a choice - the rule the category and plan lists
        // already follow. Production has one panel that could offer a trial at
        // a time, so this is the normal path rather than the corner.
        if (panels.length === 1) return takeTrial(tx, user, panels[0]!, screen);
        return screen(menu.TRIAL_CHOOSE_PANEL, menu.trialMenu(panels));
      }
      const panel = panels.find((p) => p.providerId === action.id);
      if (panel === undefined) return screen(menu.TRIAL_NONE, menu.mainMenu(user));
      return takeTrial(tx, user, panel, screen);
    }

    case 'cat': {
      if (action.id === undefined) return IGNORED;
      const categories = await categoriesForUser(tx, user.id);
      const category = categories.find((c) => c.categoryId === action.id);
      // Either the category emptied out, was switched off, or was never theirs
      // to open. One answer for all three: telling them apart would hand out a
      // map of the hidden catalogue.
      if (!category) return screen(menu.CATEGORY_EMPTY, menu.categoryMenu(categories));
      return categoryScreen(tx, user, category, screen);
    }

    case 'panel': {
      // Nothing draws this any more. It stays because messages already in
      // customers' chats still carry `panel:<id>` buttons, and Telegram keeps
      // them pressable forever — dropping the case would make an old button
      // answer nothing at all, which reads as a broken bot rather than an old
      // screen.
      if (action.id === undefined) return IGNORED;
      const products = await productsForUser(tx, user.id, action.id);
      if (products.length === 0) {
        // Either the panel emptied out, or it was never theirs to open. One
        // answer for both.
        return screen(menu.PANEL_EMPTY, menu.productMenu([]));
      }
      return screen(menu.CHOOSE_PRODUCT, menu.productMenu(products));
    }

    case 'prd': {
      if (action.id === undefined) return IGNORED;
      const plans = await plansInProduct(tx, user.id, action.id);
      if (plans.length === 0) return screen(menu.PRODUCT_EMPTY, menu.planMenu([]));
      // A list of one is not a choice. The customer already made it on the
      // screen before, so a service with a single plan opens that plan
      // directly — which is also what the shop did before services existed,
      // and the whole catalogue migrated from the PHP bot is one plan per
      // product. Falling through by hand rather than recursing: `plan` needs
      // the discount check and the held code, and having two ways to reach it
      // is how the two drift apart.
      if (plans.length === 1) return planScreen(tx, user, plans[0]!, screen);
      return screen(
        menu.choosePlan(plans[0]!.productName, plans, user.discount_percent),
        menu.planMenu(plans, user.discount_percent, SHOP.planButtonTemplate),
      );
    }

    case 'tar': {
      // Everything this customer may buy, priced for THEM: `tariffForUser`
      // applies the same visibility predicate the buttons do, and the standing
      // discount is applied here the way it is on every plan button. A price
      // list quoting the list price to a customer who is charged less is a
      // support ticket; quoting it to a reseller is a worse one.
      const plans = await tariffForUser(tx, user.id);
      return screen(menu.tariff(plans, user.discount_percent), menu.tariffMenu());
    }

    case 'plan': {
      if (action.id === undefined) return IGNORED;
      const plan = await purchasablePlan(tx, user.id, action.id);
      if (!plan) return screen(menu.PLAN_GONE, menu.planMenu([]));
      return planScreen(tx, user, plan, screen);
    }

    case 'dsc': {
      if (action.id === undefined) return IGNORED;
      // Checked here as well: a forged `dsc` for a hidden plan must not open a
      // flow that ends in an order for it.
      const plan = await purchasablePlan(tx, user.id, action.id);
      if (!plan) return screen(menu.PLAN_GONE, menu.planMenu([]));
      await ask(tx, user.id, 'code', { planId: plan.planId }, editId);
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
      await ask(tx, user.id, 'gift', {}, editId);
      return screen(menu.ASK_GIFT_CODE, menu.promptMenu(encode('wal')));
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
        menu.mainMenu(user),
      );
    }

    case 'hlp': {
      if (action.id !== undefined) {
        const article = await helpArticle(tx, action.id);
        if (!article) return screen(menu.HELP_EMPTY, menu.mainMenu(user));
        return screen(
          menu.helpArticleScreen(article.title, article.body),
          menu.helpMenu([], (await clientApps(tx)).length > 0 && SHOP.showsAppLink),
        );
      }
      const articles = await helpArticles(tx);
      const apps = await clientApps(tx);
      if (articles.length === 0 && apps.length === 0) {
        return screen(menu.HELP_EMPTY, menu.mainMenu(user));
      }
      return screen(
        menu.CHOOSE_HELP,
        menu.helpMenu(articles, apps.length > 0 && SHOP.showsAppLink),
      );
    }

    case 'app': {
      const apps = await clientApps(tx);
      if (apps.length === 0) return screen(menu.APPS_EMPTY, menu.mainMenu(user));
      return screen(menu.appsScreen(apps), menu.helpMenu([], false));
    }

    case 'ref': {
      const username = await settingText(tx, 'bot', 'username');
      if (username === null) {
        // Nothing here is worth showing without a link that works.
        return screen(menu.SOON, menu.mainMenu(user));
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
      if (user.is_reseller) return screen(menu.ALREADY_RESELLER, menu.mainMenu(user));
      if (await hasOpenRequest(tx, user.id)) {
        return screen(menu.RESELLER_REQUEST_OPEN, menu.mainMenu(user));
      }
      await ask(tx, user.id, 'agent', {}, editId);
      return screen(menu.ASK_RESELLER_REQUEST, menu.promptMenu(encode('menu')));
    }

    case 'order': {
      if (action.id === undefined) return IGNORED;
      // The same visibility check the list used, run again. Reaching this point
      // is not evidence that a button was ever offered for this plan.
      const plan = await purchasablePlan(tx, user.id, action.id);
      if (!plan) return screen(menu.PLAN_GONE, menu.planMenu([]));
      return placeOrderScreen(tx, user, plan, screen, editId);
    }

    case 'auto': {
      if (action.id === undefined) return IGNORED;
      const plan = await purchasablePlan(tx, user.id, action.id);
      if (!plan) return screen(menu.PLAN_GONE, menu.planMenu([]));
      // The open question is closed first. Without this the session still says
      // `uname`, and the next thing the customer types — «سلام», the receipt
      // amount, anything — is read as the account name for an order that has
      // already been placed and paid for.
      await clearSession(tx, user.id);
      return placeOrderScreen(tx, user, plan, screen, editId, true);
    }

    case 'mine': {
      // The page is untrusted and needs no check: it becomes an OFFSET into a
      // query that is already scoped to this customer, so the worst a forged
      // page can do is show them nothing.
      const total = await countSubscriptionsForUser(tx, user.id);
      if (total === 0) {
        return screen(menu.MY_SERVICES_EMPTY, menu.mainMenu(user));
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
        menu.serviceDetailMenu(actionsFor(service, SHOP, tierFor(user))),
      );
    }

    case 'qr': {
      if (action.id === undefined) return IGNORED;
      const service = await subscriptionOnPanelForUser(tx, user.id, action.id);
      if (!service) return screen(menu.SERVICE_GONE, menu.myServicesMenu([], Date.now(), 1, 1));
      // A service with no link has nothing to encode. Sending a QR of an empty
      // string is a picture that scans to nothing, which is worse than saying so.
      if (!service.subscription_url) {
        return screen(menu.ACTION_UNSUPPORTED, menu.serviceDetailMenu(actionsFor(service, SHOP)));
      }
      // A new message rather than an edit: the detail screen the customer is
      // looking at stays where it is, and the picture arrives under it.
      const copy = menu.copyLinkMenu(service.subscription_url);
      return {
        status: 'processed',
        replies: [
          // Built by hand for the reason `reply` is: `exactOptionalPropertyTypes`
          // rejects an explicit `undefined`, and the copy button is absent for a
          // link too long for Telegram to carry on one.
          {
            ...reply(chatId, service.subscription_url, copy ?? undefined),
            qrOf: service.subscription_url,
          },
        ],
      };
    }

    case 'xv':
    case 'xt': {
      if (action.id === undefined) return IGNORED;
      const service = await subscriptionOnPanelForUser(tx, user.id, action.id);
      if (!service) return screen(menu.SERVICE_GONE, menu.myServicesMenu([], Date.now(), 1, 1));
      const actions = actionsFor(service, SHOP, tierFor(user));
      const kind = action.action === 'xv' ? 'ADD_VOLUME' : 'ADD_TIME';
      const unit =
        kind === 'ADD_VOLUME'
          ? (actions?.volumeIrrPerGb ?? null)
          : (actions?.timeIrrPerDay ?? null);
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
      if (!actionsFor(service, SHOP)) {
        return screen(menu.ACTION_UNSUPPORTED, menu.serviceDetailMenu());
      }
      return screen(menu.CONFIRM_REVOKE, menu.confirmRevokeMenu(action.id));
    }

    case 'rvk2':
    case 'off':
    case 'on': {
      if (action.id === undefined) return IGNORED;
      const kind =
        action.action === 'rvk2' ? 'REVOKE' : action.action === 'on' ? 'ENABLE' : 'DISABLE';
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
          menu.serviceDetailMenu(actionsFor(outcome.service, SHOP)),
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
      return screen(
        `${said}\n\n${detail}`,
        menu.serviceDetailMenu(actionsFor(outcome.service, SHOP)),
      );
    }

    case 'renew': {
      const total = await countRenewableForUser(tx, user.id);
      if (total === 0) {
        return screen(menu.NOTHING_TO_RENEW, menu.mainMenu(user));
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
      await ask(tx, user.id, 'coder', { subscriptionId: service.id }, editId);
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

    // ── the admin's premium-emoji screen ─────────────────────────────────
    //
    // `user.is_admin` is re-read here rather than inferred from the button
    // having been pressed. `ADMIN_ONLY` keeps these three off a customer's
    // keyboard, and that is presentation: `callback_data` is unsigned, so
    // anybody can post `emj` and this is the line that answers them.
    //
    // The answer is the main menu, not a refusal. Telling a stranger «شما ادمین
    // نیستید» confirms the surface exists, which is the one thing a probe is
    // looking for.
    // ── the admin's premium-emoji screen ─────────────────────────────────
    //
    // `user.is_admin` is re-read here rather than inferred from the button
    // having been pressed. `ADMIN_ONLY` keeps these three off a customer's
    // keyboard, and that is presentation: `callback_data` is unsigned, so
    // anybody can post `emj` and this is the line that answers them.
    //
    // The answer is the main menu, not a refusal. Telling a stranger «شما ادمین
    // نیستید» confirms the surface exists, which is the one thing a probe is
    // looking for.
    //
    // The flow is BUTTON first, then emoji: you arrive knowing which button you
    // are unhappy with, and pressing an emoji replaces it there and then.
    //
    //   emj                  which button?
    //   emjb:<slot>          that button, with every emoji as a live tile
    //   emjb:<slot>:<id>     replace, and redraw the same screen
    //   emja[:<slot>]        send me one — coming back to <slot> when it had one
    case 'emj':
    case 'emja':
    case 'emjb': {
      if (!user.is_admin) return screen(menu.MENU_TITLE, menu.mainMenu(user));
      const buttons = menu.mainMenuButtons();

      if (action.action === 'emja') {
        // The slot travels through the session, because the answer arrives as a
        // MESSAGE — a different update with no callback data on it.
        await ask(tx, user.id, 'emoji', action.id === undefined ? {} : { slot: action.id }, editId);
        return screen(menu.ASK_PREMIUM_EMOJI, menu.promptMenu(encode('emj')));
      }

      if (action.action === 'emjb' && action.id !== undefined) {
        const target = buttons.find((b) => b.slot === action.id);
        // The slot names a declared action this shop's layout does not carry —
        // an admin removed that row. Said plainly rather than silently redrawn.
        if (!target) return screen(menu.EMOJI_BUTTON_GONE, menu.emojiHomeMenu(buttons));

        if (action.id2 === undefined) {
          const have = await storedEmoji(tx);
          return screen(
            menu.emojiForButton(target.label, have.length),
            menu.emojiForButtonMenu(target.slot, have),
          );
        }

        const chosen = await emojiById(tx, action.id2);
        // Gone between the screen being drawn and the tile being pressed —
        // another admin hid its pack. Redrawn rather than errored: there is
        // nothing for this admin to do about it.
        if (!chosen) {
          const have = await storedEmoji(tx);
          return screen(
            menu.emojiForButton(target.label, have.length),
            menu.emojiForButtonMenu(target.slot, have),
          );
        }

        const label = await setButtonEmoji(tx, target.action, target.label, chosen);
        // Redrawn from the LIVE layout, so the tile the admin just pressed is
        // shown on the button it landed on rather than on a stale copy.
        const after = menu.mainMenuButtons().find((b) => b.slot === target.slot) ?? target;
        const have = await storedEmoji(tx);
        return screen(
          label === null
            ? menu.emojiTooLong(target.label)
            : menu.emojiForButton(after.label, have.length, { placed: true }),
          menu.emojiForButtonMenu(target.slot, have),
        );
      }

      return screen(menu.emojiHome(), menu.emojiHomeMenu(buttons));
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

    case 'tpx':
      // The presets cover a 125× range in six buttons, which still leaves the
      // customer who wants 75,000 Toman choosing between paying 100,000 and
      // giving up. Mirzabot has always let them type it (`index.php:4712`
      // enforces the same floor and ceiling on whatever they send).
      await ask(tx, user.id, 'topup', {}, editId);
      return screen(
        menu.askTopupAmount(SHOP.topupMinIrr, SHOP.topupMaxIrr),
        menu.promptMenu(encode('top')),
      );

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
      if (needed === null) return screen(menu.MENU_TITLE, menu.mainMenu(user));
      return topup(tx, user.id, needed, screen);
    }

    case 'wpay': {
      if (action.id === undefined) return IGNORED;
      // Held, not merely read: the expiry sweep locks its candidates and closes
      // them, so an unlocked read here decides on a status that can already be
      // stale by the time the balance is debited. The card path takes the same
      // lock in `recordPaidClick` and this one went without it until 2026-08-15.
      const order = await lockOrderForUser(tx, user.id, action.id);
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
      const claimed = await tx
        .prepare(
          `UPDATE orders SET status = 'PAID', updated_at = now()
            WHERE id = ?1 AND status = 'AWAITING_PAYMENT'`,
        )
        .bind(order.id)
        .run();
      if (claimed.meta.changes === 0) {
        // Unreachable while the lock above is held, and thrown rather than
        // returned for exactly that reason: reaching it means the lock is gone,
        // and the only safe answer then is to roll the whole handler back —
        // which takes the debit with it — instead of telling a customer their
        // money bought an order that no longer accepts it.
        throw new Error(`order ${order.id} moved out of AWAITING_PAYMENT under a held lock`);
      }
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
