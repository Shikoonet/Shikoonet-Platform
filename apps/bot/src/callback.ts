/**
 * Callback data: parsing it, and the rule about what it may be trusted for.
 *
 * `callback_data` is NOT a token the bot handed out. Telegram does not sign it,
 * does not remember which buttons it offered, and does not check that this
 * customer was ever shown this button. Anyone can post any 64-byte string with
 * one API call. It is user input, exactly like a URL query parameter.
 *
 * Mirzabot treats it as trusted, and index.php:1252 shows the cost. The `/sub`
 * text path checks `$nameloc['id_user'] != $from_id`; the button path, four
 * lines below, takes the id straight from callback_data and hands back the
 * service's subscription URL — the VPN credential itself. Any customer can read
 * any other customer's, by counting. It is item 8 in BUGS-FOR-ADMIN.md.
 *
 * The rule here, and it is structural rather than a habit:
 *
 *   An id out of callback_data NEVER selects a row on its own. Every lookup of
 *   a customer-owned row goes through owned.ts, whose queries all carry
 *   `AND user_id = $caller`. There is no other way to load one.
 *
 * The parse below is the first half of that: an action from a closed set and an
 * id that is digits, so nothing else reaches a handler in the first place.
 */

import { z } from 'zod';

/**
 * Every action the bot answers. A closed set, checked before dispatch: an
 * action nobody added here cannot reach a handler, whatever a client sends.
 */
export const CALLBACK_ACTIONS = [
  'chk', // «عضو شدم» — ask Telegram again whether this customer is in the
  //        required channels. Carries nothing: which channels are required is
  //        the shop's row, and who is asking is the update's `from`.
  'acc', // «قوانین را می‌پذیرم» — the one thing a customer behind the rules gate
  //        is allowed to do
  'menu', // back to the main menu
  'buy', // the shop's first screen — the category list
  'tst', // [providerId] — the free trial. Without an id: the panels that
  //        offer one, or straight to the only one that does. With an id:
  //        take it on that panel. The id is re-checked against
  //        `trialPanelsForUser`, which is scoped to the caller, so it names
  //        a row only if that customer could already see it.
  'panel', // <providerId> — the services on one panel
  'cat', // <categoryId> — the priced rows inside one category. The shop's
  //        second screen, and the first one that carries prices.
  'prd', // <productId> — the plans inside one service. A service holding a
  //        single plan answers with that plan's page instead of a list of one.
  //        LEGACY: the shop is category-first now and draws no `prd:` button,
  //        but Telegram keeps a button pressable forever and these are sitting
  //        in customers' chats. Dropping the case would make an old button
  //        answer nothing at all, which reads as a broken bot rather than an
  //        old screen — the same reason `panel` is still here.
  'tar', // the whole price list, as text — no ids, nothing to forge
  'plan', // <planId> — one plan, with its price
  'order', // <planId> — create the order and show the card to pay into
  'auto', // <planId> — «خودکار انتخاب کن!»: place the order WITHOUT a typed
  //         account name, on a panel whose mode asks for one. Not a shortcut
  //         past the setting — `remoteUsernameFor` already names a
  //         CUSTOMER_TEXT order with no text after its own order id, which is
  //         the generated name the customer is agreeing to here.
  'paid', // <orderId> — the customer says they have paid
  'mine', // [page] — the services this customer already owns
  'sub', // <subscriptionId> — one owned service, with its link
  'renew', // [page] — the services that can be extended
  'rnw', // <subscriptionId> — the plans this service can be extended onto
  'rord', // <subscriptionId>:<planId> — extend that service with that plan
  // ── admin only, and the guard is in the handler ──────────────────────────
  //
  // `emj` is drawn only for an admin (`ADMIN_ONLY` in `botKeyboard.ts`), and
  // being undrawn is not being closed: `callback_data` is unsigned, so anybody
  // can post these three. `handleCallback` re-reads `is_admin` before acting on
  // any of them, which is where the door actually is.
  'emj', // the admin's premium-emoji screen: what the bot has, and how to add
  'emja', // [buttonSlot] — ask the admin to SEND a premium emoji, so its id can
  //         be read off the message entity: the only way to get one without
  //         guessing. The slot rides along so the answer lands back on the
  //         button they were looking at.
  'emjb', // <buttonSlot>[:<emojiId>] — that button's tiles, then the swap
  'wal', // the balance and the last movements on it
  'top', // the deposit amounts on offer
  'tp', // <presetIndex> — deposit that preset. An INDEX, never an amount:
  //        the customer controls this field, so the number it means is
  //        looked up in `TOPUP_AMOUNTS_IRR` rather than read off the wire.
  'tpo', // <orderId> — deposit exactly what this order still needs, computed
  //        from the order row for the same reason.
  'tpx', // ask the customer to type an amount. The number then arrives as a
  //        MESSAGE, not in callback data, and is checked against the shop's
  //        own floor and ceiling before it becomes an order.
  'wpay', // <orderId> — pay that order out of the balance
  'qr', // <subscriptionId> — send the subscription link as a QR image. Reads
  //        nothing and changes nothing, which is why it needs no confirmation
  //        step the way `rvk` does.
  'rvk', // <subscriptionId> — ask before replacing the subscription link
  'rvk2', // <subscriptionId> — do it. Separate action rather than a flag: the
  //        old link stops working the moment this runs, on every device the
  //        customer has already imported it onto.
  'xv', // <subscriptionId> — ask how many gigabytes to add
  'xt', // <subscriptionId> — ask how many days to add
  'off', // <subscriptionId> — turn the account off at the panel
  'on', // <subscriptionId> — turn it back on
  'dsc', // <planId> — ask for a discount code to put on that plan
  'dsx', // <planId> — take the code back off it
  'dsr', // <subscriptionId> — the same, for a renewal, where the plan is not
  //        chosen yet and the code is held against the SERVICE
  'dxr', // <subscriptionId> — take it back off the renewal
  'gft', // ask for a gift code to credit the wallet
  'agr', // ask for a reseller application
  'sup', // how to reach support
  'ref', // the customer's referral link and what it has earned
  'hlp', // [articleId] — the education list, or one article
  'app', // the client apps and their links
  'soon', // a menu entry that has no implementation yet
] as const;

export type CallbackAction = (typeof CALLBACK_ACTIONS)[number];

export interface Callback {
  action: CallbackAction;
  /** Present only for actions that carry one. Digits, already range-checked. */
  id?: number;
  /**
   * A second id, for the one action that names two rows at once: extending a
   * particular service with a particular plan.
   *
   * Carried in the button rather than in `bot_sessions` on purpose. A session
   * would have to be written, read back a tap later, and expire — and a
   * customer with Telegram open on a phone and a desktop would have two flows
   * writing one row. Both ids are re-checked against the database anyway, so
   * there is nothing a session would protect that this does not.
   */
  id2?: number;
  /** Set instead of `id` for the actions that name a hub row by its UUID. */
  ref?: string;
}

const ActionSchema = z.enum(CALLBACK_ACTIONS);

/**
 * The actions that carry two ids — a closed set, like the actions themselves.
 *
 * Without this, `panel:1:2` would parse. No handler reads the second id, so
 * nothing would go wrong today; the check is here because "nothing reads it
 * yet" is not a property anybody can rely on, and an action's arity is part of
 * its shape in the same way its name is.
 */
const TWO_ID_ACTIONS = new Set<CallbackAction>(['rord', 'emjb']);

/**
 * Telegram's limit is 64 bytes. Our longest is `order:<bigint>` — well inside
 * it — but the cap is enforced on the way out so a future action cannot quietly
 * produce a button Telegram refuses to send.
 */
export const CALLBACK_MAX_BYTES = 64;

export function encode(action: CallbackAction, id?: number, id2?: number): string {
  if (id === undefined && id2 !== undefined) {
    throw new Error('a second callback id without a first is not a shape we produce');
  }
  const parts = [action, id, id2].filter((part) => part !== undefined);
  return capped(parts.join(':'));
}

function capped(data: string): string {
  const bytes = new TextEncoder().encode(data).length;
  if (bytes > CALLBACK_MAX_BYTES) {
    throw new Error(`callback_data is ${bytes} bytes, over Telegram's ${CALLBACK_MAX_BYTES}`);
  }
  return data;
}

/**
 * Returns null for anything unrecognised — an unknown action, a missing id, a
 * negative or non-numeric one, or an id too large to be a real key.
 *
 * Null means "ignore", not "error". A crafted callback is not worth a reply,
 * and answering differently for "no such action" than for "not yours" would
 * hand an attacker a probe.
 */
export function decode(data: string | undefined): Callback | null {
  if (data === undefined) return null;
  const [rawAction, rawId, rawId2, ...rest] = data.split(':');
  // More than two colons is not a shape we ever produce.
  if (rest.length > 0) return null;

  const action = ActionSchema.safeParse(rawAction);
  if (!action.success) return null;

  if (rawId === undefined) return { action: action.data };

  const id = parseId(rawId);
  if (id === null) return null;
  if (rawId2 === undefined) return { action: action.data, id };
  if (!TWO_ID_ACTIONS.has(action.data)) return null;

  const id2 = parseId(rawId2);
  if (id2 === null) return null;
  return { action: action.data, id, id2 };
}

/**
 * Digits only: no sign, no whitespace, no exponent, and no leading zeros to
 * make two spellings of one id.
 */
function parseId(raw: string): number | null {
  if (!/^[1-9][0-9]{0,18}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}
