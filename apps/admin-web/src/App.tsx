/**
 * The panel's frame: header across the top, navigation down the right.
 *
 * This is a separate application from the payment hub — separate build,
 * separate stylesheet, separate Cloudflare Access audience. It shares nothing
 * with it but the Postgres underneath, and that is the point: the two answer
 * different questions for different people, and a shop admin should not have
 * to learn a reconciliation tool to change a price.
 *
 * Navigation is state, not a router. Twelve sections with no deep links and no
 * shareable URLs do not need one, and adding a router would mean the worker's
 * SPA fallback has to know every path. The one path that matters — /admin —
 * is already handled server-side.
 */

import { useState } from 'react';
import { NAV, pageLabel, type PageId } from './nav.js';
import { Icon } from './icons.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { CustomersPage } from './pages/CustomersPage.js';
import { ProductsPage } from './pages/ProductsPage.js';
import { PanelsPage } from './pages/PanelsPage.js';
import { DiscountsPage } from './pages/DiscountsPage.js';
import { OrdersPage, ServicesPage, TransactionsPage } from './pages/LedgerPages.js';
import { SettingsPage, RequestsPage } from './pages/SettingsPage.js';
import { BotTextsPage, KeyboardPage } from './pages/BotContentPages.js';
import './theme.css';

/**
 * Which screen the selected section shows.
 *
 * A switch rather than a lookup table so the compiler checks the section list
 * for us. Every `PageId` now has a screen, so there is no default arm: adding a
 * section to `nav.ts` without building it is a type error here, which is a
 * better place to find out than a «به‌زودی» badge in front of a customer's
 * admin. That badge, and the placeholder page behind it, are gone with the last
 * unbuilt section.
 */
function Body({ page, go }: { page: PageId; go: (id: PageId) => void }) {
  switch (page) {
    case 'dashboard':
      return <DashboardPage onGo={go} />;
    case 'customers':
      return <CustomersPage />;
    case 'products':
      return <ProductsPage />;
    case 'panels':
      return <PanelsPage />;
    case 'discounts':
      return <DiscountsPage />;
    case 'orders':
      return <OrdersPage />;
    case 'services':
      return <ServicesPage />;
    case 'transactions':
      return <TransactionsPage />;
    case 'requests':
      return <RequestsPage />;
    case 'settings':
      return <SettingsPage />;
    case 'texts':
      return <BotTextsPage />;
    case 'keyboard':
      return <KeyboardPage />;
  }
}

export function App() {
  const [page, setPage] = useState<PageId>('dashboard');
  const [navOpen, setNavOpen] = useState(false);

  function go(id: PageId) {
    setPage(id);
    setNavOpen(false);
  }

  return (
    <>
      <header className="app-header">
        <div className="app-header__left">
          <button
            type="button"
            className="icon-btn"
            aria-label="منو"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((v) => !v)}
          >
            <Icon name="bars" />
          </button>
          <div>
            <div className="app-header__title">{pageLabel(page)}</div>
            <div className="app-header__crumb">شیکو / {pageLabel(page)}</div>
          </div>
        </div>
      </header>

      <aside className={navOpen ? 'app-sidebar open' : 'app-sidebar'}>
        <div className="sidebar-brand">
          <span className="sidebar-brand__mark">ش</span>
          <span>
            <span className="sidebar-brand__name">شیکو</span>
            <br />
            <span className="sidebar-brand__sub">پنل مدیریت</span>
          </span>
        </div>

        {NAV.map((group) => (
          <div key={group.label}>
            <div className="sidebar-section-label">{group.label}</div>
            {group.items.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={page === item.id ? 'page' : undefined}
                className={page === item.id ? 'sidebar-link active' : 'sidebar-link'}
                onClick={() => go(item.id)}
              >
                <span className="sidebar-link__icon">
                  <Icon name={item.icon} />
                </span>
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        ))}

        <div className="sidebar-foot">
          <span className="sidebar-foot__avatar">ش</span>
          <span>
            پنل مدیریت
            <br />
            <span className="muted">نسخهٔ ۱</span>
          </span>
        </div>
      </aside>

      <div
        className={navOpen ? 'sidebar-overlay open' : 'sidebar-overlay'}
        onClick={() => setNavOpen(false)}
      />

      <section id="main-content">
        <div className="wrapper">
          <Body page={page} go={go} />
        </div>
      </section>
    </>
  );
}
