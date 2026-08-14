/**
 * Every sentence an admin may rewrite, and every button they may move.
 *
 * The defaults live here, in the source, and the database holds only overrides.
 * That ordering is the whole safety property: a bot whose `bot_texts` table is
 * empty — or unreachable, or truncated by a careless hand — says exactly what it
 * says today. There is no state in which a customer sees a blank screen because
 * a row went missing.
 *
 * ## The placeholder contract
 *
 * A text may carry named slots, written `{name}`. `supportScreen` is the live
 * example: its `{handle}` is the only way a customer learns who to message. An
 * admin who rewrites that sentence and drops the slot has not made a wording
 * change, they have removed the information — and nothing about the result
 * looks broken, which is why it has to be refused rather than warned about.
 *
 * So every entry declares its placeholders and `checkOverride` requires the
 * replacement to use exactly that set. Not a subset, because a missing slot
 * loses data; not a superset, because `{balance}` in a text that is never given
 * a balance renders as the literal characters to the customer.
 *
 * Most entries declare none. They are ordinary sentences and the check reduces
 * to "you did not invent a slot", which is still worth having: `{name}` typed
 * hopefully into the welcome message would otherwise ship as `{name}`.
 *
 * ## What is not here
 *
 * The screens built by interpolation in `menu.ts` — the checkout, the finished
 * service, the invoice — are still code. They assemble conditional lines around
 * their values rather than filling slots in a sentence, so exposing them would
 * mean exposing a template language, and a shop's wording is not worth an
 * evaluator that can fail at send time. `supportScreen` is included because it
 * genuinely is one sentence with one slot.
 */

/** A slot in a text, as an admin writes it. */
const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

export interface TextEntry {
  /** What the bot says when nobody has overridden it. */
  default: string;
  /** Slots the override must use, exactly. */
  placeholders: readonly string[];
  /** The section this appears in, for the admin screen. */
  group: TextGroup;
  /** When and where the customer sees it. */
  hint: string;
}

export type TextGroup =
  | 'welcome'
  | 'buy'
  | 'services'
  | 'renew'
  | 'wallet'
  | 'discount'
  | 'support'
  | 'reseller'
  | 'errors';

/**
 * The catalogue.
 *
 * Every default here is the string that was in `menu.ts`, moved rather than
 * retyped — the wording is production's, arrived at over a long time, and this
 * change is about who can edit it, not about what it says.
 */
export const TEXTS = {
  WELCOME: {
    default: 'به شیکو خوش آمدید 👋\n\nاز منوی زیر انتخاب کنید.',
    placeholders: [],
    group: 'welcome',
    hint: 'اولین پیام بعد از /start',
  },
  MENU_TITLE: {
    default: 'منوی اصلی — چه کاری برایتان انجام دهم؟',
    placeholders: [],
    group: 'welcome',
    hint: 'بالای منوی اصلی',
  },
  NOT_REGISTERED: {
    default: 'برای شروع لطفاً /start را بزنید.',
    placeholders: [],
    group: 'welcome',
    hint: 'وقتی کاربر بدون /start دکمه‌ای می‌زند',
  },
  SOON: {
    default: 'این بخش هنوز آماده نیست. به‌زودی 🙏',
    placeholders: [],
    group: 'errors',
    hint: 'بخشی که هنوز ساخته نشده',
  },
  BACK_TO_MENU_LABEL: {
    default: 'بازگشت به منو ⬅️',
    placeholders: [],
    group: 'welcome',
    hint: 'دکمهٔ بازگشت در همهٔ صفحه‌ها',
  },

  // --- خرید ---------------------------------------------------------------
  CHOOSE_PANEL: {
    default: '📌 لوکیشن سرویس را انتخاب کنید.',
    placeholders: [],
    group: 'buy',
    hint: 'فهرست لوکیشن‌ها',
  },
  CHOOSE_PLAN: {
    default: '🛍 سرویس مورد نظرتان را انتخاب کنید.',
    placeholders: [],
    group: 'buy',
    hint: 'فهرست پلن‌های یک لوکیشن',
  },
  PANEL_EMPTY: {
    default: 'در حال حاضر محصولی روی این لوکیشن موجود نیست.',
    placeholders: [],
    group: 'buy',
    hint: 'لوکیشنی که پلن فروختنی ندارد',
  },
  SHOP_EMPTY: {
    default: 'در حال حاضر سرویسی برای فروش موجود نیست. کمی بعد دوباره سر بزنید.',
    placeholders: [],
    group: 'buy',
    hint: 'وقتی هیچ چیزی برای فروش نیست',
  },
  PLAN_GONE: {
    default: 'این سرویس در دسترس شما نیست. لطفاً از منوی خرید دوباره انتخاب کنید.',
    placeholders: [],
    group: 'buy',
    hint: 'پلنی که حذف یا پنهان شده',
  },
  ORDER_GONE: {
    default: 'این سفارش پیدا نشد. لطفاً از منوی خرید دوباره اقدام کنید.',
    placeholders: [],
    group: 'buy',
    hint: 'سفارشی که دیگر وجود ندارد',
  },
  NO_CARD_AVAILABLE: {
    default:
      'در حال حاضر امکان دریافت شمارهٔ کارت نیست. لطفاً چند دقیقهٔ دیگر دوباره تلاش کنید یا به پشتیبانی پیام دهید.',
    placeholders: [],
    group: 'buy',
    hint: 'وقتی همهٔ کارت‌ها غیرفعال یا مشغول‌اند',
  },
  ORDER_NOT_PAYABLE: {
    default:
      'مبلغ این سفارش با تخفیف شما صفر می‌شود و ثبتش ممکن نیست. لطفاً به پشتیبانی پیام دهید.',
    placeholders: [],
    group: 'buy',
    hint: 'وقتی تخفیف ثابت مشتری یا کد تخفیف، مبلغ را به صفر می‌رساند',
  },

  // --- سرویس‌های من --------------------------------------------------------
  MY_SERVICES_EMPTY: {
    default:
      'هنوز سرویسی ندارید.\n\nاز دکمهٔ «خرید اشتراک» می‌توانید اولین سرویس‌تان را بگیرید.',
    placeholders: [],
    group: 'services',
    hint: 'کاربری که هیچ سرویسی ندارد',
  },
  SERVICE_GONE: {
    default: 'این سرویس پیدا نشد. لطفاً از فهرست سرویس‌ها دوباره انتخاب کنید.',
    placeholders: [],
    group: 'services',
    hint: 'سرویسی که دیگر نیست',
  },
  ACTION_UNSUPPORTED: {
    default:
      'این سرویس به‌صورت دستی آماده شده و از این طریق قابل تغییر نیست. لطفاً به پشتیبانی پیام دهید.',
    placeholders: [],
    group: 'services',
    hint: 'سرویس دستی که دکمه‌های پنل رویش کار نمی‌کند',
  },
  CONFIRM_REVOKE: {
    default:
      '⚠️ لینک اشتراک این سرویس عوض می‌شود.\n\nلینک فعلی از کار می‌افتد و باید لینک جدید را روی همهٔ دستگاه‌هایتان دوباره وارد کنید.\nحجم و تاریخ سرویس دست‌نخورده می‌ماند.',
    placeholders: [],
    group: 'services',
    hint: 'تایید تغییر لینک اشتراک',
  },
  ADDON_NOT_A_NUMBER: {
    default: 'لطفاً فقط یک عدد بفرستید — مثلاً 5. برای انصراف /start را بزنید.',
    placeholders: [],
    group: 'services',
    hint: 'وقتی برای حجم یا زمان اضافه عدد نفرستاده',
  },

  // --- تمدید ---------------------------------------------------------------
  NOTHING_TO_RENEW: {
    default:
      'سرویسی برای تمدید ندارید.\n\nاگر سرویس فعالی دارید و اینجا نمی‌بینید، به پشتیبانی پیام دهید.',
    placeholders: [],
    group: 'renew',
    hint: 'کاربری که سرویس قابل تمدید ندارد',
  },
  CHOOSE_SERVICE_TO_RENEW: {
    default: '♻️ کدام سرویس را تمدید می‌کنید؟',
    placeholders: [],
    group: 'renew',
    hint: 'فهرست سرویس‌ها برای تمدید',
  },
  RENEWAL_GONE: {
    default: 'این سرویس قابل تمدید نیست. لطفاً از فهرست تمدید دوباره انتخاب کنید.',
    placeholders: [],
    group: 'renew',
    hint: 'سرویسی که دیگر قابل تمدید نیست',
  },
  RENEWAL_CLOSED: {
    default:
      'تمدید روی لوکیشن این سرویس فعال نیست.\n\nمی‌توانید از بخش «خرید اشتراک» سرویس جدیدی بگیرید یا به پشتیبانی پیام دهید.',
    placeholders: [],
    group: 'renew',
    hint: 'پنلی که تمدید رویش خاموش است',
  },
  NO_RENEWAL_PLAN: {
    default:
      'در حال حاضر پلنی برای تمدید این سرویس موجود نیست.\n\nلطفاً کمی بعد دوباره امتحان کنید یا به پشتیبانی پیام دهید.',
    placeholders: [],
    group: 'renew',
    hint: 'وقتی پلن تمدیدی موجود نیست',
  },

  // --- کیف پول -------------------------------------------------------------
  WALLET_TOO_LITTLE: {
    default: 'موجودی کیف پول شما برای این خرید کافی نیست. اول کیف پول را شارژ کنید.',
    placeholders: [],
    group: 'wallet',
    hint: 'موجودی کمتر از مبلغ سفارش',
  },
  ASK_GIFT_CODE: {
    default: '🎁 کد هدیه را بفرستید.',
    placeholders: [],
    group: 'wallet',
    hint: 'درخواست کد هدیه',
  },

  // --- کد تخفیف ------------------------------------------------------------
  ASK_DISCOUNT_CODE: {
    default: '🏷 کد تخفیف را بفرستید.\n\nاگر پشیمان شدید، دکمهٔ بازگشت را بزنید.',
    placeholders: [],
    group: 'discount',
    hint: 'درخواست کد تخفیف',
  },
  DISCOUNT_TAKEN_OFF: {
    default: 'کد تخفیف برداشته شد.',
    placeholders: [],
    group: 'discount',
    hint: 'بعد از برداشتن کد',
  },

  // --- پشتیبانی و آموزش ----------------------------------------------------
  SUPPORT_SCREEN: {
    default:
      '☎️ پشتیبانی\n\nبرای گفتگو با پشتیبانی به @{handle} پیام بدهید.\n\n🔖 اگر دربارهٔ یک سفارش است، شمارهٔ سفارش را هم بفرستید.',
    // The one live slot. Without it the customer is told to contact support and
    // not told who — a screen that looks complete and is useless.
    placeholders: ['handle'],
    group: 'support',
    hint: 'صفحهٔ پشتیبانی — {handle} آیدی پشتیبانی است',
  },
  SUPPORT_UNAVAILABLE: {
    default: 'راه ارتباط با پشتیبانی هنوز تنظیم نشده است. کمی بعد دوباره امتحان کنید.',
    placeholders: [],
    group: 'support',
    hint: 'وقتی آیدی پشتیبانی تنظیم نشده',
  },
  CHOOSE_HELP: {
    default: '📚 آموزش — یک مورد را انتخاب کنید.',
    placeholders: [],
    group: 'support',
    hint: 'فهرست مطالب آموزشی',
  },
  HELP_EMPTY: {
    default: 'هنوز مطلب آموزشی ثبت نشده است.',
    placeholders: [],
    group: 'support',
    hint: 'وقتی مطلب آموزشی نیست',
  },
  APPS_EMPTY: {
    default: 'هنوز برنامه‌ای ثبت نشده است.',
    placeholders: [],
    group: 'support',
    hint: 'وقتی برنامه‌ای ثبت نشده',
  },

  // --- نمایندگی ------------------------------------------------------------
  ASK_RESELLER_REQUEST: {
    default:
      '👨‍💻 درخواست نمایندگی\n\nدر یک پیام بنویسید چه می‌فروشید، چند مشتری دارید، و چرا نمایندگی می‌خواهید.\nهمین پیام برای ادمین فرستاده می‌شود.',
    placeholders: [],
    group: 'reseller',
    hint: 'درخواست توضیح از متقاضی نمایندگی',
  },
  RESELLER_REQUEST_FILED: {
    default: '✅ درخواست شما ثبت شد.\n\nبعد از بررسی، نتیجه همین‌جا به شما اطلاع داده می‌شود.',
    placeholders: [],
    group: 'reseller',
    hint: 'بعد از ثبت درخواست',
  },
  RESELLER_REQUEST_OPEN: {
    default:
      '🕓 درخواست شما ثبت شده و در حال بررسی است. تا اعلام نتیجه، درخواست تازه لازم نیست.',
    placeholders: [],
    group: 'reseller',
    hint: 'وقتی درخواست باز دارد',
  },
  RESELLER_REQUEST_EMPTY: {
    default: 'لطفاً توضیح‌تان را در یک پیام متنی بفرستید.',
    placeholders: [],
    group: 'reseller',
    hint: 'وقتی متن درخواست خالی است',
  },
  ALREADY_RESELLER: {
    default: '✅ شما از قبل نماینده هستید.',
    placeholders: [],
    group: 'reseller',
    hint: 'وقتی از قبل نماینده است',
  },
  REFERRAL_WELCOME: {
    default: '👥 شما با لینک دعوت یکی از کاربران وارد شدید.',
    placeholders: [],
    group: 'reseller',
    hint: 'ورود با لینک دعوت',
  },
} as const satisfies Record<string, TextEntry>;

export type TextKey = keyof typeof TEXTS;

export const TEXT_KEYS = Object.keys(TEXTS) as TextKey[];

export function isTextKey(key: string): key is TextKey {
  return Object.prototype.hasOwnProperty.call(TEXTS, key);
}

/** The slots a string actually uses, deduplicated and in no particular order. */
export function placeholdersIn(value: string): string[] {
  return [...new Set([...value.matchAll(PLACEHOLDER)].map((m) => m[1] as string))].sort();
}

export type OverrideProblem =
  | { kind: 'UNKNOWN_KEY' }
  | { kind: 'EMPTY' }
  | { kind: 'TOO_LONG'; limit: number }
  | { kind: 'MISSING_PLACEHOLDER'; names: string[] }
  | { kind: 'UNKNOWN_PLACEHOLDER'; names: string[] };

/** Telegram refuses a message body longer than this, so the bot would fail to
 *  answer at all rather than answer badly. */
export const MAX_TEXT_LENGTH = 4096;

/**
 * Whether this replacement may be stored, and what is wrong with it if not.
 *
 * Returns null when the override is acceptable. Pure, so the admin API and the
 * bot can reach the same verdict without either calling the other.
 */
export function checkOverride(key: string, value: string): OverrideProblem | null {
  if (!isTextKey(key)) return { kind: 'UNKNOWN_KEY' };
  if (value.trim() === '') return { kind: 'EMPTY' };
  if (value.length > MAX_TEXT_LENGTH) return { kind: 'TOO_LONG', limit: MAX_TEXT_LENGTH };

  // Widened on purpose: `as const` makes this a union of literal tuples, and
  // the comparison below is against slots an admin typed, which are plain
  // strings.
  const required: string[] = [...TEXTS[key].placeholders].sort();
  const used = placeholdersIn(value);
  const missing = required.filter((p) => !used.includes(p));
  if (missing.length > 0) return { kind: 'MISSING_PLACEHOLDER', names: missing };
  const unknown = used.filter((p) => !required.includes(p));
  if (unknown.length > 0) return { kind: 'UNKNOWN_PLACEHOLDER', names: unknown };
  return null;
}

/**
 * The bot's view of the texts: overrides on top of defaults.
 *
 * An override that fails `checkOverride` is ignored rather than rendered. It
 * should be impossible — the write path refuses it — but the row could have been
 * written by hand, and the customer must not be the one who finds out.
 */
export class Texts {
  private readonly overrides: Partial<Record<TextKey, string>>;

  constructor(overrides: Record<string, string> = {}) {
    const kept: Partial<Record<TextKey, string>> = {};
    for (const [key, value] of Object.entries(overrides)) {
      if (isTextKey(key) && checkOverride(key, value) === null) kept[key] = value;
    }
    this.overrides = kept;
  }

  /** The raw text, with slots still in it. */
  raw(key: TextKey): string {
    return this.overrides[key] ?? TEXTS[key].default;
  }

  /**
   * The text with its slots filled.
   *
   * A slot with no value is left as written rather than replaced with an empty
   * string: `@` on its own reads as a broken screen, `{handle}` reads as a
   * misconfiguration, and only one of those gets reported.
   */
  render(key: TextKey, values: Record<string, string | number> = {}): string {
    return this.raw(key).replace(PLACEHOLDER, (whole, name: string) =>
      name in values ? String(values[name]) : whole,
    );
  }
}

/** The texts as the code ships them — used wherever no database is in reach. */
export const DEFAULT_TEXTS = new Texts();
