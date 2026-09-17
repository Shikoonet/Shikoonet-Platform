/**
 * Every setting the shop actually reads, with a name a person can understand.
 *
 * `/admin/settings` printed the settings TABLE: 163 rows of raw key and raw
 * value, sorted by scope, most of them dead columns the Mirzabot importer
 * copied across — `Lottery_Status`, `Dice`, `ticketstatus` and the rest. (The
 * ten `topic_*` rows were listed here as dead too, for a day, and they are
 * not: the bot reads every one of them. See `REPORT_TOPIC_SETTINGS` below.)
 * An operator looking for «چند روز قبل از انقضا هشدار
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

import { REPORT_KINDS, REPORT_TOPIC_TITLES, reportTopicKey, type ReportKind } from './reportTopics.js';

export type SettingKind = 'bool' | 'int' | 'irr' | 'text' | 'chatId';

/**
 * The exact strings ONE switch's reader recognises.
 *
 * There is no shop-wide convention and there never was. `Bot_Status` is off on
 * `botstatusoff` and on nothing else; `statuscopycart` uses `1`/`0`; the cron
 * toggles are this platform's own and use `true`/`false`. The words come from
 * the PHP that wrote the rows — `legacy/mirzabot-php/admin.php` — for the nine
 * imported switches, and from `loadShopSettings` for ours.
 *
 * `unknown` is what a value matching NEITHER means, and it is not decoration:
 * for the seven read through `isOff` the rule is «off only on the exact word»,
 * so an unrecognised row is ON, and for `roll_Status` the rule is the opposite.
 * A form that guessed would draw the shop-open switch in the wrong position.
 */
export interface SettingTruth {
  on: string;
  off: string;
  unknown: 'on' | 'off';
}

export interface ShopSetting {
  scope: 'bot' | 'shop' | 'pay' | 'panel';
  key: string;
  label: string;
  /** One sentence about what changing it does. Shown under the control. */
  hint: string;
  kind: SettingKind;
  /** Required for `kind: 'bool'`, meaningless otherwise. */
  truth?: SettingTruth;
}

/**
 * `SETTING_ON` was here, and the comment it carried is why it is not.
 *
 * It said: «the legacy rows store `'on'`/`'off'` and, in a few places,
 * `'1'`/`'0'` — and which one a given key uses is not a convention, it is
 * whatever the PHP wrote». That was correct, and the file exported a single
 * `SETTING_ON = 'on'` for all seventeen switches anyway. Pressing
 * «ربات روشن است» to close the shop wrote `'off'`; the bot compares against
 * `'botstatusoff'`; the shop stayed open and kept selling. Each entry now
 * carries its own `truth`, taken from the reader.
 */

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
const TYPED_OUT_SETTINGS = [
  // ── The shop's front door ───────────────────────────────────────────────
  {
    scope: 'bot',
    key: 'Bot_Status',
    label: 'ربات روشن است',
    hint: 'خاموش که باشد، ربات به هیچ پیامی جواب نمی‌دهد جز به ادمین‌ها.',
    kind: 'bool',
    truth: { on: 'botstatuson', off: 'botstatusoff', unknown: 'on' },
  },
  {
    scope: 'shop',
    key: 'configshow',
    label: 'نمایش کانفیگ در ربات',
    hint: 'کانفیگ سرویس بعد از خرید داخل چت نشان داده شود یا فقط لینک.',
    kind: 'bool',
    truth: { on: 'onconfig', off: 'offconfig', unknown: 'on' },
  },
  {
    scope: 'bot',
    key: 'statuscopycart',
    label: 'کپی‌کردن شمارهٔ کارت',
    hint: 'دکمهٔ کپی زیر شمارهٔ کارت در پیام پرداخت.',
    kind: 'bool',
    truth: { on: '1', off: '0', unknown: 'on' },
  },
  {
    scope: 'bot',
    key: 'linkappstatus',
    label: 'نمایش لینک اپلیکیشن',
    hint: 'لینک دانلود اپ همراه کانفیگ فرستاده شود.',
    kind: 'bool',
    truth: { on: '1', off: '0', unknown: 'on' },
  },
  {
    scope: 'bot',
    key: 'roll_Status',
    label: 'ثبت‌نام آزاد',
    hint: 'خاموش که باشد کاربر تازه نمی‌تواند وارد ربات شود.',
    kind: 'bool',
    truth: { on: 'rolleon', off: 'rolleoff', unknown: 'off' },
  },

  // ── Extra volume and time ───────────────────────────────────────────────
  {
    scope: 'shop',
    key: 'statusextra',
    label: 'فروش حجم اضافه',
    hint: 'مشتری می‌تواند به سرویس فعالش حجم اضافه کند.',
    kind: 'bool',
    truth: { on: 'onextra', off: 'offextra', unknown: 'on' },
  },
  {
    scope: 'shop',
    key: 'statustimeextra',
    label: 'فروش زمان اضافه',
    hint: 'مشتری می‌تواند به سرویس فعالش روز اضافه کند.',
    kind: 'bool',
    truth: { on: 'ontimeextraa', off: 'offtimeextraa', unknown: 'on' },
  },
  {
    scope: 'shop',
    key: 'statuschangeservice',
    label: 'تغییر سرویس',
    hint: 'مشتری می‌تواند سرویسش را با یکی دیگر عوض کند.',
    kind: 'bool',
    truth: { on: 'onstatus', off: 'offstatus', unknown: 'on' },
  },

  // ── Money ───────────────────────────────────────────────────────────────
  // Both rows hold TOMAN, as the PHP wrote them; `settings.ts` multiplies by
  // ten on the way in (`tomanLimit`). The label says so because the form has
  // no unit of its own, and an operator who read «10000000» as Rial and
  // «corrected» it would set a ceiling ten times what they meant.
  {
    scope: 'pay',
    key: 'minbalancecart',
    label: 'کمینهٔ شارژ کیف پول (تومان)',
    hint: 'کمتر از این مبلغ، شارژ پذیرفته نمی‌شود.',
    kind: 'irr',
  },
  {
    scope: 'pay',
    key: 'maxbalancecart',
    label: 'بیشینهٔ شارژ کیف پول (تومان)',
    hint: 'بیشتر از این مبلغ، شارژ پذیرفته نمی‌شود.',
    kind: 'irr',
  },
  {
    scope: 'pay',
    key: 'card_hold_minutes',
    label: 'مهلت پرداخت فاکتور و نگه‌داشتن کارت (دقیقه)',
    hint: 'کارتی که روی فاکتور چاپ شد، این‌قدر دقیقه به کس دیگری داده نمی‌شود و فاکتور هم همین‌قدر معتبر است. سر مهلت، کارت آزاد و پیام فاکتور در چت مشتری «منقضی شد» می‌شود — «پرداخت کردم» مهلت را بلندتر نمی‌کند؛ پرداخت ادعاشده در صف بررسی می‌ماند. کمتر از ۱ پذیرفته نمی‌شود و ۱۰ فرض می‌شود.',
    kind: 'int',
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
    truth: { on: 'true', off: 'false', unknown: 'on' },
  },
  {
    scope: 'bot',
    key: 'cron_warn_volume',
    label: 'کرون: هشدار حجم',
    hint: 'روزی یک بار به سرویس‌های رو به اتمام حجم پیام می‌دهد.',
    kind: 'bool',
    truth: { on: 'true', off: 'false', unknown: 'on' },
  },
  {
    scope: 'bot',
    key: 'cron_warn_unused',
    label: 'کرون: هشدار سرویس بلااستفاده',
    hint: 'به سرویسی که خریده شده و وصل نشده پیام می‌دهد.',
    kind: 'bool',
    truth: { on: 'true', off: 'false', unknown: 'on' },
  },
  {
    scope: 'bot',
    key: 'cron_remove_expired',
    label: 'کرون: حذف سرویس منقضی',
    hint: 'اکانت مشتری را از پنل پاک می‌کند و برگشت ندارد.',
    kind: 'bool',
    truth: { on: 'true', off: 'false', unknown: 'off' },
  },
  {
    scope: 'bot',
    key: 'cron_remove_volume',
    label: 'کرون: حذف سرویس بی‌حجم',
    hint: 'اکانت مشتری را از پنل پاک می‌کند و برگشت ندارد.',
    kind: 'bool',
    truth: { on: 'true', off: 'false', unknown: 'off' },
  },
  {
    scope: 'bot',
    key: 'cron_nudge_never_bought',
    label: 'کرون: یادآوری به نخریده‌ها',
    hint: 'به کاربرانی که ثبت‌نام کرده‌اند و هیچ خریدی نکرده‌اند پیام می‌دهد.',
    kind: 'bool',
    truth: { on: 'true', off: 'false', unknown: 'off' },
  },
  {
    scope: 'bot',
    key: 'cron_remove_dry_run',
    label: 'کرون حذف فقط گزارش بدهد',
    hint: 'روشن که باشد، کرون‌های حذف چیزی پاک نمی‌کنند و فقط گزارش می‌دهند. پیش‌فرض روشن است.',
    kind: 'bool',
    truth: { on: 'true', off: 'false', unknown: 'on' },
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
    key: 'spam_limit_per_minute',
    label: 'حداکثر پیام یک مشتری در دقیقه',
    hint: 'بیشتر از این، مشتری خودکار مسدود می‌شود و به گروه گزارش خبر می‌رود؛ در نیمهٔ راه یک هشدار می‌گیرد. ادمین‌های ربات معاف‌اند.',
    kind: 'int',
  },
  {
    scope: 'bot',
    key: 'limit_usertest_all',
    label: 'هر مشتری چند بار اکانت تست بگیرد',
    // The old hint said «در کل … صفر یعنی بدون سقف» — the opposite of what
    // the bot does with it (`settings.ts`: per customer, and zero switches
    // trials OFF). Sam asked for this setting on 2026-09-16 without knowing
    // it existed; the words were why.
    hint: 'سقف برای هر مشتری، روی همهٔ پنل‌ها. صفر یعنی اکانت تست خاموش. ریست‌کردن شمارنده در «ارسال گروهی» است.',
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
    truth: { on: 'onpvsupport', off: 'offpvsupport', unknown: 'off' },
  },
  // A HANDLE, not a chat id. The PHP wrote it from a username the admin typed
  // (`admin.php:8021`) and the bot puts it on the support screen as «@…»
  // (`menu.supportScreen`). It was `chatId` here, so the form drew a number
  // box that could not show «admiinturbo» — production's value — and the
  // empty box invited a number, which the screen would then have printed as
  // «@12345». Seen 2026-09-16, the first night on the real shop.
  {
    scope: 'bot',
    key: 'id_support',
    label: 'نام کاربری پشتیبان',
    hint: 'بدون @ — دکمهٔ پشتیبانی مشتری را به این حساب می‌فرستد.',
    kind: 'text',
  },
  // The BOT's own username, and the bot writes it itself on every boot from
  // `getMe` (`server.ts`) — so the referral links it hands out cannot name a
  // different bot. The old label called it the support handle and the hint
  // named a `{support}` placeholder that exists nowhere; an operator who
  // «fixed» it would have had it overwritten at the next restart.
  {
    scope: 'bot',
    key: 'username',
    label: 'نام کاربری ربات',
    hint: 'ربات خودش در هر بوت از تلگرام می‌گیرد و لینک معرفی را از آن می‌سازد؛ تغییرش با اولین ری‌استارت برمی‌گردد.',
    kind: 'text',
  },

  // ── Appearance ──────────────────────────────────────────────────────────
  {
    scope: 'bot',
    key: 'custom_emoji',
    label: 'ایموجی پریمیوم',
    hint: 'خاموش که باشد ربات ایموجی ساده می‌فرستد؛ روشن، برای کاربران غیرپریمیوم هم درست دیده می‌شود.',
    kind: 'bool',
    truth: { on: 'true', off: 'false', unknown: 'off' },
  },
  {
    scope: 'shop',
    key: 'plan_button_template',
    label: 'قالب دکمهٔ سرویس',
    hint: 'مثل {name} — {volume} گیگ — {days} روز. هر توکن با مقدار همان سرویس پر می‌شود.',
    kind: 'text',
  },
] as const satisfies readonly ShopSetting[];

/**
 * The ten report topics, generated rather than typed out.
 *
 * The header of this file used to name them among the dead imported rows —
 * «ten `topic_*` rows nothing has ever read» — and `loadShopSettings` had been
 * reading all ten the whole time, as ``topicId(num(`topic_${k}`))``. The cast
 * on that line, `as ShopSettingKey`, is what let the two coexist: it told the
 * compiler a question had been answered that nobody had asked. The registry's
 * own test could not see it either, because a key built from a template
 * literal is invisible to a regex looking for a quoted string.
 *
 * So the shop's report topics were not editable: the panel filed all ten under
 * «وارداتی» and the server answered `409 imported_key` to any change.
 *
 * Generated from `REPORT_KINDS` so that an eleventh kind cannot arrive without
 * its setting, and titled from `REPORT_TOPIC_TITLES` so the form says the same
 * words as the topic the report lands in.
 */
const REPORT_TOPIC_SETTINGS: readonly ShopSetting[] = REPORT_KINDS.map((kind) => ({
  scope: 'bot',
  key: reportTopicKey(kind),
  label: `تاپیک ${REPORT_TOPIC_TITLES[kind]}`,
  hint: 'شمارهٔ تاپیک این گزارش در گروه گزارش‌ها. خالی یعنی به خودِ گروه برود.',
  kind: 'int',
}));

export const SHOP_SETTINGS: readonly ShopSetting[] = [
  ...TYPED_OUT_SETTINGS,
  ...REPORT_TOPIC_SETTINGS,
];

/**
 * The key of any setting the shop reads.
 *
 * A union of the literal keys above and the ten generated ones, so the bot's
 * typed helpers still fail to COMPILE on a key that is not here — which was
 * the whole point of `as const`, and what the cast was quietly undoing.
 */
export type ShopSettingKey =
  | (typeof TYPED_OUT_SETTINGS)[number]['key']
  | `topic_${ReportKind}`;

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
