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

import { encode } from './callback.js';
import type { CatalogPlan, Panel } from './catalog.js';
import { formatToman, nameMentionsPrice, priceForUser, type Price } from './money.js';
import type { InlineKeyboard } from './telegram.js';

export const WELCOME = 'به شیکو خوش آمدید 👋\n\nاز منوی زیر انتخاب کنید.';

export const MENU_TITLE = 'منوی اصلی — چه کاری برایتان انجام دهم؟';

export const SOON = 'این بخش هنوز آماده نیست. به‌زودی 🙏';

export const CHOOSE_PANEL = '📌 لوکیشن سرویس را انتخاب کنید.';

export const CHOOSE_PLAN = '🛍 سرویس مورد نظرتان را انتخاب کنید.';

/** Shown when a panel that was listed a moment ago now has nothing on it. */
export const PANEL_EMPTY = 'در حال حاضر محصولی روی این لوکیشن موجود نیست.';

/** No panel has anything this customer can buy. */
export const SHOP_EMPTY = 'در حال حاضر سرویسی برای فروش موجود نیست. کمی بعد دوباره سر بزنید.';

/** The one answer to a plan that is gone, hidden, or was never theirs to see. */
export const PLAN_GONE = 'این سرویس در دسترس شما نیست. لطفاً از منوی خرید دوباره انتخاب کنید.';

export const NOT_REGISTERED = 'برای شروع لطفاً /start را بزنید.';

const BACK_TO_MENU = 'بازگشت به منو ⬅️';

export function mainMenu(isReseller: boolean): InlineKeyboard {
  const keyboard: InlineKeyboard = [
    [
      { text: '♻️ تمدید سرویس', callback_data: encode('renew') },
      { text: '🔐 خرید اشتراک', callback_data: encode('buy') },
    ],
    [
      { text: '🏦 کیف پول + شارژ', callback_data: encode('wal') },
      { text: '🛍 سرویس های من', callback_data: encode('mine') },
    ],
    [
      { text: '☎️ پشتیبانی', callback_data: encode('soon') },
      { text: '📚 آموزش', callback_data: encode('soon') },
      { text: '👥 زیر مجموعه گیری', callback_data: encode('soon') },
    ],
  ];
  // Production appends this only for non-resellers, and only while
  // `setting.statusagentrequest` is on — which it is.
  if (!isReseller) {
    keyboard.push([{ text: '👨‍💻 درخواست نمایندگی', callback_data: encode('soon') }]);
  }
  return keyboard;
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

export function planDetail(plan: CatalogPlan, price: Price): string {
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
  if (price.discountIrr > 0) {
    lines.push(`💵 قیمت: ${formatToman(price.unitPriceIrr)}`);
    lines.push(`🎁 تخفیف شما: ${formatToman(price.discountIrr)}`);
  }
  lines.push(`💳 قابل پرداخت: ${formatToman(price.totalIrr)}`);
  return lines.join('\n');
}

export function planDetailMenu(plan: CatalogPlan): InlineKeyboard {
  return [
    [{ text: '✅ ثبت سفارش', callback_data: encode('order', plan.planId) }],
    [
      { text: 'بازگشت ⬅️', callback_data: encode('panel', plan.providerId) },
      { text: BACK_TO_MENU, callback_data: encode('menu') },
    ],
  ];
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
export const NO_CARD_AVAILABLE =
  'در حال حاضر امکان دریافت شمارهٔ کارت نیست. لطفاً چند دقیقهٔ دیگر دوباره تلاش کنید یا به پشتیبانی پیام دهید.';

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

export const ORDER_GONE = 'این سفارش پیدا نشد. لطفاً از منوی خرید دوباره اقدام کنید.';

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

export const MY_SERVICES_EMPTY = [
  'هنوز سرویسی ندارید.',
  '',
  'از دکمهٔ «خرید اشتراک» می‌توانید اولین سرویس‌تان را بگیرید.',
].join('\n');

export const SERVICE_GONE = 'این سرویس پیدا نشد. لطفاً از فهرست سرویس‌ها دوباره انتخاب کنید.';

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
export interface ServiceActions {
  id: number;
  disabled: boolean;
}

export const CONFIRM_REVOKE = [
  '⚠️ لینک اشتراک این سرویس عوض می‌شود.',
  '',
  'لینک فعلی از کار می‌افتد و باید لینک جدید را روی همهٔ دستگاه‌هایتان دوباره وارد کنید.',
  'حجم و تاریخ سرویس دست‌نخورده می‌ماند.',
].join('\n');

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

export const ACTION_UNSUPPORTED =
  'این سرویس به‌صورت دستی آماده شده و از این طریق قابل تغییر نیست. لطفاً به پشتیبانی پیام دهید.';

// ---------------------------------------------------------------------------
// «تمدید سرویس»
// ---------------------------------------------------------------------------

export const NOTHING_TO_RENEW = [
  'سرویسی برای تمدید ندارید.',
  '',
  'اگر سرویس فعالی دارید و اینجا نمی‌بینید، به پشتیبانی پیام دهید.',
].join('\n');

export const CHOOSE_SERVICE_TO_RENEW = '♻️ کدام سرویس را تمدید می‌کنید؟';

export const RENEWAL_GONE = 'این سرویس قابل تمدید نیست. لطفاً از فهرست تمدید دوباره انتخاب کنید.';

/** The panel the service lives on has renewal switched off — the admin's own
 *  `status_extend` setting, carried over from the old bot. */
export const RENEWAL_CLOSED = [
  'تمدید روی لوکیشن این سرویس فعال نیست.',
  '',
  'می‌توانید از بخش «خرید اشتراک» سرویس جدیدی بگیرید یا به پشتیبانی پیام دهید.',
].join('\n');

export const NO_RENEWAL_PLAN = [
  'در حال حاضر پلنی برای تمدید این سرویس موجود نیست.',
  '',
  'لطفاً کمی بعد دوباره امتحان کنید یا به پشتیبانی پیام دهید.',
].join('\n');

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
): InlineKeyboard {
  const keyboard: InlineKeyboard = plans.map((plan) => {
    const price = priceForUser(plan.priceIrr, discountPercent);
    const quoted = price.discountIrr === 0 && nameMentionsPrice(plan.productName, plan.priceIrr);
    return [
      {
        text: quoted ? plan.productName : `${plan.productName} — ${formatToman(price.totalIrr)}`,
        callback_data: encode('rord', subscriptionId, plan.planId),
      },
    ];
  });
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
): string {
  const lines = [
    '🧾 درخواست تمدید ثبت شد. برای تکمیل، مبلغ زیر را کارت‌به‌کارت کنید.',
    '',
    `🔖 شمارهٔ سفارش: ${publicId}`,
    `♻️ تمدید سرویس: ${serviceName}`,
    `🔐 با پلن: ${plan.productName}`,
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

export const WALLET_TOO_LITTLE =
  'موجودی کیف پول شما برای این خرید کافی نیست. اول کیف پول را شارژ کنید.';
