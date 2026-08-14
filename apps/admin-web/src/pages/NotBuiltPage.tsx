/**
 * A section that has a place in the navigation and no screen behind it yet.
 *
 * It says so plainly and names what it will read, rather than showing an empty
 * table that looks like "no data". Those are opposite facts and an admin acting
 * on the wrong one wastes an afternoon.
 */

import { pageLabel, type PageId } from '../nav.js';

const SOURCE: Partial<Record<PageId, string>> = {
  orders: 'orders · payments',
  services: 'subscriptions',
  products: 'products · product_plans',
  transactions: 'wallet_entries · payments',
  requests: 'payment_claims · reseller_requests',
  panels: 'provisioning_providers',
  discounts: 'discount_codes · discount_redemptions',
  texts: 'help_articles · settings',
  keyboard: 'settings',
  settings: 'settings',
};

export function NotBuiltPage({ id }: { id: PageId }) {
  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">{pageLabel(id)}</div>
          <div className="page-head__sub">این بخش هنوز ساخته نشده است</div>
        </div>
      </div>
      <div className="card">
        <p className="muted" style={{ margin: 0 }}>
          جدول‌هایش در دیتابیس آماده است — <span className="ltr">{SOURCE[id] ?? '—'}</span> — و
          کاری که مانده ساختن همین صفحه روی آن‌هاست. ترتیب ساخت در{' '}
          <span className="ltr">docs/admin-panel-roadmap.md</span> نوشته شده.
        </p>
      </div>
    </>
  );
}
