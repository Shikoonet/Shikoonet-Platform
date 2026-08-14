/**
 * The main menu's layout: what it may contain, and what makes one valid.
 *
 * Here rather than in the bot because two things need it and they must not
 * disagree. The bot draws the keyboard; the admin panel saves one. If the panel
 * carried its own copy of "at least one button must be visible", the day the
 * two drifted would be the day a shop saved a keyboard its own bot refuses to
 * draw.
 *
 * Only the rules and the data live here. Turning a layout into the structure
 * Telegram is sent needs `encode` and `InlineKeyboard`, which are the bot's, so
 * `buildMainMenu` stays there.
 *
 * The default is production's own layout, read out of `setting.keyboardmain` on
 * the 2026-08-11 dump. Customers have this muscle memory and the replacement
 * bot should not move their buttons unless the shop asks it to.
 *
 * ## All or nothing
 *
 * `bot_texts` overrides one key at a time because keys are independent. A
 * keyboard is not: a button means something by where it sits relative to the
 * others. So the table is either empty — and this layout is used whole — or it
 * holds every button. There is no merge, and therefore no question about where
 * a button added by a later release lands in a layout saved last year.
 *
 * The cost is honest and small: a shop that customises the keyboard does not
 * automatically receive a new button. `MENU_ACTIONS` is what tells the admin
 * screen one exists, and adding it is one click.
 */

/** A button the main menu is allowed to carry. */
export interface MenuAction {
  /**
   * The callback this fires. The bot must have a branch for it — enforced
   * there, where `CallbackAction` is defined, and at runtime by `checkLayout`
   * for rows arriving from the database.
   */
  action: string;
  /** The wording as the code ships it. */
  label: string;
  /** What it does, for the admin screen. */
  hint: string;
}

export const MENU_ACTIONS: readonly MenuAction[] = [
  { action: 'renew', label: '♻️ تمدید سرویس', hint: 'تمدید سرویس‌های موجود' },
  { action: 'buy', label: '🔐 خرید اشتراک', hint: 'خرید سرویس جدید' },
  { action: 'wal', label: '🏦 کیف پول + شارژ', hint: 'کیف پول و شارژ آن' },
  { action: 'mine', label: '🛍 سرویس های من', hint: 'فهرست سرویس‌های کاربر' },
  { action: 'sup', label: '☎️ پشتیبانی', hint: 'صفحهٔ پشتیبانی' },
  { action: 'hlp', label: '📚 آموزش', hint: 'مطالب آموزشی' },
  { action: 'ref', label: '👥 زیر مجموعه گیری', hint: 'لینک دعوت و پورسانت' },
  {
    action: 'agr',
    label: '👨‍💻 درخواست نمایندگی',
    hint: 'فقط به کاربران غیرنماینده نشان داده می‌شود',
  },
];

const BY_ACTION = new Map(MENU_ACTIONS.map((a) => [a.action, a]));

export function isMenuAction(action: string): boolean {
  return BY_ACTION.has(action);
}

/**
 * Actions the bot hides from a customer who already has that status.
 *
 * Production appends «درخواست نمایندگی» only for non-resellers, and this stays
 * a rule rather than a layout setting: it depends on who is looking, which a
 * saved layout cannot know.
 */
export const RESELLER_ONLY_HIDDEN: ReadonlySet<string> = new Set(['agr']);

export interface ButtonPlacement {
  action: string;
  label: string;
  rowIndex: number;
  colIndex: number;
  visible: boolean;
}

const DEFAULT_CELLS: ReadonlyArray<{ action: string; rowIndex: number; colIndex: number }> = [
  { action: 'renew', rowIndex: 0, colIndex: 0 },
  { action: 'buy', rowIndex: 0, colIndex: 1 },
  { action: 'wal', rowIndex: 1, colIndex: 0 },
  { action: 'mine', rowIndex: 1, colIndex: 1 },
  { action: 'sup', rowIndex: 2, colIndex: 0 },
  { action: 'hlp', rowIndex: 2, colIndex: 1 },
  { action: 'ref', rowIndex: 2, colIndex: 2 },
  { action: 'agr', rowIndex: 3, colIndex: 0 },
];

/**
 * The layout the code ships, in the shape the database stores.
 *
 * Labels come from `MENU_ACTIONS` rather than being repeated, so the default
 * wording has one definition and cannot disagree with itself.
 */
export const DEFAULT_LAYOUT: readonly ButtonPlacement[] = DEFAULT_CELLS.map((b) => ({
  ...b,
  label: BY_ACTION.get(b.action)!.label,
  visible: true,
}));

export type LayoutProblem =
  | { kind: 'EMPTY' }
  | { kind: 'UNKNOWN_ACTION'; actions: string[] }
  | { kind: 'DUPLICATE_ACTION'; actions: string[] }
  | { kind: 'DUPLICATE_CELL' }
  | { kind: 'NOTHING_VISIBLE' }
  | { kind: 'LABEL_EMPTY'; actions: string[] }
  | { kind: 'LABEL_TOO_LONG'; actions: string[]; limit: number };

/** Telegram truncates beyond this and the row stops being readable on a phone. */
export const MAX_LABEL_LENGTH = 64;

/**
 * Whether a layout may be saved.
 *
 * `NOTHING_VISIBLE` is the one that matters most: a keyboard with every button
 * hidden leaves a customer on a screen with no way forward and no way back, and
 * the only fix is an admin who realises what they did. Refusing it costs a
 * confused click; allowing it costs a shop its bot.
 */
export function checkLayout(buttons: ButtonPlacement[]): LayoutProblem | null {
  if (buttons.length === 0) return { kind: 'EMPTY' };

  const unknown = buttons.filter((b) => !isMenuAction(b.action)).map((b) => b.action);
  if (unknown.length > 0) return { kind: 'UNKNOWN_ACTION', actions: [...new Set(unknown)] };

  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const b of buttons) {
    if (seen.has(b.action)) duplicated.add(b.action);
    seen.add(b.action);
  }
  if (duplicated.size > 0) return { kind: 'DUPLICATE_ACTION', actions: [...duplicated] };

  const cells = new Set(buttons.map((b) => `${b.rowIndex}:${b.colIndex}`));
  if (cells.size !== buttons.length) return { kind: 'DUPLICATE_CELL' };

  const empty = buttons.filter((b) => b.label.trim() === '').map((b) => b.action);
  if (empty.length > 0) return { kind: 'LABEL_EMPTY', actions: empty };

  const long = buttons.filter((b) => b.label.length > MAX_LABEL_LENGTH).map((b) => b.action);
  if (long.length > 0) {
    return { kind: 'LABEL_TOO_LONG', actions: long, limit: MAX_LABEL_LENGTH };
  }

  // A layout whose only visible buttons are ones this customer never sees is
  // still empty for them, so `agr` alone visible would strand every reseller.
  const visible = buttons.filter((b) => b.visible);
  if (visible.length === 0) return { kind: 'NOTHING_VISIBLE' };
  if (visible.every((b) => RESELLER_ONLY_HIDDEN.has(b.action))) {
    return { kind: 'NOTHING_VISIBLE' };
  }
  return null;
}
