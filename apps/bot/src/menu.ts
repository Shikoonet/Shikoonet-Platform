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

export function orderPlaced(publicId: string, plan: CatalogPlan, totalIrr: number): string {
  return [
    '✅ سفارش شما ثبت شد.',
    '',
    `🔖 شمارهٔ سفارش: ${publicId}`,
    `🔐 سرویس: ${plan.productName}`,
    `💳 مبلغ: ${formatToman(totalIrr)}`,
    '',
    'مرحلهٔ پرداخت هنوز فعال نشده است. سفارش شما ثبت و نگهداری می‌شود.',
  ].join('\n');
}

export function orderPlacedMenu(): InlineKeyboard {
  return [[{ text: BACK_TO_MENU, callback_data: encode('menu') }]];
}
