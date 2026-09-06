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
 * Navigation is a real URL now (`route.ts`), not `useState`. Twenty-three
 * sections that cannot be linked to is a panel where «look at this payment» has
 * to be described rather than sent.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ADMIN_ONLY,
  NAV,
  pageLabel,
  READABLE_BY_READER,
  type HubPageId,
  type PageId,
} from './nav.js';
import { api, type PanelRole } from './api.js';
import { ADMIN_ONLY_HINT, READ_ONLY_HINT, RoleProvider } from './role.js';
import { useRoute } from './route.js';
import { LoginPage } from './LoginPage.js';
import { PasswordCard } from './PasswordCard.js';
import { AccessPage } from './pages/AccessPage.js';
import { ImportPage } from './pages/ImportPage.js';
import { EventsPage } from './pages/EventsPage.js';
import { Icon } from './icons.js';
import { HubSection } from './hub/HubSection.js';
import { createCache } from './hub/query.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { StatsPage } from './pages/StatsPage.js';
import { CustomersPage } from './pages/CustomersPage.js';
import { BulkPage } from './pages/BulkPage.js';
import { CatalogPage } from './pages/CatalogPage.js';
import { ProductsPage } from './pages/ProductsPage.js';
import { CategoriesPage } from './pages/CategoriesPage.js';
import { PanelsPage } from './pages/PanelsPage.js';
import { ContentPage } from './pages/ContentPage.js';
import { StockPage } from './pages/StockPage.js';
import { CronPage } from './pages/CronPage.js';
import { ExpensesPage } from './pages/ExpensesPage.js';
import { DiscountsPage } from './pages/DiscountsPage.js';
import { OrdersPage, SubscriptionsPage, TransactionsPage } from './pages/LedgerPages.js';
import { SettingsPage, RequestsPage } from './pages/SettingsPage.js';
import { BotPage } from './pages/BotPage.js';
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
    case 'stats':
      return <StatsPage />;
    case 'customers':
      return <CustomersPage />;
    case 'bulk':
      return <BulkPage />;
    case 'catalog':
      return <CatalogPage />;
    case 'products':
      return <ProductsPage onGo={go} />;
    case 'categories':
      return <CategoriesPage />;
    case 'panels':
      return <PanelsPage onGo={go} />;
    case 'stock':
      return <StockPage />;
    case 'cron':
      return <CronPage onGo={go} />;
    case 'expenses':
      return <ExpensesPage />;
    case 'discounts':
      return <DiscountsPage />;
    case 'orders':
      return <OrdersPage />;
    case 'subscriptions':
      return <SubscriptionsPage />;
    case 'transactions':
      return <TransactionsPage />;
    case 'requests':
      return <RequestsPage />;
    case 'bot':
      return <BotPage />;
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
    case 'events':
      return <EventsPage />;
    case 'import':
      return <ImportPage />;
  }
}

export function App() {
  const [page, setPage] = useRoute();
  const [navOpen, setNavOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
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

  const visible = (id: PageId) => {
    // Two rules, not one. `ADMIN_ONLY` is the narrower: a REVIEWER may read
    // customers and must not be offered the shop's own stack traces.
    if (ADMIN_ONLY.has(id)) return role === 'ADMIN';
    return role !== 'READ_ONLY' || READABLE_BY_READER.has(id);
  };

  // The sidebar is a URL, so hiding a link is not hiding a section: `/admin/
  // customers` typed by hand — or opened from a bookmark made while signed in
  // as somebody else — still reached `Body`, which drew the whole screen and
  // let it fill with the 403s its own requests came back with. The filter above
  // was the only thing standing there and it stands beside the door, not in it.
  //
  // The server is unmoved either way; what changes is that a reader is now told
  // which of the two it is, instead of reading an empty table and a red bar.
  const withheld = !visible(page);

  /**
   * The sentence at the top of the page, or none.
   *
   * Two roles, two different truths, and saying either one everywhere would be
   * a lie half the time. READ_ONLY writes nothing anywhere. A REVIEWER writes
   * on the six finance screens — approving a claim IS the job — and writes
   * nothing under `/api/v1/admin/`, which is every other section. So the second
   * line is drawn only where it is true.
   *
   * «داشبورد» is excluded because it has no control to disable: an explanation
   * of why nothing can be changed, on a screen where nothing could be changed
   * anyway, is noise on the one page every operator opens first.
   */
  const adminSurface = !isHubPage(page) && page !== 'dashboard';
  const banner =
    role === 'READ_ONLY'
      ? `${READ_ONLY_HINT}.`
      : role === 'REVIEWER' && adminSurface
        ? `${ADMIN_ONLY_HINT}.`
        : null;

  // `search` is forwarded, not dropped. The notification bell asks for a
  // section *and* a sub-tab, and the sub-tab lives in the query — swallowing
  // the second argument here sent every bell entry to the default tab while
  // looking, from the sidebar, entirely correct.
  function go(id: PageId, search?: string) {
    setPage(id, search);
    setNavOpen(false);
  }

  return (
    <RoleProvider role={role}>
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
        {/* The two things you do to your own account rather than to the shop.
            Here rather than in the sidebar because every role needs both, and
            the sidebar is filtered by role — READ_ONLY sees fifteen of
            twenty-four entries and would have seen neither of these.
            The number said "nine" until 2026-08-22, when it was counted for the
            first time; `e2e/roles.spec.ts` now reads it off the rendered
            sidebar, so it cannot drift again. */}
        <div className="app-header__actions">
          <button
            type="button"
            className="app-header__signout"
            aria-expanded={passwordOpen}
            onClick={() => setPasswordOpen((v) => !v)}
          >
            رمز عبور
          </button>
          {/* There was nowhere to sign out from before, because there was
              nowhere to sign in. A session lasts twelve hours of use, so on a
              shared or borrowed machine this is the only way to end it. */}
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
            {group.items
              .filter((item) => visible(item.id))
              .map((item) => (
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
          {/* Above the page rather than over it: the panel has no modal, and
              inventing one for a three-field form would be the larger thing to
              keep working. */}
          {passwordOpen && <PasswordCard onClose={() => setPasswordOpen(false)} />}
          {/* Said once, at the top, rather than only on each disabled control.
              A reader who opens «سرویس‌ها» sees a full catalogue with every
              action greyed out, and without this line the honest reading of
              that screen is «the panel is broken», not «this account reads».
              The `title` on each control says the same thing to whoever
              reaches for one anyway. */}
          {!withheld && banner !== null && (
            <div className="alert-info" role="status">
              {banner} آنچه می‌بینید کامل است؛ فقط ذخیره و حذف غیرفعال‌اند.
            </div>
          )}
          {withheld ? (
            <div className="page-head">
              <div>
                <div className="page-head__title">{pageLabel(page)}</div>
                <div className="page-head__sub">
                  این بخش برای نقش شما باز نیست. از منوی کنار، بخشی را انتخاب کنید.
                </div>
              </div>
            </div>
          ) : (
            <Body page={page} go={go} role={role} cache={cache} />
          )}
        </div>
      </section>
    </RoleProvider>
  );
}
