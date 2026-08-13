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
      { text: '♻️ تمدید سرویس', callback_data: encode('soon') },
      { text: '🔐 خرید اشتراک', callback_data: encode('buy') },
    ],
    [
      { text: '🏦 کیف پول + شارژ', callback_data: encode('soon') },
      { text: '🛍 سرویس های من', callback_data: encode('soon') },
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

export function checkoutMenu(orderId: number): InlineKeyboard {
  return [
    [{ text: '✅ پرداخت کردم', callback_data: encode('paid', orderId) }],
    [{ text: BACK_TO_MENU, callback_data: encode('menu') }],
  ];
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
