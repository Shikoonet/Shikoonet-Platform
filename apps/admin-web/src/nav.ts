/**
 * The panel's navigation, grouped the way the admin already knows it.
 *
 * The three groups and their order come from the panel this replaces
 * (`panel/header.php`): منوی اصلی for the day-to-day lists, مدیریت for the
 * things that decide what can be sold, پیکربندی for the bot's own text and
 * layout. Keeping the order means an admin's muscle memory survives the move.
 *
 * `built: false` is deliberate and stays visible. Hiding a section until it
 * exists makes the panel look finished when it is not, and the admin cannot
 * tell "we decided against this" from "it is coming". Every one of these has a
 * table in Postgres already — see `docs/admin-panel-roadmap.md` for the order.
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
  | 'settings';

export interface NavItem {
  id: PageId;
  label: string;
  icon: string;
  built: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    label: 'منوی اصلی',
    items: [
      { id: 'dashboard', label: 'داشبورد', icon: 'home', built: true },
      { id: 'customers', label: 'کاربران', icon: 'users', built: true },
      { id: 'orders', label: 'سفارشات', icon: 'receipt', built: false },
      { id: 'services', label: 'سرویس‌ها', icon: 'package', built: false },
      { id: 'products', label: 'محصولات', icon: 'grid', built: true },
      { id: 'transactions', label: 'تراکنش‌ها', icon: 'wallet', built: false },
      { id: 'requests', label: 'لیست درخواست‌ها', icon: 'list', built: false },
    ],
  },
  {
    label: 'مدیریت',
    items: [
      { id: 'panels', label: 'مدیریت پنل‌ها', icon: 'server', built: false },
      { id: 'discounts', label: 'کدهای تخفیف', icon: 'ticket', built: false },
    ],
  },
  {
    label: 'پیکربندی',
    items: [
      { id: 'texts', label: 'متن‌های ربات', icon: 'text', built: false },
      { id: 'keyboard', label: 'چیدمان کیبورد', icon: 'keyboard', built: false },
      { id: 'settings', label: 'تنظیمات', icon: 'settings', built: false },
    ],
  },
];

const BY_ID = new Map(NAV.flatMap((g) => g.items).map((i) => [i.id, i]));

export function navItem(id: PageId): NavItem | undefined {
  return BY_ID.get(id);
}

/** The label shown in the header crumb and the page heading. */
export function pageLabel(id: PageId): string {
  return BY_ID.get(id)?.label ?? '';
}
