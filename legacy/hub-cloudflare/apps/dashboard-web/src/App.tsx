import { useMemo, useState } from 'react';
import { createCache } from './query.js';
import { Tabs } from './Tabs.js';
import { TodayView } from './TodayView.js';
import { DevicesView } from './DevicesView.js';
import { AccountsView } from './AccountsView.js';
import { PaymentsView } from './PaymentsView.js';
import { StatisticsView } from './StatisticsView.js';
import { Drawer } from './Drawer.js';
import { ShikoonetHeader } from './shikoonetShell.js';
import { syncPaymentTabToLocation } from './paymentsNav.js';
import { useMediaQuery } from './useMediaQuery.js';

type Tab = 'payments' | 'statistics' | 'today' | 'devices' | 'accounts';

const TAB_ITEMS = [
  { value: 'payments', label: 'Payments' },
  { value: 'statistics', label: 'Statistics' },
  { value: 'today', label: 'Today' },
  { value: 'devices', label: 'Devices' },
  { value: 'accounts', label: 'Accounts' },
] as const;

export function App() {
  const cache = useMemo(() => createCache(), []);

  const [tab, setTab] = useState<Tab>('payments');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isWide = useMediaQuery('(min-width: 1024px)');

  function selectTab(next: Tab) {
    setTab(next);
    setDrawerOpen(false);
  }

  const isPaymentsOps = tab === 'payments';

  const mobileMenu = !isWide ? (
    <button
      type="button"
      aria-label="Open navigation"
      aria-expanded={drawerOpen}
      aria-controls="primary-nav"
      className="hamburger"
      onClick={() => setDrawerOpen(true)}
    >
      <span aria-hidden>☰</span>
    </button>
  ) : null;

  const secondaryNav =
    isWide && !isPaymentsOps ? (
      <Tabs value={tab} onChange={(v) => selectTab(v)} items={[...TAB_ITEMS]} className="app-tabs" />
    ) : null;

  return (
    <div className={`app${isPaymentsOps ? ' app--ops' : ''}`}>
      <ShikoonetHeader
        cache={cache}
        opsMode={isPaymentsOps}
        onRefresh={() => cache.refetch()}
        onNavigateSection={(section) => selectTab(section)}
        onNavigate={(t, filter) => {
          if (filter?.paymentTab) {
            syncPaymentTabToLocation(filter.paymentTab as import('./paymentReview.js').PaymentTab);
          }
          selectTab(t);
        }}
        secondaryNav={secondaryNav}
        mobileMenu={mobileMenu}
      >
        {!isWide && (
          <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} label="Primary navigation">
            <nav className="drawer-nav" role="tablist" aria-label="Sections">
              {TAB_ITEMS.map((it) => (
                <button
                  key={it.value}
                  type="button"
                  role="tab"
                  aria-selected={tab === it.value}
                  className={tab === it.value ? 'drawer-link active' : 'drawer-link'}
                  onClick={() => selectTab(it.value)}
                >
                  {it.label}
                </button>
              ))}
            </nav>
          </Drawer>
        )}

        {tab === 'today' && <TodayView cache={cache} />}
        {tab === 'devices' && <DevicesView cache={cache} />}
        {tab === 'accounts' && <AccountsView cache={cache} />}
        {tab === 'payments' && <PaymentsView cache={cache} />}
        {tab === 'statistics' && <StatisticsView cache={cache} />}
      </ShikoonetHeader>
    </div>
  );
}
