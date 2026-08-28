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
 * ## Where the words come from
 *
 * Not from here. Every sentence below is `TEXTS_NOW.render(KEY, …)` or a live
 * binding filled from the same place, and the defaults live in
 * `@shikoo/contracts`. What stays in this file is the part that cannot be a
 * string: which line appears, in what order, and under what condition.
 *
 * That is the whole split. An admin gets every line of every screen; the
 * conditions stay type-checked in TypeScript instead of becoming a template
 * language that can fail halfway through answering a customer.
 *
 * ponytail: Persian only, inline. The `lang` column exists and production is
 * 11,240 'fa' to one 'en'; wire up a second language when it has a customer.
 */

import { encode } from './callback.js';
import type { CatalogCategory, CatalogPlan, CatalogProduct } from './catalog.js';
import type { RequiredChannel } from './gate.js';
import { DEFAULT_CONTENT, type BotContent } from './botContent.js';
import {
  buildMainMenu,
  buildMenu,
  DEFAULT_LAYOUTS,
  MENU_ACTIONS,
  type ButtonPlacement,
  type MenuId,
  type MenuViewer,
} from './keyboard.js';
import type { Layouts } from './botContent.js';
import {
  DEFAULT_TEXTS,
  groupIntoRows,
  renderPlanLabel,
  type TextKey,
  type Texts,
} from '@shikoo/contracts';
import { formatToman, nameMentionsPrice, priceForUser, tomanDigits, type Price } from './money.js';
import {
  MAX_COPY_TEXT_LENGTH,
  type ButtonStyle,
  type InlineButton,
  type InlineKeyboard,
} from './telegram.js';

/**
 * A refusal reason, as `discount.ts` names it, mapped to the sentence for it.
 *
 * Declared before the exported bindings below because those are initialised at
 * module load and read this — a `const` further down would be in its temporal
 * dead zone by then, which is exactly how the first version of this file failed
 * to import at all.
 */
const REASON_TEXT_KEY: Record<string, TextKey> = {
  UNKNOWN_CODE: 'DISCOUNT_REFUSED_UNKNOWN_CODE',
  EXPIRED: 'DISCOUNT_REFUSED_EXPIRED',
  USED_UP: 'DISCOUNT_REFUSED_USED_UP',
  ALREADY_USED: 'DISCOUNT_REFUSED_ALREADY_USED',
  NOT_FOR_THIS: 'DISCOUNT_REFUSED_NOT_FOR_THIS',
  NOT_FOR_YOU: 'DISCOUNT_REFUSED_NOT_FOR_YOU',
  FIRST_PURCHASE_ONLY: 'DISCOUNT_REFUSED_FIRST_PURCHASE_ONLY',
};

/**
 * The sentences an admin may rewrite, for the screens that are one sentence.
 *
 * These are `let`, not `const`, and that is the whole wiring: ES module exports
 * are live bindings, so `applyContent` reassigning them is seen by every
 * `menu.X` in `handle.ts` without a single call site changing.
 *
 * Screens built out of several lines do not appear here — they are functions
 * further down that render their lines one at a time.
 *
 * Safe because the bot handles one update at a time (`poll.ts` awaits each
 * `handleUpdate` in a plain `for` loop). If that ever becomes concurrent, this
 * becomes shared mutable state between customers and must be threaded through
 * instead.
 */
export let WELCOME = DEFAULT_TEXTS.raw('WELCOME');
export let SHOP_CLOSED = DEFAULT_TEXTS.raw('SHOP_CLOSED');
export let MENU_TITLE = DEFAULT_TEXTS.raw('MENU_TITLE');
export let GATE_RULES = DEFAULT_TEXTS.raw('GATE_RULES');
export let GATE_RULES_ACCEPTED = DEFAULT_TEXTS.raw('GATE_RULES_ACCEPTED');
export let SOON = DEFAULT_TEXTS.raw('SOON');
export let CHOOSE_CATEGORY = DEFAULT_TEXTS.raw('CHOOSE_CATEGORY');
export let CATEGORY_EMPTY = DEFAULT_TEXTS.raw('CATEGORY_EMPTY');
export let CHOOSE_PRODUCT = DEFAULT_TEXTS.raw('CHOOSE_PRODUCT');
export let PANEL_EMPTY = DEFAULT_TEXTS.raw('PANEL_EMPTY');
export let PRODUCT_EMPTY = DEFAULT_TEXTS.raw('PRODUCT_EMPTY');
export let SHOP_EMPTY = DEFAULT_TEXTS.raw('SHOP_EMPTY');
export let PLAN_GONE = DEFAULT_TEXTS.raw('PLAN_GONE');
export let NOT_REGISTERED = DEFAULT_TEXTS.raw('NOT_REGISTERED');
/** For the few screens handle.ts builds a one-button keyboard for itself. */

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
export let ORDER_EXPIRED = DEFAULT_TEXTS.raw('ORDER_EXPIRED');
export let RECEIPT_REPLACED = DEFAULT_TEXTS.raw('RECEIPT_REPLACED');
export let RECEIPT_SETTLED = DEFAULT_TEXTS.raw('RECEIPT_SETTLED');
export let RECEIPT_NOTHING_WAITING = DEFAULT_TEXTS.raw('RECEIPT_NOTHING_WAITING');
export let RECEIPT_WRONG_FILE = DEFAULT_TEXTS.raw('RECEIPT_WRONG_FILE');
export let ACTION_FAILED_NO_LINK = DEFAULT_TEXTS.raw('ACTION_FAILED_NO_LINK');

// The admin screens. Editable like the rest now — an operator's wording is as
// much the shop's as a customer's.

/**
 * Says which role is missing rather than just "no".
 *
 * An operator who does not know they are SUPPORT reads a bare refusal as a
 * broken button and presses it again; naming the reason sends them to whoever
 * can change it instead.
 */
export let SPAM_BLOCKED = DEFAULT_TEXTS.raw('SPAM_BLOCKED');


/**
 * Why a code was refused, in the customer's words.
 *
 * Each reason gets its own sentence. The legacy bot answers "code is not valid"
 * to an expired code, a used-up code and a code for another product alike, and
 * support then has to ask which of the three it was.
 */
export let DISCOUNT_REFUSED: Record<string, string> = buildDiscountRefused(DEFAULT_TEXTS);

/** The active texts, for the screens that fill in slots. */
let TEXTS_NOW: Texts = DEFAULT_TEXTS;
/** The active keyboard for every screen. */
let LAYOUTS_NOW: Layouts = DEFAULT_LAYOUTS;

/** One menu's saved layout, or the shipped one. */
function layout(id: MenuId): readonly ButtonPlacement[] {
  return LAYOUTS_NOW[id];
}

function buildDiscountRefused(t: Texts): Record<string, string> {
  return Object.fromEntries(
    Object.entries(REASON_TEXT_KEY).map(([reason, key]) => [reason, t.raw(key)]),
  );
}



/**
 * A button's label, as the customer currently sees it.
 *
 * Several screens tell a customer to press a button. They used to quote its
 * wording as a literal, so an admin who renamed it in the panel left those
 * messages pointing at a button that no longer exists — and nothing about the
 * result looks broken. Reading the live layout is what keeps them in step.
 *
 * Falls back to the shipped label when the saved layout has dropped the button
 * entirely, which is legal: the sentence is then wrong in a smaller way than a
 * literal `{renewButton}` on a customer's screen would be.
 */
function buttonLabel(menuId: MenuId, action: string, shipped: string): string {
  const placed = layout(menuId).find((b) => b.action === action && b.visible);
  if (placed) return placed.label;
  return MENU_ACTIONS.find((a) => a.action === action)?.label ?? shipped;
}

const renewButtonLabel = (): string => buttonLabel('main', 'renew', 'تمدید سرویس');
const paidButtonLabel = (): string => buttonLabel('checkout', 'paid', 'پرداخت کردم');
const joinedButtonLabel = (): string => buttonLabel('gateChannels', 'chk', 'عضو شدم');

/**
 * Points this module at the content the admin has saved.
 *
 * Called once per update, before anything is drawn. Everything it touches is a
 * live binding, so nothing downstream has to know it happened.
 */
export function applyContent(content: BotContent): void {
  const t = content.texts;
  TEXTS_NOW = t;
  LAYOUTS_NOW = content.layouts;
  WELCOME = t.raw('WELCOME');
  SHOP_CLOSED = t.raw('SHOP_CLOSED');
  MENU_TITLE = t.raw('MENU_TITLE');
  GATE_RULES = t.raw('GATE_RULES');
  GATE_RULES_ACCEPTED = t.raw('GATE_RULES_ACCEPTED');
  SOON = t.raw('SOON');
  CHOOSE_CATEGORY = t.raw('CHOOSE_CATEGORY');
  CATEGORY_EMPTY = t.raw('CATEGORY_EMPTY');
  CHOOSE_PRODUCT = t.raw('CHOOSE_PRODUCT');
  PANEL_EMPTY = t.raw('PANEL_EMPTY');
  PRODUCT_EMPTY = t.raw('PRODUCT_EMPTY');
  SHOP_EMPTY = t.raw('SHOP_EMPTY');
  PLAN_GONE = t.raw('PLAN_GONE');
  NOT_REGISTERED = t.raw('NOT_REGISTERED');
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
  ORDER_EXPIRED = t.raw('ORDER_EXPIRED');
  RECEIPT_REPLACED = t.raw('RECEIPT_REPLACED');
  RECEIPT_SETTLED = t.raw('RECEIPT_SETTLED');
  RECEIPT_NOTHING_WAITING = t.raw('RECEIPT_NOTHING_WAITING');
  RECEIPT_WRONG_FILE = t.raw('RECEIPT_WRONG_FILE');
  ACTION_FAILED_NO_LINK = t.raw('ACTION_FAILED_NO_LINK');
  SPAM_BLOCKED = t.raw('SPAM_BLOCKED');
  DISCOUNT_REFUSED = buildDiscountRefused(t);
}

/** Back to what the code ships. Tests call this so one does not colour the next. */
export function resetContent(): void {
  applyContent(DEFAULT_CONTENT);
}

export function mainMenu(viewer: MenuViewer): InlineKeyboard {
  return buildMainMenu(layout('main'), viewer);
}

/**
 * The rows that come from the database, above the shop's chrome.
 *
 * Always in that order, and that part has not changed. What has: these rows are
 * no longer always one per row. This used to say a data row had «no fixed
 * identity» and so could not be positioned — but a category and a plan carry
 * the same id their callback does, which is exactly the anchor that was
 * missing. `groupIntoRows` reads it; see `packages/contracts/src/catalogLayout.ts`.
 *
 * The chrome below still comes from `bot_keyboard_buttons`, and the two must
 * not be merged: that table is keyed on a closed action set `isMenuAction`
 * validates, this one on rows that come and go.
 */
function withChrome(
  dataRows: InlineKeyboard,
  menuId: MenuId,
  ctx?: Parameters<typeof buildMenu>[2],
): InlineKeyboard {
  return [...dataRows, ...buildMenu(menuId, layout(menuId), ctx)];
}

/**
 * The previous/next row, when there is more than one screenful.
 *
 * Generated rather than placed by the shop, because both buttons fire the same
 * callback with a different page number and the layout table is keyed by
 * action. Only their wording is editable, and that lives with the texts.
 */
function paging(action: 'mine' | 'renew', page: number, pages: number): InlineKeyboard {
  if (pages <= 1) return [];
  const row: InlineKeyboard[number] = [];
  if (page > 1) {
    row.push({ text: TEXTS_NOW.raw('PAGING_PREV'), callback_data: encode(action, page - 1) });
  }
  if (page < pages) {
    row.push({ text: TEXTS_NOW.raw('PAGING_NEXT'), callback_data: encode(action, page + 1) });
  }
  return row.length > 0 ? [row] : [];
}

/**
 * The join-the-channel screen, and the same screen after «عضو شدم» found them
 * still outside.
 *
 * Two sentences rather than one because re-sending the identical text is how
 * this screen dead-ends: pressing the button and getting the very same message
 * back reads as a bot that ignored you, and if it is ever drawn as an edit
 * instead Telegram refuses it outright as "message is not modified".
 */
export function gateChannels(retried = false): string {
  return TEXTS_NOW.render(retried ? 'GATE_NOT_JOINED_YET' : 'GATE_CHANNELS', {
    joinedButton: joinedButtonLabel(),
  });
}

/**
 * One link per channel above the shop's chrome, exactly as the live bot draws it
 * (`index.php:434`): the channel's own name on a button that opens it.
 *
 * `url` buttons, so nothing here ever calls back — what happened is asked of
 * Telegram afterwards by «عضو شدم», never reported by the client.
 */
export function gateChannelsMenu(missing: RequiredChannel[]): InlineKeyboard {
  return withChrome(
    missing.map((channel) => [{ text: channel.title, url: channel.join_link }]),
    'gateChannels',
  );
}

export function gateRulesMenu(): InlineKeyboard {
  return buildMenu('gateRules', layout('gateRules'));
}

/**
 * The plan list's title, which names the service it belongs to.
 *
 * A function rather than one of the exported strings above, because it renders
 * a placeholder: without the name on it, three plan lists reached from three
 * different services are three identical screens.
 */
export function choosePlan(productName: string): string {
  return TEXTS_NOW.render('CHOOSE_PLAN', { product: productName });
}

/** The heading over a category's price list. */
export function categoryPlans(categoryName: string): string {
  return TEXTS_NOW.render('CATEGORY_PLANS', { category: categoryName });
}

/**
 * How a shop button quotes a price.
 *
 * Appended only when the name does not already carry it. Every migrated product
 * has it typed in ('...-195.000ت') because the legacy schema had nowhere else to
 * put it, and appending ours makes the button say the number twice — seen on the
 * live bot on 2026-08-12.
 *
 * A discounted customer always gets the price appended, whatever the name says,
 * because then the name is quoting a price that is not theirs. Production has
 * this backwards: with `statusshowprice = 'offshowprice'` it shows the raw name,
 * so the eight customers with a standing discount read the full price on the
 * button and a different one at checkout.
 */
/**
 * The admin's badge, in front of the label — «🆕 ۵۰ گیگ — ۹۰,۰۰۰ تومان».
 *
 * In FRONT, always, and never appended: a plan's label already ends in a price
 * and a category's ends in the name, so a badge on the tail would land after
 * the number on one screen and read as part of the name on the other. The front
 * is also the side Telegram keeps put in an RTL label — see the measurement in
 * `telegram.ts:313`, which is why «🟢 پلاتینیوم» was the example there.
 *
 * The badge is admin-written free text and goes onto a button label, which is
 * the one place Telegram treats text as text: no parse_mode is set on these
 * sends, so there is nothing here for a «<» to escape into.
 */
function badged(badge: string | null, label: string): string {
  const b = badge?.trim();
  return b ? `${b} ${label}` : label;
}

/**
 * The admin's colour, as a key that is either on the button or not on it.
 *
 * Absent and not `style: null`: to Telegram, omitting the field means «your own
 * default», and `null` is a value it refuses. The column stores the same
 * absence as NULL, so the two ends agree without a translation table — the
 * three names in 0034's CHECK are the three `ButtonStyle` allows.
 *
 * Spread into the button rather than assigned after it, so a button with no
 * colour has no `style` key at all and every keyboard test keeps reading the
 * object it already read.
 */
function styled(style: ButtonStyle | null): { style?: ButtonStyle } {
  return style === null ? {} : { style };
}

function priced(name: string, listedIrr: number, price: Price): string {
  const quoted = price.discountIrr === 0 && nameMentionsPrice(name, listedIrr);
  return quoted ? name : `${name} — ${formatToman(price.totalIrr)}`;
}

/**
 * `30` -> `'1 ماهه'`, `7` -> `'7 روزه'`, `null` -> `''`.
 *
 * Whole months only when the days divide evenly. «1.5 ماهه» is not a thing a
 * shop sells, and 45 days rounded to «1 ماهه» would put a number on the button
 * that is not what the customer gets — so anything that is not a clean month
 * stays in days, which is always true.
 *
 * Latin digits, like `formatToman` and like every other number the bot draws
 * (`menu.ts:1226`). A label that mixed «۱ ماهه» with «350,000 تومان» would be
 * two digit systems on one button.
 */
function durationText(days: number | null): string {
  if (days === null || days <= 0) return '';
  if (days % 30 === 0) return `${days / 30} ماهه`;
  return `${days} روزه`;
}

/**
 * `100` -> `'100 گیگ'`, `null` -> `'نامحدود'`.
 *
 * NULL is unmetered and says so, rather than collapsing to nothing: on a plans
 * screen «نامحدود» is the thing the customer is choosing between, and an empty
 * slot there reads as a plan whose volume nobody filled in.
 */
function volumeText(gb: number | null): string {
  if (gb === null) return 'نامحدود';
  // `numeric(12,3)` arrives as a number; 50.000 must draw as «50 گیگ».
  const shown = Number.isInteger(gb) ? gb : Number(gb.toFixed(3));
  return `${shown.toLocaleString('en-US')} گیگ`;
}

/**
 * `3` -> `'چند کاربره'`, `1` -> `''`, `null` -> `''`.
 *
 * One user is the shape nobody remarks on, so it draws nothing rather than «1
 * کاربره» — a button that announces the ordinary case spends its one line on
 * the least interesting thing about the plan.
 */
function usersText(limit: number | null): string {
  return limit !== null && limit > 1 ? 'چند کاربره' : '';
}

/**
 * One row per service — پلاتینیوم, طلایی, معمولی. The shop's first screen.
 *
 * Names only. This screen picks a LEVEL, and a level does not have a price: a
 * service holding three sizes has three of them, and quoting the cheapest with
 * «از» — which is what this drew at first — puts a number on the button that
 * the customer then cannot find on the next screen. A service holding one plan
 * does have a single price, but quoting it on some rows and not others makes a
 * list where two rows mean different things while looking the same.
 *
 * Prices belong one screen down, where every row is a real, payable amount.
 *
 * The panel's name is appended ONLY to a service whose name is not unique in
 * this list. One panel is the shop today and putting «(پنل تست)» on every row
 * would be noise on every row; a second panel selling its own «پلاتینیوم» would
 * otherwise draw the same button twice, which is the defect this whole screen
 * was built to remove.
 */
export function productMenu(products: CatalogProduct[]): InlineKeyboard {
  const seen = new Map<string, number>();
  for (const p of products) seen.set(p.name, (seen.get(p.name) ?? 0) + 1);
  // Rows from `groupIntoRows`, not one per product. This was the last
  // catalogue keyboard drawing a row per button, and on the live shop it showed:
  // four tiers as four rows of one, between a category screen with two per row
  // and a price screen with two per row.
  return withChrome(
    groupIntoRows(products).map((row) =>
      row.map((product) => ({
        text:
          (seen.get(product.name) ?? 0) > 1
            ? `${product.name} (${product.providerName})`
            : product.name,
        callback_data: encode('prd', product.productId),
      })),
    ),
    'products',
  );
}

/**
 * One row per plan, inside one service.
 *
 * Labelled with the PLAN's name, not the product's. Every button on this screen
 * belongs to the same product, so labelling by product drew the same words on
 * every row and the only thing telling «۳۰ گیگ» from «۵۰ گیگ» apart was a price
 * — which a migrated name already quotes, so two plans of one product could
 * come out as literally the same button twice.
 *
 * «بازگشت به دسته‌بندی‌ها» needs no argument: the category list is the shop's
 * first screen now, so it is plain `buy`.
 */
export function planMenu(
  plans: CatalogPlan[],
  discountPercent = 0,
  /**
   * The shop's own label, or null for the one this screen has always drawn.
   *
   * Null and not a default template on purpose — `planLabel.ts` has the
   * reason, and it is that every migrated product already has its price typed
   * into its name.
   */
  template: string | null = null,
): InlineKeyboard {
  return withChrome(
    // The label and the callback are built together, from ONE plan object,
    // inside the row mapping. Not by index into a parallel array, and not
    // before the grouping: an arrangement that paired a price with somebody
    // else's id is the one way this feature could sell the wrong thing.
    groupIntoRows(plans).map((row) =>
      row.map((plan) => ({
        text: planLabel(plan, discountPercent, template),
        callback_data: encode('plan', plan.planId),
        ...styled(plan.buttonStyle),
      })),
    ),
    'plans',
  );
}

/**
 * One plan's button text, by whichever of the two routes the shop has chosen.
 *
 * The template path does NOT go through `priced`: that function's job is to
 * decide whether a hand-typed name already quotes its own price, and a shop
 * writing `{duration} | {price}` has said where the price goes. Running the
 * suppression there would silently drop the price from a label that asked for
 * it, on exactly the migrated plans whose names are the reason it exists.
 *
 * The discount is applied either way. It is the one thing on this button that
 * belongs to the customer looking at it rather than to the plan.
 */
function planLabel(plan: CatalogPlan, discountPercent: number, template: string | null): string {
  const price = priceForUser(plan.priceIrr, discountPercent);
  if (template === null) {
    return badged(plan.badge, priced(plan.planName, plan.priceIrr, price));
  }
  return renderPlanLabel(template, {
    name: plan.planName,
    badge: plan.badge ?? '',
    duration: durationText(plan.durationDays),
    volume: volumeText(plan.volumeGb),
    users: usersText(plan.userLimit),
    price: formatToman(price.totalIrr),
  });
}

/**
 * The shop's first screen — the categories holding something to buy.
 *
 * It replaced the service list, and the reason is written one screen down: a
 * service is a TIER, a tier has no single price, so that screen could only show
 * names and the customer chose blind. A category groups priced rows, so the
 * very next screen is payable amounts.
 *
 * Rows come from `groupIntoRows` rather than one-per-row, which is the whole of
 * what «چیدمان» does here.
 */
export function categoryMenu(categories: CatalogCategory[]): InlineKeyboard {
  return withChrome(
    groupIntoRows(categories).map((row) =>
      row.map((category) => ({
        text: badged(category.badge, category.name),
        callback_data: encode('cat', category.categoryId),
        ...styled(category.buttonStyle),
      })),
    ),
    'categories',
  );
}

/**
 * What the customer is buying, said in full.
 *
 * A legacy row's plan IS its product — the importer wrote the same string into
 * both — so those come out unchanged and every migrated invoice reads exactly
 * as it did. A tiered service does not: «پلاتینیوم» alone leaves out which size,
 * and «۵۰ گیگ - یک‌ماهه» alone leaves out which level, and three services each
 * holding a «۳۰ گیگ - یک‌ماهه» is not a hypothetical — it is the shape the shop
 * has the moment an operator builds پلاتینیوم/طلایی/معمولی on one panel.
 */
export function soldAs(productName: string, planName: string): string {
  const product = productName.trim();
  const plan = planName.trim();
  return plan === '' || plan === product ? product : `${product} — ${plan}`;
}

/** A code the customer typed and the checker allowed, as the screen shows it. */
export interface AppliedCode {
  code: string;
  discountIrr: number;
}

export function planDetail(plan: CatalogPlan, price: Price, applied?: AppliedCode | null): string {
  const t = TEXTS_NOW;
  const lines = [
    t.render('PLAN_TITLE', { product: soldAs(plan.productName, plan.planName) }),
    t.render('PLAN_LOCATION', { provider: plan.providerName }),
    '',
    plan.volumeGb === null
      ? t.raw('PLAN_VOLUME_UNLIMITED')
      : t.render('PLAN_VOLUME', { volume: plan.volumeGb }),
    plan.durationDays === null
      ? t.raw('PLAN_DURATION_UNLIMITED')
      : t.render('PLAN_DURATION', { days: plan.durationDays }),
  ];
  if (plan.userLimit !== null) {
    lines.push(t.render('PLAN_USER_LIMIT', { limit: plan.userLimit }));
  }
  lines.push('');
  const codeOff = applied?.discountIrr ?? 0;
  if (price.discountIrr > 0 || codeOff > 0) {
    lines.push(t.render('PLAN_PRICE', { price: formatToman(price.unitPriceIrr) }));
  }
  if (price.discountIrr > 0) {
    lines.push(t.render('PLAN_STANDING_DISCOUNT', { amount: formatToman(price.discountIrr) }));
  }
  if (applied && codeOff > 0) {
    lines.push(
      t.render('PLAN_CODE_DISCOUNT', { code: applied.code, amount: formatToman(codeOff) }),
    );
  }
  // The floor is the same one `order.ts` applies, and for the same reason: two
  // discounts on one price must not add up to more than the price.
  const payable = Math.max(0, price.totalIrr - codeOff);
  lines.push(t.render('PLAN_PAYABLE', { amount: formatToman(payable) }));
  return lines.join('\n');
}

export function planDetailMenu(plan: CatalogPlan, applied?: AppliedCode | null): InlineKeyboard {
  return buildMenu('planDetail', layout('planDetail'), {
    // Exactly one of the two code buttons applies, and which one depends on
    // whether a code is already on the plan. Both are in the layout so the shop
    // can word each one; the bot picks.
    applies: (action) =>
      action === 'dsx' ? applied != null : action === 'dsc' ? applied == null : true,
    target: (action) =>
      action === 'buy'
        ? // One step back is the screen the customer actually came from, which
          // since 2026-08-27 is one of three: this service's price list, the
          // category's tier list, or the shop's first screen. The two counts
          // mirror the two collapses — a customer never shown a list of one
          // must not be sent «back» to a screen with a single button on it that
          // leads where they already are.
          //
          // Re-pointed through `target` rather than by changing `MENUS`:
          // removing `buy` from this screen would make `checkLayout` reject
          // every layout a shop already saved for it, and `buildMenu` drop the
          // button — a customer with no way back.
          plan.siblings > 1
          ? encode('prd', plan.productId)
          : plan.tiers > 1
            ? encode('cat', plan.categoryId)
            : encode('buy')
        : action === 'menu'
          ? encode('menu')
          : encode(action as 'order', plan.planId),
  });
}

/**
 * Support.
 *
 * Production runs `statussupportpv = 'onpvsupport'` with `id_support` set, which
 * means support on the live bot is "message this person", not a ticket system.
 * The ticket tables exist and hold seven messages from before that switch; they
 * stay unread until an admin asks for them back.
 *
 * **And that is the end of it — Sam's decision, 2026-08-22: the ticket screens
 * are not built.** The dump settled it: one department, seven tickets, all of
 * them between 12 and 19 June 2026, and every one still `Unseen`. The shop
 * turned the feature on for a week, answered nothing, and switched to a handle.
 * So an absent ticket flow here is a decision, not a gap — see `docs/STATUS.md`
 * › «۶. پاریتی نساخته». The tables and `migrate.ts` stay as they are: importing
 * seven rows costs nothing and throwing them away would be the one choice that
 * cannot be undone.
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
  return withChrome(
    articles.map((a) => [{ text: shortName(a.title), callback_data: encode('hlp', a.id) }]),
    'help',
    { applies: (action) => (action === 'app' ? hasApps : true) },
  );
}

export function helpArticleScreen(title: string, body: string): string {
  const head = TEXTS_NOW.render('HELP_ARTICLE_TITLE', { title });
  return body.trim() === '' ? head : `${head}\n\n${body}`;
}

// ---------------------------------------------------------------------------
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
  const t = TEXTS_NOW;
  return [
    t.raw('REFERRAL_TITLE'),
    '',
    // No parse_mode anywhere in this bot, so emphasis is quotation marks.
    t.render('REFERRAL_TERMS', { percent }),
    '',
    t.render('REFERRAL_INVITED', { count: invited.toLocaleString('en-US') }),
    t.render('REFERRAL_EARNED', { amount: formatToman(earnedIrr) }),
    '',
    t.raw('REFERRAL_LINK_LABEL'),
    link,
  ].join('\n');
}

export function referralMenu(): InlineKeyboard {
  return buildMenu('referral', layout('referral'));
}

/**
 * The keyboard under a question the bot has asked.
 *
 * One button, and where it goes depends on what was asked — back to the plan
 * whose discount code was being typed, back to the service being extended, back
 * to the wallet. Six screens built this by hand, four of them quoting «بازگشت
 * ⬅️» letter for letter and two reading a shared constant, which is what a
 * half-finished extraction looks like.
 */
export function promptMenu(back: string): InlineKeyboard {
  return buildMenu('prompt', layout('prompt'), { target: () => back });
}

/**
 * The apps, as a list of links in one message.
 *
 * Not buttons: a `callback_data` button cannot open a link, and the URL button
 * Telegram does have would need the whole keyboard type widened for eight rows
 * of text that read perfectly well as text.
 */
export function appsScreen(
  apps: { name: string; platform: string | null; link: string }[],
): string {
  const t = TEXTS_NOW;
  const lines = [t.raw('APPS_TITLE'), ''];
  for (const app of apps) {
    lines.push(
      app.platform
        ? t.render('APPS_ITEM', { name: app.name, platform: app.platform })
        : t.render('APPS_ITEM_NO_PLATFORM', { name: app.name }),
    );
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
  const t = TEXTS_NOW;
  return [t.render('DISCOUNT_HELD_TITLE', { code }), '', t.raw('DISCOUNT_HELD_BODY')].join('\n');
}

export function discountApplied(code: string, offIrr: number): string {
  return TEXTS_NOW.render('DISCOUNT_APPLIED', { code, amount: formatToman(offIrr) });
}

export function giftCredited(amountIrr: number, balanceIrr: number): string {
  const t = TEXTS_NOW;
  return [
    t.render('GIFT_CREDITED', { amount: formatToman(amountIrr) }),
    t.render('GIFT_BALANCE', { balance: formatToman(balanceIrr) }),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The four card-to-card invoices
//
// They were four near-identical blocks with the same four sentences typed out
// each time. What actually differs between them is the opening line and the two
// middle lines naming what is being bought; the rest — the amount, the card, the
// exact-amount warning — is one screen wearing four hats.
// ---------------------------------------------------------------------------

/** The card, the warning, and the closing line. Shared by all four invoices. */
function checkoutTail(cardDigits: string, cardHolder: string | null): string[] {
  const t = TEXTS_NOW;
  const lines = [t.raw('CHECKOUT_CARD_LABEL'), formatCard(cardDigits)];
  if (cardHolder) lines.push(t.render('CHECKOUT_CARD_HOLDER', { name: cardHolder }));
  lines.push('', t.raw('CHECKOUT_EXACT_WARNING'), t.raw('CHECKOUT_PRESS_BUTTON'));
  // `PaySetting.helpcart`, live in production and shown before every card
  // invoice there. It is on the invoice itself here so it cannot be scrolled
  // past, and it is on all four because `checkoutTail` is the one place the
  // four builders share.
  lines.push(
    '',
    t.raw('CHECKOUT_NOTES_TITLE'),
    t.raw('CHECKOUT_NOTE_WORDS'),
    t.raw('CHECKOUT_NOTE_TRANSFER'),
    // The one note that names a button. It reads the live label for the same
    // reason the three renewal messages do: an admin who renames «پرداخت کردم»
    // would otherwise leave every invoice pointing at a button nobody can find.
    t.render('CHECKOUT_NOTE_PRESS', { paidButton: paidButtonLabel() }),
    t.raw('CHECKOUT_NOTE_WAIT'),
  );
  return lines;
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
  const t = TEXTS_NOW;
  return [
    t.raw('CHECKOUT_INTRO'),
    '',
    t.render('CHECKOUT_ORDER_ID', { id: publicId }),
    t.render('CHECKOUT_SERVICE', { product: soldAs(plan.productName, plan.planName) }),
    t.render('CHECKOUT_AMOUNT', { amount: formatToman(totalIrr) }),
    '',
    ...checkoutTail(cardDigits, cardHolder),
  ].join('\n');
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
  totalIrr: number,
  cardDigits: string,
  wallet?: { balanceIrr: number; totalIrr: number },
  /**
   * `setting.statuscopycart`. Optional and defaulting to on, so a caller that
   * has not been given the shop's settings keeps drawing the buttons rather
   * than silently taking them off an invoice.
   */
  showCopy = true,
): InlineKeyboard {
  const covers = wallet !== undefined && wallet.balanceIrr >= wallet.totalIrr;
  const someBalance = wallet !== undefined && wallet.balanceIrr > 0;
  const chrome = buildMenu('checkout', layout('checkout'), {
    applies: (action) =>
      action === 'wpay' ? covers : action === 'tpo' ? someBalance && !covers : true,
    target: (action) => (action === 'menu' ? encode('menu') : encode(action as 'paid', orderId)),
    values: { balance: wallet ? formatToman(wallet.balanceIrr) : '' },
  });
  const copy = showCopy ? copyRow(cardDigits, totalIrr) : [];
  // Above the chrome, like every other data row on every other screen. The
  // layout an admin saves describes the buttons below this one.
  return copy.length > 0 ? [copy, ...chrome] : chrome;
}

/**
 * The two buttons that stop a customer typing.
 *
 * Card-to-card verification compares the bank's amount against ours EXACTLY —
 * no tolerance, no rounding — and the destination is sixteen digits copied by
 * eye into a banking app. Every mistyped digit is either a payment that lands
 * in the manual queue or money sent to somebody else entirely. `copy_text`
 * puts both on the clipboard, so neither is ever retyped.
 *
 * A value Telegram would refuse drops its own button rather than the invoice.
 * The cap is 256 characters and a card number is sixteen, so this can only fire
 * on a card row somebody has filled with something that is not a card — and
 * when it does, the number is still written in the message above, which is
 * where it was read from before this existed.
 */
function copyRow(cardDigits: string, totalIrr: number): InlineButton[] {
  const t = TEXTS_NOW;
  const row: InlineButton[] = [];
  const add = (label: string, value: string): void => {
    if (value.length > 0 && value.length <= MAX_COPY_TEXT_LENGTH) {
      row.push({ text: label, copy_text: { text: value } });
    }
  };
  add(t.raw('CHECKOUT_COPY_CARD'), cardDigits);
  add(t.raw('CHECKOUT_COPY_AMOUNT'), tomanDigits(totalIrr));
  return row;
}

export function paidRecorded(publicId: string): string {
  const t = TEXTS_NOW;
  return [
    t.raw('PAID_RECORDED_TITLE'),
    '',
    t.render('PAID_TRACKING_ID', { id: publicId }),
    '',
    t.raw('PAID_WAIT'),
    // Asked for here and nowhere else. A receipt matters most in the one case
    // the customer cannot see coming: automatic verification found nothing, and
    // an admin is about to decide about their money with no document in front
    // of them.
    t.raw('PAID_SEND_RECEIPT'),
  ].join('\n');
}

/**
 * Sent unprompted when an invoice runs out of time.
 *
 * It names the order so a customer can tell which of theirs it was, and says
 * the card is no longer valid — the invoice with that card on it is still
 * sitting in their chat, and «منقضی شد» alone would not stop anybody scrolling
 * up and paying it.
 */
export function orderExpired(publicId: string): string {
  const t = TEXTS_NOW;
  return [
    t.raw('ORDER_EXPIRED_TITLE'),
    '',
    t.render('PAID_TRACKING_ID', { id: publicId }),
    '',
    t.raw('ORDER_EXPIRED_CARD_STALE'),
  ].join('\n');
}

/** The receipt landed and is attached to the claim under review. */
export function receiptReceived(publicId: string): string {
  const t = TEXTS_NOW;
  return [t.raw('RECEIPT_RECEIVED_TITLE'), '', t.render('PAID_TRACKING_ID', { id: publicId })].join(
    '\n',
  );
}

/**
 * Second press of a button that is already spent. Same screen, no scolding.
 *
 * And the same ask. This reply used to be the title and the tracking id and
 * nothing else, so the one line inviting a receipt appeared only on the very
 * first press — the press a customer is least likely to be reading carefully,
 * having just come back from their banking app. Press the button twice and the
 * bot never mentioned a receipt at all.
 *
 * That is very likely what Sam saw on 2026-08-24: «یک ضرب گفت اوکیه و صبر کن».
 * `checkoutFor` answers `claimed` for an order that already has a live claim,
 * and `handle.ts` sends this reply on that path too.
 */
export function paidAlready(publicId: string): string {
  const t = TEXTS_NOW;
  return [
    t.raw('PAID_ALREADY_TITLE'),
    '',
    t.render('PAID_TRACKING_ID', { id: publicId }),
    '',
    t.raw('PAID_SEND_RECEIPT'),
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
  const t = TEXTS_NOW;
  return [
    t.raw('PAYMENT_CONFIRMED_TITLE'),
    '',
    t.render('PAID_TRACKING_ID', { id: publicId }),
    '',
    t.raw('PAYMENT_CONFIRMED_QUEUED'),
  ].join('\n');
}

export function afterPaidMenu(): InlineKeyboard {
  return buildMenu('afterPaid', layout('afterPaid'));
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
  const t = TEXTS_NOW;
  const lines = [
    t.raw('SERVICE_READY_TITLE'),
    '',
    t.render('SERVICE_READY_USERNAME', { username }),
  ];
  if (expiresAt !== null) {
    lines.push(t.render('SERVICE_READY_EXPIRES', { date: formatTehranDate(expiresAt) }));
  }
  lines.push(
    '',
    t.raw('SERVICE_READY_LINK_LABEL'),
    subscriptionUrl,
    '',
    t.raw('SERVICE_READY_HOWTO'),
  );
  return lines.join('\n');
}

/**
 * The same moment, on the screen the service actually deserves.
 *
 * `serviceReady` above is three lines: username, expiry, link. The screen a
 * customer reaches later by tapping «سرویس‌های من» is the full card — state,
 * location, quota with a usage bar, days left — with the buttons that renew,
 * switch off, or replace the link. The worse screen was the one that arrived
 * at the moment of purchase, and the competitor's bot has been sending the
 * better one at that moment for as long as anyone has looked.
 *
 * So the delivery message IS the service screen, with one line of celebration
 * above it. `serviceReady` stays as the fallback for a delivery that produced
 * no subscription row to draw.
 */
export function serviceReadyCard(service: ServiceView, now: number): string {
  return `${TEXTS_NOW.raw('SERVICE_READY_TITLE')}\n\n${serviceDetail(service, now)}`;
}

/**
 * Sold, paid, and waiting on a person — a manual product, or a kind whose
 * adapter is not written yet. Distinct from the failure message on purpose:
 * nothing is wrong, it is simply not instant.
 */
export function serviceBeingPrepared(publicId: string): string {
  const t = TEXTS_NOW;
  return [
    t.raw('SERVICE_MANUAL_TITLE'),
    '',
    t.render('SERVICE_MANUAL_TRACKING_ID', { id: publicId }),
    '',
    t.raw('SERVICE_MANUAL_BODY'),
  ].join('\n');
}

/**
 * Something went wrong that trying again will not fix.
 *
 * `refundedIrr` is what went back into the wallet, or null when nothing did.
 *
 * The old wording said the payment "is safe" whatever had happened. For a bank
 * transfer that is true — the money is in the account. For an order paid from
 * the balance it was not: the credit had been spent and the service never
 * arrived, so "safe" meant "we still have your money". Say which one it was.
 */
export function serviceNeedsHelp(publicId: string, refundedIrr: number | null = null): string {
  const t = TEXTS_NOW;
  const lines = [
    refundedIrr === null ? t.raw('SERVICE_FAILED_SAFE') : t.raw('SERVICE_FAILED_REFUNDED'),
    '',
    t.render('SERVICE_FAILED_TRACKING_ID', { id: publicId }),
  ];
  if (refundedIrr !== null) {
    lines.push(t.render('SERVICE_FAILED_REFUND_LINE', { amount: formatToman(refundedIrr) }));
  }
  lines.push('', t.raw('SERVICE_FAILED_FOOTER'));
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

const STATE_TEXT_KEY = {
  ACTIVE: 'STATE_ACTIVE',
  EXPIRED: 'STATE_EXPIRED',
  EXHAUSTED: 'STATE_EXHAUSTED',
  ON_HOLD: 'STATE_ON_HOLD',
  DISABLED: 'STATE_DISABLED',
  REMOVED: 'STATE_REMOVED',
  FAILED: 'STATE_FAILED',
} as const satisfies Record<ServiceState, TextKey>;

/** Telegram wraps a long button onto several lines and the list stops being
 *  scannable. The name carries the plan, the duration and the price, so the
 *  front of it is the part worth keeping. */
function shortName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length <= 38 ? trimmed : `${trimmed.slice(0, 37)}…`;
}

export function myServicesTitle(total: number, page: number, pages: number): string {
  const t = TEXTS_NOW;
  const head = t.render('MY_SERVICES_TITLE', { total });
  return pages > 1 ? `${head}\n\n${t.render('MY_SERVICES_PAGE', { page, pages })}` : head;
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
  return withChrome(
    [
      ...services.map((service) => [
        {
          text: `${STATE_GLYPH[serviceState(service, now)]} ${shortName(service.plan_name_at_sale)}`,
          callback_data: encode('sub', service.id),
        },
      ]),
      ...paging('mine', page, pages),
    ],
    'myServices',
  );
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
 * direction of their own; between `⁦` and `⁩` the bar fills from the
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
  return `⁦${'█'.repeat(filled)}${'░'.repeat(BAR_CELLS - filled)} ${percent}%⁩`;
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
  const t = TEXTS_NOW;
  const state = serviceState(service, now);
  const lines = [
    t.render('SERVICE_DETAIL_TITLE', {
      glyph: STATE_GLYPH[state],
      name: service.plan_name_at_sale,
    }),
    t.render('SERVICE_DETAIL_STATE', { state: t.raw(STATE_TEXT_KEY[state]) }),
  ];
  if (service.provider_name_at_sale) {
    lines.push(t.render('SERVICE_DETAIL_LOCATION', { provider: service.provider_name_at_sale }));
  }
  lines.push(t.render('SERVICE_DETAIL_ID', { id: service.public_id }));
  if (service.remote_username) {
    lines.push(t.render('SERVICE_DETAIL_USERNAME', { username: service.remote_username }));
  }

  lines.push('');
  if (service.volume_gb === null) {
    lines.push(t.raw('SERVICE_DETAIL_VOLUME_UNLIMITED'));
    if (service.used_bytes !== null) {
      lines.push(t.render('SERVICE_DETAIL_USED', { used: formatGigabytes(service.used_bytes) }));
    }
  } else {
    lines.push(
      t.render('SERVICE_DETAIL_VOLUME', { volume: service.volume_gb.toLocaleString('en-US') }),
    );
    if (service.used_bytes !== null) {
      const remaining = Math.max(0, service.volume_gb * BYTES_PER_GB - service.used_bytes);
      // A zero quota would divide by zero, and a migrated row can carry one.
      if (service.volume_gb > 0) lines.push(usageBar(service.used_bytes, service.volume_gb));
      lines.push(t.render('SERVICE_DETAIL_USED', { used: formatGigabytes(service.used_bytes) }));
      lines.push(t.render('SERVICE_DETAIL_REMAINING', { remaining: formatGigabytes(remaining) }));
    }
  }

  if (service.expires_at === null) {
    lines.push(t.raw('SERVICE_DETAIL_NO_EXPIRY'));
  } else {
    const expiry = new Date(service.expires_at);
    lines.push(t.render('SERVICE_DETAIL_EXPIRES', { date: formatTehranDate(expiry) }));
    const daysLeft = Math.ceil((expiry.getTime() - now) / 86_400_000);
    if (daysLeft > 0) {
      lines.push(t.render('SERVICE_DETAIL_DAYS_LEFT', { days: daysLeft.toLocaleString('en-US') }));
    }
  }

  if (state === 'ACTIVE' && service.subscription_url) {
    lines.push('', t.raw('SERVICE_DETAIL_LINK_LABEL'), service.subscription_url);
  } else if (state === 'ACTIVE') {
    // Provisioned by a person, or a row migrated from the old bot that the sync
    // has not reached yet. Saying so beats an empty space where a link goes.
    lines.push('', t.raw('SERVICE_DETAIL_NO_LINK'));
  } else if (state === 'EXPIRED' || state === 'EXHAUSTED') {
    // Seen on the real screen: a dead service showed its status, withheld its
    // link, and then said nothing at all — leaving the customer on a screen
    // with no way forward. This is the one thing they can do about it.
    lines.push('', t.render('SERVICE_DETAIL_DEAD_HINT', { renewButton: renewButtonLabel() }));
  }
  return lines.join('\n');
}

/**
 * One tap to put the link on the clipboard.
 *
 * The competitor's bot renders the link in monospace, which on Telegram means
 * tap-to-copy. We set no `parse_mode` anywhere — a Persian sentence full of `<`
 * and `&` is safe precisely because of that — so the same affordance is a
 * `copy_text` button instead, which is what the checkout already uses for the
 * card number.
 *
 * Absent when the link is longer than Telegram allows a copy button to carry:
 * a button that silently copies a truncated URL is worse than none, and the
 * caption underneath is still selectable by hand.
 */
export function copyLinkMenu(url: string): InlineKeyboard | undefined {
  if (url.length > MAX_COPY_TEXT_LENGTH) return undefined;
  return [[{ text: '📋 کپی لینک اشتراک', copy_text: { text: url } }]];
}

/**
 * ponytail: back always lands on the first page. Carrying the page the customer
 * came from would need a second id in `callback_data`, and it costs four
 * customers in production one extra tap.
 */
export function serviceDetailMenu(actions?: ServiceActions | null): InlineKeyboard {
  return buildMenu('serviceDetail', layout('serviceDetail'), {
    // Each panel button appears only if that panel can actually do it: the shop
    // prices the add-ons per panel, and one panel has extending switched off
    // entirely. A service no panel can be asked about gets none of them.
    applies: (action) => {
      switch (action) {
        case 'xv':
          return actions != null && actions.volumeIrrPerGb !== null;
        case 'xt':
          return actions != null && actions.timeIrrPerDay !== null;
        // Same condition as `rvk`: both need a panel-backed service, and both
        // are about the subscription link. Drawn even for a service whose link
        // is missing — the handler says so, which beats a screen that silently
        // has one button fewer than the customer remembers.
        // `rvk` is panel-backed and nothing else. `qr` is the same button the
        // legacy calls «کانفیگ» and the shop can switch off, so it carries one
        // more condition than its neighbour despite sharing everything else.
        case 'qr':
          return actions != null && actions.showsConfig !== false;
        case 'rvk':
          return actions != null;
        case 'off':
          return actions != null && actions.canSwitch !== false && !actions.disabled;
        case 'on':
          return actions != null && actions.canSwitch !== false && actions.disabled;
        default:
          return true;
      }
    },
    target: (action) =>
      action === 'mine' || action === 'menu' ? action : encode(action as 'rvk', actions!.id),
  });
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
  /** Null when this panel does not sell that add-on, or the shop has it off. */
  volumeIrrPerGb: number | null;
  timeIrrPerDay: number | null;
  /**
   * Whether the customer may turn their own service off and on.
   *
   * The shop's `statuschangeservice` switch, which has been off in production
   * for years while this bot drew the buttons anyway. Optional so a caller that
   * has not been given the setting keeps the old behaviour rather than silently
   * removing a working button.
   */
  canSwitch?: boolean;
  /**
   * Whether the shop hands the config over from this screen —
   * `shopSetting.configshow`. Optional for the same reason as `canSwitch`: a
   * caller without the settings keeps the button rather than removing one the
   * customer remembers.
   */
  showsConfig?: boolean;
}

/** What the customer is buying, as one phrase both the invoice and the receipt
 *  drop into a sentence. */
function addonQuantity(kind: 'ADD_VOLUME' | 'ADD_TIME', quantity: number): string {
  const shown = quantity.toLocaleString('en-US');
  return kind === 'ADD_VOLUME'
    ? TEXTS_NOW.render('ADDON_QUANTITY_VOLUME', { quantity: shown })
    : TEXTS_NOW.render('ADDON_QUANTITY_TIME', { quantity: shown });
}

export function askAddonAmount(kind: 'ADD_VOLUME' | 'ADD_TIME', unitIrr: number): string {
  const t = TEXTS_NOW;
  const price = formatToman(unitIrr);
  return kind === 'ADD_VOLUME'
    ? [
        t.raw('ADDON_VOLUME_TITLE'),
        '',
        t.render('ADDON_VOLUME_PRICE', { price }),
        '',
        t.raw('ADDON_VOLUME_ASK'),
      ].join('\n')
    : [
        t.raw('ADDON_TIME_TITLE'),
        '',
        t.render('ADDON_TIME_PRICE', { price }),
        '',
        t.raw('ADDON_TIME_ASK'),
      ].join('\n');
}

export function addonTooMuch(max: number): string {
  return TEXTS_NOW.render('ADDON_TOO_MUCH', { max: max.toLocaleString('en-US') });
}

export function addonInvoice(
  kind: 'ADD_VOLUME' | 'ADD_TIME',
  quantity: number,
  totalIrr: number,
): string {
  const t = TEXTS_NOW;
  return [
    t.raw('ADDON_INVOICE_TITLE'),
    '',
    t.render('ADDON_INVOICE_ITEM', { what: addonQuantity(kind, quantity) }),
    t.render('ADDON_INVOICE_AMOUNT', { amount: formatToman(totalIrr) }),
  ].join('\n');
}

/**
 * The checkout for an add-on.
 *
 * Its own opening lines rather than the plan checkout with a fake plan pushed
 * through it: what is being bought here is a quantity, not a product, and the
 * two lines that differ are exactly the two a customer checks before
 * transferring money. Everything below them is the shared invoice.
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
  const t = TEXTS_NOW;
  return [
    t.raw('CHECKOUT_INTRO'),
    '',
    t.render('CHECKOUT_ORDER_ID', { id: publicId }),
    t.render('CHECKOUT_ADDON_ITEM', {
      what: addonQuantity(kind, quantity),
      service: serviceName,
    }),
    t.render('CHECKOUT_AMOUNT', { amount: formatToman(totalIrr) }),
    '',
    ...checkoutTail(cardDigits, cardHolder),
  ].join('\n');
}

export function addonApplied(
  kind: 'ADD_VOLUME' | 'ADD_TIME',
  quantity: number,
  serviceName: string,
  expiresAt: Date | null,
): string {
  const t = TEXTS_NOW;
  const shown = quantity.toLocaleString('en-US');
  const lines = [
    kind === 'ADD_VOLUME'
      ? t.render('ADDON_APPLIED_VOLUME', { quantity: shown, service: serviceName })
      : t.render('ADDON_APPLIED_TIME', { quantity: shown, service: serviceName }),
  ];
  if (expiresAt !== null) {
    lines.push(t.render('ADDON_APPLIED_EXPIRES', { date: formatTehranDate(expiresAt) }));
  }
  lines.push('', t.raw('ADDON_APPLIED_LINK_NOTE'));
  return lines.join('\n');
}

export function confirmRevokeMenu(subscriptionId: number): InlineKeyboard {
  return buildMenu('revokeConfirm', layout('revokeConfirm'), {
    target: (action) => encode(action as 'rvk2', subscriptionId),
  });
}

export function linkReplaced(subscriptionUrl: string): string {
  const t = TEXTS_NOW;
  return [
    t.raw('LINK_REPLACED_TITLE'),
    '',
    t.raw('LINK_REPLACED_LABEL'),
    subscriptionUrl,
    '',
    t.raw('LINK_REPLACED_NOTE'),
  ].join('\n');
}

export function serviceSwitched(enabled: boolean): string {
  return enabled ? TEXTS_NOW.raw('SERVICE_SWITCHED_ON') : TEXTS_NOW.raw('SERVICE_SWITCHED_OFF');
}

/** The panel said no. The reason is the adapter's, and it is written for a person. */
export function actionFailed(reason: string): string {
  const t = TEXTS_NOW;
  return [t.raw('ACTION_FAILED_TITLE'), '', reason, '', t.raw('ACTION_FAILED_RETRY')].join('\n');
}

// ---------------------------------------------------------------------------
// «تمدید سرویس»
// ---------------------------------------------------------------------------

/** The list of services, keyed to the renewal flow rather than the detail one. */
export function renewMenu(
  services: ServiceListItem[],
  now: number,
  page: number,
  pages: number,
): InlineKeyboard {
  return withChrome(
    [
      ...services.map((service) => [
        {
          text: `${STATE_GLYPH[serviceState(service, now)]} ${shortName(service.plan_name_at_sale)}`,
          callback_data: encode('rnw', service.id),
        },
      ]),
      ...paging('renew', page, pages),
    ],
    'renewList',
  );
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
  const t = TEXTS_NOW;
  const lines = [
    t.raw('RENEW_INTRO_TITLE'),
    '',
    t.render('RENEW_INTRO_SERVICE', { service: service.plan_name_at_sale }),
    t.render('RENEW_INTRO_ID', { id: service.public_id }),
  ];
  if (service.expires_at !== null) {
    lines.push(
      t.render('RENEW_INTRO_CURRENT_EXPIRY', {
        date: formatTehranDate(new Date(service.expires_at)),
      }),
    );
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
      ? t.raw('RENEW_MODE_ADD')
      : mode === 'ADD'
        ? t.raw('RENEW_MODE_ADD_EXPIRED')
        : t.raw('RENEW_MODE_RESET'),
    '',
    t.raw('RENEW_CHOOSE_PLAN'),
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
    // `soldAs`, not the product alone. A renewal is offered EVERYTHING the panel
    // sells — flat, because the plan a service was sold under is gone for
    // roughly half the migrated ones — so once tiers exist this list holds three
    // buttons reading «پلاتینیوم» told apart only by a price. Seen on the test
    // bot on 2026-08-23, after the buy flow had already been fixed: the same bug
    // in the one screen the fix did not reach.
    const label = soldAs(plan.productName, plan.planName);
    const quoted = price.discountIrr === 0 && nameMentionsPrice(label, plan.priceIrr);
    return [
      {
        text: quoted ? label : `${label} — ${formatToman(price.totalIrr)}`,
        callback_data: encode('rord', subscriptionId, plan.planId),
      },
    ];
  });
  return withChrome(keyboard, 'renewPlans', {
    applies: (action) =>
      action === 'dxr' ? heldCode != null : action === 'dsr' ? heldCode == null : true,
    target: (action) =>
      action === 'renew' || action === 'menu' ? action : encode(action as 'dsr', subscriptionId),
    values: { code: heldCode ?? '' },
  });
}

/** The checkout screen for a renewal — same money, different opening lines. */
export function renewCheckout(
  publicId: string,
  serviceName: string,
  plan: CatalogPlan,
  totalIrr: number,
  cardDigits: string,
  cardHolder: string | null,
  applied?: AppliedCode | null,
): string {
  const t = TEXTS_NOW;
  const lines = [
    t.raw('CHECKOUT_INTRO_RENEW'),
    '',
    t.render('CHECKOUT_ORDER_ID', { id: publicId }),
    t.render('CHECKOUT_RENEW_SERVICE', { service: serviceName }),
    t.render('CHECKOUT_RENEW_PLAN', { plan: plan.productName }),
  ];
  if (applied && applied.discountIrr > 0) {
    lines.push(
      t.render('CHECKOUT_CODE_DISCOUNT', {
        code: applied.code,
        amount: formatToman(applied.discountIrr),
      }),
    );
  }
  lines.push(
    t.render('CHECKOUT_AMOUNT', { amount: formatToman(totalIrr) }),
    '',
    ...checkoutTail(cardDigits, cardHolder),
  );
  return lines.join('\n');
}

/**
 * The renewal is done. Deliberately does not repeat the subscription link:
 * nothing about it changed, and a second link in the chat is one more thing to
 * import by mistake.
 */
export function serviceRenewed(
  serviceName: string,
  expiresAt: Date | null,
  /** The renewal cashback just credited, when the shop pays one. */
  cashbackIrr: number | null = null,
): string {
  const t = TEXTS_NOW;
  const lines = [
    t.raw('SERVICE_RENEWED_TITLE'),
    '',
    t.render('SERVICE_RENEWED_SERVICE', { service: serviceName }),
  ];
  if (expiresAt !== null) {
    lines.push(t.render('SERVICE_RENEWED_EXPIRES', { date: formatTehranDate(expiresAt) }));
  }
  // Said in the same message rather than a second one. The legacy bot sends two
  // («تبریک 🎉 … حساب شما شارژ گردید», then the renewal), and two notifications
  // for one action is a habit worth not carrying over.
  if (cashbackIrr !== null && cashbackIrr > 0) {
    lines.push('', t.render('SERVICE_RENEWED_CASHBACK', { amount: formatToman(cashbackIrr) }));
  }
  lines.push('', t.raw('SERVICE_RENEWED_LINK_NOTE'));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The two warnings, sent unprompted
// ---------------------------------------------------------------------------

/**
 * Both say which service, and both point at the same button — by its live
 * label, not by a copy of it.
 *
 * The service is named because a customer with several — and 1,687 of them have
 * more than one — cannot act on "your service is running out". Mirzabot names
 * it too, by remote username; the plan name is what the customer actually
 * recognises.
 */
export function timeRunningOut(serviceName: string, daysLeft: number): string {
  const t = TEXTS_NOW;
  return [
    t.raw('WARN_TIME_TITLE'),
    '',
    t.render('WARN_SERVICE', { service: serviceName }),
    t.render('WARN_TIME_DAYS', { days: daysLeft.toLocaleString('en-US') }),
    '',
    t.render('WARN_RENEW_HINT', { renewButton: renewButtonLabel() }),
  ].join('\n');
}

export function volumeRunningOut(serviceName: string, remainingBytes: number): string {
  const t = TEXTS_NOW;
  return [
    t.raw('WARN_VOLUME_TITLE'),
    '',
    t.render('WARN_SERVICE', { service: serviceName }),
    t.render('WARN_VOLUME_REMAINING', { remaining: formatGigabytes(remainingBytes) }),
    '',
    t.render('WARN_RENEW_HINT', { renewButton: renewButtonLabel() }),
  ].join('\n');
}

/**
 * The customer bought a service and has never connected to it.
 *
 * Not a warning about running out — the opposite. Mirzabot's version
 * (`cronbot/on_hold.php`) points at support and nothing else, and that is
 * right: somebody still not connected after four days is stuck, and the useful
 * thing to hand them is a person, not a button.
 *
 * The service is named the way the other two name it — by plan, not by remote
 * username. The legacy uses the config username because that is the key its
 * cron happens to hold; the customer recognises what they bought.
 *
 * `supportHandle` is nullable because `setting.id_support` can be empty, and
 * the message is still worth sending without it: "you have not connected" is
 * the news. The legacy renders a bare `@` in that case.
 */
export function serviceNeverUsed(
  serviceName: string,
  daysSincePurchase: number,
  supportHandle: string | null,
): string {
  const t = TEXTS_NOW;
  const lines = [
    t.raw('WARN_UNUSED_TITLE'),
    '',
    t.render('WARN_SERVICE', { service: serviceName }),
    t.render('WARN_UNUSED_DAYS', { days: daysSincePurchase.toLocaleString('en-US') }),
  ];
  if (supportHandle !== null) {
    lines.push('', t.render('WARN_UNUSED_SUPPORT', { handle: supportHandle }));
  }
  return lines.join('\n');
}

/**
 * What the shop's channel is told when the flood guard fires.
 *
 * The numeric id rather than the @handle: a customer who was blocked for
 * flooding is exactly the sort who has no username, and the id is what the
 * button underneath resolves anyway.
 */
export function spamBlockedReport(telegramId: number): string {
  return TEXTS_NOW.render('SPAM_BLOCKED_REPORT', { telegramId: String(telegramId) });
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
const ENTRY_TEXT_KEY: Record<string, TextKey> = {
  OPENING: 'ENTRY_OPENING',
  TOPUP: 'ENTRY_TOPUP',
  PURCHASE: 'ENTRY_PURCHASE',
  REFUND: 'ENTRY_REFUND',
  ADMIN_ADJUST: 'ENTRY_ADMIN_ADJUST',
  REFERRAL_BONUS: 'ENTRY_REFERRAL_BONUS',
  RENEWAL_CASHBACK: 'ENTRY_RENEWAL_CASHBACK',
  WHEEL_PRIZE: 'ENTRY_WHEEL_PRIZE',
  TRANSFER_IN: 'ENTRY_TRANSFER_IN',
  TRANSFER_OUT: 'ENTRY_TRANSFER_OUT',
  GIFT_CODE: 'ENTRY_GIFT_CODE',
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
  const t = TEXTS_NOW;
  const lines = [
    t.raw('WALLET_TITLE'),
    '',
    t.render('WALLET_BALANCE', { balance: formatToman(balanceIrr) }),
  ];
  if (balanceIrr < 0) {
    lines.push('', t.raw('WALLET_NEGATIVE'));
  }
  if (entries.length === 0) {
    lines.push('', t.raw('WALLET_NO_ENTRIES'));
    return lines.join('\n');
  }
  lines.push('', t.raw('WALLET_HISTORY_TITLE'));
  for (const entry of entries) {
    const key = ENTRY_TEXT_KEY[entry.kind];
    lines.push(
      t.render('WALLET_ENTRY_LINE', {
        sign: entry.amount_irr < 0 ? '➖' : '➕',
        amount: formatToman(Math.abs(entry.amount_irr)),
        // An unmapped kind falls back to its own name. A row written by a
        // future release must still be readable rather than blank.
        label: key ? t.raw(key) : entry.kind,
      }),
    );
  }
  return lines.join('\n');
}

export interface WalletEntryView {
  amount_irr: number;
  kind: string;
}

export function walletMenu(): InlineKeyboard {
  return buildMenu('wallet', layout('wallet'));
}

export function chooseTopupAmount(minIrr: number, maxIrr: number): string {
  const t = TEXTS_NOW;
  return [
    t.raw('TOPUP_TITLE'),
    '',
    t.render('TOPUP_RANGE', { min: formatToman(minIrr), max: formatToman(maxIrr) }),
    t.raw('TOPUP_NEXT'),
  ].join('\n');
}

/** The question behind «مبلغ دلخواه», with the limits it will be judged by. */
export function askTopupAmount(minIrr: number, maxIrr: number): string {
  const t = TEXTS_NOW;
  return [
    t.raw('TOPUP_ASK_AMOUNT'),
    '',
    t.render('TOPUP_RANGE', { min: formatToman(minIrr), max: formatToman(maxIrr) }),
  ].join('\n');
}

/** Said when the typed amount is a number, but not one the shop accepts. */
export function topupOutOfRange(minIrr: number, maxIrr: number): string {
  const t = TEXTS_NOW;
  return [
    t.raw('TOPUP_OUT_OF_RANGE'),
    '',
    t.render('TOPUP_RANGE', { min: formatToman(minIrr), max: formatToman(maxIrr) }),
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
  return withChrome(keyboard, 'topup');
}

/** The card screen for a deposit — same money, no service being bought. */
export function topupCheckout(
  publicId: string,
  amountIrr: number,
  cardDigits: string,
  cardHolder: string | null,
): string {
  const t = TEXTS_NOW;
  return [
    t.raw('CHECKOUT_INTRO_TOPUP'),
    '',
    t.render('CHECKOUT_TRACKING_ID', { id: publicId }),
    t.render('CHECKOUT_AMOUNT', { amount: formatToman(amountIrr) }),
    '',
    ...checkoutTail(cardDigits, cardHolder),
  ].join('\n');
}

/** Sent by the settle sweep, not by a button: the deposit has landed. */
export function walletToppedUp(amountIrr: number): string {
  const t = TEXTS_NOW;
  return [
    t.raw('WALLET_TOPPED_UP_TITLE'),
    '',
    t.render('WALLET_TOPPED_UP_AMOUNT', { amount: formatToman(amountIrr) }),
    '',
    t.raw('WALLET_TOPPED_UP_FOOTER'),
  ].join('\n');
}

/**
 * `publicId`, not a service name. The first version of this screen labelled the
 * order id with 🔐 as though it were the product, so the customer read
 * `🔐 143e2b4cb3` where they expected to see what they had just bought. Only
 * opening the screen showed it.
 */
export function walletPaid(publicId: string, remainingIrr: number): string {
  const t = TEXTS_NOW;
  return [
    t.raw('WALLET_PAID_TITLE'),
    '',
    t.render('WALLET_PAID_ORDER_ID', { id: publicId }),
    t.render('WALLET_PAID_REMAINING', { balance: formatToman(remainingIrr) }),
    '',
    t.raw('WALLET_PAID_FOOTER'),
  ].join('\n');
}
