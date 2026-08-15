/**
 * Turning a saved layout into the keyboard Telegram is sent.
 *
 * The layouts themselves — what buttons each screen may carry, what the default
 * is, and what makes one valid — live in `@shikoo/contracts`, because the admin
 * panel saves layouts and the two must not disagree about the rules. Only the
 * part that needs the bot's own `encode` and `InlineKeyboard` is here.
 *
 * ## What the bot still decides
 *
 * Three things a saved layout cannot know, and therefore three things this file
 * is given rather than told:
 *
 *   * where a button points — `panel:7` and `rnw:31` name a row, and the row is
 *     whichever one the customer is looking at;
 *   * whether a button applies at all — a panel that does not sell extra
 *     volume, a wallet that cannot cover the order, an education list with no
 *     apps behind it;
 *   * what goes in its label's slots — the balance, the held discount code.
 *
 * A conditional button that does not apply is dropped and its place closed up.
 * One rule instead of a special case per screen, and it is the same rule the
 * old code applied by hand: never draw a button that cannot do anything.
 */

import { encode, type CallbackAction } from './callback.js';
import type { InlineKeyboard } from './telegram.js';
import {
  ADMIN_ONLY,
  DEFAULT_LAYOUTS,
  isMenuAction,
  MENUS,
  RESELLER_ONLY_HIDDEN,
  type ButtonPlacement,
  type MenuId,
} from '@shikoo/contracts';

export {
  checkLayout,
  DEFAULT_LAYOUT,
  DEFAULT_LAYOUTS,
  isMenuId,
  MAX_LABEL_LENGTH,
  MENU_ACTIONS,
  MENU_IDS,
  MENUS,
  type ButtonPlacement,
  type LayoutProblem,
  type MenuAction,
  type MenuId,
} from '@shikoo/contracts';

/** A slot in a button label. */
const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

/**
 * What the bot knows and the layout does not.
 *
 * `applies` defaults to "everything applies", so a screen with no conditional
 * buttons passes nothing. `target` defaults to the bare action, which is right
 * for every button that names no row.
 */
export interface MenuContext {
  /** False drops the button and closes its place up. Chrome only. */
  applies?: (action: string) => boolean;
  /** The `callback_data` for an action that names a row. */
  target?: (action: string) => string | undefined;
  /** Values for the slots in labels. */
  values?: Record<string, string>;
}

function fill(label: string, values: Record<string, string> | undefined): string {
  // A slot with no value is left as written, exactly as the texts do: `()` on
  // its own reads as a broken button, `{balance}` reads as a misconfiguration,
  // and only one of those gets reported.
  return label.replace(PLACEHOLDER, (whole, name: string) =>
    values && name in values ? values[name]! : whole,
  );
}

/**
 * The keyboard Telegram is sent.
 *
 * Sorted rather than trusted in query order, and a row that ends up with
 * nothing in it is dropped — an admin who hides the middle of a row should not
 * get a blank line, and neither should a customer whose whole row turned out
 * not to apply.
 */
export function buildMenu(
  menuId: MenuId,
  buttons: readonly ButtonPlacement[],
  ctx: MenuContext = {},
): InlineKeyboard {
  const shown = buttons
    .filter((b) => b.visible)
    .filter((b) => ctx.applies === undefined || ctx.applies(b.action))
    .slice()
    .sort((a, b) => a.rowIndex - b.rowIndex || a.colIndex - b.colIndex);

  const rows: InlineKeyboard = [];
  let currentRow = -1;
  for (const button of shown) {
    // A row naming an action this build does not handle is dropped rather than
    // drawn. The write path refuses one, but a layout saved before an action
    // was removed would otherwise render a button that does nothing.
    if (!isMenuAction(menuId, button.action)) continue;
    // `back` has no fixed destination, so a context that did not supply one is
    // a bug in the caller, not a button to draw pointing at nothing.
    const data = ctx.target?.(button.action) ?? (button.action === 'back' ? undefined : button.action);
    if (data === undefined) continue;
    if (button.rowIndex !== currentRow) {
      rows.push([]);
      currentRow = button.rowIndex;
    }
    rows[rows.length - 1]!.push({ text: fill(button.label, ctx.values), callback_data: data });
  }
  return rows.filter((row) => row.length > 0);
}

/**
 * Who is looking at the main menu.
 *
 * One object rather than two booleans, and passed whole rather than unpacked at
 * the call site, because the main menu is drawn from sixteen places. Two
 * positional flags is sixteen chances to answer one of them and forget the
 * other — and the failure mode is silent: the shop's admin sees their button on
 * `/start` and then watches it vanish the moment they press «بازگشت به منو».
 */
export interface MenuViewer {
  is_reseller: boolean;
  is_admin: boolean;
}

/**
 * The main menu.
 *
 * Its own function because the two rules it needs — hide «درخواست نمایندگی»
 * from a reseller, hide «پنل مدیریت» from everyone else — depend on who is
 * looking, which a layout cannot know and an `applies` callback at every call
 * site would have to repeat.
 */
export function buildMainMenu(
  buttons: readonly ButtonPlacement[],
  viewer: MenuViewer,
): InlineKeyboard {
  return buildMenu('main', buttons, {
    applies: (action) => {
      if (viewer.is_reseller && RESELLER_ONLY_HIDDEN.has(action)) return false;
      if (!viewer.is_admin && ADMIN_ONLY.has(action)) return false;
      return true;
    },
  });
}

/**
 * Asserts at load that every action the panel offers is one the bot dispatches.
 *
 * `MENUS` lives in `@shikoo/contracts`, which cannot import `CallbackAction` —
 * so the contract the compiler used to check is checked by a test instead. This
 * type alias is what makes that test's expectation precise.
 */
export type DispatchableAction = CallbackAction;

/** Every action across every menu, for the test that checks all of them. */
export function allMenuActions(): { menu: MenuId; action: string }[] {
  return (Object.keys(MENUS) as MenuId[]).flatMap((menu) =>
    MENUS[menu].buttons.map((b) => ({ menu, action: b.action })),
  );
}

/** The shipped layout for one menu. */
export function defaultLayout(menuId: MenuId): readonly ButtonPlacement[] {
  return DEFAULT_LAYOUTS[menuId];
}

export { encode };
