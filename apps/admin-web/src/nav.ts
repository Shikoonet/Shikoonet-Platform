/**
 * The panel's navigation, grouped by the job rather than by where a screen
 * came from.
 *
 * ## Why this was regrouped on 2026-08-30
 *
 * Until today the groups were «منوی اصلی · مدیریت · پول · پیکربندی», inherited
 * from `panel/header.php` so that muscle memory would survive the move. That
 * reason expired: the panel now has screens the legacy never had, and the
 * inheritance had turned «منوی اصلی» into eleven items covering four unrelated
 * jobs while splitting every subject in two.
 *
 * It cost something real. Sam went looking for the expense ledger, did not find
 * it, and asked where it was — it was the tenth of those eleven, under a name
 * that starts with the word he was looking for. Five money screens sat in two
 * different groups; six catalogue screens sat in two different groups; the two
 * reporting screens sat in two different groups.
 *
 * So the rule here is now one sentence: **a group is one job, and nothing that
 * belongs to that job lives anywhere else.** «هزینه‌ها» is beside «تراکنش‌ها»
 * under «پول», «دسته‌بندی‌ها» is beside «محصولات» under «کاتالوگ», and the two
 * «آمار» screens are beside each other under «گزارش‌ها» — which is also the only
 * arrangement that makes their two names read as a pair rather than as a
 * duplicate.
 *
 * `nav.test.tsx` used to pin the old four names and their order. That test was
 * recording the decision above, not guarding an invariant, so it records this
 * one now. What it still guards — and must keep guarding — is that no label is
 * a substring of another.
 *
 * There was a `built: false` flag here and a «به‌زودی» badge beside the sections
 * that carried it. Both are gone because no section carries it any more —
 * catalogue create/edit/delete was the last one. A flag that is true on every
 * row is not documentation, it is a claim nobody checks; `App.tsx` now proves
 * the same thing at compile time by having no default arm.
 */

/**
 * The six screens that came from the payment hub.
 *
 * Kept as their own type because `App.tsx` hands exactly these to `HubSection`
 * and nothing else: the compiler, not a comment, is what stops «کاربران» being
 * routed into a screen that expects a payment cache.
 */
export type HubPageId = 'payments' | 'statistics' | 'today' | 'accounts' | 'banks' | 'devices';

export type PageId =
  | HubPageId
  | 'dashboard'
  | 'stats'
  | 'customers'
  | 'bulk'
  | 'orders'
  | 'catalog'
  | 'products'
  | 'categories'
  | 'subscriptions'
  | 'transactions'
  | 'expenses'
  | 'requests'
  | 'panels'
  | 'stock'
  | 'discounts'
  | 'texts'
  | 'keyboard'
  | 'content'
  | 'access'
  | 'events'
  | 'import'
  | 'bot'
  | 'settings';

export interface NavItem {
  id: PageId;
  label: string;
  icon: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    // First, because it is the question every other screen is an answer to.
    // The two «آمار» screens are here together on purpose: one is the shop's
    // own trade and the other is the bank side, and side by side their names
    // read as a division of labour instead of as the same word twice.
    label: 'گزارش‌ها',
    items: [
      { id: 'dashboard', label: 'داشبورد', icon: 'home' },
      { id: 'stats', label: 'آمار فروشگاه', icon: 'grid' },
      { id: 'statistics', label: 'آمار مالی', icon: 'bars' },
    ],
  },
  {
    // A customer and what they bought. «سفارشات» sits between the person and
    // the service because that is the order it happens in: someone orders, the
    // order becomes a subscription.
    label: 'مشتری و فروش',
    items: [
      { id: 'customers', label: 'کاربران', icon: 'users' },
      { id: 'orders', label: 'سفارشات', icon: 'receipt' },
      { id: 'subscriptions', label: 'اشتراک‌های مشتری', icon: 'package' },
      { id: 'requests', label: 'لیست درخواست‌ها', icon: 'list' },
      { id: 'bulk', label: 'ارسال گروهی', icon: 'send' },
    ],
  },
  {
    // What can be sold, in the order the work happens in: a panel decides where
    // a service lives, a service decides the tier, and a product is a price on
    // it. «دسته‌بندی‌ها» and «قفسهٔ انبار» were two groups away from «محصولات»
    // until today, which is how you edit a product and then hunt for the
    // category it belongs to.
    label: 'کاتالوگ',
    items: [
      { id: 'panels', label: 'مدیریت پنل‌ها', icon: 'server' },
      { id: 'catalog', label: 'سرویس‌ها', icon: 'grid' },
      { id: 'products', label: 'محصولات', icon: 'package' },
      { id: 'categories', label: 'دسته‌بندی‌ها', icon: 'grid' },
      { id: 'discounts', label: 'کدهای تخفیف', icon: 'ticket' },
      { id: 'stock', label: 'قفسهٔ انبار', icon: 'package' },
    ],
  },
  {
    // Every screen where money is looked at, in one place — which is what Sam
    // could not find. «پرداخت‌ها» stays first: it is the one an operator sits
    // in rather than visits.
    label: 'پول',
    items: [
      { id: 'payments', label: 'پرداخت‌ها', icon: 'money' },
      { id: 'today', label: 'امروز', icon: 'receipt' },
      { id: 'transactions', label: 'تراکنش‌ها', icon: 'wallet' },
      // «هزینه‌ها», not «هزینه‌ها و تعدیل‌ها»: the ledger now names each row's
      // kind in a column of its own, so the title no longer has to list them.
      { id: 'expenses', label: 'هزینه‌ها', icon: 'wallet' },
      { id: 'accounts', label: 'حساب‌ها', icon: 'wallet' },
      { id: 'banks', label: 'بانک‌ها', icon: 'list' },
      { id: 'devices', label: 'دستگاه‌ها', icon: 'server' },
    ],
  },
  {
    label: 'ربات',
    items: [
      // First in its group, and above the bot's own wording, because it is the
      // question that comes before every other one here: an admin editing
      // «متن‌های ربات» is editing the text of a bot, and until this screen
      // existed nothing in the panel said which bot that was.
      // «ربات تلگرام», not «ربات»: the shorter label is a substring of
      // «متن‌های ربات» below it, and `nav.test.tsx` refuses that — correctly.
      // A sidebar where one entry's name is contained in another's is one an
      // operator has to read twice, which is the same rule as «سرویس‌ها».
      { id: 'bot', label: 'ربات تلگرام', icon: 'settings' },
      { id: 'texts', label: 'متن‌های ربات', icon: 'text' },
      { id: 'keyboard', label: 'چیدمان کیبورد', icon: 'keyboard' },
      { id: 'content', label: 'آموزش، برنامه‌ها و کانال‌ها', icon: 'text' },
    ],
  },
  {
    // Last, and the only group whose screens are about the panel itself rather
    // than about the shop.
    label: 'سیستم',
    items: [
      { id: 'settings', label: 'تنظیمات', icon: 'settings' },
      { id: 'access', label: 'دسترسی‌ها', icon: 'users' },
      { id: 'events', label: 'رویدادها', icon: 'list' },
      { id: 'import', label: 'ایمپورت میرزابات', icon: 'server' },
    ],
  },
];

/**
 * The sections a READ_ONLY operator can actually open.
 *
 * The server decides this — `mayRead` in `apps/dashboard-worker/src/access.ts`
 * is the guard, and it answers 403 whatever this file says. What this list is
 * for is not drawing a section that will only ever show an error: a panel that
 * offers a door and then refuses it reads as broken rather than as a boundary.
 *
 * Kept here rather than derived from a route, because a section is not a path —
 * «اشتراک‌های مشتری» reads `/subscriptions` and «سرویس‌ها» reads `/catalog`.
 */
/**
 * Sections only the shop's owner is offered.
 *
 * `READABLE_BY_READER` below draws the line for READ_ONLY; this one is the
 * narrower case, and «رویدادها» is so far the only member. A REVIEWER reviews
 * payments — stack traces and the shop's own failures are not that job, and the
 * route refuses them anyway (`eventRoutes.ts`), so offering the section would
 * be offering a door that answers 403.
 */
export const ADMIN_ONLY: ReadonlySet<PageId> = new Set<PageId>(['events', 'import']);

export const READABLE_BY_READER: ReadonlySet<PageId> = new Set<PageId>([
  'dashboard',
  // Every figure on it is an aggregate — nothing there names a customer.
  'stats',
  // All six finance screens. Not an oversight and not generosity: reviewing
  // payments is the entire reason the READ_ONLY role exists, and `mayRead`
  // withholds nothing on these paths — its list is `/api/v1/admin/*` only, and
  // the hub's routes have never been under it. Every *write* on them already
  // answers 403 for this role, checked per route in `index.ts`. Leaving them
  // out of this set would hide from a reviewer exactly the work they were
  // given the account to do.
  'payments',
  'statistics',
  'today',
  'accounts',
  'banks',
  'devices',
  'catalog',
  'products',
  'categories',
  'panels',
  // Counting the shelf is stock control; the accounts on it are not handed
  // over — `stockRoutes.ts` withholds the subscription link from anyone but an
  // ADMIN, so reading this page is safe for a reviewer.
  'stock',
  'discounts',
  // «هزینه‌ها» is deliberately absent. It is not customer data, which
  // is the usual reason to withhold a page — it is the shop's own costs, and
  // what the shop spends is not part of reviewing a payment.
  'texts',
  'keyboard',
  // Reading what the shop tells its customers is shop operation, not customer
  // data — the same line «متن‌های ربات» sits on.
  'content',
  // Which bot the shop is. The token is not on the page and the write is
  // ADMIN-only in the route; what a reviewer sees is a bot's username, which
  // is public the moment anyone opens the shop.
  'bot',
  'settings',
]);

const BY_ID = new Map(NAV.flatMap((g) => g.items).map((i) => [i.id, i]));

export function navItem(id: PageId): NavItem | undefined {
  return BY_ID.get(id);
}

/**
 * Whether a URL segment names a section.
 *
 * Derived from `NAV` rather than from a second list of strings, so a section
 * that exists in the sidebar is linkable and one that does not is not — there
 * is no third state where the router accepts a path nothing can draw.
 */
export function isPageId(value: string): value is PageId {
  return BY_ID.has(value as PageId);
}

/** The label shown in the header crumb and the page heading. */
export function pageLabel(id: PageId): string {
  return BY_ID.get(id)?.label ?? '';
}
