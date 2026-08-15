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
  'menu', // back to the main menu
  'buy', // the panel/location list
  'panel', // <providerId> — the products on one panel
  'plan', // <planId> — one plan, with its price
  'order', // <planId> — create the order and show the card to pay into
  'paid', // <orderId> — the customer says they have paid
  'mine', // [page] — the services this customer already owns
  'sub', // <subscriptionId> — one owned service, with its link
  'renew', // [page] — the services that can be extended
  'rnw', // <subscriptionId> — the plans this service can be extended onto
  'rord', // <subscriptionId>:<planId> — extend that service with that plan
  'wal', // the balance and the last movements on it
  'top', // the deposit amounts on offer
  'tp', // <presetIndex> — deposit that preset. An INDEX, never an amount:
  //        the customer controls this field, so the number it means is
  //        looked up in `TOPUP_AMOUNTS_IRR` rather than read off the wire.
  'tpo', // <orderId> — deposit exactly what this order still needs, computed
  //        from the order row for the same reason.
  'wpay', // <orderId> — pay that order out of the balance
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
  // --- admin only. Every one of these re-checks `admins` before it acts; the
  // button is not the permission, the row is.
  'pnl', // the admin home
  'clm', // [page] — payments waiting for a decision
  'clv', // <claimId> — one of them, with the bank transactions that could be it
  'apv', // <transactionId> — settle the claim in the session with that transaction
  'apx', // settle it with no transaction at all — the admin's word alone
  'rej', // refuse it
  'cnf', // confirm whichever of the two was asked for
  'sts', // the shop's headline numbers
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
const TWO_ID_ACTIONS = new Set<CallbackAction>(['rord']);

/**
 * The actions whose id is a text reference rather than a number.
 *
 * The payment hub's own tables carry UUID primary keys — `payment_claims.id`,
 * `transaction_candidates.id` — and an admin screen has to name one. Also a
 * closed set, and the shape is still narrow: the characters a UUID is made of,
 * and short enough that two of them could never fit in one button, which is why
 * the claim being worked on lives in the session instead.
 */
const REF_ACTIONS = new Set<CallbackAction>(['clv', 'apv']);

const REF_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * Telegram's limit is 64 bytes. Our longest is `order:<bigint>` — well inside
 * it — but the cap is enforced on the way out so a future action cannot quietly
 * produce a button Telegram refuses to send.
 */
export const CALLBACK_MAX_BYTES = 64;

/** `clv:<uuid>` — the text-referenced half of the same grammar. */
export function encodeRef(action: CallbackAction, ref: string): string {
  if (!REF_ACTIONS.has(action)) {
    throw new Error(`${action} does not carry a reference`);
  }
  if (!REF_PATTERN.test(ref)) {
    throw new Error('a callback reference must be short and alphanumeric');
  }
  return capped(`${action}:${ref}`);
}

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

  if (REF_ACTIONS.has(action.data)) {
    // A ref action always carries exactly one ref and never an id.
    if (rawId === undefined || rawId2 !== undefined) return null;
    return REF_PATTERN.test(rawId) ? { action: action.data, ref: rawId } : null;
  }

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
