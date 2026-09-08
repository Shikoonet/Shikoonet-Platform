/**
 * The six finance screens, inside the panel.
 *
 * This was the payment hub's own `App.tsx` — its own build, its own document,
 * its own tab bar and mobile drawer. All three are gone: the panel's sidebar
 * chose the section before this renders, and the panel's URL is what says which
 * one. What survives is the part that was actually the hub — the query cache
 * and the six views.
 *
 * The direction used to be decided per screen, from a set naming the ones whose
 * copy had been translated — a screen still in English reads worse mirrored than
 * it does left-to-right. All six are Persian now, so the set is gone and `dir`
 * is a constant. It stays written out rather than inherited from `<html>`,
 * because this div is the boundary between the two stylesheets and should say
 * which way its half runs.
 *
 * `className="hub"` is not cosmetic either: `styles.css` hangs its design tokens
 * and its element rules off it.
 */

import type { Cache } from './query.js';
import type { HubPageId } from '../nav.js';
import { TodayView } from './TodayView.js';
import { DevicesView } from './DevicesView.js';
import { AccountsView } from './AccountsView.js';
import { PaymentsView } from './PaymentsView.js';
import { StatisticsView } from './StatisticsView.js';
import { BanksView } from './BanksView.js';

/*
 * `onGo` left with the header.
 *
 * It existed for one caller: the notification bell, which deep-links into a
 * payment tab. The bell is in the panel's own header now and navigates through
 * `App`'s `go` directly, so nothing here needs a way to change section — which
 * is the point of the merge rather than a side effect of it.
 */
export function HubSection({ section, cache }: { section: HubPageId; cache: Cache }) {
  return (
    <div className="hub" dir="rtl">
      {/* The wrapper stays — `finance.spec.ts` and `panel.spec.ts` read `.hub`,
          and the stylesheet hangs its remaining tokens on it. What left is the
          header: there is one, in `App`, and it carries the bell, the
          continuity control and the date slot for every screen rather than for
          six of them. */}
      {section === 'today' && <TodayView cache={cache} />}
      {section === 'devices' && <DevicesView cache={cache} />}
      {section === 'accounts' && <AccountsView cache={cache} />}
      {section === 'payments' && <PaymentsView cache={cache} />}
      {section === 'statistics' && <StatisticsView cache={cache} />}
      {section === 'banks' && <BanksView />}
    </div>
  );
}
