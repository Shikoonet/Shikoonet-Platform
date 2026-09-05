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

import { checkCustomEmoji, stripCustomEmoji } from './customEmoji.js';

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
      {
        action: 'tar',
        label: '📋 تعرفه سرویس‌ها',
        hint: 'فهرست قیمت همهٔ سرویس‌ها در یک پیام — بدون رفتن داخل مسیر خرید',
      },
      {
        action: 'tst',
        label: '🎁 سرویس تست رایگان',
        hint: 'یک اکانت رایگان و کوتاه. حجم و زمانش را هر پنل خودش تعیین می‌کند و سهمیهٔ هر کاربر در «تنظیمات» است',
      },
      { action: 'wal', label: '🏦 کیف پول + شارژ', hint: 'کیف پول و شارژ آن' },
      { action: 'mine', label: '🛍 سرویس های من', hint: 'فهرست سرویس‌های کاربر' },
      { action: 'sup', label: '☎️ پشتیبانی', hint: 'صفحهٔ پشتیبانی' },
      { action: 'hlp', label: '📚 آموزش', hint: 'مطالب آموزشی' },
      { action: 'ref', label: '👥 زیر مجموعه گیری', hint: 'لینک دعوت و پورسانت' },
      {
        action: 'emj',
        label: '🎨 ایموجی پریمیوم',
        hint: 'فقط ادمین‌ها می‌بینند — افزودن ایموجی پریمیوم و گذاشتنش روی دکمه‌ها',
      },
      {
        action: 'agr',
        label: '👨‍💻 درخواست نمایندگی',
        hint: 'فقط به کاربران غیرنماینده نشان داده می‌شود',
      },
    ],
  },
  gateChannels: {
    label: 'عضویت اجباری کانال',
    hint: 'وقتی کاربر عضو کانال‌های اجباری نیست — دکمهٔ خود کانال‌ها بالای این‌ها می‌آید',
    buttons: [
      {
        action: 'chk',
        label: '✅ عضو شدم',
        hint: 'دوباره از تلگرام می‌پرسد — تنها راه رد شدن از این صفحه',
        required: true,
      },
    ],
  },
  gateRules: {
    label: 'پذیرش قوانین',
    hint: 'تا وقتی کاربر قوانین را نپذیرفته، تنها صفحه‌ای است که می‌بیند',
    buttons: [
      {
        action: 'acc',
        label: '✅ قوانین را می‌پذیرم',
        hint: 'تنها راه رد شدن از این صفحه — بدون آن ربات برای کاربر بن‌بست است',
        required: true,
      },
    ],
  },
  trial: {
    label: 'انتخاب لوکیشن سرویس تست',
    hint: 'فقط وقتی بیش از یک پنل سرویس تست می‌دهد',
    buttons: [BACK_TO_MENU],
  },
  categories: {
    label: 'فهرست دسته‌بندی‌ها',
    hint: 'اولین صفحهٔ خرید — دسته‌هایی که چیزی برای فروش دارند',
    buttons: [BACK_TO_MENU],
  },
  products: {
    label: 'فهرست سرویس‌های یک دسته‌بندی',
    // Live again since 2026-08-27. It was «صفحهٔ قدیمی» for as long as the only
    // way here was a `prd:` button left in an old chat; the shop now opens it
    // from a category, which is the level it was built for.
    hint: 'سرویس‌های یک دسته‌بندی — پلاتینیوم، طلایی، معمولی. صفحهٔ دوم خرید، وقتی دسته‌بندی بیش از یک سرویس دارد',
    buttons: [
      { action: 'buy', label: 'بازگشت به دسته‌بندی‌ها ⬅️', hint: 'برگشت به فهرست دسته‌بندی‌ها' },
      BACK_TO_MENU,
    ],
  },
  plans: {
    label: 'فهرست قیمت‌های یک سرویس',
    hint: 'کانفیگ‌های خریدنیِ یک سرویس، با قیمتشان روی دکمه — صفحهٔ سوم خرید',
    buttons: [
      // `buy` is the CATEGORY list now, so one step back is one action. The
      // label said «سرویس‌ها» while this screen was one service's plans; the
      // screen changed underneath it on 2026-08-27 and the word did not.
      { action: 'buy', label: 'بازگشت به دسته‌بندی‌ها ⬅️', hint: 'برگشت به فهرست دسته‌بندی‌ها' },
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
      // One step back, wherever that is. A service with several plans came via
      // its plan list and goes back to it; a service with a single plan never
      // drew one, so it goes back to the service list instead. Same button,
      // because "back" is one idea and giving it two rows is how a screen ends
      // up with two buttons that both say بازگشت.
      { action: 'buy', label: 'بازگشت ⬅️', hint: 'برگشت به پلن‌ها یا فهرست سرویس‌ها' },
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
        action: 'qr',
        label: '📷 دریافت QR Code',
        hint: 'همان لینک اشتراک به‌صورت عکس، برای اسکن با دوربین برنامه',
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
    buttons: [
      {
        action: 'tpx',
        label: '✏️ مبلغ دلخواه',
        hint: 'مشتری مبلغ را خودش تایپ می‌کند — بین کف و سقف شارژ',
      },
      { action: 'wal', label: '🏦 کیف پول', hint: 'برگشت به کیف پول', required: true },
    ],
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

/**
 * Buttons only an admin ever sees.
 *
 * The rule this file's own docstring has described since it was written — «hide
 * «پنل مدیریت» from everyone else» — and never implemented. `MenuViewer` has
 * carried `is_admin` the whole time and nothing read it.
 *
 * `emj` is the first entry: the screen where an admin gives the bot a premium
 * emoji by sending it. It is hidden rather than merely useless to a customer,
 * because a button that answers «شما ادمین نیستید» is a button that tells every
 * customer an admin surface exists.
 *
 * Hiding is NOT the guard. `handleCallback` re-checks `is_admin` before it acts,
 * because `callback_data` is unsigned and anybody can post `emj`.
 */
export const ADMIN_ONLY: ReadonlySet<string> = new Set(['emj']);

/** Buttons that some viewers never see, whoever they are. */
const AUDIENCE_LIMITED: ReadonlySet<string> = new Set([...RESELLER_ONLY_HIDDEN, ...ADMIN_ONLY]);

export interface ButtonPlacement {
  action: string;
  label: string;
  rowIndex: number;
  colIndex: number;
  visible: boolean;
  /**
   * The whole button's colour — Bot API 9.4's `style`, or null for the
   * client's own default.
   *
   * The same three names `product_categories.button_style` uses, because they
   * are Telegram's and there is nothing to translate. A shop colours «خرید
   * اشتراک» green and «بازگشت» red on the same screen, so it belongs to the
   * placement rather than to the action: the same `back` action is chrome on
   * eleven keyboards and a shop may want it to read differently on each.
   */
  style: ButtonStyle | null;
}

/** Telegram's three, spelled as 0034's CHECK and 0036's spell them. */
export type ButtonStyle = 'primary' | 'success' | 'danger';

export const BUTTON_STYLES: readonly ButtonStyle[] = ['primary', 'success', 'danger'];

export function isButtonStyle(value: unknown): value is ButtonStyle {
  return typeof value === 'string' && (BUTTON_STYLES as readonly string[]).includes(value);
}

/**
 * Where each menu's buttons sit and which colour they use by default.
 *
 * The main menu keeps production's grid. Every other menu is one button per
 * row, except the pairs that are already drawn side by side today — the two
 * add-ons on a service, and the two back buttons that end most screens. The
 * optional fourth cell is Telegram's button style; almost every button keeps
 * the client's own colour, while a small number of primary actions name theirs
 * explicitly.
 */
const DEFAULT_CELLS: Record<
  MenuId,
  ReadonlyArray<readonly [string, number, number, ButtonStyle?]>
> = {
  main: [
    ['renew', 0, 0],
    ['buy', 0, 1],
    ['wal', 1, 0],
    ['mine', 1, 1],
    ['sup', 2, 0],
    ['hlp', 2, 1],
    ['ref', 2, 2],
    ['agr', 3, 0],
    /*
     * LAST, and not where a free account deserves to be.
     *
     * The four rows above are `setting.keyboardmain` from the production dump,
     * in order, and `menu.test.ts` asserts them with a comment saying why:
     * customers have this muscle memory and the replacement must not move
     * their buttons. A new row anywhere else pushes «کیف پول» or «پشتیبانی»
     * onto a different line for eleven thousand people who have not asked for
     * anything to change.
     *
     * Appending costs nothing today either: every production panel is
     * `OFFTestAccount`, so this button answers «سرویس تستی فعال نیست» until an
     * admin turns one on — and the admin who turns it on can drag it to the
     * top in «چیدمان کیبورد», which is the screen that exists for this.
     */
    ['tst', 4, 0],
    /*
     * Last, and for a stronger version of the reason above: nobody but an admin
     * sees it at all. `ADMIN_ONLY` drops it for everybody else and `buildMenu`
     * closes the row up, so a customer's menu is byte-for-byte the one they had
     * before this button existed.
     */
    ['emj', 5, 0],
    /*
     * Appended for the same reason `tst` was, and it is worth reading that
     * comment first: the four rows above are `setting.keyboardmain` from the
     * production dump and moving them moves buttons under eleven thousand
     * thumbs. A price list is genuinely useful high up — the shop we copied it
     * from has it third — and «چیدمان کیبورد» is the screen for saying so.
     *
     * A shop that has ALREADY saved a layout will not see this button at all:
     * `readLayouts` replaces the shipped menu with the saved one rather than
     * merging, so a new default row reaches only shops that never customised.
     * That is the existing rule and not something this button changes; it is
     * written down here because the next person to add one will wonder why
     * theirs did not appear on staging.
     */
    ['tar', 6, 0],
  ],
  gateChannels: [['chk', 0, 0]],
  gateRules: [['acc', 0, 0]],
  trial: [['menu', 0, 0]],
  categories: [['menu', 0, 0]],
  // Two buttons since 2026-08-27, when this became a screen the shop actually
  // draws again: it is now the SERVICE list inside a category, so «back» has a
  // level above it to return to. It kept a lone «منو» for as long as the only
  // way here was a `panel:` button left in an old chat, where there was no
  // category to go back to.
  products: [
    ['buy', 0, 0],
    ['menu', 0, 1],
  ],
  plans: [
    ['buy', 0, 0],
    ['menu', 0, 1],
  ],
  planDetail: [
    ['order', 0, 0],
    ['dsc', 1, 0],
    ['dsx', 1, 1],
    ['buy', 2, 0],
    ['menu', 2, 1],
  ],
  // «پرداخت کردم» owns the final row and is green: it is the primary action on
  // an invoice, and sharing its row made it half the size of the wallet top-up
  // immediately above it. There is no inline «بازگشت» here any more; the
  // persistent keyboard below the chat is the one navigation control.
  //
  // The copy row is NOT in this layout and is not removable from it — it is
  // drawn above the chrome by `checkoutMenu`, because sixteen digits retyped by
  // eye is how money reaches somebody else's account.
  checkout: [
    ['wpay', 0, 0],
    ['tpo', 0, 1],
    ['paid', 1, 0, 'success'],
  ],
  afterPaid: [['menu', 0, 0]],
  myServices: [['menu', 0, 0]],
  serviceDetail: [
    ['xv', 0, 0],
    ['xt', 0, 1],
    ['qr', 1, 0],
    ['rvk', 2, 0],
    ['off', 3, 0],
    ['on', 3, 1],
    ['mine', 4, 0],
    ['menu', 4, 1],
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
  topup: [
    ['tpx', 0, 0],
    ['wal', 1, 0],
  ],
  help: [
    ['app', 0, 0],
    ['menu', 1, 0],
  ],
  referral: [['menu', 0, 0]],
  prompt: [['back', 0, 0]],
};

function layoutFor(id: MenuId): readonly ButtonPlacement[] {
  const byAction = new Map(MENUS[id].buttons.map((b) => [b.action, b]));
  return DEFAULT_CELLS[id].map(([action, rowIndex, colIndex, style]) => ({
    action,
    // Labels come from `MENUS` rather than being repeated, so the default
    // wording has one definition and cannot disagree with itself.
    label: byAction.get(action)!.label,
    rowIndex,
    colIndex,
    visible: true,
    style: style ?? null,
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

/**
 * A label's length as everything that measures it counts.
 *
 * Two decisions, and both were wrong once before this existed:
 *
 * **Stripped.** The cap is about one line on a phone, and markup is not on the
 * screen. A `<tg-emoji>` tag is fifty-two characters that draw as one glyph.
 *
 * **Code points, not UTF-16 units.** `'🔥'.length` is 2 in JavaScript and
 * `length('🔥')` is 1 in Postgres, so a plain `.length` here is stricter than
 * the CHECK constraint that has the last word — the panel would refuse a label
 * the database would have taken, and only for labels with emoji in them, which
 * is most of this shop's. Spreading the string counts what Postgres counts.
 *
 * One function, because three layers ask this question — `checkLayout`, the
 * bot's own writer, and migration 0053 — and a version of this commit shipped
 * with them disagreeing.
 */
export function renderedLabelLength(label: string): number {
  return [...stripCustomEmoji(label)].length;
}

/**
 * Whether a label's custom-emoji markup is something a button can draw.
 *
 * True means «refuse». One tag, at the very front, well formed: that is the
 * shape `keyboardFor` turns into `icon_custom_emoji_id`, and it is the only
 * shape a button has anywhere to put.
 *
 * Exported so the bot's own admin screen can ask the same question before it
 * writes a label — one rule, two callers, rather than a second spelling of it
 * next to the thing that writes.
 */
export function labelMarkupProblem(label: string): boolean {
  if (!label.includes('<tg-emoji')) return false;
  // Well formed at all? `true` for the switch here rather than `false`: this
  // function is about SHAPE, and «the shop has the feature off» is a different
  // refusal that belongs to the screen doing the saving.
  if (checkCustomEmoji(label, true) !== null) return true;
  // Exactly one, and at the front. `stripCustomEmoji` on the remainder tells us
  // whether a second one is hiding further along.
  const leading = /^\s*<tg-emoji\s+emoji-id="\d{1,24}">[^<>]{1,16}<\/tg-emoji>/.exec(label);
  if (!leading) return true;
  return label.slice(leading[0].length).includes('<tg-emoji');
}

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

  // Measured on the label as DRAWN, not as written.
  //
  // The cap is about a phone screen — a button label is one line, shared with
  // nothing — and markup is not on the screen. A `<tg-emoji>` tag is fifty-two
  // characters that draw as one glyph, so counting it would refuse
  // «🔥 خرید اشتراک» for being too long while a plainly longer label saves.
  const long = buttons
    .filter((b) => renderedLabelLength(b.label) > MAX_LABEL_LENGTH)
    .map((b) => b.action);
  if (long.length > 0) {
    return { kind: 'LABEL_TOO_LONG', actions: long, limit: MAX_LABEL_LENGTH };
  }

  // A tag at the START of a label is allowed; anywhere else is not.
  //
  // ## This rule was the opposite of itself for a day, and that is worth saying
  //
  // It used to refuse markup on a label unconditionally, and the reasoning was
  // sound when it was written: an inline button's `text` is plain in the Bot
  // API, so a tag could only ever reach the customer as literal angle brackets.
  //
  // Then `icon_custom_emoji_id` was added to the SEND path (2026-09-03) — a
  // field on the button itself that draws one custom emoji at the label's
  // leading edge — and this check was not moved with it. The result was a
  // feature that could be drawn and could not be saved: the bot knew how to put
  // an emoji on a button and the panel answered «LABEL_MARKUP» to every attempt
  // to give it one. Nothing was broken; the two halves simply disagreed, which
  // is worse, because each half looks right on its own.
  //
  // What is still refused, and why:
  //
  //   * a tag anywhere but the front — the button has ONE icon slot, so a
  //     second emoji has nowhere to render and would be silently dropped;
  //   * a malformed tag — `checkCustomEmoji` decides that, and the admin hears
  //     about it at save time rather than from a customer.
  //
  // `false` for the switch stays, and now means something narrower than it did:
  // whether the SHOP has custom emoji on is a question for the send path, which
  // strips the tag and draws the fallback glyph when it is off. A layout saved
  // while the feature was off must still be the same layout when it is on.
  const marked = buttons.filter((b) => labelMarkupProblem(b.label)).map((b) => b.action);
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
  // still empty for them, so `agr` alone visible would strand every reseller —
  // and `agr` plus «پنل مدیریت» would strand every ordinary customer, who is
  // neither. Judged against the union rather than against either list, because
  // the question is whether *somebody* is left with a blank screen.
  //
  // On `main` only, because that is the one keyboard whose audience varies —
  // `buildMainMenu` is where both rules are consulted. An action name does not
  // carry the rule with it: `pnl` on the claims list is the way back to the
  // panel, on a screen only an admin ever reaches, and judging it by the main
  // menu's rule would refuse the layout this file itself ships.
  const visible = buttons.filter((b) => b.visible);
  if (visible.length === 0) return { kind: 'NOTHING_VISIBLE' };
  if (menuId === 'main' && visible.every((b) => AUDIENCE_LIMITED.has(b.action))) {
    return { kind: 'NOTHING_VISIBLE' };
  }
  return null;
}

export function isMenuAction(menuId: MenuId, action: string): boolean {
  return MENUS[menuId].buttons.some((b) => b.action === action);
}
