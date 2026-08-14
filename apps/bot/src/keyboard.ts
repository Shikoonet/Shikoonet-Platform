/**
 * Turning a saved layout into the keyboard Telegram is sent.
 *
 * The layout itself — what buttons exist, what the default is, and what makes
 * one valid — lives in `@shikoo/contracts`, because the admin panel saves
 * layouts and the two must not disagree about the rules. Only the part that
 * needs the bot's own `encode` and `InlineKeyboard` is here.
 */

import { encode, type CallbackAction } from './callback.js';
import type { InlineKeyboard } from './telegram.js';
import {
  isMenuAction,
  RESELLER_ONLY_HIDDEN,
  type ButtonPlacement,
} from '@shikoo/contracts';

export {
  checkLayout,
  DEFAULT_LAYOUT,
  isMenuAction,
  MAX_LABEL_LENGTH,
  MENU_ACTIONS,
  type ButtonPlacement,
  type LayoutProblem,
  type MenuAction,
} from '@shikoo/contracts';

/**
 * The keyboard Telegram is sent.
 *
 * Sorted rather than trusted in query order, and a row that ends up with
 * nothing in it is dropped — an admin who hides the middle of a row should not
 * get a blank line in the menu.
 */
export function buildMainMenu(
  buttons: readonly ButtonPlacement[],
  isReseller: boolean,
): InlineKeyboard {
  const shown = buttons
    .filter((b) => b.visible)
    .filter((b) => !(isReseller && RESELLER_ONLY_HIDDEN.has(b.action)))
    .slice()
    .sort((a, b) => a.rowIndex - b.rowIndex || a.colIndex - b.colIndex);

  const rows: InlineKeyboard = [];
  let currentRow = -1;
  for (const button of shown) {
    // A row naming an action this build does not handle is dropped rather than
    // drawn. The write path refuses one, but a layout saved before an action
    // was removed would otherwise render a button that does nothing.
    if (!isMenuAction(button.action)) continue;
    if (button.rowIndex !== currentRow) {
      rows.push([]);
      currentRow = button.rowIndex;
    }
    rows[rows.length - 1]!.push({
      text: button.label,
      // Safe by the check above: `isMenuAction` only admits actions that are in
      // `MENU_ACTIONS`, and a test asserts every one of those is a
      // `CallbackAction` the bot dispatches.
      callback_data: encode(button.action as CallbackAction),
    });
  }
  // A row can end up empty when every button in it was dropped, and an empty
  // row renders as a blank line in the menu.
  return rows.filter((row) => row.length > 0);
}
