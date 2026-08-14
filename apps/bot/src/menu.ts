/**
 * Every screen the customer sees, as pure functions.
 *
 * No database, no network, no clock. A keyboard is data, and building it out of
 * data that has already been fetched keeps the interesting part — what a
 * customer is allowed to see — in catalog.ts where it can be enforced once,
 * rather than smeared across the code that draws buttons.
 *
 * The main menu is not invented. It is the production layout, read out of
 * `setting.keyboardmain` on the 2026-08-11 dump:
 *
 *   [["text_extend","text_sell"],
 *    ["accountwallet","text_Purchased_services"],
 *    ["text_support","text_help","text_affiliates"]]
 *
 * with `requestAgent` appended for non-resellers, and `inlinebtnmain` set to
 * `oninline` — so it is an inline keyboard, not a reply keyboard. Customers
 * have this muscle memory; the replacement bot should not move their buttons.
 *
 * ponytail: Persian only, inline. The `lang` column exists and production is
 * 11,240 'fa' to one 'en'; wire up a second language when it has a customer.
 */

import { encode, encodeRef } from './callback.js';
import type { CatalogPlan, Panel } from './catalog.js';
import { DEFAULT_CONTENT, type BotContent } from './botContent.js';
import { buildMainMenu, DEFAULT_LAYOUT, type ButtonPlacement } from './keyboard.js';
import { DEFAULT_TEXTS, type Texts } from '@shikoo/contracts';
import { formatToman, nameMentionsPrice, priceForUser, type Price } from './money.js';
import type { InlineKeyboard } from './telegram.js';

/**
 * The sentences an admin may rewrite.
 *
 * These are `let`, not `const`, and that is the whole wiring: ES module exports
 * are live bindings, so `applyContent` reassigning them is seen by every
 * `menu.X` in `handle.ts` without a single call site changing. The defaults come
 * from `texts.ts`, which is where they now live — one definition, editable and
 * rendered from the same place.
 *
 * Safe because the bot handles one update at a time (`poll.ts` awaits each
 * `handleUpdate` in a plain `for` loop). If that ever becomes concurrent, this
 * becomes shared mutable state between customers and must be threaded through
 * instead.
 */
export let WELCOME = DEFAULT_TEXTS.raw('WELCOME');
export let MENU_TITLE = DEFAULT_TEXTS.raw('MENU_TITLE');
export let SOON = DEFAULT_TEXTS.raw('SOON');
export let CHOOSE_PANEL = DEFAULT_TEXTS.raw('CHOOSE_PANEL');
export let CHOOSE_PLAN = DEFAULT_TEXTS.raw('CHOOSE_PLAN');
/** Shown when a panel that was listed a moment ago now has nothing on it. */
export let PANEL_EMPTY = DEFAULT_TEXTS.raw('PANEL_EMPTY');
/** No panel has anything this customer can buy. */
export let SHOP_EMPTY = DEFAULT_TEXTS.raw('SHOP_EMPTY');
/** The one answer to a plan that is gone, hidden, or was never theirs to see. */
export let PLAN_GONE = DEFAULT_TEXTS.raw('PLAN_GONE');
export let NOT_REGISTERED = DEFAULT_TEXTS.raw('NOT_REGISTERED');
/** For the few screens handle.ts builds a one-button keyboard for itself. */
export let BACK_TO_MENU_LABEL = DEFAULT_TEXTS.raw('BACK_TO_MENU_LABEL');

export let ASK_DISCOUNT_CODE = DEFAULT_TEXTS.raw('ASK_DISCOUNT_CODE');
export let ASK_GIFT_CODE = DEFAULT_TEXTS.raw('ASK_GIFT_CODE');
export let ASK_RESELLER_REQUEST = DEFAULT_TEXTS.raw('ASK_RESELLER_REQUEST');
export let RESELLER_REQUEST_FILED = DEFAULT_TEXTS.raw('RESELLER_REQUEST_FILED');
export let RESELLER_REQUEST_OPEN = DEFAULT_TEXTS.raw('RESELLER_REQUEST_OPEN');
export let ALREADY_RESELLER = DEFAULT_TEXTS.raw('ALREADY_RESELLER');
export let RESELLER_REQUEST_EMPTY = DEFAULT_TEXTS.raw('RESELLER_REQUEST_EMPTY');
export let SUPPORT_UNAVAILABLE = DEFAULT_TEXTS.raw('SUPPORT_UNAVAILABLE');
export let HELP_EMPTY = DEFAULT_TEXTS.raw('HELP_EMPTY');
export let CHOOSE_HELP = DEFAULT_TEXTS.raw('CHOOSE_HELP');
export let APPS_EMPTY = DEFAULT_TEXTS.raw('APPS_EMPTY');
export let REFERRAL_WELCOME = DEFAULT_TEXTS.raw('REFERRAL_WELCOME');
export let NO_CARD_AVAILABLE = DEFAULT_TEXTS.raw('NO_CARD_AVAILABLE');
export let ORDER_NOT_PAYABLE = DEFAULT_TEXTS.raw('ORDER_NOT_PAYABLE');
export let MY_SERVICES_EMPTY = DEFAULT_TEXTS.raw('MY_SERVICES_EMPTY');
export let SERVICE_GONE = DEFAULT_TEXTS.raw('SERVICE_GONE');
export let ACTION_UNSUPPORTED = DEFAULT_TEXTS.raw('ACTION_UNSUPPORTED');
export let CONFIRM_REVOKE = DEFAULT_TEXTS.raw('CONFIRM_REVOKE');
export let ADDON_NOT_A_NUMBER = DEFAULT_TEXTS.raw('ADDON_NOT_A_NUMBER');
export let NOTHING_TO_RENEW = DEFAULT_TEXTS.raw('NOTHING_TO_RENEW');
export let CHOOSE_SERVICE_TO_RENEW = DEFAULT_TEXTS.raw('CHOOSE_SERVICE_TO_RENEW');
export let RENEWAL_GONE = DEFAULT_TEXTS.raw('RENEWAL_GONE');
export let RENEWAL_CLOSED = DEFAULT_TEXTS.raw('RENEWAL_CLOSED');
export let NO_RENEWAL_PLAN = DEFAULT_TEXTS.raw('NO_RENEWAL_PLAN');
export let WALLET_TOO_LITTLE = DEFAULT_TEXTS.raw('WALLET_TOO_LITTLE');
export let DISCOUNT_TAKEN_OFF = DEFAULT_TEXTS.raw('DISCOUNT_TAKEN_OFF');
export let ORDER_GONE = DEFAULT_TEXTS.raw('ORDER_GONE');

/** The active texts, for the screens that fill in a slot rather than read one. */
let TEXTS_NOW: Texts = DEFAULT_TEXTS;
/** The active main-menu layout. */
let LAYOUT_NOW: readonly ButtonPlacement[] = DEFAULT_LAYOUT;

let BACK_TO_MENU = BACK_TO_MENU_LABEL;

/**
 * Points this module at the content the admin has saved.
 *
 * Called once per update, before anything is drawn. Everything it touches is a
 * live binding, so nothing downstream has to know it happened.
 */
export function applyContent(content: BotContent): void {
  const t = content.texts;
  TEXTS_NOW = t;
  LAYOUT_NOW = content.layout;
  WELCOME = t.raw('WELCOME');
  MENU_TITLE = t.raw('MENU_TITLE');
  SOON = t.raw('SOON');
  CHOOSE_PANEL = t.raw('CHOOSE_PANEL');
  CHOOSE_PLAN = t.raw('CHOOSE_PLAN');
  PANEL_EMPTY = t.raw('PANEL_EMPTY');
  SHOP_EMPTY = t.raw('SHOP_EMPTY');
  PLAN_GONE = t.raw('PLAN_GONE');
  NOT_REGISTERED = t.raw('NOT_REGISTERED');
  BACK_TO_MENU_LABEL = t.raw('BACK_TO_MENU_LABEL');
  BACK_TO_MENU = BACK_TO_MENU_LABEL;
  ASK_DISCOUNT_CODE = t.raw('ASK_DISCOUNT_CODE');
  ASK_GIFT_CODE = t.raw('ASK_GIFT_CODE');
  ASK_RESELLER_REQUEST = t.raw('ASK_RESELLER_REQUEST');
  RESELLER_REQUEST_FILED = t.raw('RESELLER_REQUEST_FILED');
  RESELLER_REQUEST_OPEN = t.raw('RESELLER_REQUEST_OPEN');
  ALREADY_RESELLER = t.raw('ALREADY_RESELLER');
  RESELLER_REQUEST_EMPTY = t.raw('RESELLER_REQUEST_EMPTY');
  SUPPORT_UNAVAILABLE = t.raw('SUPPORT_UNAVAILABLE');
  HELP_EMPTY = t.raw('HELP_EMPTY');
  CHOOSE_HELP = t.raw('CHOOSE_HELP');
  APPS_EMPTY = t.raw('APPS_EMPTY');
  REFERRAL_WELCOME = t.raw('REFERRAL_WELCOME');
  NO_CARD_AVAILABLE = t.raw('NO_CARD_AVAILABLE');
  ORDER_NOT_PAYABLE = t.raw('ORDER_NOT_PAYABLE');
  MY_SERVICES_EMPTY = t.raw('MY_SERVICES_EMPTY');
  SERVICE_GONE = t.raw('SERVICE_GONE');
  ACTION_UNSUPPORTED = t.raw('ACTION_UNSUPPORTED');
  CONFIRM_REVOKE = t.raw('CONFIRM_REVOKE');
  ADDON_NOT_A_NUMBER = t.raw('ADDON_NOT_A_NUMBER');
  NOTHING_TO_RENEW = t.raw('NOTHING_TO_RENEW');
  CHOOSE_SERVICE_TO_RENEW = t.raw('CHOOSE_SERVICE_TO_RENEW');
  RENEWAL_GONE = t.raw('RENEWAL_GONE');
  RENEWAL_CLOSED = t.raw('RENEWAL_CLOSED');
  NO_RENEWAL_PLAN = t.raw('NO_RENEWAL_PLAN');
  WALLET_TOO_LITTLE = t.raw('WALLET_TOO_LITTLE');
  DISCOUNT_TAKEN_OFF = t.raw('DISCOUNT_TAKEN_OFF');
  ORDER_GONE = t.raw('ORDER_GONE');
}

/** Back to what the code ships. Tests call this so one does not colour the next. */
export function resetContent(): void {
  applyContent(DEFAULT_CONTENT);
}

export function mainMenu(isReseller: boolean): InlineKeyboard {
  return buildMainMenu(LAYOUT_NOW, isReseller);
}

export function panelMenu(panels: Panel[]): InlineKeyboard {
  const keyboard: InlineKeyboard = panels.map((panel) => [
    { text: panel.name, callback_data: encode('panel', panel.id) },
  ]);
  keyboard.push([{ text: BACK_TO_MENU, callback_data: encode('menu') }]);
  return keyboard;
}

/**
 * One row per plan.
 *
 * The price is appended only when the name does not already carry it. Every
 * migrated product has it typed in ('...-195.000ت') because the legacy schema
 * had nowhere else to put it, and appending ours makes the button say the
 * number twice — seen on the live bot on 2026-08-12.
 *
 * A discounted customer always gets the price appended, whatever the name says,
 * because then the name is quoting a price that is not theirs. Production has
 * this backwards: with `statusshowprice = 'offshowprice'` it shows the raw name,
 * so the eight customers with a standing discount read the full price on the
 * button and a different one at checkout.
 */
export function planMenu(plans: CatalogPlan[], discountPercent = 0): InlineKeyboard {
  const keyboard: InlineKeyboard = plans.map((plan) => {
    const price = priceForUser(plan.priceIrr, discountPercent);
    const quoted = price.discountIrr === 0 && nameMentionsPrice(plan.productName, plan.priceIrr);
    return [
      {
        text: quoted ? plan.productName : `${plan.productName} — ${formatToman(price.totalIrr)}`,
        callback_data: encode('plan', plan.planId),
      },
    ];
  });
  keyboard.push([
    { text: 'بازگشت به لوکیشن‌ها ⬅️', callback_data: encode('buy') },
    { text: BACK_TO_MENU, callback_data: encode('menu') },
  ]);
  return keyboard;
}

/** A code the customer typed and the checker allowed, as the screen shows it. */
export interface AppliedCode {
  code: string;
  discountIrr: number;
}

export function planDetail(plan: CatalogPlan, price: Price, applied?: AppliedCode | null): string {
  const lines = [
    `🔐 ${plan.productName}`,
    `📍 لوکیشن: ${plan.providerName}`,
    '',
    `📦 حجم: ${plan.volumeGb === null ? 'نامحدود' : `${plan.volumeGb} گیگابایت`}`,
    `⏳ مدت: ${plan.durationDays === null ? 'بدون محدودیت زمان' : `${plan.durationDays} روز`}`,
  ];
  if (plan.userLimit !== null) {
    lines.push(`👥 کاربر همزمان: ${plan.userLimit}`);
  }
  lines.push('');
  const codeOff = applied?.discountIrr ?? 0;
  if (price.discountIrr > 0 || codeOff > 0) {
    lines.push(`💵 قیمت: ${formatToman(price.unitPriceIrr)}`);
  }
  if (price.discountIrr > 0) {
    lines.push(`🎁 تخفیف شما: ${formatToman(price.discountIrr)}`);
  }
  if (applied && codeOff > 0) {
    lines.push(`🏷 کد «${applied.code}»: ${formatToman(codeOff)}`);
  }
  // The floor is the same one `order.ts` applies, and for the same reason: two
  // discounts on one price must not add up to more than the price.
  const payable = Math.max(0, price.totalIrr - codeOff);
  lines.push(`💳 قابل پرداخت: ${formatToman(payable)}`);
  return lines.join('\n');
}

export function planDetailMenu(plan: CatalogPlan, applied?: AppliedCode | null): InlineKeyboard {
  return [
    [{ text: '✅ ثبت سفارش', callback_data: encode('order', plan.planId) }],
    [
      applied
        ? { text: '🏷 برداشتن کد تخفیف', callback_data: encode('dsx', plan.planId) }
        : { text: '🏷 کد تخفیف دارم', callback_data: encode('dsc', plan.planId) },
    ],
    [
      { text: 'بازگشت ⬅️', callback_data: encode('panel', plan.providerId) },
      { text: BACK_TO_MENU, callback_data: encode('menu') },
    ],
  ];
}

/**
 * Support.
 *
 * Production runs `statussupportpv = 'onpvsupport'` with `id_support` set, which
 * means support on the live bot is "message this person", not a ticket system.
 * The ticket tables exist and hold seven messages from before that switch; they
 * stay unread until an admin asks for them back.
 *
 * The handle is written as plain text on purpose. Messages carry no
 * `parse_mode`, and Telegram turns `@name` into a link by itself — so this
 * needs no markup and cannot be broken by a handle with an underscore in it.
 */
export function supportScreen(handle: string): string {
  // The one screen an admin may rewrite that still has to carry a value. The
  // slot is filled here rather than concatenated, so an override that moves
  // «@{handle}» to a different line still says who to contact — and one that
  // drops it never reaches the database.
  return TEXTS_NOW.render('SUPPORT_SCREEN', { handle });
}

export function helpMenu(
  articles: { id: number; title: string }[],
  hasApps: boolean,
): InlineKeyboard {
  const keyboard: InlineKeyboard = articles.map((a) => [
    { text: shortName(a.title), callback_data: encode('hlp', a.id) },
  ]);
  if (hasApps) keyboard.push([{ text: '📱 برنامه‌ها', callback_data: encode('app') }]);
  keyboard.push([{ text: BACK_TO_MENU, callback_data: encode('menu') }]);
  return keyboard;
}

export function helpArticleScreen(title: string, body: string): string {
  return body.trim() === '' ? `📚 ${title}` : `📚 ${title}\n\n${body}`;
}

// ---------------------------------------------------------------------------
// The admin panel. Every screen below is drawn only after `admins` said yes.
// ---------------------------------------------------------------------------

export const ADMIN_HOME = '🛠 پنل ادمین';

export function adminHome(waiting: number): string {
  return [
    ADMIN_HOME,
    '',
    waiting === 0
      ? '✅ رسیدی در انتظار بررسی نیست.'
      : `🧾 ${waiting.toLocaleString('en-US')} پرداخت در انتظار تصمیم شماست.`,
  ].join('\n');
}

export function adminMenu(waiting: number): InlineKeyboard {
  const keyboard: InlineKeyboard = [];
  if (waiting > 0) {
    keyboard.push([{ text: '🧾 بررسی پرداخت‌ها', callback_data: encode('clm') }]);
  }
  keyboard.push([{ text: BACK_TO_MENU, callback_data: encode('menu') }]);
  return keyboard;
}

export const NO_CLAIMS = '✅ در حال حاضر پرداختی در انتظار بررسی نیست.';

/**
 * Says which role is missing rather than just "no".
 *
 * An operator who does not know they are SUPPORT reads a bare refusal as a
 * broken button and presses it again; naming the reason sends them to whoever
 * can change it instead.
 */
export const ADMIN_NOT_ALLOWED =
  '⛔ این کار از دسترس نقش شما بیرون است.\n\nبررسی و تایید پرداخت فقط برای نقش ادمین و مالک باز است. اگر لازمش دارید از مالک ربات بخواهید نقش شما را تغییر دهد.';

/** One line per waiting payment: who, how much, and what the engine thought. */
export function claimList(page: number, pages: number, total: number): string {
  const head = `🧾 پرداخت‌های در انتظار (${total.toLocaleString('en-US')} مورد)`;
  return pages > 1 ? `${head}\n\nصفحهٔ ${page} از ${pages}` : head;
}

export interface ClaimRow {
  id: string;
  expected_amount_irr: number;
  username: string | null;
  telegram_id: number | null;
  suspect_reason: string | null;
}

export function claimListMenu(
  claims: ClaimRow[],
  page: number,
  pages: number,
): InlineKeyboard {
  const keyboard: InlineKeyboard = claims.map((c) => [
    {
      text: `${formatToman(c.expected_amount_irr)} — ${c.username ?? c.telegram_id ?? '؟'}`,
      callback_data: encodeRef('clv', c.id),
    },
  ]);
  if (pages > 1) {
    const paging: InlineKeyboard[number] = [];
    if (page > 1) paging.push({ text: '« قبلی', callback_data: encode('clm', page - 1) });
    if (page < pages) paging.push({ text: 'بعدی »', callback_data: encode('clm', page + 1) });
    keyboard.push(paging);
  }
  keyboard.push([{ text: '🛠 پنل ادمین', callback_data: encode('pnl') }]);
  return keyboard;
}

/**
 * One payment, with everything an admin needs to decide and nothing they do
 * not — no card number in full, and no raw SMS text.
 */
export function claimDetail(
  claim: {
    external_order_id: string;
    expected_amount_irr: number;
    card_digits: string | null;
    paid_clicked_at: number | null;
    suspect_reason: string | null;
    username: string | null;
    telegram_id: number | null;
  },
  candidates: { amount_irr: number; bank_timestamp: number; sender: string | null }[],
): string {
  const lines = [
    '🧾 بررسی پرداخت',
    '',
    `👤 مشتری: ${claim.username ? `@${claim.username}` : (claim.telegram_id ?? '؟')}`,
    `💳 مبلغ: ${formatToman(claim.expected_amount_irr)}`,
    `🔖 مرجع: ${claim.external_order_id}`,
  ];
  if (claim.card_digits) lines.push(`🏦 کارت مقصد: ${claim.card_digits.slice(-4)}`);
  if (claim.paid_clicked_at !== null) {
    lines.push(`🕓 «پرداخت کردم»: ${formatTehranDate(new Date(claim.paid_clicked_at))}`);
  }
  if (claim.suspect_reason) lines.push(`⚠️ نظر سامانه: ${claim.suspect_reason}`);
  lines.push('');
  lines.push(
    candidates.length === 0
      ? '🔍 هیچ تراکنش بانکی متناظری پیدا نشد.'
      : `🔍 ${candidates.length} تراکنش بانکی با همین مبلغ و همین حساب:`,
  );
  for (const c of candidates) {
    lines.push(
      `• ${formatToman(c.amount_irr)} — ${formatTehranDate(new Date(c.bank_timestamp))}` +
        (c.sender ? ` — ${c.sender}` : ''),
    );
  }
  return lines.join('\n');
}

export function claimDetailMenu(
  candidates: { id: string; bank_timestamp: number }[],
): InlineKeyboard {
  const keyboard: InlineKeyboard = candidates.map((c) => [
    {
      text: `✅ تایید با تراکنش ${formatTehranTime(new Date(c.bank_timestamp))}`,
      callback_data: encodeRef('apv', c.id),
    },
  ]);
  keyboard.push([{ text: '⚠️ تایید بدون تراکنش', callback_data: encode('apx') }]);
  keyboard.push([{ text: '❌ رد کردن', callback_data: encode('rej') }]);
  keyboard.push([{ text: 'بازگشت ⬅️', callback_data: encode('clm') }]);
  return keyboard;
}

export const CONFIRM_APPROVE_WITHOUT_TX = [
  '⚠️ تایید بدون تراکنش بانکی',
  '',
  'یعنی این پرداخت فقط با تصمیم شما تسویه می‌شود و هیچ تراکنش بانکی پشتش نیست.',
  'این کار در دفتر ممیزی به نام شما ثبت می‌شود.',
].join('\n');

export const CONFIRM_REJECT = [
  '❌ رد کردن این پرداخت',
  '',
  'مشتری سرویس نمی‌گیرد و پرداخت به حالت رد شده می‌رود.',
  'این کار در دفتر ممیزی به نام شما ثبت می‌شود.',
].join('\n');

export function confirmMenu(): InlineKeyboard {
  return [
    [{ text: 'بله، انجام شود', callback_data: encode('cnf') }],
    [{ text: 'بازگشت ⬅️', callback_data: encode('clm') }],
  ];
}

export const CLAIM_GONE = 'این پرداخت دیگر در انتظار بررسی نیست.';

export function claimApproved(amountIrr: number): string {
  return `✅ پرداخت ${formatToman(amountIrr)} تایید شد و سفارش مشتری به جریان افتاد.`;
}

export function claimRejected(amountIrr: number): string {
  return `❌ پرداخت ${formatToman(amountIrr)} رد شد.`;
}

export function claimNotApproved(reason: string): string {
  return `⛔ تایید انجام نشد: ${reason}`;
}

/**
 * The referral screen.
 *
 * The percentage and the "first purchase" limit are stated because they are the
 * whole deal: production pays ten percent of a referred customer's FIRST
 * purchase and nothing after it, and a screen that said "commission on your
 * friends' purchases" would be selling something that does not exist.
 */
export function referralScreen(
  link: string,
  invited: number,
  earnedIrr: number,
  percent: number,
): string {
  return [
    '👥 زیرمجموعه‌گیری',
    '',
    // No parse_mode anywhere in this bot, so emphasis is quotation marks.
    `هر کسی با لینک شما وارد شود، از «اولین خرید» او ${percent}٪ به کیف پول شما اضافه می‌شود.`,
    '',
    `👤 دعوت‌شده‌ها: ${invited.toLocaleString('en-US')}`,
    `💰 درآمد تا امروز: ${formatToman(earnedIrr)}`,
    '',
    '🔗 لینک دعوت شما:',
    link,
  ].join('\n');
}

export function referralMenu(): InlineKeyboard {
  return [[{ text: BACK_TO_MENU, callback_data: encode('menu') }]];
}

/**
 * The apps, as a list of links in one message.
 *
 * Not buttons: a `callback_data` button cannot open a link, and the URL button
 * Telegram does have would need the whole keyboard type widened for eight rows
 * of text that read perfectly well as text.
 */
export function appsScreen(apps: { name: string; platform: string | null; link: string }[]): string {
  const lines = ['📱 برنامه‌های پیشنهادی', ''];
  for (const app of apps) {
    lines.push(app.platform ? `• ${app.name} — ${app.platform}` : `• ${app.name}`);
    lines.push(app.link, '');
  }
  return lines.join('\n').trimEnd();
}

/**
 * A code accepted before a plan is chosen.
 *
 * It deliberately promises nothing about the amount. On the renewal path the
 * plan comes after the code, and some codes are tied to one product — so the
 * only honest thing to say here is that it will be applied where it fits.
 */
export function discountHeldForRenewal(code: string): string {
  return [
    `✅ کد «${code}» ثبت شد.`,
    '',
    'حالا پلن تمدید را انتخاب کنید؛ اگر کد به آن پلن بخورد، روی فاکتور اعمال می‌شود.',
  ].join('\n');
}


/**
 * Why a code was refused, in the customer's words.
 *
 * Each reason gets its own sentence. The legacy bot answers "code is not valid"
 * to an expired code, a used-up code and a code for another product alike, and
 * support then has to ask which of the three it was.
 */
export const DISCOUNT_REFUSED: Record<string, string> = {
  UNKNOWN_CODE: '❌ چنین کدی وجود ندارد. املای آن را بررسی کنید.',
  EXPIRED: '❌ مهلت این کد تمام شده است.',
  USED_UP: '❌ ظرفیت این کد پر شده است.',
  ALREADY_USED: '❌ شما قبلاً از این کد استفاده کرده‌اید.',
  NOT_FOR_THIS: '❌ این کد برای این خرید نیست.',
  NOT_FOR_YOU: '❌ این کد برای حساب شما نیست.',
  FIRST_PURCHASE_ONLY: '❌ این کد فقط برای اولین خرید است.',
};

export function discountApplied(code: string, offIrr: number): string {
  return `✅ کد «${code}» اعمال شد — ${formatToman(offIrr)} تخفیف.`;
}

export function giftCredited(amountIrr: number, balanceIrr: number): string {
  return [
    `🎁 کد هدیه اعمال شد و ${formatToman(amountIrr)} به کیف پول شما اضافه شد.`,
    `💰 موجودی: ${formatToman(balanceIrr)}`,
  ].join('\n');
}

/**
 * The checkout screen: what to pay, where to pay it, and the one button that
 * says it is done.
 *
 * The amount is spelled out in full and never rounded for display. Card-to-card
 * verification compares the bank's number against this one exactly — no
 * tolerance — so a customer who sends a "close enough" amount lands in manual
 * review. Telling them the precise number is the cheapest way to prevent that.
 */
export function checkout(
  publicId: string,
  plan: CatalogPlan,
  totalIrr: number,
  cardDigits: string,
  cardHolder: string | null,
): string {
  const lines = [
    '🧾 سفارش شما ثبت شد. برای تکمیل، مبلغ زیر را کارت‌به‌کارت کنید.',
    '',
    `🔖 شمارهٔ سفارش: ${publicId}`,
    `🔐 سرویس: ${plan.productName}`,
    `💳 مبلغ دقیق: ${formatToman(totalIrr)}`,
    '',
    '🏦 شمارهٔ کارت:',
    formatCard(cardDigits),
  ];
  if (cardHolder) lines.push(`👤 به نام: ${cardHolder}`);
  lines.push(
    '',
    'لطفاً دقیقاً همین مبلغ را واریز کنید — مبلغ متفاوت بررسی دستی می‌خواهد و طول می‌کشد.',
    'بعد از واریز، دکمهٔ زیر را بزنید.',
  );
  return lines.join('\n');
}

/**
 * `6037997512345678` -> `6037-9975-1234-5678`.
 *
 * Grouped because a customer types this into a banking app by hand and an
 * unbroken 16-digit run is where the typo happens. Messages carry no
 * `parse_mode`, so there is no code formatting to lean on — the grouping is
 * the whole affordance.
 */
export function formatCard(digits: string): string {
  return digits.replace(/(\d{4})(?=\d)/g, '$1-');
}

/**
 * The buttons under a checkout screen.
 *
 * `wallet` is omitted for a deposit — paying a deposit out of the balance is a
 * circle — and present for anything being sold. When the balance covers the
 * order the customer never has to visit a bank at all, which is the whole point
 * of the wallet; when it does not, the offer is to deposit the difference
 * rather than to work it out themselves.
 */
export function checkoutMenu(
  orderId: number,
  wallet?: { balanceIrr: number; totalIrr: number },
): InlineKeyboard {
  const keyboard: InlineKeyboard = [];
  if (wallet && wallet.balanceIrr >= wallet.totalIrr) {
    keyboard.push([
      {
        text: `💰 پرداخت از کیف پول (${formatToman(wallet.balanceIrr)})`,
        callback_data: encode('wpay', orderId),
      },
    ]);
  } else if (wallet && wallet.balanceIrr > 0) {
    keyboard.push([
      {
        text: `💰 شارژ کیف پول (موجودی: ${formatToman(wallet.balanceIrr)})`,
        callback_data: encode('tpo', orderId),
      },
    ]);
  }
  keyboard.push([{ text: '✅ پرداخت کردم', callback_data: encode('paid', orderId) }]);
  keyboard.push([{ text: BACK_TO_MENU, callback_data: encode('menu') }]);
  return keyboard;
}

/** Every card is disabled or busy. Honest about it, and does not pretend. */

export function paidRecorded(publicId: string): string {
  return [
    '🕓 ممنون. پرداخت شما ثبت شد و در حال بررسی است.',
    '',
    `🔖 شمارهٔ پیگیری: ${publicId}`,
    '',
    'به‌محض تایید تراکنش، سرویس برایتان ارسال می‌شود. معمولاً چند دقیقه طول می‌کشد.',
  ].join('\n');
}

/** Second press of a button that is already spent. Same screen, no scolding. */
export function paidAlready(publicId: string): string {
  return [
    '🕓 پرداخت این سفارش قبلاً ثبت شده و در حال بررسی است.',
    '',
    `🔖 شمارهٔ پیگیری: ${publicId}`,
  ].join('\n');
}


/**
 * Sent unprompted once the bank transaction is matched to the payment.
 *
 * Deliberately does not promise the service in the next breath — provisioning
 * is a separate step and may still fail. Saying "confirmed" is true now; saying
 * "here it is" would not be.
 */
export function paymentConfirmed(publicId: string): string {
  return [
    '✅ پرداخت شما تایید شد.',
    '',
    `🔖 شمارهٔ پیگیری: ${publicId}`,
    '',
    'سفارش شما در صف آماده‌سازی قرار گرفت.',
  ].join('\n');
}

export function afterPaidMenu(): InlineKeyboard {
  return [[{ text: BACK_TO_MENU, callback_data: encode('menu') }]];
}

/**
 * The message the whole purchase exists to produce: the service itself.
 *
 * The subscription link goes on its own line with nothing after it, because
 * Telegram's autolinker stops at whitespace and a customer who taps a link with
 * a trailing Persian word gets a broken address. No `parse_mode` is used
 * anywhere in this file, so the URL is never inside markup either.
 */
export function serviceReady(
  subscriptionUrl: string,
  username: string,
  expiresAt: Date | null,
): string {
  const lines = ['🎉 سرویس شما آماده است.', '', `👤 نام کاربری: ${username}`];
  if (expiresAt !== null) {
    lines.push(`📅 اعتبار تا: ${formatTehranDate(expiresAt)}`);
  }
  lines.push('', '🔗 لینک اشتراک:', subscriptionUrl, '', 'این لینک را در برنامهٔ خود وارد کنید.');
  return lines.join('\n');
}

/**
 * Sold, paid, and waiting on a person — a manual product, or a kind whose
 * adapter is not written yet. Distinct from the failure message on purpose:
 * nothing is wrong, it is simply not instant.
 */
export function serviceBeingPrepared(publicId: string): string {
  return [
    '✅ پرداخت شما تایید شد و سفارش ثبت شد.',
    '',
    `🔖 شمارهٔ پیگیری: ${publicId}`,
    '',
    'این سرویس به‌صورت دستی آماده می‌شود و به‌زودی برایتان ارسال می‌گردد.',
  ].join('\n');
}

/**
 * Something went wrong that trying again will not fix.
 *
 * Says the money is safe first. That is the customer's actual question, and the
 * order is sitting in FAILED with a reason attached for whoever picks it up.
 */
/**
 * `refundedIrr` is what went back into the wallet, or null when nothing did.
 *
 * The old wording said the payment "is safe" whatever had happened. For a bank
 * transfer that is true — the money is in the account. For an order paid from
 * the balance it was not: the credit had been spent and the service never
 * arrived, so "safe" meant "we still have your money". Say which one it was.
 */
export function serviceNeedsHelp(publicId: string, refundedIrr: number | null = null): string {
  const lines = [
    refundedIrr === null
      ? '⚠️ پرداخت شما ثبت شده و محفوظ است، ولی آماده‌سازی سرویس به مشکل خورد.'
      : '⚠️ آماده‌سازی سرویس به مشکل خورد.',
    '',
    `🔖 شمارهٔ پیگیری: ${publicId}`,
  ];
  if (refundedIrr !== null) {
    lines.push(`💰 مبلغ ${formatToman(refundedIrr)} به کیف پول شما برگشت.`);
  }
  lines.push('', 'همکاران ما پیگیری می‌کنند. لطفاً این شماره را نگه دارید.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// «سرویس های من» — what the customer already owns
// ---------------------------------------------------------------------------


/** How many services fit on one screen without the keyboard becoming a wall. */
export const SERVICES_PER_PAGE = 8;

const BYTES_PER_GB = 1024 ** 3;

/**
 * What state a service is really in.
 *
 * `subscriptions.status` alone is not the answer: it stays 'ACTIVE' after the
 * expiry date passes and after the volume runs out, because neither of those
 * is an event anybody writes — they are simply true from a moment onward. The
 * panel knows, but asking it is a network call, so the two facts that decide it
 * (`expires_at`, `used_bytes` against `volume_gb`) are compared here instead.
 *
 * Deliberately not written back to the row. A clock that is briefly wrong, or a
 * usage figure the sync has not refreshed yet, would otherwise permanently
 * mark a service the customer paid for as dead.
 */
export type ServiceState =
  | 'ACTIVE'
  | 'EXPIRED'
  | 'EXHAUSTED'
  | 'ON_HOLD'
  | 'DISABLED'
  | 'REMOVED'
  | 'FAILED';

/**
 * What a row in a list needs, and no more.
 *
 * Narrow on purpose: the renewal list reads a different query than the service
 * list, and widening this to the full row would have meant filling in fields
 * that query never selects with plausible-looking nulls.
 */
export interface ServiceListItem {
  id: number;
  status: string;
  plan_name_at_sale: string;
  volume_gb: number | null;
  used_bytes: number | null;
  expires_at: string | null;
}

/** Everything the detail screen shows. */
export interface ServiceView extends ServiceListItem {
  public_id: string;
  provider_name_at_sale: string | null;
  remote_username: string | null;
  subscription_url: string | null;
}

export function serviceState(service: ServiceListItem, now: number): ServiceState {
  if (service.status !== 'ACTIVE') {
    switch (service.status) {
      case 'ON_HOLD':
        return 'ON_HOLD';
      case 'DISABLED':
        return 'DISABLED';
      case 'REMOVED':
        return 'REMOVED';
      default:
        return 'FAILED';
    }
  }
  if (service.expires_at !== null && Date.parse(service.expires_at) <= now) {
    return 'EXPIRED';
  }
  // Unmetered plans have no volume, so there is nothing to run out of.
  if (
    service.volume_gb !== null &&
    service.volume_gb > 0 &&
    service.used_bytes !== null &&
    service.used_bytes >= service.volume_gb * BYTES_PER_GB
  ) {
    return 'EXHAUSTED';
  }
  return 'ACTIVE';
}

const STATE_GLYPH: Record<ServiceState, string> = {
  ACTIVE: '✅',
  EXPIRED: '⌛',
  EXHAUSTED: '📵',
  ON_HOLD: '⏸',
  DISABLED: '⛔',
  REMOVED: '🗑',
  FAILED: '⚠️',
};

const STATE_LABEL: Record<ServiceState, string> = {
  ACTIVE: 'فعال',
  EXPIRED: 'تاریخ انقضا گذشته',
  EXHAUSTED: 'حجم تمام شده',
  ON_HOLD: 'در انتظار فعال‌سازی',
  DISABLED: 'غیرفعال',
  REMOVED: 'حذف شده',
  FAILED: 'مشکل در آماده‌سازی',
};

/** Telegram wraps a long button onto several lines and the list stops being
 *  scannable. The name carries the plan, the duration and the price, so the
 *  front of it is the part worth keeping. */
function shortName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length <= 38 ? trimmed : `${trimmed.slice(0, 37)}…`;
}

export function myServicesTitle(total: number, page: number, pages: number): string {
  const head = `🛍 سرویس‌های شما (${total} مورد)`;
  return pages > 1 ? `${head}\n\nصفحهٔ ${page} از ${pages}` : head;
}

/**
 * One row per service, plus paging when there is more than one screenful.
 *
 * Page numbers travel in `callback_data` and are therefore untrusted — which
 * costs nothing, because a page is only an OFFSET into a query already scoped
 * to this customer. The worst a forged page can produce is an empty list.
 */
export function myServicesMenu(
  services: ServiceListItem[],
  now: number,
  page: number,
  pages: number,
): InlineKeyboard {
  const keyboard: InlineKeyboard = services.map((service) => [
    {
      text: `${STATE_GLYPH[serviceState(service, now)]} ${shortName(service.plan_name_at_sale)}`,
      callback_data: encode('sub', service.id),
    },
  ]);
  if (pages > 1) {
    const paging: InlineKeyboard[number] = [];
    if (page > 1) paging.push({ text: '« قبلی', callback_data: encode('mine', page - 1) });
    if (page < pages) paging.push({ text: 'بعدی »', callback_data: encode('mine', page + 1) });
    keyboard.push(paging);
  }
  keyboard.push([{ text: BACK_TO_MENU, callback_data: encode('menu') }]);
  return keyboard;
}

/** Ten cells: one per ten percent, and short enough not to wrap on a phone. */
const BAR_CELLS = 10;

/**
 * The quota, drawn.
 *
 * Faoxima does this as an 800×400 PNG through GD — a dark card, a circular
 * gauge, a bundled Persian font, a temp file per view. Ten characters do the
 * same job: no image library, no font file, nothing written to disk, and every
 * Telegram client already renders them, because they are text.
 *
 * The isolate is not decoration. This line sits inside a message whose
 * paragraph direction is right-to-left, and block characters carry no
 * direction of their own; between `\u2066` and `\u2069` the bar fills from the
 * same end everywhere, instead of from whichever end the surrounding Persian
 * happens to impose.
 *
 * The percentage rounds, but 100 is reserved: a quota at 99.7% reads 99%, and
 * only a quota that is genuinely finished reads 100%. Telling a customer their
 * service is finished while it still works is a support ticket; being a
 * fraction of a percent out is not.
 *
 * Flooring instead was the first attempt and the browser found it: 62.00% in
 * the database came out as 61% on the screen, because the division lands a
 * hair under.
 */
export function usageBar(usedBytes: number, volumeGb: number): string {
  const ratio = usedBytes / (volumeGb * BYTES_PER_GB);
  const percent = ratio >= 1 ? 100 : ratio <= 0 ? 0 : Math.min(99, Math.round(ratio * 100));
  const filled = Math.floor((percent * BAR_CELLS) / 100);
  return `\u2066${'█'.repeat(filled)}${'░'.repeat(BAR_CELLS - filled)} ${percent}%\u2069`;
}

/** `1288490188` -> `'1.2 گیگابایت'`. Latin digits, like every other number here. */
export function formatGigabytes(bytes: number): string {
  const gb = bytes / BYTES_PER_GB;
  // Under a tenth of a gigabyte "0.0" reads as nothing at all, which is wrong
  // for a customer who has just started using a service.
  const shown = gb > 0 && gb < 0.1 ? gb.toFixed(2) : gb.toFixed(1);
  return `${Number(shown).toLocaleString('en-US')} گیگابایت`;
}

/**
 * One service, in full.
 *
 * The link is only shown while the service can actually be used. Handing a
 * customer the config of an expired or exhausted account is how support gets
 * "I imported it and nothing works" — the link resolves, the account is dead,
 * and nothing on the screen said so.
 */
export function serviceDetail(service: ServiceView, now: number): string {
  const state = serviceState(service, now);
  const lines = [
    `${STATE_GLYPH[state]} ${service.plan_name_at_sale}`,
    `وضعیت: ${STATE_LABEL[state]}`,
  ];
  if (service.provider_name_at_sale) {
    lines.push(`📍 لوکیشن: ${service.provider_name_at_sale}`);
  }
  lines.push(`🔖 شمارهٔ سرویس: ${service.public_id}`);
  if (service.remote_username) {
    lines.push(`👤 نام کاربری: ${service.remote_username}`);
  }

  lines.push('');
  if (service.volume_gb === null) {
    lines.push('📦 حجم: نامحدود');
    if (service.used_bytes !== null) {
      lines.push(`📊 مصرف شده: ${formatGigabytes(service.used_bytes)}`);
    }
  } else {
    lines.push(`📦 حجم: ${service.volume_gb.toLocaleString('en-US')} گیگابایت`);
    if (service.used_bytes !== null) {
      const remaining = Math.max(0, service.volume_gb * BYTES_PER_GB - service.used_bytes);
      // A zero quota would divide by zero, and a migrated row can carry one.
      if (service.volume_gb > 0) lines.push(usageBar(service.used_bytes, service.volume_gb));
      lines.push(`📊 مصرف شده: ${formatGigabytes(service.used_bytes)}`);
      lines.push(`🎯 باقی‌مانده: ${formatGigabytes(remaining)}`);
    }
  }

  if (service.expires_at === null) {
    lines.push('📅 اعتبار: بدون محدودیت زمان');
  } else {
    const expiry = new Date(service.expires_at);
    lines.push(`📅 اعتبار تا: ${formatTehranDate(expiry)}`);
    const daysLeft = Math.ceil((expiry.getTime() - now) / 86_400_000);
    if (daysLeft > 0) lines.push(`⏳ ${daysLeft.toLocaleString('en-US')} روز باقی مانده`);
  }

  if (state === 'ACTIVE' && service.subscription_url) {
    lines.push('', '🔗 لینک اشتراک:', service.subscription_url);
  } else if (state === 'ACTIVE') {
    // Provisioned by a person, or a row migrated from the old bot that the sync
    // has not reached yet. Saying so beats an empty space where a link goes.
    lines.push('', 'لینک این سرویس هنوز در دسترس نیست. لطفاً به پشتیبانی پیام دهید.');
  } else if (state === 'EXPIRED' || state === 'EXHAUSTED') {
    // Seen on the real screen: a dead service showed its status, withheld its
    // link, and then said nothing at all — leaving the customer on a screen
    // with no way forward. This is the one thing they can do about it.
    lines.push('', 'برای استفادهٔ دوباره، از دکمهٔ «♻️ تمدید سرویس» در منوی اصلی اقدام کنید.');
  }
  return lines.join('\n');
}

/**
 * ponytail: back always lands on the first page. Carrying the page the customer
 * came from would need a second id in `callback_data`, and it costs four
 * customers in production one extra tap.
 */
export function serviceDetailMenu(actions?: ServiceActions | null): InlineKeyboard {
  const keyboard: InlineKeyboard = [];
  if (actions) {
    const addons: InlineKeyboard[number] = [];
    // Each button appears only if that panel has a price for it. The admin sets
    // them per panel, and one panel has extending switched off entirely.
    if (actions.volumeIrrPerGb !== null) {
      addons.push({ text: '➕ حجم اضافه', callback_data: encode('xv', actions.id) });
    }
    if (actions.timeIrrPerDay !== null) {
      addons.push({ text: '⏳ زمان اضافه', callback_data: encode('xt', actions.id) });
    }
    if (addons.length > 0) keyboard.push(addons);
    keyboard.push([
      { text: '🔄 تغییر لینک اشتراک', callback_data: encode('rvk', actions.id) },
    ]);
    keyboard.push([
      actions.disabled
        ? { text: '💡 روشن کردن سرویس', callback_data: encode('on', actions.id) }
        : { text: '⛔ خاموش کردن سرویس', callback_data: encode('off', actions.id) },
    ]);
  }
  keyboard.push([
    { text: 'بازگشت به سرویس‌ها ⬅️', callback_data: encode('mine') },
    { text: BACK_TO_MENU, callback_data: encode('menu') },
  ]);
  return keyboard;
}

/**
 * Whether to draw the panel buttons at all, and which way the switch points.
 *
 * Absent for a service no panel can be asked about — a manual product, or a row
 * whose panel was deleted. Drawing a button that cannot do anything is how a
 * customer comes to support saying they pressed it and nothing happened.
 */
export type { CustomerTier } from '@shikoo/domain';

export interface ServiceActions {
  id: number;
  disabled: boolean;
  /** Null when this panel does not sell that add-on. */
  volumeIrrPerGb: number | null;
  timeIrrPerDay: number | null;
}

/** `1_950_000` → `'195,000 تومان'`. The customer's currency, at the edge only. */
function toman(irr: number): string {
  return `${Math.round(irr / 10).toLocaleString('en-US')} تومان`;
}

export function askAddonAmount(kind: 'ADD_VOLUME' | 'ADD_TIME', unitIrr: number): string {
  return kind === 'ADD_VOLUME'
    ? [
        '➕ خرید حجم اضافه',
        '',
        `قیمت هر گیگابایت: ${toman(unitIrr)}`,
        '',
        'چند گیگابایت می‌خواهید؟ فقط عدد بفرستید — مثلاً 5',
      ].join('\n')
    : [
        '⏳ خرید زمان اضافه',
        '',
        `قیمت هر روز: ${toman(unitIrr)}`,
        '',
        'چند روز می‌خواهید؟ فقط عدد بفرستید — مثلاً 30',
      ].join('\n');
}

/** The customer typed something that is not a count. */

export function addonTooMuch(max: number): string {
  return `بیشترین مقدار در هر خرید ${max.toLocaleString('en-US')} است. عدد کوچک‌تری بفرستید.`;
}

export function addonInvoice(
  kind: 'ADD_VOLUME' | 'ADD_TIME',
  quantity: number,
  totalIrr: number,
): string {
  const what =
    kind === 'ADD_VOLUME'
      ? `${quantity.toLocaleString('en-US')} گیگابایت حجم`
      : `${quantity.toLocaleString('en-US')} روز زمان`;
  return ['🧾 فاکتور شما:', '', `📦 ${what}`, `💳 مبلغ: ${toman(totalIrr)}`].join('\n');
}

/**
 * The checkout for an add-on.
 *
 * Its own screen rather than the plan checkout with a fake plan pushed through
 * it: what is being bought here is a quantity, not a product, and the two lines
 * that differ are exactly the two a customer checks before transferring money.
 */
export function addonCheckout(
  publicId: string,
  kind: 'ADD_VOLUME' | 'ADD_TIME',
  quantity: number,
  serviceName: string,
  totalIrr: number,
  cardDigits: string,
  cardHolder: string | null,
): string {
  const what =
    kind === 'ADD_VOLUME'
      ? `${quantity.toLocaleString('en-US')} گیگابایت حجم`
      : `${quantity.toLocaleString('en-US')} روز زمان`;
  const lines = [
    '🧾 سفارش شما ثبت شد. برای تکمیل، مبلغ زیر را کارت‌به‌کارت کنید.',
    '',
    `🔖 شمارهٔ سفارش: ${publicId}`,
    `📦 ${what} برای «${serviceName}»`,
    `💳 مبلغ دقیق: ${toman(totalIrr)}`,
    '',
    '🏦 شمارهٔ کارت:',
    formatCard(cardDigits),
  ];
  if (cardHolder) lines.push(`👤 به نام: ${cardHolder}`);
  lines.push(
    '',
    'لطفاً دقیقاً همین مبلغ را واریز کنید — مبلغ متفاوت بررسی دستی می‌خواهد و طول می‌کشد.',
    'بعد از واریز، دکمهٔ زیر را بزنید.',
  );
  return lines.join('\n');
}

export function addonApplied(
  kind: 'ADD_VOLUME' | 'ADD_TIME',
  quantity: number,
  serviceName: string,
  expiresAt: Date | null,
): string {
  const lines = [
    kind === 'ADD_VOLUME'
      ? `✅ ${quantity.toLocaleString('en-US')} گیگابایت به «${serviceName}» اضافه شد.`
      : `✅ ${quantity.toLocaleString('en-US')} روز به «${serviceName}» اضافه شد.`,
  ];
  if (expiresAt !== null) lines.push(`📅 اعتبار تا: ${formatTehranDate(expiresAt)}`);
  lines.push('', 'لینک اشتراک شما عوض نشده و همان قبلی است.');
  return lines.join('\n');
}


export function confirmRevokeMenu(subscriptionId: number): InlineKeyboard {
  return [
    [{ text: '✅ بله، لینک را عوض کن', callback_data: encode('rvk2', subscriptionId) }],
    [{ text: 'بازگشت ⬅️', callback_data: encode('sub', subscriptionId) }],
  ];
}

export function linkReplaced(subscriptionUrl: string): string {
  return [
    '✅ لینک اشتراک عوض شد.',
    '',
    '🔗 لینک جدید:',
    subscriptionUrl,
    '',
    'لینک قبلی دیگر کار نمی‌کند.',
  ].join('\n');
}

export function serviceSwitched(enabled: boolean): string {
  return enabled
    ? '💡 سرویس روشن شد و دوباره قابل استفاده است.'
    : '⛔ سرویس خاموش شد. هر وقت خواستید از همین صفحه روشنش کنید — حجم و تاریخ سرویس حساب می‌شود.';
}

/** The panel said no. The reason is the adapter's, and it is written for a person. */
export function actionFailed(reason: string): string {
  return ['⚠️ این کار انجام نشد.', '', reason, '', 'کمی بعد دوباره امتحان کنید.'].join('\n');
}


// ---------------------------------------------------------------------------
// «تمدید سرویس»
// ---------------------------------------------------------------------------


/** The panel the service lives on has renewal switched off — the admin's own
 *  `status_extend` setting, carried over from the old bot. */

/** The list of services, keyed to the renewal flow rather than the detail one. */
export function renewMenu(
  services: ServiceListItem[],
  now: number,
  page: number,
  pages: number,
): InlineKeyboard {
  const keyboard: InlineKeyboard = services.map((service) => [
    {
      text: `${STATE_GLYPH[serviceState(service, now)]} ${shortName(service.plan_name_at_sale)}`,
      callback_data: encode('rnw', service.id),
    },
  ]);
  if (pages > 1) {
    const paging: InlineKeyboard[number] = [];
    if (page > 1) paging.push({ text: '« قبلی', callback_data: encode('renew', page - 1) });
    if (page < pages) paging.push({ text: 'بعدی »', callback_data: encode('renew', page + 1) });
    keyboard.push(paging);
  }
  keyboard.push([{ text: BACK_TO_MENU, callback_data: encode('menu') }]);
  return keyboard;
}

/**
 * What the customer is about to extend, before they pick what to extend it
 * with.
 *
 * The current expiry is spelled out because the two renewal modes behave
 * differently and the customer cannot see which one their panel uses: on a
 * panel that adds, renewing three days early keeps those three days; on one
 * that resets, it does not. Showing today's date is what makes that visible.
 */
export function renewIntro(
  service: { plan_name_at_sale: string; public_id: string; expires_at: string | null },
  mode: 'ADD' | 'RESET',
  now: number,
): string {
  const lines = [
    `♻️ تمدید سرویس`,
    '',
    `🔐 ${service.plan_name_at_sale}`,
    `🔖 شمارهٔ سرویس: ${service.public_id}`,
  ];
  if (service.expires_at !== null) {
    lines.push(`📅 اعتبار فعلی تا: ${formatTehranDate(new Date(service.expires_at))}`);
  }
  // An ADD panel adds to whatever is left — but only if anything IS left. Seen
  // on the real screen: a service four days past its date, on an ADD panel,
  // promising the customer their remaining time would be kept. There was none.
  // The adapter already anchors at today in that case; this is the sentence
  // catching up with what it does.
  const somethingLeft = service.expires_at !== null && Date.parse(service.expires_at) > now;
  lines.push(
    '',
    mode === 'ADD' && somethingLeft
      ? 'زمان و حجم پلنی که انتخاب می‌کنید به باقی‌ماندهٔ فعلی اضافه می‌شود.'
      : mode === 'ADD'
        ? 'اعتبار این سرویس تمام شده، پس زمان پلن جدید از امروز حساب می‌شود.'
        : 'با تمدید، زمان و حجم از نو شروع می‌شود و مصرف قبلی صفر می‌گردد.',
    '',
    '🛍 پلن تمدید را انتخاب کنید:',
  );
  return lines.join('\n');
}

/** One row per plan, each carrying BOTH the service and the plan. */
export function renewPlanMenu(
  subscriptionId: number,
  plans: CatalogPlan[],
  discountPercent = 0,
  heldCode?: string | null,
): InlineKeyboard {
  const keyboard: InlineKeyboard = plans.map((plan) => {
    const price = priceForUser(plan.priceIrr, discountPercent);
    // The listed price stays the listed price while a code is held: which plan
    // the code applies to is not known until one is chosen, and a button that
    // promised a discount the chosen plan turns out not to qualify for would be
    // worse than one that says nothing.
    const quoted = price.discountIrr === 0 && nameMentionsPrice(plan.productName, plan.priceIrr);
    return [
      {
        text: quoted ? plan.productName : `${plan.productName} — ${formatToman(price.totalIrr)}`,
        callback_data: encode('rord', subscriptionId, plan.planId),
      },
    ];
  });
  keyboard.push([
    heldCode
      ? { text: `🏷 برداشتن کد «${heldCode}»`, callback_data: encode('dxr', subscriptionId) }
      : { text: '🏷 کد تخفیف دارم', callback_data: encode('dsr', subscriptionId) },
  ]);
  keyboard.push([
    { text: 'بازگشت به سرویس‌ها ⬅️', callback_data: encode('renew') },
    { text: BACK_TO_MENU, callback_data: encode('menu') },
  ]);
  return keyboard;
}

/** The checkout screen for a renewal — same money, different sentence. */
export function renewCheckout(
  publicId: string,
  serviceName: string,
  plan: CatalogPlan,
  totalIrr: number,
  cardDigits: string,
  cardHolder: string | null,
  applied?: AppliedCode | null,
): string {
  const lines = [
    '🧾 درخواست تمدید ثبت شد. برای تکمیل، مبلغ زیر را کارت‌به‌کارت کنید.',
    '',
    `🔖 شمارهٔ سفارش: ${publicId}`,
    `♻️ تمدید سرویس: ${serviceName}`,
    `🔐 با پلن: ${plan.productName}`,
  ];
  if (applied && applied.discountIrr > 0) {
    lines.push(`🏷 کد «${applied.code}»: ${formatToman(applied.discountIrr)} تخفیف`);
  }
  lines.push(
    `💳 مبلغ دقیق: ${formatToman(totalIrr)}`,
    '',
    '🏦 شمارهٔ کارت:',
    formatCard(cardDigits),
  );
  if (cardHolder) lines.push(`👤 به نام: ${cardHolder}`);
  lines.push(
    '',
    'لطفاً دقیقاً همین مبلغ را واریز کنید — مبلغ متفاوت بررسی دستی می‌خواهد و طول می‌کشد.',
    'بعد از واریز، دکمهٔ زیر را بزنید.',
  );
  return lines.join('\n');
}

/**
 * The renewal is done. Deliberately does not repeat the subscription link:
 * nothing about it changed, and a second link in the chat is one more thing to
 * import by mistake.
 */
export function serviceRenewed(serviceName: string, expiresAt: Date | null): string {
  const lines = ['♻️ سرویس شما تمدید شد.', '', `🔐 ${serviceName}`];
  if (expiresAt !== null) {
    lines.push(`📅 اعتبار جدید تا: ${formatTehranDate(expiresAt)}`);
  }
  lines.push('', 'لینک اشتراک شما تغییری نکرده و همان قبلی است.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The two warnings, sent unprompted
// ---------------------------------------------------------------------------

/**
 * Both say which service, and both point at the same button.
 *
 * The service is named because a customer with several — and 1,687 of them have
 * more than one — cannot act on "your service is running out". Mirzabot names
 * it too, by remote username; the plan name is what the customer actually
 * recognises.
 */
export function timeRunningOut(serviceName: string, daysLeft: number): string {
  return [
    '⏳ سرویس شما رو به پایان است.',
    '',
    `🔐 ${serviceName}`,
    `📅 ${daysLeft.toLocaleString('en-US')} روز تا پایان اعتبار`,
    '',
    'برای اینکه سرویس‌تان قطع نشود، از دکمهٔ «♻️ تمدید سرویس» در منوی اصلی استفاده کنید.',
  ].join('\n');
}

export function volumeRunningOut(serviceName: string, remainingBytes: number): string {
  return [
    '📉 حجم سرویس شما رو به پایان است.',
    '',
    `🔐 ${serviceName}`,
    `📦 باقی‌مانده: ${formatGigabytes(remainingBytes)}`,
    '',
    'برای اینکه سرویس‌تان قطع نشود، از دکمهٔ «♻️ تمدید سرویس» در منوی اصلی استفاده کنید.',
  ].join('\n');
}

/**
 * Tehran calendar date, from `Intl` rather than by adding 3.5 hours.
 *
 * Doing this arithmetically is what put the "today" window seven hours out and
 * hid every transaction between midnight and 07:00 from the daily report.
 */
function formatTehranDate(when: Date): string {
  return new Intl.DateTimeFormat('fa-IR', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(when);
}

/**
 * The clock time in Tehran.
 *
 * Only the admin screens use it, and they need it: two bank transactions for
 * the same amount on the same day are told apart by the minute they arrived,
 * and a button that said only the date would name both.
 */
function formatTehranTime(when: Date): string {
  return new Intl.DateTimeFormat('fa-IR', {
    timeZone: 'Asia/Tehran',
    hour: '2-digit',
    minute: '2-digit',
  }).format(when);
}

// ---------------------------------------------------------------------------
// wallet
// ---------------------------------------------------------------------------

/** What a ledger entry is called in a sentence a customer reads. */
const ENTRY_LABEL: Record<string, string> = {
  OPENING: 'موجودی اولیه',
  TOPUP: 'شارژ کیف پول',
  PURCHASE: 'خرید',
  REFUND: 'بازگشت وجه',
  ADMIN_ADJUST: 'اصلاح توسط پشتیبانی',
  REFERRAL_BONUS: 'پاداش زیرمجموعه',
  WHEEL_PRIZE: 'جایزهٔ گردونه',
  TRANSFER_IN: 'انتقال دریافتی',
  TRANSFER_OUT: 'انتقال ارسالی',
  GIFT_CODE: 'کد هدیه',
};

/**
 * The balance, and where it came from.
 *
 * The history is shown because the balance alone is what Mirzabot has, and a
 * balance nobody can explain is the thing that produced a customer sitting at
 * -5,940,000 Toman with no way to find out why.
 *
 * A negative balance is stated plainly rather than hidden or clamped to zero.
 * Production contains one, and a customer who owes money is owed the truth.
 */
export function walletHome(balanceIrr: number, entries: WalletEntryView[]): string {
  const lines = ['🏦 کیف پول شما', '', `💰 موجودی: ${formatToman(balanceIrr)}`];
  if (balanceIrr < 0) {
    lines.push('', '⚠️ موجودی شما منفی است. تا تسویه نشود امکان خرید از کیف پول نیست.');
  }
  if (entries.length === 0) {
    lines.push('', 'هنوز تراکنشی ندارید.');
    return lines.join('\n');
  }
  lines.push('', '🧾 آخرین تراکنش‌ها:');
  for (const entry of entries) {
    const sign = entry.amount_irr < 0 ? '➖' : '➕';
    const label = ENTRY_LABEL[entry.kind] ?? entry.kind;
    lines.push(`${sign} ${formatToman(Math.abs(entry.amount_irr))} — ${label}`);
  }
  return lines.join('\n');
}

export interface WalletEntryView {
  amount_irr: number;
  kind: string;
}

export function walletMenu(): InlineKeyboard {
  return [
    [{ text: '💰 افزایش موجودی', callback_data: encode('top') }],
    [{ text: '🎁 کد هدیه', callback_data: encode('gft') }],
    [{ text: BACK_TO_MENU, callback_data: encode('menu') }],
  ];
}

export function chooseTopupAmount(minIrr: number, maxIrr: number): string {
  return [
    '💰 چه مبلغی به کیف پول اضافه شود؟',
    '',
    `کمترین مبلغ ${formatToman(minIrr)} و بیشترین ${formatToman(maxIrr)} است.`,
    'بعد از انتخاب، شمارهٔ کارت برایتان فرستاده می‌شود.',
  ].join('\n');
}

/**
 * One button per allowed amount.
 *
 * The button carries the CHOICE, not the amount. `callback_data` is a field the
 * customer can write whatever they like into, and a deposit is the one place in
 * this bot where a number from them would otherwise be believed.
 */
export function topupMenu(amountsIrr: readonly number[]): InlineKeyboard {
  const keyboard: InlineKeyboard = [];
  for (let i = 0; i < amountsIrr.length; i += 2) {
    const row = amountsIrr.slice(i, i + 2).map((amount, offset) => ({
      text: formatToman(amount),
      callback_data: encode('tp', i + offset + 1),
    }));
    keyboard.push(row);
  }
  keyboard.push([{ text: '🏦 کیف پول', callback_data: encode('wal') }]);
  return keyboard;
}

/** The card screen for a deposit — same money, no service being bought. */
export function topupCheckout(
  publicId: string,
  amountIrr: number,
  cardDigits: string,
  cardHolder: string | null,
): string {
  const lines = [
    '🧾 درخواست شارژ ثبت شد. برای تکمیل، مبلغ زیر را کارت‌به‌کارت کنید.',
    '',
    `🔖 شمارهٔ پیگیری: ${publicId}`,
    `💳 مبلغ دقیق: ${formatToman(amountIrr)}`,
    '',
    '🏦 شمارهٔ کارت:',
    formatCard(cardDigits),
  ];
  if (cardHolder) lines.push(`👤 به نام: ${cardHolder}`);
  lines.push(
    '',
    'لطفاً دقیقاً همین مبلغ را واریز کنید — مبلغ متفاوت بررسی دستی می‌خواهد و طول می‌کشد.',
    'بعد از واریز، دکمهٔ زیر را بزنید.',
  );
  return lines.join('\n');
}

/** Sent by the settle sweep, not by a button: the deposit has landed. */
export function walletToppedUp(amountIrr: number): string {
  return [
    '✅ کیف پول شما شارژ شد.',
    '',
    `💰 مبلغ: ${formatToman(amountIrr)}`,
    '',
    'حالا می‌توانید بدون کارت‌به‌کارت خرید کنید.',
  ].join('\n');
}

/**
 * `publicId`, not a service name. The first version of this screen labelled the
 * order id with 🔐 as though it were the product, so the customer read
 * `🔐 143e2b4cb3` where they expected to see what they had just bought. Only
 * opening the screen showed it.
 */
export function walletPaid(publicId: string, remainingIrr: number): string {
  return [
    '✅ پرداخت از کیف پول انجام شد.',
    '',
    `🔖 شمارهٔ سفارش: ${publicId}`,
    `💰 موجودی باقی‌مانده: ${formatToman(remainingIrr)}`,
    '',
    'سرویس در حال آماده‌سازی است و تا لحظاتی دیگر فرستاده می‌شود.',
  ].join('\n');
}

