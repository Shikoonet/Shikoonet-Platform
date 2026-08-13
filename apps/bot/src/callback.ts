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
  'soon', // a menu entry that has no implementation yet
] as const;

export type CallbackAction = (typeof CALLBACK_ACTIONS)[number];

export interface Callback {
  action: CallbackAction;
  /** Present only for actions that carry one. Digits, already range-checked. */
  id?: number;
}

const ActionSchema = z.enum(CALLBACK_ACTIONS);

/**
 * Telegram's limit is 64 bytes. Our longest is `order:<bigint>` — well inside
 * it — but the cap is enforced on the way out so a future action cannot quietly
 * produce a button Telegram refuses to send.
 */
export const CALLBACK_MAX_BYTES = 64;

export function encode(action: CallbackAction, id?: number): string {
  const data = id === undefined ? action : `${action}:${id}`;
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
  const [rawAction, rawId, ...rest] = data.split(':');
  // More than one colon is not a shape we ever produce.
  if (rest.length > 0) return null;

  const action = ActionSchema.safeParse(rawAction);
  if (!action.success) return null;

  if (rawId === undefined) return { action: action.data };

  // Digits only: no sign, no whitespace, no exponent, no leading zeros to make
  // two spellings of one id.
  if (!/^[1-9][0-9]{0,18}$/.test(rawId)) return null;
  const id = Number(rawId);
  if (!Number.isSafeInteger(id)) return null;

  return { action: action.data, id };
}
