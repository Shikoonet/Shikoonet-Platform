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

export type PageId =
  | 'dashboard'
  | 'customers'
  | 'orders'
  | 'services'
  | 'products'
  | 'transactions'
  | 'requests'
  | 'panels'
  | 'discounts'
  | 'texts'
  | 'keyboard'
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
      { id: 'orders', label: 'سفارشات', icon: 'receipt' },
      { id: 'services', label: 'سرویس‌ها', icon: 'package' },
      { id: 'products', label: 'محصولات', icon: 'grid' },
      { id: 'transactions', label: 'تراکنش‌ها', icon: 'wallet' },
      { id: 'requests', label: 'لیست درخواست‌ها', icon: 'list' },
    ],
  },
  {
    label: 'مدیریت',
    items: [
      { id: 'panels', label: 'مدیریت پنل‌ها', icon: 'server' },
      { id: 'discounts', label: 'کدهای تخفیف', icon: 'ticket' },
      { id: 'access', label: 'دسترسی‌ها', icon: 'users' },
    ],
  },
  {
    label: 'پیکربندی',
    items: [
      { id: 'texts', label: 'متن‌های ربات', icon: 'text' },
      { id: 'keyboard', label: 'چیدمان کیبورد', icon: 'keyboard' },
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
  'products',
  'panels',
  'discounts',
  'texts',
  'keyboard',
  'settings',
]);

const BY_ID = new Map(NAV.flatMap((g) => g.items).map((i) => [i.id, i]));

export function navItem(id: PageId): NavItem | undefined {
  return BY_ID.get(id);
}

/** The label shown in the header crumb and the page heading. */
export function pageLabel(id: PageId): string {
  return BY_ID.get(id)?.label ?? '';
}
