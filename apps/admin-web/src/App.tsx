/**
 * The panel's frame: header across the top, navigation down the right.
 *
 * One build, one door, one menu. Until 2026-08-16 the shop was run from two
 * separate SPAs behind two separate Cloudflare Access applications — the
 * payment hub at `/` and this panel at `/admin/` — and nothing could be done
 * from both. Access is gone, the hub's six screens are the «پول» group in the
 * sidebar below, and `/` is a redirect.
 *
 * Nothing renders until `/api/v1/auth/me` has answered. That is a deliberate
 * flash of nothing rather than a flash of the panel — every screen here fetches
 * on mount, and drawing them before the identity is known means a signed-out
 * visitor watches a dozen requests fail behind a login form.
 *
 * Navigation is a real URL now (`route.ts`), not `useState`. Twenty-two
 * sections that cannot be linked to is a panel where «look at this payment» has
 * to be described rather than sent.
 */

import { useEffect, useMemo, useState } from 'react';
import { NAV, pageLabel, READABLE_BY_READER, type HubPageId, type PageId } from './nav.js';
import { api, type PanelRole } from './api.js';
import { useRoute } from './route.js';
import { LoginPage } from './LoginPage.js';
import { AccessPage } from './pages/AccessPage.js';
import { Icon } from './icons.js';
import { HubSection } from './hub/HubSection.js';
import { createCache } from './hub/query.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { CustomersPage } from './pages/CustomersPage.js';
import { BulkPage } from './pages/BulkPage.js';
import { ProductsPage } from './pages/ProductsPage.js';
import { PanelsPage } from './pages/PanelsPage.js';
import { ContentPage } from './pages/ContentPage.js';
import { StockPage } from './pages/StockPage.js';
import { ExpensesPage } from './pages/ExpensesPage.js';
import { DiscountsPage } from './pages/DiscountsPage.js';
import { OrdersPage, ServicesPage, TransactionsPage } from './pages/LedgerPages.js';
import { SettingsPage, RequestsPage } from './pages/SettingsPage.js';
import { BotTextsPage, KeyboardPage } from './pages/BotContentPages.js';
import './theme.css';
// Second, and the order is load-bearing: `styles.css` scopes everything it can
// reach to `.hub`, but where the two sheets declare the same property at equal
// specificity the later one wins, and inside the hub that should be the hub.
import './hub/styles.css';

const HUB_PAGES: ReadonlySet<PageId> = new Set<HubPageId>([
  'payments',
  'statistics',
  'today',
  'accounts',
  'banks',
  'devices',
]);

function isHubPage(id: PageId): id is HubPageId {
  return HUB_PAGES.has(id);
}

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
function Body({
  page,
  go,
  role,
  cache,
}: {
  page: PageId;
  go: (id: PageId, search?: string) => void;
  role: PanelRole | null;
  cache: ReturnType<typeof createCache>;
}) {
  if (isHubPage(page)) {
    return <HubSection section={page} cache={cache} onGo={go} />;
  }
  switch (page) {
    case 'dashboard':
      return <DashboardPage onGo={go} />;
    case 'customers':
      return <CustomersPage />;
    case 'bulk':
      return <BulkPage />;
    case 'products':
      return <ProductsPage />;
    case 'panels':
      return <PanelsPage />;
    case 'stock':
      return <StockPage />;
    case 'expenses':
      return <ExpensesPage />;
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
    case 'content':
      return <ContentPage />;
    case 'access':
      return <AccessPage role={role} />;
  }
}

export function App() {
  const [page, setPage] = useRoute();
  const [navOpen, setNavOpen] = useState(false);
  // One cache for the whole session, not one per visit to a finance screen: it
  // is what holds the polling intervals and the seen-markers, and `query.ts`
  // warns in dev if a second instance appears. Building it costs nothing until
  // a view subscribes — no timer starts before then — so it is created even for
  // an operator who never opens the «پول» group.
  const cache = useMemo(() => createCache(), []);
  const [role, setRole] = useState<PanelRole | null>(null);
  // null = still asking. The three states are distinct on purpose: "asking",
  // "signed out" and "signed in" each draw something different, and collapsing
  // the first two shows a login form to somebody who is already signed in.
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  // Asked once, and again after a sign-in. Until it answers, `role` is null and
  // every section is drawn — the alternative is a sidebar that visibly
  // rearranges itself a moment after the page opens. The server refuses
  // whatever this gets wrong.
  const [reload, setReload] = useState(0);
  useEffect(() => {
    void api
      .me()
      .then((m) => {
        setRole(m.role);
        setSignedIn(true);
      })
      .catch(() => {
        setRole(null);
        setSignedIn(false);
      });
  }, [reload]);

  if (signedIn === null) return <div className="boot" />;
  if (!signedIn) return <LoginPage onSignedIn={() => setReload((n) => n + 1)} />;

  const visible = (id: PageId) => role !== 'READ_ONLY' || READABLE_BY_READER.has(id);

  // `search` is forwarded, not dropped. The notification bell asks for a
  // section *and* a sub-tab, and the sub-tab lives in the query — swallowing
  // the second argument here sent every bell entry to the default tab while
  // looking, from the sidebar, entirely correct.
  function go(id: PageId, search?: string) {
    setPage(id, search);
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
        {/* There was nowhere to sign out from before, because there was nowhere
            to sign in. A session lasts twelve hours of use, so on a shared or
            borrowed machine this is the only way to end it. */}
        <button
          type="button"
          className="app-header__signout"
          onClick={() => {
            void fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'include' }).finally(
              () => setReload((n) => n + 1),
            );
          }}
        >
          خروج
        </button>
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
            {group.items.filter((item) => visible(item.id)).map((item) => (
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
          <Body page={page} go={go} role={role} cache={cache} />
        </div>
      </section>
    </>
  );
}
