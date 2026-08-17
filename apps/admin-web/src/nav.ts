/**
 * The panel's navigation, grouped the way the admin already knows it.
 *
 * The three groups and their order come from the panel this replaces
 * (`panel/header.php`): منوی اصلی for the day-to-day lists, مدیریت for the
 * things that decide what can be sold, پیکربندی for the bot's own text and
 * layout. Keeping the order means an admin's muscle memory survives the move.
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
  | 'customers'
  | 'bulk'
  | 'orders'
  | 'services'
  | 'products'
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
    label: 'منوی اصلی',
    items: [
      { id: 'dashboard', label: 'داشبورد', icon: 'home' },
      { id: 'customers', label: 'کاربران', icon: 'users' },
      { id: 'bulk', label: 'ارسال گروهی', icon: 'send' },
      { id: 'orders', label: 'سفارشات', icon: 'receipt' },
      { id: 'services', label: 'سرویس‌ها', icon: 'package' },
      { id: 'products', label: 'محصولات', icon: 'grid' },
      { id: 'transactions', label: 'تراکنش‌ها', icon: 'wallet' },
      { id: 'expenses', label: 'هزینه‌ها و تعدیل‌ها', icon: 'wallet' },
      { id: 'requests', label: 'لیست درخواست‌ها', icon: 'list' },
    ],
  },
  {
    label: 'مدیریت',
    items: [
      { id: 'panels', label: 'مدیریت پنل‌ها', icon: 'server' },
      { id: 'stock', label: 'قفسهٔ انبار', icon: 'package' },
      { id: 'discounts', label: 'کدهای تخفیف', icon: 'ticket' },
      { id: 'access', label: 'دسترسی‌ها', icon: 'users' },
    ],
  },
  {
    // The payment hub, which until 2026-08-16 was a separate build behind a
    // separate Cloudflare Access application at `/`. Third, in the position Sam
    // put it after seeing the merged sidebar — the two groups above are what
    // the shop's admin opens the panel for, and this is the one an operator
    // sits in rather than visits.
    label: 'پول',
    items: [
      { id: 'payments', label: 'پرداخت‌ها', icon: 'money' },
      { id: 'statistics', label: 'آمار مالی', icon: 'grid' },
      { id: 'today', label: 'امروز', icon: 'receipt' },
      { id: 'accounts', label: 'حساب‌ها', icon: 'wallet' },
      { id: 'banks', label: 'بانک‌ها', icon: 'list' },
      { id: 'devices', label: 'دستگاه‌ها', icon: 'server' },
    ],
  },
  {
    label: 'پیکربندی',
    items: [
      { id: 'texts', label: 'متن‌های ربات', icon: 'text' },
      { id: 'keyboard', label: 'چیدمان کیبورد', icon: 'keyboard' },
      { id: 'content', label: 'آموزش، برنامه‌ها و کانال‌ها', icon: 'text' },
      { id: 'settings', label: 'تنظیمات', icon: 'settings' },
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
 * «سرویس‌ها» reads `/subscriptions` and the sidebar has no idea.
 */
export const READABLE_BY_READER: ReadonlySet<PageId> = new Set<PageId>([
  'dashboard',
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
  'products',
  'panels',
  // Counting the shelf is stock control; the accounts on it are not handed
  // over — `stockRoutes.ts` withholds the subscription link from anyone but an
  // ADMIN, so reading this page is safe for a reviewer.
  'stock',
  'discounts',
  // «هزینه‌ها و تعدیل‌ها» is deliberately absent. It is not customer data, which
  // is the usual reason to withhold a page — it is the shop's own costs, and
  // what the shop spends is not part of reviewing a payment.
  'texts',
  'keyboard',
  // Reading what the shop tells its customers is shop operation, not customer
  // data — the same line «متن‌های ربات» sits on.
  'content',
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
