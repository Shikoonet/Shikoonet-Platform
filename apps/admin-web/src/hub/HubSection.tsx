/**
 * The six finance screens, inside the panel.
 *
 * This was the payment hub's own `App.tsx` — its own build, its own document,
 * its own tab bar and mobile drawer. All three are gone: the panel's sidebar
 * chose the section before this renders, and the panel's URL is what says which
 * one. What survives is the part that was actually the hub — the query cache
 * and the six views.
 *
 * `dir="ltr"` on the wrapper, deliberately and temporarily. These screens are
 * still English and laid out left-to-right, inside a document that is `rtl`.
 * Without it the tables mirror and the amounts land on the wrong side. It comes
 * off in the pass that translates them, and until then it is one attribute
 * rather than a stylesheet full of overrides.
 *
 * `className="hub"` is not cosmetic: `styles.css` hangs its design tokens and
 * its element rules off it, so this div is the boundary between the two design
 * languages.
 */

import type { Cache } from './query.js';
import type { HubPageId } from '../nav.js';
import { TodayView } from './TodayView.js';
import { DevicesView } from './DevicesView.js';
import { AccountsView } from './AccountsView.js';
import { PaymentsView } from './PaymentsView.js';
import { StatisticsView } from './StatisticsView.js';
import { BanksView } from './BanksView.js';
import { ShikoonetHeader } from './shikoonetShell.js';

export function HubSection({
  section,
  cache,
  onGo,
}: {
  section: HubPageId;
  cache: Cache;
  onGo: (id: HubPageId, search?: string) => void;
}) {
  return (
    <div className="hub" dir="ltr">
      <ShikoonetHeader
        cache={cache}
        opsMode={section === 'payments'}
        onRefresh={() => cache.refetch()}
        // The notification bell deep-links into a payment tab, and the tab
        // lives in `?tab=`. It goes through `onGo` as one navigation rather
        // than being written to the URL first: the section change pushes a path
        // with no query, so anything written beforehand is wiped a moment
        // later. That is what sent every bell entry to the income tab.
        onNavigate={(tab, filter) => {
          const paymentTab = filter?.paymentTab;
          onGo(tab, paymentTab ? `?tab=${encodeURIComponent(paymentTab)}` : '');
        }}
      >
        {section === 'today' && <TodayView cache={cache} />}
        {section === 'devices' && <DevicesView cache={cache} />}
        {section === 'accounts' && <AccountsView cache={cache} />}
        {section === 'payments' && <PaymentsView cache={cache} />}
        {section === 'statistics' && <StatisticsView cache={cache} />}
        {section === 'banks' && <BanksView />}
      </ShikoonetHeader>
    </div>
  );
}
