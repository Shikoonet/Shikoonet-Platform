/**
 * Every sentence an admin may rewrite.
 *
 * The defaults live here, in the source, and the database holds only overrides.
 * That ordering is the whole safety property: a bot whose `bot_texts` table is
 * empty — or unreachable, or truncated by a careless hand — says exactly what it
 * says today. There is no state in which a customer sees a blank screen because
 * a row went missing.
 *
 * ## Lines, not pages
 *
 * A screen is not one entry. It is a list of lines, each a plain sentence with
 * its slots declared, and the code decides *which* lines appear. That split is
 * deliberate and it is the whole design:
 *
 *   - the admin gets every line, including the ones inside a computed screen —
 *     the invoice, the finished service, the wallet history;
 *   - the conditions stay in TypeScript, where they are type-checked, instead of
 *     becoming a template language that can fail while a customer waits.
 *
 * So `planDetail` has one entry for "unlimited volume" and another for "N
 * gigabytes", rather than one entry with an `{#if}` in it. Two rows in the panel
 * is a smaller price than an evaluator in the send path.
 *
 * ## The placeholder contract
 *
 * A text may carry named slots, written `{name}`. `SUPPORT_SCREEN` is the
 * clearest example: its `{handle}` is the only way a customer learns who to
 * message. An admin who rewrites that sentence and drops the slot has not made a
 * wording change, they have removed the information — and nothing about the
 * result looks broken, which is why it has to be refused rather than warned
 * about.
 *
 * So every entry declares its placeholders and `checkOverride` requires the
 * replacement to use exactly that set. Not a subset, because a missing slot
 * loses data; not a superset, because `{balance}` in a text that is never given
 * a balance renders as the literal characters to the customer.
 *
 * ## What is still not here
 *
 * Button labels. A button means something by *where it sits* relative to the
 * others, so the keyboard is edited as a layout rather than as a list of
 * sentences, and `botKeyboard.ts` owns it.
 *
 * The crossing points are `{renewButton}` and `{paidButton}`: some screens tell
 * the customer to press a named button, and they read its label from the live
 * layout instead of quoting it. An admin who renames that button used to break
 * those sentences silently.
 */

import { checkCustomEmoji, stripCustomEmoji, type CustomEmojiProblem } from './customEmoji.js';

/** A slot in a text, as an admin writes it. */
const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

export interface TextEntry {
  /** What the bot says when nobody has overridden it. */
  default: string;
  /** Slots the override must use, exactly. */
  placeholders: readonly string[];
  /** The screen this line belongs to, for the admin panel. */
  screen: ScreenId;
  /** When and where the customer sees it. */
  hint: string;
}

/**
 * The screens, in the order the admin panel lists them.
 *
 * Roughly the order a customer meets them: the menu, then buying, then owning,
 * then money, then the corners, then the admin's own screens last.
 */
export type ScreenId =
  | 'welcome'
  | 'gate'
  | 'products'
  | 'plans'
  | 'planDetail'
  | 'checkout'
  | 'paid'
  | 'delivery'
  | 'myServices'
  | 'serviceDetail'
  | 'addon'
  | 'serviceActions'
  | 'renew'
  | 'wallet'
  | 'topup'
  | 'gift'
  | 'discount'
  | 'support'
  | 'help'
  | 'referral'
  | 'reseller'
  | 'warnings'
  | 'paging';

/** The Persian name of each screen, for the admin panel's grouping. */
export const SCREENS: Record<ScreenId, string> = {
  welcome: 'خوش‌آمد و منوی اصلی',
  gate: 'عضویت کانال و پذیرش قوانین',
  products: 'فهرست سرویس‌ها',
  plans: 'فهرست پلن‌ها',
  planDetail: 'جزئیات پلن',
  checkout: 'فاکتور و کارت‌به‌کارت',
  paid: 'ثبت پرداخت',
  delivery: 'تحویل سرویس',
  myServices: 'سرویس‌های من',
  serviceDetail: 'جزئیات سرویس',
  addon: 'حجم و زمان اضافه',
  serviceActions: 'تغییر لینک و روشن/خاموش',
  renew: 'تمدید سرویس',
  wallet: 'کیف پول',
  topup: 'شارژ کیف پول',
  gift: 'کد هدیه',
  discount: 'کد تخفیف',
  support: 'پشتیبانی',
  help: 'آموزش و برنامه‌ها',
  referral: 'زیرمجموعه‌گیری',
  reseller: 'نمایندگی',
  warnings: 'هشدارهای خودکار',
  paging: 'دکمه‌های صفحه‌بندی',
};

export const SCREEN_IDS = Object.keys(SCREENS) as ScreenId[];

/**
 * The catalogue.
 *
 * Every default here is the string that was in `menu.ts`, moved rather than
 * retyped — the wording is production's, arrived at over a long time, and this
 * change is about who can edit it, not about what it says.
 *
 * Declaration order is display order. JavaScript preserves insertion order for
 * string keys, so a screen's lines are listed in the panel in the order they
 * appear on the screen, and no `order` column is needed to say so.
 */
export const TEXTS = {
  // --- خوش‌آمد و منوی اصلی --------------------------------------------------
  WELCOME: {
    default: 'به شیکو خوش آمدید 👋\n\nاز منوی زیر انتخاب کنید.',
    placeholders: [],
    screen: 'welcome',
    hint: 'اولین پیام بعد از /start',
  },
  SHOP_CLOSED: {
    default: '🔧 فروشگاه موقتاً بسته است. لطفاً کمی بعد دوباره امتحان کنید.',
    placeholders: [],
    screen: 'welcome',
    hint: 'تنها چیزی که مشتری می‌بیند وقتی `Bot_Status` خاموش است — ادمین‌ها می‌بینندش نمی‌شوند',
  },
  MENU_TITLE: {
    default: 'منوی اصلی — چه کاری برایتان انجام دهم؟',
    placeholders: [],
    screen: 'welcome',
    hint: 'بالای منوی اصلی',
  },
  REFERRAL_WELCOME: {
    default: '👥 شما با لینک دعوت یکی از کاربران وارد شدید.',
    placeholders: [],
    screen: 'welcome',
    hint: 'ورود با لینک دعوت، بالای پیام خوش‌آمد',
  },
  NOT_REGISTERED: {
    default: 'برای شروع لطفاً /start را بزنید.',
    placeholders: [],
    screen: 'welcome',
    hint: 'وقتی کاربر بدون /start دکمه‌ای می‌زند',
  },
  SOON: {
    default: 'این بخش هنوز آماده نیست. به‌زودی 🙏',
    placeholders: [],
    screen: 'welcome',
    hint: 'بخشی که هنوز ساخته نشده',
  },
  // `BACK_TO_MENU_LABEL` used to live here. It is a button, and buttons are now
  // in `botKeyboard.ts` — one per screen, so a shop can word the way back out
  // of the invoice differently from the way back out of the wallet. Two
  // registries owning one label is the drift this project keeps paying for.

  // --- عضویت کانال و پذیرش قوانین -------------------------------------------
  GATE_CHANNELS: {
    default:
      'برای استفاده از ربات، لطفاً ابتدا در کانال‌های زیر عضو شوید و سپس «{joinedButton}» را بزنید.',
    placeholders: ['joinedButton'],
    screen: 'gate',
    hint: 'وقتی کاربر عضو یکی از کانال‌های اجباری نیست — دکمهٔ هر کانال بالای این پیام می‌آید',
  },
  GATE_NOT_JOINED_YET: {
    default:
      'هنوز عضویت شما تایید نشد. لطفاً در همهٔ کانال‌های بالا عضو شوید و دوباره «{joinedButton}» را بزنید.',
    placeholders: ['joinedButton'],
    screen: 'gate',
    hint: 'وقتی کاربر «عضو شدم» را زده ولی هنوز عضو نشده — بدون این، فشردن دکمه هیچ اثری به نظر نمی‌رسد',
  },
  GATE_RULES: {
    default:
      '📜 قوانین فروشگاه\n\nبا ادامه دادن، قوانین فروشگاه را می‌پذیرید.\n\nمتن قوانین را از پنل مدیریت اینجا بنویسید.',
    placeholders: [],
    screen: 'gate',
    hint: 'متن قوانین — تا وقتی کاربر نپذیرفته، تنها چیزی است که می‌بیند',
  },
  GATE_RULES_ACCEPTED: {
    default: '✅ ممنون، قوانین را پذیرفتید.',
    placeholders: [],
    screen: 'gate',
    hint: 'بالای منوی اصلی، بلافاصله بعد از پذیرش قوانین',
  },

  // --- فهرست سرویس‌ها -------------------------------------------------------
  SHOP_EMPTY: {
    default: 'در حال حاضر سرویسی برای فروش موجود نیست. کمی بعد دوباره سر بزنید.',
    placeholders: [],
    screen: 'products',
    hint: 'وقتی هیچ چیزی برای فروش نیست',
  },

  CHOOSE_PRODUCT: {
    default: '🛍 سرویس مورد نظرتان را انتخاب کنید.',
    placeholders: [],
    screen: 'products',
    hint: 'اولین صفحهٔ خرید — پلاتینیوم، طلایی، معمولی',
  },
  PANEL_EMPTY: {
    default: 'در حال حاضر محصولی روی این لوکیشن موجود نیست.',
    placeholders: [],
    screen: 'products',
    hint: 'یک لوکیشن که پلن فروختنی ندارد — از دکمه‌های قدیمی',
  },

  // --- فهرست پلن‌ها ---------------------------------------------------------
  CHOOSE_PLAN: {
    default: '📦 یکی از پلن‌های «{product}» را انتخاب کنید.',
    placeholders: ['product'],
    screen: 'plans',
    hint: 'فهرست پلن‌های یک سرویس',
  },
  PRODUCT_EMPTY: {
    default: 'در حال حاضر پلنی روی این سرویس موجود نیست.',
    placeholders: [],
    screen: 'plans',
    hint: 'سرویسی که پلن فروختنی ندارد',
  },

  // --- جزئیات پلن ----------------------------------------------------------
  PLAN_TITLE: {
    default: '🔐 {product}',
    placeholders: ['product'],
    screen: 'planDetail',
    hint: 'خط اول — نام محصول',
  },
  PLAN_LOCATION: {
    default: '📍 لوکیشن: {provider}',
    placeholders: ['provider'],
    screen: 'planDetail',
    hint: 'نام لوکیشن',
  },
  PLAN_VOLUME: {
    default: '📦 حجم: {volume} گیگابایت',
    placeholders: ['volume'],
    screen: 'planDetail',
    hint: 'حجم پلن، وقتی محدود است',
  },
  PLAN_VOLUME_UNLIMITED: {
    default: '📦 حجم: نامحدود',
    placeholders: [],
    screen: 'planDetail',
    hint: 'به‌جای خط بالا، وقتی پلن حجم نامحدود دارد',
  },
  PLAN_DURATION: {
    default: '⏳ مدت: {days} روز',
    placeholders: ['days'],
    screen: 'planDetail',
    hint: 'مدت پلن، وقتی محدود است',
  },
  PLAN_DURATION_UNLIMITED: {
    default: '⏳ مدت: بدون محدودیت زمان',
    placeholders: [],
    screen: 'planDetail',
    hint: 'به‌جای خط بالا، وقتی پلن انقضا ندارد',
  },
  PLAN_USER_LIMIT: {
    default: '👥 کاربر همزمان: {limit}',
    placeholders: ['limit'],
    screen: 'planDetail',
    hint: 'فقط وقتی پلن سقف کاربر همزمان دارد',
  },
  PLAN_PRICE: {
    default: '💵 قیمت: {price}',
    placeholders: ['price'],
    screen: 'planDetail',
    hint: 'قیمت پیش از تخفیف — فقط وقتی تخفیفی هست',
  },
  PLAN_STANDING_DISCOUNT: {
    default: '🎁 تخفیف شما: {amount}',
    placeholders: ['amount'],
    screen: 'planDetail',
    hint: 'تخفیف ثابت مشتری',
  },
  PLAN_CODE_DISCOUNT: {
    default: '🏷 کد «{code}»: {amount}',
    placeholders: ['code', 'amount'],
    screen: 'planDetail',
    hint: 'تخفیف کدی که مشتری وارد کرده',
  },
  PLAN_PAYABLE: {
    default: '💳 قابل پرداخت: {amount}',
    placeholders: ['amount'],
    screen: 'planDetail',
    hint: 'خط آخر — مبلغی که پرداخت می‌شود',
  },
  PLAN_GONE: {
    default: 'این سرویس در دسترس شما نیست. لطفاً از منوی خرید دوباره انتخاب کنید.',
    placeholders: [],
    screen: 'planDetail',
    hint: 'پلنی که حذف یا پنهان شده',
  },

  // --- فاکتور و کارت‌به‌کارت --------------------------------------------------
  // یک بلوک برای هر چهار فاکتور (خرید، تمدید، شارژ، حجم/زمان اضافه). فقط خط
  // اول و خط‌های میانی فرق دارند؛ بقیه یکی است و قبلاً چهار بار تکرار شده بود.
  CHECKOUT_INTRO: {
    default: '🧾 سفارش شما ثبت شد. برای تکمیل، مبلغ زیر را کارت‌به‌کارت کنید.',
    placeholders: [],
    screen: 'checkout',
    hint: 'خط اول فاکتور خرید و فاکتور حجم/زمان اضافه',
  },
  CHECKOUT_INTRO_RENEW: {
    default: '🧾 درخواست تمدید ثبت شد. برای تکمیل، مبلغ زیر را کارت‌به‌کارت کنید.',
    placeholders: [],
    screen: 'checkout',
    hint: 'خط اول فاکتور تمدید',
  },
  CHECKOUT_INTRO_TOPUP: {
    default: '🧾 درخواست شارژ ثبت شد. برای تکمیل، مبلغ زیر را کارت‌به‌کارت کنید.',
    placeholders: [],
    screen: 'checkout',
    hint: 'خط اول فاکتور شارژ کیف پول',
  },
  CHECKOUT_ORDER_ID: {
    default: '🔖 شمارهٔ سفارش: {id}',
    placeholders: ['id'],
    screen: 'checkout',
    hint: 'شمارهٔ سفارش روی فاکتور خرید، تمدید و افزودنی',
  },
  CHECKOUT_TRACKING_ID: {
    default: '🔖 شمارهٔ پیگیری: {id}',
    placeholders: ['id'],
    screen: 'checkout',
    hint: 'شمارهٔ پیگیری روی فاکتور شارژ کیف پول',
  },
  CHECKOUT_SERVICE: {
    default: '🔐 سرویس: {product}',
    placeholders: ['product'],
    screen: 'checkout',
    hint: 'نام محصول روی فاکتور خرید',
  },
  CHECKOUT_RENEW_SERVICE: {
    default: '♻️ تمدید سرویس: {service}',
    placeholders: ['service'],
    screen: 'checkout',
    hint: 'نام سرویسی که تمدید می‌شود',
  },
  CHECKOUT_RENEW_PLAN: {
    default: '🔐 با پلن: {plan}',
    placeholders: ['plan'],
    screen: 'checkout',
    hint: 'پلن تمدید روی فاکتور',
  },
  CHECKOUT_ADDON_ITEM: {
    default: '📦 {what} برای «{service}»',
    placeholders: ['what', 'service'],
    screen: 'checkout',
    hint: 'حجم یا زمان اضافه‌ای که خریداری می‌شود',
  },
  CHECKOUT_CODE_DISCOUNT: {
    default: '🏷 کد «{code}»: {amount} تخفیف',
    placeholders: ['code', 'amount'],
    screen: 'checkout',
    hint: 'کد تخفیف اعمال‌شده روی فاکتور تمدید',
  },
  CHECKOUT_AMOUNT: {
    default: '💳 مبلغ دقیق: {amount}',
    placeholders: ['amount'],
    screen: 'checkout',
    hint: 'مبلغی که باید واریز شود — روی هر چهار فاکتور',
  },
  CHECKOUT_CARD_LABEL: {
    default: '🏦 شمارهٔ کارت:',
    placeholders: [],
    screen: 'checkout',
    hint: 'خط بالای شمارهٔ کارت',
  },
  CHECKOUT_CARD_HOLDER: {
    default: '👤 به نام: {name}',
    placeholders: ['name'],
    screen: 'checkout',
    hint: 'نام صاحب کارت، وقتی ثبت شده باشد',
  },
  CHECKOUT_EXACT_WARNING: {
    default: 'لطفاً دقیقاً همین مبلغ را واریز کنید — مبلغ متفاوت بررسی دستی می‌خواهد و طول می‌کشد.',
    placeholders: [],
    screen: 'checkout',
    hint: 'هشدار مبلغ دقیق — تایید خودکار هیچ تلورانسی ندارد',
  },
  CHECKOUT_PRESS_BUTTON: {
    default: 'بعد از واریز، دکمهٔ زیر را بزنید.',
    placeholders: [],
    screen: 'checkout',
    hint: 'خط آخر فاکتور',
  },
  // The four notes below are `PaySetting.helpcart`, the live production text
  // read out of the dump on 2026-08-15. The legacy bot sends them as a separate
  // message just before every card invoice (`index.php:4811`); here they are
  // part of the invoice, so a customer cannot scroll past them.
  //
  // They are not decoration. Automatic verification has zero tolerance on the
  // amount and matches on the bank's own SMS, so notes 2 and 3 are what keep a
  // payment out of the manual queue, and note 1 is what keeps the transfer from
  // being refused by the bank at all. Dropping them lengthens the queue.
  CHECKOUT_NOTES_TITLE: {
    default: 'نکات مهم قبل از کارت به کارت:',
    placeholders: [],
    screen: 'checkout',
    hint: 'سرصفحهٔ نکات کارت به کارت — روی هر چهار فاکتور',
  },
  CHECKOUT_NOTE_WORDS: {
    default:
      '۱- به هیچ عنوان از کلمات مشکل‌دار مثل VPN، فیلترشکن، قندشکن و … در توضیحات رسید استفاده نکنید.',
    placeholders: [],
    screen: 'checkout',
    hint: 'نکتهٔ ۱ — کلمات مشکل‌دار در توضیحات واریز',
  },
  CHECKOUT_NOTE_TRANSFER: {
    default: '۲- از انتقال پل، پایا و ساتنا استفاده نکنید؛ تراکنش با تاخیر می‌رسد.',
    placeholders: [],
    screen: 'checkout',
    hint: 'نکتهٔ ۲ — پل/پایا/ساتنا تایید خودکار را از پنجرهٔ ۵ دقیقه بیرون می‌برد',
  },
  CHECKOUT_NOTE_PRESS: {
    default: '۳- بعد از واریز حتماً دکمهٔ «{paidButton}» را بزنید و بعد عکس رسید را بفرستید.',
    placeholders: ['paidButton'],
    screen: 'checkout',
    hint: 'نکتهٔ ۳ — بدون این دکمه هیچ claimی باز نمی‌شود · {paidButton} نام زندهٔ دکمه است',
  },
  CHECKOUT_NOTE_WAIT: {
    default: '۴- رسید را برای ادمین نفرستید؛ در صورت واریز درست، حداکثر تا ۱۰ دقیقه تایید می‌شود.',
    placeholders: [],
    screen: 'checkout',
    hint: 'نکتهٔ ۴ — ۱۰ دقیقه همان پنجرهٔ انتظار تطبیق است',
  },
  CHECKOUT_COPY_CARD: {
    default: '📋 کپی شمارهٔ کارت',
    placeholders: [],
    screen: 'checkout',
    hint: 'دکمه‌ای که شمارهٔ کارت را در حافظه کپی می‌کند — بدون تایپ دستی',
  },
  CHECKOUT_COPY_AMOUNT: {
    default: '📋 کپی مبلغ',
    placeholders: [],
    screen: 'checkout',
    hint: 'دکمه‌ای که مبلغ را به تومان و بدون جداکننده کپی می‌کند',
  },
  ORDER_GONE: {
    default: 'این سفارش پیدا نشد. لطفاً از منوی خرید دوباره اقدام کنید.',
    placeholders: [],
    screen: 'checkout',
    hint: 'سفارشی که دیگر وجود ندارد',
  },
  NO_CARD_AVAILABLE: {
    default:
      'در حال حاضر امکان دریافت شمارهٔ کارت نیست. لطفاً چند دقیقهٔ دیگر دوباره تلاش کنید یا به پشتیبانی پیام دهید.',
    placeholders: [],
    screen: 'checkout',
    hint: 'وقتی همهٔ کارت‌ها غیرفعال یا مشغول‌اند',
  },
  ORDER_EXPIRED: {
    default:
      'مهلت این فاکتور تمام شده و شمارهٔ کارت روی آن دیگر معتبر نیست. لطفاً از منوی خرید دوباره اقدام کنید.',
    placeholders: [],
    screen: 'checkout',
    hint: 'وقتی «پرداخت کردم» روی فاکتوری زده می‌شود که منقضی شده',
  },
  ORDER_EXPIRED_TITLE: {
    default: '⌛ مهلت پرداخت این سفارش تمام شد.',
    placeholders: [],
    screen: 'checkout',
    hint: 'خط اول پیامی که خودکار برای سفارش پرداخت‌نشده فرستاده می‌شود',
  },
  ORDER_EXPIRED_CARD_STALE: {
    default:
      '⚠️ به شمارهٔ کارت آن فاکتور واریز نکنید؛ دیگر معتبر نیست. برای خرید، از منوی اصلی دوباره شروع کنید.',
    placeholders: [],
    screen: 'checkout',
    hint: 'هشدار واریز نکردن به کارت کهنه — فاکتور قدیمی هنوز در چت مشتری است',
  },
  ORDER_NOT_PAYABLE: {
    default:
      'مبلغ این سفارش با تخفیف شما صفر می‌شود و ثبتش ممکن نیست. لطفاً به پشتیبانی پیام دهید.',
    placeholders: [],
    screen: 'checkout',
    hint: 'وقتی تخفیف ثابت مشتری یا کد تخفیف، مبلغ را به صفر می‌رساند',
  },

  // --- ثبت پرداخت ----------------------------------------------------------
  PAID_RECORDED_TITLE: {
    default: '🕓 ممنون. پرداخت شما ثبت شد و در حال بررسی است.',
    placeholders: [],
    screen: 'paid',
    hint: 'بعد از زدن «پرداخت کردم»',
  },
  PAID_ALREADY_TITLE: {
    default: '🕓 پرداخت این سفارش قبلاً ثبت شده و در حال بررسی است.',
    placeholders: [],
    screen: 'paid',
    hint: 'وقتی دکمهٔ «پرداخت کردم» دوباره زده می‌شود',
  },
  PAID_TRACKING_ID: {
    default: '🔖 شمارهٔ پیگیری: {id}',
    placeholders: ['id'],
    screen: 'paid',
    hint: 'شمارهٔ پیگیری در پیام ثبت پرداخت',
  },
  PAID_WAIT: {
    default: 'به‌محض تایید تراکنش، سرویس برایتان ارسال می‌شود. معمولاً چند دقیقه طول می‌کشد.',
    placeholders: [],
    screen: 'paid',
    hint: 'خط آخر پیام ثبت پرداخت',
  },
  PAID_SEND_RECEIPT: {
    default: '📸 اگر رسید واریز دارید، همین‌جا عکسش را بفرستید. بررسی را سریع‌تر می‌کند.',
    placeholders: [],
    screen: 'paid',
    hint: 'دعوت به فرستادن عکس رسید، بعد از «پرداخت کردم»',
  },
  RECEIPT_RECEIVED_TITLE: {
    default: '📸 رسید شما دریافت شد و به پروندهٔ پرداخت اضافه شد.',
    placeholders: [],
    screen: 'paid',
    hint: 'وقتی اولین عکس رسید می‌رسد',
  },
  RECEIPT_REPLACED: {
    default: '📸 رسید تازه ثبت شد و جایگزین قبلی شد. زمان بررسی تغییری نمی‌کند.',
    placeholders: [],
    screen: 'paid',
    hint: 'وقتی مشتری عکس دوم را می‌فرستد',
  },
  RECEIPT_SETTLED: {
    default: 'این پرداخت قبلاً بررسی و تعیین‌تکلیف شده است.',
    placeholders: [],
    screen: 'paid',
    hint: 'وقتی رسید برای پرداختی می‌رسد که تایید یا رد شده',
  },
  RECEIPT_NOTHING_WAITING: {
    default:
      'الان پرداختی در انتظار بررسی ندارید. اگر واریز کرده‌اید، اول روی فاکتور دکمهٔ «پرداخت کردم» را بزنید.',
    placeholders: [],
    screen: 'paid',
    hint: 'وقتی عکسی می‌رسد و هیچ پرداختی در صف بررسی نیست',
  },
  RECEIPT_WRONG_FILE: {
    default: 'این فایل رسید نیست. لطفاً تصویر رسید را بفرستید — عکس، یا فایل عکس، یا PDF بانک.',
    placeholders: [],
    screen: 'paid',
    hint: 'وقتی مشتری فایلی می‌فرستد که عکس یا PDF نیست — بدون این، فایل بی‌صدا دور انداخته می‌شد',
  },
  PAYMENT_CONFIRMED_TITLE: {
    default: '✅ پرداخت شما تایید شد.',
    placeholders: [],
    screen: 'paid',
    hint: 'پیام خودکار وقتی تراکنش بانکی جفت شد',
  },
  PAYMENT_CONFIRMED_QUEUED: {
    default: 'سفارش شما در صف آماده‌سازی قرار گرفت.',
    placeholders: [],
    screen: 'paid',
    hint: 'خط آخر پیام تایید پرداخت',
  },

  // --- تحویل سرویس ---------------------------------------------------------
  SERVICE_READY_TITLE: {
    default: '🎉 سرویس شما آماده است.',
    placeholders: [],
    screen: 'delivery',
    hint: 'خط اول پیام تحویل',
  },
  SERVICE_READY_USERNAME: {
    default: '👤 نام کاربری: {username}',
    placeholders: ['username'],
    screen: 'delivery',
    hint: 'نام کاربری روی پنل',
  },
  SERVICE_READY_EXPIRES: {
    default: '📅 اعتبار تا: {date}',
    placeholders: ['date'],
    screen: 'delivery',
    hint: 'تاریخ انقضا، وقتی سرویس انقضا دارد',
  },
  SERVICE_READY_LINK_LABEL: {
    default: '🔗 لینک اشتراک:',
    placeholders: [],
    screen: 'delivery',
    hint: 'خط بالای لینک اشتراک',
  },
  SERVICE_READY_HOWTO: {
    default: 'این لینک را در برنامهٔ خود وارد کنید.',
    placeholders: [],
    screen: 'delivery',
    hint: 'خط آخر پیام تحویل',
  },
  SERVICE_MANUAL_TITLE: {
    default: '✅ پرداخت شما تایید شد و سفارش ثبت شد.',
    placeholders: [],
    screen: 'delivery',
    hint: 'سرویسی که دستی آماده می‌شود',
  },
  SERVICE_MANUAL_TRACKING_ID: {
    default: '🔖 شمارهٔ پیگیری: {id}',
    placeholders: ['id'],
    screen: 'delivery',
    hint: 'شمارهٔ پیگیری در پیام سرویس دستی',
  },
  SERVICE_MANUAL_BODY: {
    default: 'این سرویس به‌صورت دستی آماده می‌شود و به‌زودی برایتان ارسال می‌گردد.',
    placeholders: [],
    screen: 'delivery',
    hint: 'خط آخر پیام سرویس دستی',
  },
  SERVICE_FAILED_SAFE: {
    default: '⚠️ پرداخت شما ثبت شده و محفوظ است، ولی آماده‌سازی سرویس به مشکل خورد.',
    placeholders: [],
    screen: 'delivery',
    hint: 'شکست آماده‌سازی، وقتی پول کارت‌به‌کارت بوده و در حساب است',
  },
  SERVICE_FAILED_REFUNDED: {
    default: '⚠️ آماده‌سازی سرویس به مشکل خورد.',
    placeholders: [],
    screen: 'delivery',
    hint: 'شکست آماده‌سازی، وقتی پول به کیف پول برگشته',
  },
  SERVICE_FAILED_TRACKING_ID: {
    default: '🔖 شمارهٔ پیگیری: {id}',
    placeholders: ['id'],
    screen: 'delivery',
    hint: 'شمارهٔ پیگیری در پیام شکست',
  },
  SERVICE_FAILED_REFUND_LINE: {
    default: '💰 مبلغ {amount} به کیف پول شما برگشت.',
    placeholders: ['amount'],
    screen: 'delivery',
    hint: 'مبلغی که به کیف پول برگشت',
  },
  SERVICE_FAILED_FOOTER: {
    default: 'همکاران ما پیگیری می‌کنند. لطفاً این شماره را نگه دارید.',
    placeholders: [],
    screen: 'delivery',
    hint: 'خط آخر پیام شکست',
  },

  // --- سرویس‌های من ---------------------------------------------------------
  MY_SERVICES_TITLE: {
    default: '🛍 سرویس‌های شما ({total} مورد)',
    placeholders: ['total'],
    screen: 'myServices',
    hint: 'بالای فهرست سرویس‌ها',
  },
  MY_SERVICES_PAGE: {
    default: 'صفحهٔ {page} از {pages}',
    placeholders: ['page', 'pages'],
    screen: 'myServices',
    hint: 'فقط وقتی بیش از یک صفحه هست',
  },
  MY_SERVICES_EMPTY: {
    default: 'هنوز سرویسی ندارید.\n\nاز دکمهٔ «خرید اشتراک» می‌توانید اولین سرویس‌تان را بگیرید.',
    placeholders: [],
    screen: 'myServices',
    hint: 'کاربری که هیچ سرویسی ندارد',
  },

  // --- جزئیات سرویس --------------------------------------------------------
  SERVICE_DETAIL_TITLE: {
    default: '{glyph} {name}',
    placeholders: ['glyph', 'name'],
    screen: 'serviceDetail',
    hint: 'خط اول — نشانهٔ وضعیت و نام سرویس',
  },
  SERVICE_DETAIL_STATE: {
    default: 'وضعیت: {state}',
    placeholders: ['state'],
    screen: 'serviceDetail',
    hint: 'وضعیت سرویس به حروف',
  },
  SERVICE_DETAIL_LOCATION: {
    default: '📍 لوکیشن: {provider}',
    placeholders: ['provider'],
    screen: 'serviceDetail',
    hint: 'لوکیشن سرویس',
  },
  SERVICE_DETAIL_ID: {
    default: '🔖 شمارهٔ سرویس: {id}',
    placeholders: ['id'],
    screen: 'serviceDetail',
    hint: 'شمارهٔ سرویس',
  },
  SERVICE_DETAIL_USERNAME: {
    default: '👤 نام کاربری: {username}',
    placeholders: ['username'],
    screen: 'serviceDetail',
    hint: 'نام کاربری روی پنل',
  },
  SERVICE_DETAIL_VOLUME: {
    default: '📦 حجم: {volume} گیگابایت',
    placeholders: ['volume'],
    screen: 'serviceDetail',
    hint: 'حجم کل سرویس',
  },
  SERVICE_DETAIL_VOLUME_UNLIMITED: {
    default: '📦 حجم: نامحدود',
    placeholders: [],
    screen: 'serviceDetail',
    hint: 'به‌جای خط بالا، وقتی حجم نامحدود است',
  },
  SERVICE_DETAIL_USED: {
    default: '📊 مصرف شده: {used}',
    placeholders: ['used'],
    screen: 'serviceDetail',
    hint: 'مصرف تا امروز',
  },
  SERVICE_DETAIL_REMAINING: {
    default: '🎯 باقی‌مانده: {remaining}',
    placeholders: ['remaining'],
    screen: 'serviceDetail',
    hint: 'حجم باقی‌مانده',
  },
  SERVICE_DETAIL_EXPIRES: {
    default: '📅 اعتبار تا: {date}',
    placeholders: ['date'],
    screen: 'serviceDetail',
    hint: 'تاریخ انقضا',
  },
  SERVICE_DETAIL_NO_EXPIRY: {
    default: '📅 اعتبار: بدون محدودیت زمان',
    placeholders: [],
    screen: 'serviceDetail',
    hint: 'به‌جای خط بالا، وقتی سرویس انقضا ندارد',
  },
  SERVICE_DETAIL_DAYS_LEFT: {
    default: '⏳ {days} روز باقی مانده',
    placeholders: ['days'],
    screen: 'serviceDetail',
    hint: 'فقط وقتی هنوز روزی مانده',
  },
  SERVICE_DETAIL_LINK_LABEL: {
    default: '🔗 لینک اشتراک:',
    placeholders: [],
    screen: 'serviceDetail',
    hint: 'خط بالای لینک — فقط برای سرویس فعال',
  },
  SERVICE_DETAIL_NO_LINK: {
    default: 'لینک این سرویس هنوز در دسترس نیست. لطفاً به پشتیبانی پیام دهید.',
    placeholders: [],
    screen: 'serviceDetail',
    hint: 'سرویس فعالی که لینکش هنوز نرسیده',
  },
  SERVICE_DETAIL_DEAD_HINT: {
    default: 'برای استفادهٔ دوباره، از دکمهٔ «{renewButton}» در منوی اصلی اقدام کنید.',
    // Read from the live keyboard, not quoted. An admin who renames that button
    // used to leave this sentence pointing at a button that no longer exists.
    placeholders: ['renewButton'],
    screen: 'serviceDetail',
    hint: 'سرویس منقضی یا تمام‌شده — {renewButton} نام زندهٔ دکمهٔ تمدید است',
  },
  STATE_ACTIVE: {
    default: 'فعال',
    placeholders: [],
    screen: 'serviceDetail',
    hint: 'برچسب وضعیت: سرویس سالم',
  },
  STATE_EXPIRED: {
    default: 'تاریخ انقضا گذشته',
    placeholders: [],
    screen: 'serviceDetail',
    hint: 'برچسب وضعیت: تاریخ گذشته',
  },
  STATE_EXHAUSTED: {
    default: 'حجم تمام شده',
    placeholders: [],
    screen: 'serviceDetail',
    hint: 'برچسب وضعیت: حجم تمام',
  },
  STATE_ON_HOLD: {
    default: 'در انتظار فعال‌سازی',
    placeholders: [],
    screen: 'serviceDetail',
    hint: 'برچسب وضعیت: هنوز فعال نشده',
  },
  STATE_DISABLED: {
    default: 'غیرفعال',
    placeholders: [],
    screen: 'serviceDetail',
    hint: 'برچسب وضعیت: خاموش شده',
  },
  STATE_REMOVED: {
    default: 'حذف شده',
    placeholders: [],
    screen: 'serviceDetail',
    hint: 'برچسب وضعیت: حذف‌شده از پنل',
  },
  STATE_FAILED: {
    default: 'مشکل در آماده‌سازی',
    placeholders: [],
    screen: 'serviceDetail',
    hint: 'برچسب وضعیت: آماده‌سازی شکست خورده',
  },
  SERVICE_GONE: {
    default: 'این سرویس پیدا نشد. لطفاً از فهرست سرویس‌ها دوباره انتخاب کنید.',
    placeholders: [],
    screen: 'serviceDetail',
    hint: 'سرویسی که دیگر نیست',
  },

  // --- حجم و زمان اضافه ----------------------------------------------------
  ADDON_VOLUME_TITLE: {
    default: '➕ خرید حجم اضافه',
    placeholders: [],
    screen: 'addon',
    hint: 'خط اول صفحهٔ حجم اضافه',
  },
  ADDON_VOLUME_PRICE: {
    default: 'قیمت هر گیگابایت: {price}',
    placeholders: ['price'],
    screen: 'addon',
    hint: 'قیمت واحد حجم',
  },
  ADDON_VOLUME_ASK: {
    default: 'چند گیگابایت می‌خواهید؟ فقط عدد بفرستید — مثلاً 5',
    placeholders: [],
    screen: 'addon',
    hint: 'درخواست عدد برای حجم',
  },
  ADDON_TIME_TITLE: {
    default: '⏳ خرید زمان اضافه',
    placeholders: [],
    screen: 'addon',
    hint: 'خط اول صفحهٔ زمان اضافه',
  },
  ADDON_TIME_PRICE: {
    default: 'قیمت هر روز: {price}',
    placeholders: ['price'],
    screen: 'addon',
    hint: 'قیمت واحد زمان',
  },
  ADDON_TIME_ASK: {
    default: 'چند روز می‌خواهید؟ فقط عدد بفرستید — مثلاً 30',
    placeholders: [],
    screen: 'addon',
    hint: 'درخواست عدد برای زمان',
  },
  ADDON_NOT_A_NUMBER: {
    default: 'لطفاً فقط یک عدد بفرستید — مثلاً 5. برای انصراف /start را بزنید.',
    placeholders: [],
    screen: 'addon',
    hint: 'وقتی برای حجم یا زمان اضافه عدد نفرستاده',
  },
  ADDON_TOO_MUCH: {
    default: 'بیشترین مقدار در هر خرید {max} است. عدد کوچک‌تری بفرستید.',
    placeholders: ['max'],
    screen: 'addon',
    hint: 'عددی بزرگ‌تر از سقف مجاز',
  },
  ADDON_QUANTITY_VOLUME: {
    default: '{quantity} گیگابایت حجم',
    placeholders: ['quantity'],
    screen: 'addon',
    hint: 'توصیف مقدار حجم، داخل فاکتور و پیام تایید',
  },
  ADDON_QUANTITY_TIME: {
    default: '{quantity} روز زمان',
    placeholders: ['quantity'],
    screen: 'addon',
    hint: 'توصیف مقدار زمان، داخل فاکتور و پیام تایید',
  },
  ADDON_INVOICE_TITLE: {
    default: '🧾 فاکتور شما:',
    placeholders: [],
    screen: 'addon',
    hint: 'خط اول فاکتور پیش از انتخاب روش پرداخت',
  },
  ADDON_INVOICE_ITEM: {
    default: '📦 {what}',
    placeholders: ['what'],
    screen: 'addon',
    hint: 'چیزی که خریداری می‌شود',
  },
  ADDON_INVOICE_AMOUNT: {
    default: '💳 مبلغ: {amount}',
    placeholders: ['amount'],
    screen: 'addon',
    hint: 'مبلغ فاکتور افزودنی',
  },
  ADDON_APPLIED_VOLUME: {
    default: '✅ {quantity} گیگابایت به «{service}» اضافه شد.',
    placeholders: ['quantity', 'service'],
    screen: 'addon',
    hint: 'بعد از اعمال حجم اضافه',
  },
  ADDON_APPLIED_TIME: {
    default: '✅ {quantity} روز به «{service}» اضافه شد.',
    placeholders: ['quantity', 'service'],
    screen: 'addon',
    hint: 'بعد از اعمال زمان اضافه',
  },
  ADDON_APPLIED_EXPIRES: {
    default: '📅 اعتبار تا: {date}',
    placeholders: ['date'],
    screen: 'addon',
    hint: 'تاریخ انقضای تازه',
  },
  ADDON_APPLIED_LINK_NOTE: {
    default: 'لینک اشتراک شما عوض نشده و همان قبلی است.',
    placeholders: [],
    screen: 'addon',
    hint: 'خط آخر پیام اعمال افزودنی',
  },
  ACTION_UNSUPPORTED: {
    default:
      'این سرویس به‌صورت دستی آماده شده و از این طریق قابل تغییر نیست. لطفاً به پشتیبانی پیام دهید.',
    placeholders: [],
    screen: 'addon',
    hint: 'سرویس دستی که دکمه‌های پنل رویش کار نمی‌کند',
  },

  // --- تغییر لینک و روشن/خاموش ---------------------------------------------
  CONFIRM_REVOKE: {
    default:
      '⚠️ لینک اشتراک این سرویس عوض می‌شود.\n\nلینک فعلی از کار می‌افتد و باید لینک جدید را روی همهٔ دستگاه‌هایتان دوباره وارد کنید.\nحجم و تاریخ سرویس دست‌نخورده می‌ماند.',
    placeholders: [],
    screen: 'serviceActions',
    hint: 'تایید تغییر لینک اشتراک',
  },
  LINK_REPLACED_TITLE: {
    default: '✅ لینک اشتراک عوض شد.',
    placeholders: [],
    screen: 'serviceActions',
    hint: 'خط اول بعد از تغییر لینک',
  },
  LINK_REPLACED_LABEL: {
    default: '🔗 لینک جدید:',
    placeholders: [],
    screen: 'serviceActions',
    hint: 'خط بالای لینک تازه',
  },
  LINK_REPLACED_NOTE: {
    default: 'لینک قبلی دیگر کار نمی‌کند.',
    placeholders: [],
    screen: 'serviceActions',
    hint: 'خط آخر بعد از تغییر لینک',
  },
  SERVICE_SWITCHED_ON: {
    default: '💡 سرویس روشن شد و دوباره قابل استفاده است.',
    placeholders: [],
    screen: 'serviceActions',
    hint: 'بعد از روشن کردن سرویس',
  },
  SERVICE_SWITCHED_OFF: {
    default:
      '⛔ سرویس خاموش شد. هر وقت خواستید از همین صفحه روشنش کنید — حجم و تاریخ سرویس حساب می‌شود.',
    placeholders: [],
    screen: 'serviceActions',
    hint: 'بعد از خاموش کردن سرویس',
  },
  ACTION_FAILED_TITLE: {
    default: '⚠️ این کار انجام نشد.',
    placeholders: [],
    screen: 'serviceActions',
    hint: 'خط اول وقتی پنل درخواست را رد کرد',
  },
  ACTION_FAILED_RETRY: {
    default: 'کمی بعد دوباره امتحان کنید.',
    placeholders: [],
    screen: 'serviceActions',
    hint: 'خط آخر وقتی پنل درخواست را رد کرد',
  },
  ACTION_FAILED_NO_LINK: {
    default: 'پنل لینک جدیدی برنگرداند',
    placeholders: [],
    screen: 'serviceActions',
    hint: 'وقتی تغییر لینک انجام شد ولی پنل لینک تازه نداد',
  },

  // --- تمدید ---------------------------------------------------------------
  CHOOSE_SERVICE_TO_RENEW: {
    default: '♻️ کدام سرویس را تمدید می‌کنید؟',
    placeholders: [],
    screen: 'renew',
    hint: 'فهرست سرویس‌ها برای تمدید',
  },
  NOTHING_TO_RENEW: {
    default:
      'سرویسی برای تمدید ندارید.\n\nاگر سرویس فعالی دارید و اینجا نمی‌بینید، به پشتیبانی پیام دهید.',
    placeholders: [],
    screen: 'renew',
    hint: 'کاربری که سرویس قابل تمدید ندارد',
  },
  RENEW_INTRO_TITLE: {
    default: '♻️ تمدید سرویس',
    placeholders: [],
    screen: 'renew',
    hint: 'خط اول صفحهٔ تمدید',
  },
  RENEW_INTRO_SERVICE: {
    default: '🔐 {service}',
    placeholders: ['service'],
    screen: 'renew',
    hint: 'نام سرویسی که تمدید می‌شود',
  },
  RENEW_INTRO_ID: {
    default: '🔖 شمارهٔ سرویس: {id}',
    placeholders: ['id'],
    screen: 'renew',
    hint: 'شمارهٔ سرویس',
  },
  RENEW_INTRO_CURRENT_EXPIRY: {
    default: '📅 اعتبار فعلی تا: {date}',
    placeholders: ['date'],
    screen: 'renew',
    hint: 'تاریخ انقضای فعلی، پیش از تمدید',
  },
  RENEW_MODE_ADD: {
    default: 'زمان و حجم پلنی که انتخاب می‌کنید به باقی‌ماندهٔ فعلی اضافه می‌شود.',
    placeholders: [],
    screen: 'renew',
    hint: 'پنلی که تمدید را به باقی‌مانده اضافه می‌کند',
  },
  RENEW_MODE_ADD_EXPIRED: {
    default: 'اعتبار این سرویس تمام شده، پس زمان پلن جدید از امروز حساب می‌شود.',
    placeholders: [],
    screen: 'renew',
    hint: 'همان پنل، وقتی چیزی از اعتبار نمانده',
  },
  RENEW_MODE_RESET: {
    default: 'با تمدید، زمان و حجم از نو شروع می‌شود و مصرف قبلی صفر می‌گردد.',
    placeholders: [],
    screen: 'renew',
    hint: 'پنلی که تمدید را از نو شروع می‌کند',
  },
  RENEW_CHOOSE_PLAN: {
    default: '🛍 پلن تمدید را انتخاب کنید:',
    placeholders: [],
    screen: 'renew',
    hint: 'خط آخر صفحهٔ تمدید',
  },
  SERVICE_RENEWED_TITLE: {
    default: '♻️ سرویس شما تمدید شد.',
    placeholders: [],
    screen: 'renew',
    hint: 'خط اول بعد از تمدید موفق',
  },
  SERVICE_RENEWED_SERVICE: {
    default: '🔐 {service}',
    placeholders: ['service'],
    screen: 'renew',
    hint: 'نام سرویس تمدیدشده',
  },
  SERVICE_RENEWED_EXPIRES: {
    default: '📅 اعتبار جدید تا: {date}',
    placeholders: ['date'],
    screen: 'renew',
    hint: 'تاریخ انقضای تازه',
  },
  SERVICE_RENEWED_CASHBACK: {
    default: '🎁 به عنوان هدیهٔ تمدید، {amount} به کیف پول شما اضافه شد.',
    placeholders: ['amount'],
    screen: 'renew',
    hint: 'هدیهٔ تمدید — فقط وقتی درصد کش‌بک صفر نباشد نمایش داده می‌شود',
  },
  SERVICE_RENEWED_LINK_NOTE: {
    default: 'لینک اشتراک شما تغییری نکرده و همان قبلی است.',
    placeholders: [],
    screen: 'renew',
    hint: 'خط آخر بعد از تمدید',
  },
  RENEWAL_GONE: {
    default: 'این سرویس قابل تمدید نیست. لطفاً از فهرست تمدید دوباره انتخاب کنید.',
    placeholders: [],
    screen: 'renew',
    hint: 'سرویسی که دیگر قابل تمدید نیست',
  },
  RENEWAL_CLOSED: {
    default:
      'تمدید روی لوکیشن این سرویس فعال نیست.\n\nمی‌توانید از بخش «خرید اشتراک» سرویس جدیدی بگیرید یا به پشتیبانی پیام دهید.',
    placeholders: [],
    screen: 'renew',
    hint: 'پنلی که تمدید رویش خاموش است',
  },
  NO_RENEWAL_PLAN: {
    default:
      'در حال حاضر پلنی برای تمدید این سرویس موجود نیست.\n\nلطفاً کمی بعد دوباره امتحان کنید یا به پشتیبانی پیام دهید.',
    placeholders: [],
    screen: 'renew',
    hint: 'وقتی پلن تمدیدی موجود نیست',
  },

  // --- کیف پول -------------------------------------------------------------
  WALLET_TITLE: {
    default: '🏦 کیف پول شما',
    placeholders: [],
    screen: 'wallet',
    hint: 'خط اول صفحهٔ کیف پول',
  },
  WALLET_BALANCE: {
    default: '💰 موجودی: {balance}',
    placeholders: ['balance'],
    screen: 'wallet',
    hint: 'موجودی فعلی',
  },
  WALLET_NEGATIVE: {
    default: '⚠️ موجودی شما منفی است. تا تسویه نشود امکان خرید از کیف پول نیست.',
    placeholders: [],
    screen: 'wallet',
    hint: 'فقط وقتی موجودی منفی است',
  },
  WALLET_NO_ENTRIES: {
    default: 'هنوز تراکنشی ندارید.',
    placeholders: [],
    screen: 'wallet',
    hint: 'کیف پولی که هیچ تراکنشی ندارد',
  },
  WALLET_HISTORY_TITLE: {
    default: '🧾 آخرین تراکنش‌ها:',
    placeholders: [],
    screen: 'wallet',
    hint: 'بالای فهرست تراکنش‌ها',
  },
  WALLET_ENTRY_LINE: {
    default: '{sign} {amount} — {label}',
    placeholders: ['sign', 'amount', 'label'],
    screen: 'wallet',
    hint: 'هر ردیف تراکنش — {sign} علامت ➕ یا ➖ است',
  },
  WALLET_TOO_LITTLE: {
    default: 'موجودی کیف پول شما برای این خرید کافی نیست. اول کیف پول را شارژ کنید.',
    placeholders: [],
    screen: 'wallet',
    hint: 'موجودی کمتر از مبلغ سفارش',
  },
  WALLET_PAID_TITLE: {
    default: '✅ پرداخت از کیف پول انجام شد.',
    placeholders: [],
    screen: 'wallet',
    hint: 'بعد از پرداخت از موجودی',
  },
  WALLET_PAID_ORDER_ID: {
    default: '🔖 شمارهٔ سفارش: {id}',
    placeholders: ['id'],
    screen: 'wallet',
    hint: 'شمارهٔ سفارشی که از کیف پول پرداخت شد',
  },
  WALLET_PAID_REMAINING: {
    default: '💰 موجودی باقی‌مانده: {balance}',
    placeholders: ['balance'],
    screen: 'wallet',
    hint: 'موجودی بعد از پرداخت',
  },
  WALLET_PAID_FOOTER: {
    default: 'سرویس در حال آماده‌سازی است و تا لحظاتی دیگر فرستاده می‌شود.',
    placeholders: [],
    screen: 'wallet',
    hint: 'خط آخر پرداخت از کیف پول',
  },
  WALLET_TOPPED_UP_TITLE: {
    default: '✅ کیف پول شما شارژ شد.',
    placeholders: [],
    screen: 'wallet',
    hint: 'وقتی شارژ کارت‌به‌کارت تایید شد',
  },
  WALLET_TOPPED_UP_AMOUNT: {
    default: '💰 مبلغ: {amount}',
    placeholders: ['amount'],
    screen: 'wallet',
    hint: 'مبلغ شارژ',
  },
  WALLET_TOPPED_UP_FOOTER: {
    default: 'حالا می‌توانید بدون کارت‌به‌کارت خرید کنید.',
    placeholders: [],
    screen: 'wallet',
    hint: 'خط آخر پیام شارژ',
  },
  ENTRY_OPENING: {
    default: 'موجودی اولیه',
    placeholders: [],
    screen: 'wallet',
    hint: 'نوع تراکنش: موجودی منتقل‌شده از ربات قبلی',
  },
  ENTRY_TOPUP: {
    default: 'شارژ کیف پول',
    placeholders: [],
    screen: 'wallet',
    hint: 'نوع تراکنش: شارژ',
  },
  ENTRY_PURCHASE: {
    default: 'خرید',
    placeholders: [],
    screen: 'wallet',
    hint: 'نوع تراکنش: خرید',
  },
  ENTRY_REFUND: {
    default: 'بازگشت وجه',
    placeholders: [],
    screen: 'wallet',
    hint: 'نوع تراکنش: بازگشت وجه',
  },
  ENTRY_ADMIN_ADJUST: {
    default: 'اصلاح توسط پشتیبانی',
    placeholders: [],
    screen: 'wallet',
    hint: 'نوع تراکنش: اصلاح دستی',
  },
  ENTRY_REFERRAL_BONUS: {
    default: 'پاداش زیرمجموعه',
    placeholders: [],
    screen: 'wallet',
    hint: 'نوع تراکنش: پورسانت زیرمجموعه',
  },
  ENTRY_RENEWAL_CASHBACK: {
    default: 'هدیهٔ تمدید',
    placeholders: [],
    screen: 'wallet',
    hint: 'نوع تراکنش: کش‌بک تمدید',
  },
  ENTRY_WHEEL_PRIZE: {
    default: 'جایزهٔ گردونه',
    placeholders: [],
    screen: 'wallet',
    hint: 'نوع تراکنش: جایزهٔ گردونه (فقط داده‌های منتقل‌شده)',
  },
  ENTRY_TRANSFER_IN: {
    default: 'انتقال دریافتی',
    placeholders: [],
    screen: 'wallet',
    hint: 'نوع تراکنش: انتقال دریافتی',
  },
  ENTRY_TRANSFER_OUT: {
    default: 'انتقال ارسالی',
    placeholders: [],
    screen: 'wallet',
    hint: 'نوع تراکنش: انتقال ارسالی',
  },
  ENTRY_GIFT_CODE: {
    default: 'کد هدیه',
    placeholders: [],
    screen: 'wallet',
    hint: 'نوع تراکنش: کد هدیه',
  },

  // --- شارژ کیف پول --------------------------------------------------------
  TOPUP_TITLE: {
    default: '💰 چه مبلغی به کیف پول اضافه شود؟',
    placeholders: [],
    screen: 'topup',
    hint: 'خط اول صفحهٔ شارژ',
  },
  TOPUP_RANGE: {
    default: 'کمترین مبلغ {min} و بیشترین {max} است.',
    placeholders: ['min', 'max'],
    screen: 'topup',
    hint: 'بازهٔ مجاز شارژ',
  },
  TOPUP_NEXT: {
    default: 'بعد از انتخاب، شمارهٔ کارت برایتان فرستاده می‌شود.',
    placeholders: [],
    screen: 'topup',
    hint: 'خط آخر صفحهٔ شارژ',
  },
  TOPUP_ASK_AMOUNT: {
    default: '✏️ مبلغ دلخواه را به تومان بفرستید.',
    placeholders: [],
    screen: 'topup',
    hint: 'پرسش «مبلغ دلخواه» — پاسخ به تومان است، همان واحدی که به بانک می‌رود',
  },
  TOPUP_OUT_OF_RANGE: {
    default: '❌ این مبلغ خارج از بازهٔ مجاز است.',
    placeholders: [],
    screen: 'topup',
    hint: 'مبلغ تایپ‌شده عدد بود ولی از کف یا سقف شارژ بیرون',
  },

  // --- کد هدیه -------------------------------------------------------------
  ASK_GIFT_CODE: {
    default: '🎁 کد هدیه را بفرستید.',
    placeholders: [],
    screen: 'gift',
    hint: 'درخواست کد هدیه',
  },
  GIFT_CREDITED: {
    default: '🎁 کد هدیه اعمال شد و {amount} به کیف پول شما اضافه شد.',
    placeholders: ['amount'],
    screen: 'gift',
    hint: 'بعد از اعمال کد هدیه',
  },
  GIFT_BALANCE: {
    default: '💰 موجودی: {balance}',
    placeholders: ['balance'],
    screen: 'gift',
    hint: 'موجودی بعد از کد هدیه',
  },

  // --- کد تخفیف ------------------------------------------------------------
  ASK_DISCOUNT_CODE: {
    default: '🏷 کد تخفیف را بفرستید.\n\nاگر پشیمان شدید، دکمهٔ بازگشت را بزنید.',
    placeholders: [],
    screen: 'discount',
    hint: 'درخواست کد تخفیف',
  },
  DISCOUNT_APPLIED: {
    default: '✅ کد «{code}» اعمال شد — {amount} تخفیف.',
    placeholders: ['code', 'amount'],
    screen: 'discount',
    hint: 'کدی که روی یک پلن مشخص نشست',
  },
  DISCOUNT_HELD_TITLE: {
    default: '✅ کد «{code}» ثبت شد.',
    placeholders: ['code'],
    screen: 'discount',
    hint: 'کدی که پیش از انتخاب پلن تمدید وارد شده',
  },
  DISCOUNT_HELD_BODY: {
    default: 'حالا پلن تمدید را انتخاب کنید؛ اگر کد به آن پلن بخورد، روی فاکتور اعمال می‌شود.',
    placeholders: [],
    screen: 'discount',
    hint: 'خط دوم — عمداً مبلغی قول نمی‌دهد',
  },
  DISCOUNT_TAKEN_OFF: {
    default: 'کد تخفیف برداشته شد.',
    placeholders: [],
    screen: 'discount',
    hint: 'بعد از برداشتن کد',
  },
  // هر دلیل، جملهٔ خودش. ربات قدیمی به هر سه حالت «کد معتبر نیست» می‌گفت و
  // پشتیبانی باید می‌پرسید کدامش بوده.
  DISCOUNT_REFUSED_UNKNOWN_CODE: {
    default: '❌ چنین کدی وجود ندارد. املای آن را بررسی کنید.',
    placeholders: [],
    screen: 'discount',
    hint: 'کدی که وجود ندارد',
  },
  DISCOUNT_REFUSED_EXPIRED: {
    default: '❌ مهلت این کد تمام شده است.',
    placeholders: [],
    screen: 'discount',
    hint: 'کد منقضی',
  },
  DISCOUNT_REFUSED_USED_UP: {
    default: '❌ ظرفیت این کد پر شده است.',
    placeholders: [],
    screen: 'discount',
    hint: 'کدی که سقف استفاده‌اش پر شده',
  },
  DISCOUNT_REFUSED_ALREADY_USED: {
    default: '❌ شما قبلاً از این کد استفاده کرده‌اید.',
    placeholders: [],
    screen: 'discount',
    hint: 'کدی که همین مشتری قبلاً مصرف کرده',
  },
  DISCOUNT_REFUSED_NOT_FOR_THIS: {
    default: '❌ این کد برای این خرید نیست.',
    placeholders: [],
    screen: 'discount',
    hint: 'کدی که به محصول دیگری بسته است',
  },
  DISCOUNT_REFUSED_NOT_FOR_YOU: {
    default: '❌ این کد برای حساب شما نیست.',
    placeholders: [],
    screen: 'discount',
    hint: 'کدی که به مشتری دیگری بسته است',
  },
  DISCOUNT_REFUSED_FIRST_PURCHASE_ONLY: {
    default: '❌ این کد فقط برای اولین خرید است.',
    placeholders: [],
    screen: 'discount',
    hint: 'کد مخصوص اولین خرید',
  },

  // --- پشتیبانی ------------------------------------------------------------
  SUPPORT_SCREEN: {
    default:
      '☎️ پشتیبانی\n\nبرای گفتگو با پشتیبانی به @{handle} پیام بدهید.\n\n🔖 اگر دربارهٔ یک سفارش است، شمارهٔ سفارش را هم بفرستید.',
    // The one live slot. Without it the customer is told to contact support and
    // not told who — a screen that looks complete and is useless.
    placeholders: ['handle'],
    screen: 'support',
    hint: 'صفحهٔ پشتیبانی — {handle} آیدی پشتیبانی است',
  },
  SUPPORT_UNAVAILABLE: {
    default: 'راه ارتباط با پشتیبانی هنوز تنظیم نشده است. کمی بعد دوباره امتحان کنید.',
    placeholders: [],
    screen: 'support',
    hint: 'وقتی آیدی پشتیبانی تنظیم نشده',
  },
  /**
   * The wrapper on a message an operator sends one customer from the dashboard.
   *
   * Filed under «پشتیبانی» because that is who the CUSTOMER thinks it is from,
   * and this is a customer-facing line. It used to live under the bot's own
   * admin panel — where nobody would look for it — and when that panel was
   * removed it nearly went with it, though the only thing that ever rendered it
   * is `customerRoutes.ts` in the dashboard.
   */
  MESSAGE_FROM_SHOP: {
    default: '✉️ پیامی از پشتیبانی:\n\n{body}',
    placeholders: ['body'],
    screen: 'support',
    hint: 'همان چیزی که مشتری می‌بیند — سرخط عمداً جدا از متن است تا پیام ناشناس نباشد',
  },

  // --- آموزش و برنامه‌ها -----------------------------------------------------
  CHOOSE_HELP: {
    default: '📚 آموزش — یک مورد را انتخاب کنید.',
    placeholders: [],
    screen: 'help',
    hint: 'فهرست مطالب آموزشی',
  },
  HELP_EMPTY: {
    default: 'هنوز مطلب آموزشی ثبت نشده است.',
    placeholders: [],
    screen: 'help',
    hint: 'وقتی مطلب آموزشی نیست',
  },
  HELP_ARTICLE_TITLE: {
    default: '📚 {title}',
    placeholders: ['title'],
    screen: 'help',
    hint: 'عنوان یک مطلب آموزشی',
  },
  APPS_TITLE: {
    default: '📱 برنامه‌های پیشنهادی',
    placeholders: [],
    screen: 'help',
    hint: 'خط اول فهرست برنامه‌ها',
  },
  APPS_ITEM: {
    default: '• {name} — {platform}',
    placeholders: ['name', 'platform'],
    screen: 'help',
    hint: 'یک برنامه، وقتی پلتفرمش ثبت شده',
  },
  APPS_ITEM_NO_PLATFORM: {
    default: '• {name}',
    placeholders: ['name'],
    screen: 'help',
    hint: 'یک برنامه، وقتی پلتفرمش ثبت نشده',
  },
  APPS_EMPTY: {
    default: 'هنوز برنامه‌ای ثبت نشده است.',
    placeholders: [],
    screen: 'help',
    hint: 'وقتی برنامه‌ای ثبت نشده',
  },

  // --- زیرمجموعه‌گیری --------------------------------------------------------
  REFERRAL_TITLE: {
    default: '👥 زیرمجموعه‌گیری',
    placeholders: [],
    screen: 'referral',
    hint: 'خط اول صفحهٔ زیرمجموعه‌گیری',
  },
  REFERRAL_TERMS: {
    default:
      'هر کسی با لینک شما وارد شود، از «اولین خرید» او {percent}٪ به کیف پول شما اضافه می‌شود.',
    placeholders: ['percent'],
    screen: 'referral',
    hint: 'شرح پورسانت — «اولین خرید» عمداً گفته می‌شود',
  },
  REFERRAL_INVITED: {
    default: '👤 دعوت‌شده‌ها: {count}',
    placeholders: ['count'],
    screen: 'referral',
    hint: 'تعداد دعوت‌شده‌ها',
  },
  REFERRAL_EARNED: {
    default: '💰 درآمد تا امروز: {amount}',
    placeholders: ['amount'],
    screen: 'referral',
    hint: 'پورسانت دریافتی تا امروز',
  },
  REFERRAL_LINK_LABEL: {
    default: '🔗 لینک دعوت شما:',
    placeholders: [],
    screen: 'referral',
    hint: 'خط بالای لینک دعوت',
  },

  // --- نمایندگی ------------------------------------------------------------
  ASK_RESELLER_REQUEST: {
    default:
      '👨‍💻 درخواست نمایندگی\n\nدر یک پیام بنویسید چه می‌فروشید، چند مشتری دارید، و چرا نمایندگی می‌خواهید.\nهمین پیام برای ادمین فرستاده می‌شود.',
    placeholders: [],
    screen: 'reseller',
    hint: 'درخواست توضیح از متقاضی نمایندگی',
  },
  RESELLER_REQUEST_FILED: {
    default: '✅ درخواست شما ثبت شد.\n\nبعد از بررسی، نتیجه همین‌جا به شما اطلاع داده می‌شود.',
    placeholders: [],
    screen: 'reseller',
    hint: 'بعد از ثبت درخواست',
  },
  RESELLER_REQUEST_OPEN: {
    default: '🕓 درخواست شما ثبت شده و در حال بررسی است. تا اعلام نتیجه، درخواست تازه لازم نیست.',
    placeholders: [],
    screen: 'reseller',
    hint: 'وقتی درخواست باز دارد',
  },
  RESELLER_REQUEST_EMPTY: {
    default: 'لطفاً توضیح‌تان را در یک پیام متنی بفرستید.',
    placeholders: [],
    screen: 'reseller',
    hint: 'وقتی متن درخواست خالی است',
  },
  ALREADY_RESELLER: {
    default: '✅ شما از قبل نماینده هستید.',
    placeholders: [],
    screen: 'reseller',
    hint: 'وقتی از قبل نماینده است',
  },

  // --- هشدارهای خودکار -----------------------------------------------------
  WARN_TIME_TITLE: {
    default: '⏳ سرویس شما رو به پایان است.',
    placeholders: [],
    screen: 'warnings',
    hint: 'هشدار نزدیک‌شدن به تاریخ انقضا',
  },
  WARN_TIME_DAYS: {
    default: '📅 {days} روز تا پایان اعتبار',
    placeholders: ['days'],
    screen: 'warnings',
    hint: 'روزهای باقی‌مانده',
  },
  WARN_VOLUME_TITLE: {
    default: '📉 حجم سرویس شما رو به پایان است.',
    placeholders: [],
    screen: 'warnings',
    hint: 'هشدار تمام‌شدن حجم',
  },
  WARN_VOLUME_REMAINING: {
    default: '📦 باقی‌مانده: {remaining}',
    placeholders: ['remaining'],
    screen: 'warnings',
    hint: 'حجم باقی‌مانده',
  },
  // The third unprompted message, and the only one that is not about running
  // out: the customer bought something and never plugged it in. Mirzabot sends
  // it too (`cronbot/on_hold.php`), from the panel's own `on_hold` status.
  WARN_UNUSED_TITLE: {
    default: '🔌 هنوز به سرویس‌تان وصل نشده‌اید.',
    placeholders: [],
    screen: 'warnings',
    hint: 'یادآوری برای سرویسی که خریده شده و هیچ مصرفی ندارد',
  },
  WARN_UNUSED_DAYS: {
    default: '📅 {days} روز از خریدش گذشته و هیچ مصرفی روی آن ثبت نشده است.',
    placeholders: ['days'],
    screen: 'warnings',
    hint: 'چند روز از خرید گذشته',
  },
  WARN_UNUSED_SUPPORT: {
    default: 'اگر در راه‌اندازی مشکلی دارید به @{handle} پیام بدهید — کمک‌تان می‌کنیم.',
    placeholders: ['handle'],
    screen: 'warnings',
    hint: 'فقط وقتی آیدی پشتیبانی در تنظیمات پر باشد',
  },
  // --- ضد-اسپم ---------------------------------------------------------------
  // `index.php:307` — ۳۵ پیام در یک دقیقه و کاربر مسدود می‌شود. متن مشتری از
  // `users.spam.spamedMessage` لگاسی می‌آید و متن کانال از `spamedReport`.
  SPAM_BLOCKED: {
    default: '📌 کاربر گرامی، حساب شما به‌دلیل ارسال پیام بیش از حد در ربات مسدود شد.',
    placeholders: [],
    screen: 'warnings',
    hint: 'به خودِ کاربر، همان لحظه‌ای که بلاک می‌شود',
  },
  SPAM_BLOCKED_REPORT: {
    default: '🚫 کاربر با شناسهٔ عددی <code>{telegramId}</code> به‌دلیل اسپم در ربات بلاک شد.',
    placeholders: ['telegramId'],
    screen: 'warnings',
    hint: 'به کانال گزارش، با دکمهٔ باز کردن همان کاربر',
  },

  PAGING_PREV: {
    default: '« قبلی',
    placeholders: [],
    screen: 'paging',
    hint: 'دکمهٔ صفحهٔ قبل در فهرست‌های چندصفحه‌ای',
  },
  PAGING_NEXT: {
    default: 'بعدی »',
    placeholders: [],
    screen: 'paging',
    hint: 'دکمهٔ صفحهٔ بعد در فهرست‌های چندصفحه‌ای',
  },
  WARN_SERVICE: {
    default: '🔐 {service}',
    placeholders: ['service'],
    screen: 'warnings',
    hint: 'نام سرویس — چون ۱٬۶۸۷ مشتری بیش از یک سرویس دارند',
  },
  WARN_RENEW_HINT: {
    default: 'برای اینکه سرویس‌تان قطع نشود، از دکمهٔ «{renewButton}» در منوی اصلی استفاده کنید.',
    placeholders: ['renewButton'],
    screen: 'warnings',
    hint: 'خط آخر هر دو هشدار — {renewButton} نام زندهٔ دکمهٔ تمدید است',
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
  | { kind: 'UNKNOWN_PLACEHOLDER'; names: string[] }
  | CustomEmojiProblem;

/**
 * Telegram refuses a message body longer than this.
 *
 * A single line may not exceed it, which is necessary but no longer sufficient:
 * a screen is many lines now, and their sum is what is actually sent. The bot
 * clamps the assembled message in `telegram.ts` for that reason — a shop that
 * writes an essay into every line gets a truncated screen, not a silent failure
 * to answer.
 */
export const MAX_TEXT_LENGTH = 4096;

/**
 * Whether this replacement may be stored, and what is wrong with it if not.
 *
 * Returns null when the override is acceptable. Pure, so the admin API and the
 * bot can reach the same verdict without either calling the other.
 */
export function checkOverride(
  key: string,
  value: string,
  options: { customEmoji?: boolean } = {},
): OverrideProblem | null {
  if (!isTextKey(key)) return { kind: 'UNKNOWN_KEY' };
  if (value.trim() === '') return { kind: 'EMPTY' };
  if (value.length > MAX_TEXT_LENGTH) return { kind: 'TOO_LONG', limit: MAX_TEXT_LENGTH };
  // Off by default. A caller that does not know whether the shop has custom
  // emoji switched on is a caller that must not accept markup — the failure of
  // guessing "on" is angle brackets in front of a customer.
  const emoji = checkCustomEmoji(value, options.customEmoji === true);
  if (emoji !== null) return emoji;

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

  /**
   * @param customEmoji whether the shop has custom emoji switched on.
   *
   * When it is off, markup in a stored override is **stripped to its fallback
   * emoji**, not rejected. Rejecting would drop the whole override and put the
   * shipped default in front of the customer — so switching the feature off, or
   * having it switched off automatically after Telegram refused, would silently
   * throw away every sentence the shop had rewritten. Falling back to the
   * fallback is what the markup is for.
   */
  constructor(overrides: Record<string, string> = {}, customEmoji = false) {
    const kept: Partial<Record<TextKey, string>> = {};
    for (const [key, raw] of Object.entries(overrides)) {
      const value = customEmoji ? raw : stripCustomEmoji(raw);
      if (isTextKey(key) && checkOverride(key, value, { customEmoji }) === null) {
        kept[key] = value;
      }
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
