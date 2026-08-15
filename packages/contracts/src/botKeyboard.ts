/**
 * Every keyboard the bot draws: what each one may contain, and what makes a
 * saved layout valid.
 *
 * Here rather than in the bot because two things need it and they must not
 * disagree. The bot draws the keyboards; the admin panel saves them. If the
 * panel carried its own copy of "this button cannot be removed", the day the
 * two drifted would be the day a shop saved a keyboard its own bot refuses to
 * draw.
 *
 * Only the rules and the data live here. Turning a layout into the structure
 * Telegram is sent needs `encode` and `InlineKeyboard`, which are the bot's, so
 * `buildMenu` stays there.
 *
 * The main menu's default is production's own layout, read out of
 * `setting.keyboardmain` on the 2026-08-11 dump. Customers have that muscle
 * memory and the replacement bot should not move their buttons unless the shop
 * asks it to.
 *
 * ## Chrome, not data
 *
 * A keyboard has two kinds of rows. The plans on a panel, the services a
 * customer owns, the bank transactions behind one payment — those come from the
 * database, there is a variable number of them, and they are not listed here.
 * The buttons around them are: back, pay, apply a code, turn the service off.
 * Those are the ones a shop can rename, move, or take away.
 *
 * Data rows are always drawn above the chrome. Making their position editable
 * would mean an anchor scheme for a row that does not exist until runtime, and
 * nobody has asked for it.
 *
 * Paging is generated too, for the same reason: «قبلی» and «بعدی» are the same
 * callback with a different page number, so they cannot be two rows in a table
 * keyed by action.
 *
 * ## All or nothing, per menu
 *
 * `bot_texts` overrides one key at a time because keys are independent. A
 * keyboard is not: a button means something by where it sits relative to the
 * others. So each menu is either absent from the table — and this file's layout
 * is used whole — or present with every one of its buttons. There is no merge,
 * and therefore no question about where a button added by a later release lands
 * in a layout saved last year.
 *
 * The cost is honest and small: a shop that customises one menu does not
 * automatically receive a new button on it. The panel shows which are available
 * and adding one is a click.
 *
 * ## Why some buttons cannot be removed
 *
 * Editing everything is only safe if the shop cannot edit its way into a dead
 * end. Take «✅ پرداخت کردم» off the invoice and the customer is left holding a
 * card number with no way to say they used it — and nothing on the screen looks
 * broken. `required` marks those, and `checkLayout` refuses a layout that has
 * dropped or hidden one. It is the same reasoning as `NOTHING_VISIBLE`, applied
 * per button instead of per keyboard.
 */

import { checkCustomEmoji } from './customEmoji.js';

/** A slot in a button label, as an admin writes it. Same contract as the texts. */
const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

/** A button a menu is allowed to carry. */
export interface MenuAction {
  /**
   * The callback this fires. The bot must have a branch for it — enforced
   * there, where `CallbackAction` is defined, and at runtime by `checkLayout`
   * for rows arriving from the database.
   *
   * `back` is the one exception: a button whose destination depends on where
   * the customer came from, so the bot supplies it. It is only ever used on the
   * `prompt` keyboard.
   */
  action: string;
  /** The wording as the code ships it. May carry `{slots}`. */
  label: string;
  /** Slots the label uses, which an override must use exactly. */
  placeholders?: readonly string[];
  /** What it does, for the admin screen. */
  hint: string;
  /**
   * Whether the customer is stranded without it. A required button may be
   * renamed and moved; it may not be removed or hidden.
   */
  required?: boolean;
  /**
   * Whether the bot decides at draw time if this button applies at all — an
   * add-on the panel does not sell, a wallet that cannot cover the order, an
   * education list with no apps behind it. A conditional button that is not
   * applicable is dropped and its place closed up; it can never be `required`.
   */
  conditional?: boolean;
}

/** One keyboard, as the shop sees it. */
export interface Menu {
  label: string;
  hint: string;
  buttons: readonly MenuAction[];
}

const BACK_TO_MENU: MenuAction = {
  action: 'menu',
  label: 'بازگشت به منو ⬅️',
  hint: 'بازگشت به منوی اصلی',
  required: true,
};

/**
 * Every keyboard, in the order the panel lists them: the customer's journey
 * first, then the wallet, then the shop's own screens, then the admin's.
 */
export const MENUS = {
  main: {
    label: 'منوی اصلی',
    hint: 'اولین چیزی که مشتری بعد از /start می‌بیند',
    buttons: [
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
    ],
  },
  panels: {
    label: 'انتخاب لوکیشن',
    hint: 'زیر فهرست لوکیشن‌ها',
    buttons: [BACK_TO_MENU],
  },
  plans: {
    label: 'فهرست پلن‌ها',
    hint: 'زیر پلن‌های یک لوکیشن',
    buttons: [
      { action: 'buy', label: 'بازگشت به لوکیشن‌ها ⬅️', hint: 'برگشت به فهرست لوکیشن‌ها' },
      BACK_TO_MENU,
    ],
  },
  planDetail: {
    label: 'جزئیات پلن',
    hint: 'صفحهٔ یک پلن، قبل از ثبت سفارش',
    buttons: [
      {
        action: 'order',
        label: '✅ ثبت سفارش',
        hint: 'سفارش را می‌سازد و کارت را نشان می‌دهد',
        required: true,
      },
      {
        action: 'dsc',
        label: '🏷 کد تخفیف دارم',
        hint: 'وقتی هنوز کدی روی این پلن نیست',
        conditional: true,
      },
      {
        action: 'dsx',
        label: '🏷 برداشتن کد تخفیف',
        hint: 'به‌جای دکمهٔ بالا، وقتی کدی اعمال شده',
        conditional: true,
      },
      { action: 'panel', label: 'بازگشت ⬅️', hint: 'برگشت به پلن‌های همین لوکیشن' },
      BACK_TO_MENU,
    ],
  },
  checkout: {
    label: 'فاکتور و کارت‌به‌کارت',
    hint: 'صفحه‌ای که شمارهٔ کارت روی آن است',
    buttons: [
      {
        action: 'wpay',
        label: '💰 پرداخت از کیف پول ({balance})',
        placeholders: ['balance'],
        hint: 'فقط وقتی موجودی کیف پول کل مبلغ را پوشش می‌دهد',
        conditional: true,
      },
      {
        action: 'tpo',
        label: '💰 شارژ کیف پول (موجودی: {balance})',
        placeholders: ['balance'],
        hint: 'وقتی موجودی هست ولی کافی نیست — کمبود را شارژ می‌کند',
        conditional: true,
      },
      {
        action: 'paid',
        label: '✅ پرداخت کردم',
        hint: 'تنها راه مشتری برای گفتن اینکه واریز کرده',
        required: true,
      },
      BACK_TO_MENU,
    ],
  },
  afterPaid: {
    label: 'بعد از ثبت پرداخت',
    hint: 'وقتی مشتری «پرداخت کردم» را زده',
    buttons: [BACK_TO_MENU],
  },
  myServices: {
    label: 'سرویس‌های من',
    hint: 'زیر فهرست سرویس‌های مشتری',
    buttons: [BACK_TO_MENU],
  },
  serviceDetail: {
    label: 'جزئیات سرویس',
    hint: 'صفحهٔ یک سرویس و کارهایی که رویش می‌شود کرد',
    buttons: [
      {
        action: 'xv',
        label: '➕ حجم اضافه',
        hint: 'فقط اگر این لوکیشن حجم اضافه می‌فروشد',
        conditional: true,
      },
      {
        action: 'xt',
        label: '⏳ زمان اضافه',
        hint: 'فقط اگر این لوکیشن زمان اضافه می‌فروشد',
        conditional: true,
      },
      {
        action: 'rvk',
        label: '🔄 تغییر لینک اشتراک',
        hint: 'لینک تازه می‌سازد؛ لینک قبلی از کار می‌افتد',
        conditional: true,
      },
      {
        action: 'off',
        label: '⛔ خاموش کردن سرویس',
        hint: 'وقتی سرویس روشن است',
        conditional: true,
      },
      {
        action: 'on',
        label: '💡 روشن کردن سرویس',
        hint: 'به‌جای دکمهٔ بالا، وقتی سرویس خاموش است',
        conditional: true,
      },
      { action: 'mine', label: 'بازگشت به سرویس‌ها ⬅️', hint: 'برگشت به فهرست سرویس‌ها' },
      BACK_TO_MENU,
    ],
  },
  revokeConfirm: {
    label: 'تایید تغییر لینک',
    hint: 'قبل از عوض کردن لینک اشتراک',
    buttons: [
      {
        action: 'rvk2',
        label: '✅ بله، لینک را عوض کن',
        hint: 'تنها راه تایید — بدون آن صفحه بن‌بست است',
        required: true,
      },
      { action: 'sub', label: 'بازگشت ⬅️', hint: 'برگشت به همان سرویس' },
    ],
  },
  renewList: {
    label: 'تمدید — انتخاب سرویس',
    hint: 'زیر فهرست سرویس‌های قابل تمدید',
    buttons: [BACK_TO_MENU],
  },
  renewPlans: {
    label: 'تمدید — انتخاب پلن',
    hint: 'زیر پلن‌هایی که سرویس با آن‌ها تمدید می‌شود',
    buttons: [
      {
        action: 'dsr',
        label: '🏷 کد تخفیف دارم',
        hint: 'وقتی هنوز کدی نگه داشته نشده',
        conditional: true,
      },
      {
        action: 'dxr',
        label: '🏷 برداشتن کد «{code}»',
        placeholders: ['code'],
        hint: 'به‌جای دکمهٔ بالا، وقتی کدی نگه داشته شده',
        conditional: true,
      },
      { action: 'renew', label: 'بازگشت به سرویس‌ها ⬅️', hint: 'برگشت به فهرست تمدید' },
      BACK_TO_MENU,
    ],
  },
  wallet: {
    label: 'کیف پول',
    hint: 'موجودی و آخرین تراکنش‌ها',
    buttons: [
      { action: 'top', label: '💰 افزایش موجودی', hint: 'مبلغ‌های شارژ را نشان می‌دهد' },
      { action: 'gft', label: '🎁 کد هدیه', hint: 'کد هدیه را می‌پرسد' },
      BACK_TO_MENU,
    ],
  },
  topup: {
    label: 'شارژ کیف پول',
    hint: 'زیر مبلغ‌های آمادهٔ شارژ',
    buttons: [{ action: 'wal', label: '🏦 کیف پول', hint: 'برگشت به کیف پول', required: true }],
  },
  help: {
    label: 'آموزش',
    hint: 'زیر فهرست مطالب آموزشی',
    buttons: [
      {
        action: 'app',
        label: '📱 برنامه‌ها',
        hint: 'فقط وقتی برنامه‌ای ثبت شده باشد',
        conditional: true,
      },
      BACK_TO_MENU,
    ],
  },
  referral: {
    label: 'زیرمجموعه‌گیری',
    hint: 'زیر لینک دعوت',
    buttons: [BACK_TO_MENU],
  },
  prompt: {
    label: 'وقتی ربات چیزی می‌پرسد',
    hint: 'زیر پرسش کد تخفیف، کد هدیه، حجم و زمان اضافه، و درخواست نمایندگی',
    buttons: [
      {
        action: 'back',
        label: 'بازگشت ⬅️',
        hint: 'انصراف — مقصدش همان صفحه‌ای است که مشتری از آن آمده',
        required: true,
      },
    ],
  },
  adminHome: {
    label: 'پنل ادمین — خانه',
    hint: 'فقط برای ادمین‌ها',
    buttons: [
      {
        action: 'clm',
        label: '🧾 بررسی پرداخت‌ها',
        hint: 'فقط وقتی پرداختی در انتظار باشد',
        conditional: true,
      },
      BACK_TO_MENU,
    ],
  },
  adminClaims: {
    label: 'پنل ادمین — فهرست پرداخت‌ها',
    hint: 'زیر پرداخت‌های در انتظار بررسی',
    buttons: [
      { action: 'pnl', label: '🛠 پنل ادمین', hint: 'برگشت به خانهٔ پنل', required: true },
    ],
  },
  adminClaimDetail: {
    label: 'پنل ادمین — یک پرداخت',
    hint: 'زیر جزئیات یک پرداخت و تراکنش‌های نامزدش',
    buttons: [
      {
        action: 'apx',
        label: '⚠️ تایید بدون تراکنش',
        hint: 'تسویه فقط با تصمیم ادمین — فقط به ادمینی که این دسترسی را دارد نشان داده می‌شود',
        conditional: true,
      },
      {
        action: 'rej',
        label: '❌ رد کردن',
        hint: 'پرداخت رد می‌شود و مشتری سرویس نمی‌گیرد — فقط با دسترسی رد کردن',
        conditional: true,
      },
      { action: 'clm', label: 'بازگشت ⬅️', hint: 'برگشت به فهرست', required: true },
    ],
  },
  adminConfirm: {
    label: 'پنل ادمین — تاییدیه',
    hint: 'قبل از تایید بدون تراکنش یا رد کردن',
    buttons: [
      {
        action: 'cnf',
        label: 'بله، انجام شود',
        hint: 'تنها راه تایید — بدون آن صفحه بن‌بست است',
        required: true,
      },
      { action: 'clm', label: 'بازگشت ⬅️', hint: 'انصراف' },
    ],
  },
} as const satisfies Record<string, Menu>;

export type MenuId = keyof typeof MENUS;

/** The order the panel lists menus in. */
export const MENU_IDS = Object.keys(MENUS) as MenuId[];

export function isMenuId(id: string): id is MenuId {
  return Object.prototype.hasOwnProperty.call(MENUS, id);
}

/**
 * The main menu's buttons, under the name the first version of this file gave
 * them. Kept because the admin panel and the bot both import it.
 */
export const MENU_ACTIONS: readonly MenuAction[] = MENUS.main.buttons;

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

/**
 * Where each menu's buttons sit by default.
 *
 * The main menu keeps production's grid. Every other menu is one button per
 * row, except the pairs that are already drawn side by side today — the two
 * add-ons on a service, and the two back buttons that end most screens.
 */
const DEFAULT_CELLS: Record<MenuId, ReadonlyArray<readonly [string, number, number]>> = {
  main: [
    ['renew', 0, 0],
    ['buy', 0, 1],
    ['wal', 1, 0],
    ['mine', 1, 1],
    ['sup', 2, 0],
    ['hlp', 2, 1],
    ['ref', 2, 2],
    ['agr', 3, 0],
  ],
  panels: [['menu', 0, 0]],
  plans: [
    ['buy', 0, 0],
    ['menu', 0, 1],
  ],
  planDetail: [
    ['order', 0, 0],
    ['dsc', 1, 0],
    ['dsx', 1, 1],
    ['panel', 2, 0],
    ['menu', 2, 1],
  ],
  checkout: [
    ['wpay', 0, 0],
    ['tpo', 0, 1],
    ['paid', 1, 0],
    ['menu', 2, 0],
  ],
  afterPaid: [['menu', 0, 0]],
  myServices: [['menu', 0, 0]],
  serviceDetail: [
    ['xv', 0, 0],
    ['xt', 0, 1],
    ['rvk', 1, 0],
    ['off', 2, 0],
    ['on', 2, 1],
    ['mine', 3, 0],
    ['menu', 3, 1],
  ],
  revokeConfirm: [
    ['rvk2', 0, 0],
    ['sub', 1, 0],
  ],
  renewList: [['menu', 0, 0]],
  renewPlans: [
    ['dsr', 0, 0],
    ['dxr', 0, 1],
    ['renew', 1, 0],
    ['menu', 1, 1],
  ],
  wallet: [
    ['top', 0, 0],
    ['gft', 1, 0],
    ['menu', 2, 0],
  ],
  topup: [['wal', 0, 0]],
  help: [
    ['app', 0, 0],
    ['menu', 1, 0],
  ],
  referral: [['menu', 0, 0]],
  prompt: [['back', 0, 0]],
  adminHome: [
    ['clm', 0, 0],
    ['menu', 1, 0],
  ],
  adminClaims: [['pnl', 0, 0]],
  adminClaimDetail: [
    ['apx', 0, 0],
    ['rej', 1, 0],
    ['clm', 2, 0],
  ],
  adminConfirm: [
    ['cnf', 0, 0],
    ['clm', 1, 0],
  ],
};

function layoutFor(id: MenuId): readonly ButtonPlacement[] {
  const byAction = new Map(MENUS[id].buttons.map((b) => [b.action, b]));
  return DEFAULT_CELLS[id].map(([action, rowIndex, colIndex]) => ({
    action,
    // Labels come from `MENUS` rather than being repeated, so the default
    // wording has one definition and cannot disagree with itself.
    label: byAction.get(action)!.label,
    rowIndex,
    colIndex,
    visible: true,
  }));
}

/** The layouts the code ships, in the shape the database stores. */
export const DEFAULT_LAYOUTS: Record<MenuId, readonly ButtonPlacement[]> = Object.fromEntries(
  MENU_IDS.map((id) => [id, layoutFor(id)]),
) as Record<MenuId, readonly ButtonPlacement[]>;

/** The main menu's default, under the name the first version of this file used. */
export const DEFAULT_LAYOUT: readonly ButtonPlacement[] = DEFAULT_LAYOUTS.main;

export type LayoutProblem =
  | { kind: 'EMPTY' }
  | { kind: 'UNKNOWN_MENU' }
  | { kind: 'UNKNOWN_ACTION'; actions: string[] }
  | { kind: 'DUPLICATE_ACTION'; actions: string[] }
  | { kind: 'DUPLICATE_CELL' }
  | { kind: 'NOTHING_VISIBLE' }
  | { kind: 'LABEL_EMPTY'; actions: string[] }
  | { kind: 'LABEL_TOO_LONG'; actions: string[]; limit: number }
  | { kind: 'REQUIRED_MISSING'; actions: string[] }
  | { kind: 'REQUIRED_HIDDEN'; actions: string[] }
  | { kind: 'LABEL_MISSING_PLACEHOLDER'; action: string; names: string[] }
  | { kind: 'LABEL_UNKNOWN_PLACEHOLDER'; action: string; names: string[] }
  | { kind: 'LABEL_MARKUP'; actions: string[] };

/** Telegram truncates beyond this and the row stops being readable on a phone. */
export const MAX_LABEL_LENGTH = 64;

/** The slots a label actually uses, deduplicated. */
export function placeholdersInLabel(value: string): string[] {
  return [...new Set([...value.matchAll(PLACEHOLDER)].map((m) => m[1] as string))].sort();
}

/**
 * Whether a layout may be saved.
 *
 * Two refusals matter most. `NOTHING_VISIBLE` catches a keyboard with every
 * button hidden — a customer left with no way forward and no way back, fixable
 * only by an admin who realises what they did. `REQUIRED_MISSING` catches the
 * subtler version: the screen still has buttons, just not the one it exists
 * for. Refusing both costs a confused click; allowing them costs a shop its
 * bot.
 */
export function checkLayout(menuId: string, buttons: ButtonPlacement[]): LayoutProblem | null {
  if (!isMenuId(menuId)) return { kind: 'UNKNOWN_MENU' };
  if (buttons.length === 0) return { kind: 'EMPTY' };

  // Widened on purpose: `as const` narrows each entry to its own literal type,
  // and the optional fields simply do not exist on the ones that omit them.
  const declared: readonly MenuAction[] = MENUS[menuId].buttons;
  const known = new Map(declared.map((b) => [b.action, b]));

  const unknown = buttons.filter((b) => !known.has(b.action)).map((b) => b.action);
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

  // The text path has checked this since custom emoji shipped; this one had
  // nothing, so a label carrying `<tg-emoji …>` saved with a 200 and every
  // customer then read the raw tag off the button.
  //
  // `false`, unconditionally, rather than taking the shop's switch as an
  // argument like `checkOverride` does. An inline button's `text` is plain in
  // the Bot API — no entities, nothing to set `parse_mode` on — so the markup
  // cannot render there whatever the shop has switched on. Passing the switch
  // in would imply there is a setting that makes it work.
  const marked = buttons
    .filter((b) => checkCustomEmoji(b.label, false) !== null)
    .map((b) => b.action);
  if (marked.length > 0) return { kind: 'LABEL_MARKUP', actions: marked };

  // A label carries a value or it does not. Dropping `{balance}` from the
  // wallet button leaves the customer guessing whether it covers the order;
  // inventing a slot ships the literal characters to them.
  for (const b of buttons) {
    const required = [...(known.get(b.action)?.placeholders ?? [])].sort();
    const used = placeholdersInLabel(b.label);
    const missing = required.filter((p) => !used.includes(p));
    if (missing.length > 0) {
      return { kind: 'LABEL_MISSING_PLACEHOLDER', action: b.action, names: missing };
    }
    const extra = used.filter((p) => !required.includes(p));
    if (extra.length > 0) {
      return { kind: 'LABEL_UNKNOWN_PLACEHOLDER', action: b.action, names: extra };
    }
  }

  const requiredActions = declared.filter((b) => b.required).map((b) => b.action);
  const absent = requiredActions.filter((a) => !seen.has(a));
  if (absent.length > 0) return { kind: 'REQUIRED_MISSING', actions: absent };
  const hidden = buttons.filter((b) => !b.visible && requiredActions.includes(b.action));
  if (hidden.length > 0) {
    return { kind: 'REQUIRED_HIDDEN', actions: hidden.map((b) => b.action) };
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

export function isMenuAction(menuId: MenuId, action: string): boolean {
  return MENUS[menuId].buttons.some((b) => b.action === action);
}
