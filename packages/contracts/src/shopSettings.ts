/**
 * Every setting the shop actually reads, with a name a person can understand.
 *
 * `/admin/settings` printed the settings TABLE: 163 rows of raw key and raw
 * value, sorted by scope, most of them dead columns the Mirzabot importer
 * copied across — `Lottery_Status`, `Dice`, `ticketstatus`, ten `topic_*` rows
 * nothing has ever read. An operator looking for «چند روز قبل از انقضا هشدار
 * برود» read forty lines of `daywarn`-shaped noise to find it, and every one of
 * those lines was editable.
 *
 * This is the other half: the keys that are LIVE, each with a label, a hint and
 * a kind. The screen draws a form from it and shows the rest read-only in an
 * «وارداتی» tab, and the server refuses a write to anything not listed here.
 *
 * ## Why it lives in contracts
 *
 * Three readers need the same answer and must not each keep a copy: the bot
 * reads the values, the dashboard decides what may be written, and the panel
 * draws the form. `apps/bot/src/settings.ts` derives its own key tuple from
 * this array, so a key that is not here cannot be read with the typed helpers
 * either — which is what makes the list a fact rather than documentation.
 *
 * ## What is deliberately absent
 *
 * `Lottery_*` and `Dice`: Sam's decision on 2026-08-20 — «ما گردونه شانس
 * نداریم» — so those are not unbuilt features, they are declined ones.
 * `ticket*`: the department/ticket system is off in production and its seven
 * tickets are all unread (Sam, 08-22). A key here is a promise the panel will
 * honour a change to it; those three would be lies.
 */

export type SettingKind = 'bool' | 'int' | 'irr' | 'text' | 'chatId';

export interface ShopSetting {
  scope: 'bot' | 'shop' | 'pay' | 'panel';
  key: string;
  label: string;
  /** One sentence about what changing it does. Shown under the control. */
  hint: string;
  kind: SettingKind;
}

/**
 * `on` for a switch is the string the bot compares against, not `true`.
 *
 * The legacy rows store `'on'`/`'off'` and, in a few places, `'1'`/`'0'` — and
 * which one a given key uses is not a convention, it is whatever the PHP wrote.
 * The dashboard sends back exactly what it was given for anything it does not
 * recognise, so a key whose truth value this file guesses wrong fails loudly at
 * the form rather than quietly at the bot.
 */
export const SETTING_ON = 'on';

/*
 * `as const`, and that is what makes this a contract rather than a list.
 *
 * `apps/bot/src/settings.ts` derives its key union from this array, so a key
 * missing here cannot be read with the typed helpers at all — the bot fails to
 * COMPILE rather than failing a test. A widened `readonly ShopSetting[]` would
 * collapse every key to `string` and turn forty checked reads back into
 * unchecked lookups, which is the trap the tuple in that file already carried a
 * comment about.
 */
export const SHOP_SETTINGS = [
  // ── The shop's front door ───────────────────────────────────────────────
  {
    scope: 'bot',
    key: 'Bot_Status',
    label: 'ربات روشن است',
    hint: 'خاموش که باشد، ربات به هیچ پیامی جواب نمی‌دهد جز به ادمین‌ها.',
    kind: 'bool',
  },
  {
    scope: 'shop',
    key: 'configshow',
    label: 'نمایش کانفیگ در ربات',
    hint: 'کانفیگ سرویس بعد از خرید داخل چت نشان داده شود یا فقط لینک.',
    kind: 'bool',
  },
  {
    scope: 'bot',
    key: 'statuscopycart',
    label: 'کپی‌کردن شمارهٔ کارت',
    hint: 'دکمهٔ کپی زیر شمارهٔ کارت در پیام پرداخت.',
    kind: 'bool',
  },
  {
    scope: 'bot',
    key: 'linkappstatus',
    label: 'نمایش لینک اپلیکیشن',
    hint: 'لینک دانلود اپ همراه کانفیگ فرستاده شود.',
    kind: 'bool',
  },
  {
    scope: 'bot',
    key: 'roll_Status',
    label: 'ثبت‌نام آزاد',
    hint: 'خاموش که باشد کاربر تازه نمی‌تواند وارد ربات شود.',
    kind: 'bool',
  },

  // ── Extra volume and time ───────────────────────────────────────────────
  {
    scope: 'shop',
    key: 'statusextra',
    label: 'فروش حجم اضافه',
    hint: 'مشتری می‌تواند به سرویس فعالش حجم اضافه کند.',
    kind: 'bool',
  },
  {
    scope: 'shop',
    key: 'statustimeextra',
    label: 'فروش زمان اضافه',
    hint: 'مشتری می‌تواند به سرویس فعالش روز اضافه کند.',
    kind: 'bool',
  },
  {
    scope: 'shop',
    key: 'statuschangeservice',
    label: 'تغییر سرویس',
    hint: 'مشتری می‌تواند سرویسش را با یکی دیگر عوض کند.',
    kind: 'bool',
  },

  // ── Money ───────────────────────────────────────────────────────────────
  {
    scope: 'pay',
    key: 'minbalancecart',
    label: 'کمینهٔ شارژ کیف پول',
    hint: 'کمتر از این مبلغ، شارژ پذیرفته نمی‌شود.',
    kind: 'irr',
  },
  {
    scope: 'pay',
    key: 'maxbalancecart',
    label: 'بیشینهٔ شارژ کیف پول',
    hint: 'بیشتر از این مبلغ، شارژ پذیرفته نمی‌شود.',
    kind: 'irr',
  },
  {
    scope: 'bot',
    key: 'affiliatespercentage',
    label: 'درصد پورسانت زیرمجموعه',
    hint: 'از اولین خرید هر زیرمجموعه، این درصد به معرف داده می‌شود.',
    kind: 'int',
  },
  {
    scope: 'shop',
    key: 'chashbackextend',
    label: 'درصد هدیهٔ تمدید',
    hint: 'از هر تمدید، این درصد به کیف پول مشتری برمی‌گردد.',
    kind: 'int',
  },
  {
    scope: 'bot',
    key: 'order_ttl_hours',
    label: 'مهلت پرداخت فاکتور (ساعت)',
    hint: 'بعد از این مدت، فاکتور پرداخت‌نشده منقضی می‌شود.',
    kind: 'int',
  },

  // ── Warnings the bot sends ──────────────────────────────────────────────
  {
    scope: 'bot',
    key: 'daywarn',
    label: 'هشدار انقضا (روز)',
    hint: 'چند روز مانده به انقضا به مشتری خبر داده شود.',
    kind: 'int',
  },
  {
    scope: 'bot',
    key: 'volumewarn',
    label: 'هشدار حجم (گیگ)',
    hint: 'با چند گیگ باقی‌مانده به مشتری خبر داده شود.',
    kind: 'int',
  },
  {
    scope: 'bot',
    key: 'on_hold_day',
    label: 'مهلت اتصال اولیه (روز)',
    hint: 'سرویس خریداری‌شده تا این تعداد روز منتظر اولین اتصال می‌ماند.',
    kind: 'int',
  },
  {
    scope: 'bot',
    key: 'nudge_after_days',
    label: 'یادآوری به نخریده‌ها (روز)',
    hint: 'کسی که ثبت‌نام کرده و نخریده، بعد از این تعداد روز یادآوری می‌گیرد.',
    kind: 'int',
  },

  // ── The sweeps ──────────────────────────────────────────────────────────
  {
    scope: 'bot',
    key: 'cron_warn_time',
    label: 'کرون: هشدار انقضا',
    hint: 'روزی یک بار به سرویس‌های رو به انقضا پیام می‌دهد.',
    kind: 'bool',
  },
  {
    scope: 'bot',
    key: 'cron_warn_volume',
    label: 'کرون: هشدار حجم',
    hint: 'روزی یک بار به سرویس‌های رو به اتمام حجم پیام می‌دهد.',
    kind: 'bool',
  },
  {
    scope: 'bot',
    key: 'cron_warn_unused',
    label: 'کرون: هشدار سرویس بلااستفاده',
    hint: 'به سرویسی که خریده شده و وصل نشده پیام می‌دهد.',
    kind: 'bool',
  },
  {
    scope: 'bot',
    key: 'cron_remove_expired',
    label: 'کرون: حذف سرویس منقضی',
    hint: 'اکانت مشتری را از پنل پاک می‌کند و برگشت ندارد.',
    kind: 'bool',
  },
  {
    scope: 'bot',
    key: 'cron_remove_volume',
    label: 'کرون: حذف سرویس بی‌حجم',
    hint: 'اکانت مشتری را از پنل پاک می‌کند و برگشت ندارد.',
    kind: 'bool',
  },
  {
    scope: 'bot',
    key: 'cron_nudge_never_bought',
    label: 'کرون: یادآوری به نخریده‌ها',
    hint: 'به کاربرانی که ثبت‌نام کرده‌اند و هیچ خریدی نکرده‌اند پیام می‌دهد.',
    kind: 'bool',
  },
  {
    scope: 'bot',
    key: 'cron_remove_dry_run',
    label: 'کرون حذف فقط گزارش بدهد',
    hint: 'روشن که باشد، کرون‌های حذف چیزی پاک نمی‌کنند و فقط گزارش می‌دهند. پیش‌فرض روشن است.',
    kind: 'bool',
  },
  {
    scope: 'bot',
    key: 'removedayc',
    label: 'مهلت حذف بعد از انقضا (روز)',
    hint: 'سرویس منقضی چند روز بماند و بعد پاک شود.',
    kind: 'int',
  },
  {
    scope: 'bot',
    key: 'cronvolumere',
    label: 'آستانهٔ حذف بی‌حجم (گیگ)',
    hint: 'با کمتر از این حجم باقی‌مانده، سرویس نامزد حذف می‌شود.',
    kind: 'int',
  },
  {
    scope: 'bot',
    key: 'limit_usertest_all',
    label: 'سقف سرویس تست',
    hint: 'در کل چند سرویس تست داده شود. صفر یعنی بدون سقف.',
    kind: 'int',
  },

  // ── Where the bot talks ─────────────────────────────────────────────────
  {
    scope: 'bot',
    key: 'Channel_Report',
    label: 'کانال گزارش',
    hint: 'شناسهٔ عددی کانالی که گزارش‌ها به آن می‌رود.',
    kind: 'chatId',
  },
  {
    scope: 'bot',
    key: 'statussupportpv',
    label: 'پشتیبانی از طریق پیام خصوصی',
    hint: 'خاموش که باشد، دکمهٔ پشتیبانی به کانال می‌برد نه به پی‌وی.',
    kind: 'bool',
  },
  {
    scope: 'bot',
    key: 'id_support',
    label: 'شناسهٔ پشتیبان',
    hint: 'آیدی عددی تلگرام کسی که پیام‌های پشتیبانی به او می‌رسد.',
    kind: 'chatId',
  },
  {
    scope: 'bot',
    key: 'username',
    label: 'نام کاربری پشتیبان',
    hint: 'بدون @ — در متن‌ها به‌جای {support} می‌نشیند.',
    kind: 'text',
  },

  // ── Appearance ──────────────────────────────────────────────────────────
  {
    scope: 'bot',
    key: 'custom_emoji',
    label: 'ایموجی پریمیوم',
    hint: 'خاموش که باشد ربات ایموجی ساده می‌فرستد؛ روشن، برای کاربران غیرپریمیوم هم درست دیده می‌شود.',
    kind: 'bool',
  },
  {
    scope: 'shop',
    key: 'plan_button_template',
    label: 'قالب دکمهٔ سرویس',
    hint: 'مثل {name} — {volume} گیگ — {days} روز. هر توکن با مقدار همان سرویس پر می‌شود.',
    kind: 'text',
  },
] as const satisfies readonly ShopSetting[];

/** The key of any setting the shop reads. */
export type ShopSettingKey = (typeof SHOP_SETTINGS)[number]['key'];

/** Fast membership test for the server's «may this be written» check. */
const LIVE = new Set(SHOP_SETTINGS.map((s) => `${s.scope}/${s.key}`));

/**
 * Whether a key is one the shop reads.
 *
 * The dashboard refuses a write to anything else with `409 imported_key`
 * rather than storing it: a value nothing reads, edited on a screen that
 * accepted it, is worse than one the screen never offered.
 */
export function isLiveSetting(scope: string, key: string): boolean {
  return LIVE.has(`${scope}/${key}`);
}

export function shopSetting(scope: string, key: string): ShopSetting | undefined {
  return SHOP_SETTINGS.find((s) => s.scope === scope && s.key === key);
}
