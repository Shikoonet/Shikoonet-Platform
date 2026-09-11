import { useState } from 'react';
import type { Cache } from './query.js';
import { HistoryDateNav } from './historyRangeNav.js';
import { SalesTrendChart, TopMetricsSummary } from './financialHub.js';
import { AccountUsagePanel } from './accountAnalytics.js';
import { CardBalancingPanel } from './cardAnalytics.js';
import type { AnalyticsResponse } from './analytics.js';
import {
  defaultHistoryRangeState,
  appendHistoryRangeQuery,
  type HistoryRangeState,
} from './paymentReview.js';

export function StatisticsView({ cache }: { cache: Cache }) {
  const [rangeState, setRangeState] = useState<HistoryRangeState>(defaultHistoryRangeState());
  const qs = new URLSearchParams();
  appendHistoryRangeQuery(qs, rangeState);
  const analyticsKey = `analytics:${qs.toString()}`;

  const { data: analytics, status: analyticsStatus } = cache.useQuery<AnalyticsResponse>(
    analyticsKey,
    {
      fetcher: async (signal) => {
        const r = await fetch(`/api/v1/analytics?${qs}`, { signal });
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      },
    },
  );

  return (
    <section className="panel statistics">
      {/* On the screen, not in the header — a deliberate exception to what
          «پرداخت‌ها» does. There the control shares the header with the
          payment tabs and has to fold; here it had folded into a badge
          reading «همه 📅» that nobody recognised as a control (Sam,
          2026-09-11). A screen that is only numbers has the room to show every
          window as a chip, and the two hour windows added the same day only
          make sense where they can be seen. The second-header problem the
          header slot was created to end stays ended: no `header` element
          here, no repeated title. */}
      <HistoryDateNav value={rangeState} onChange={setRangeState} variant="strip" />

      {analyticsStatus === 'error' && (
        <p className="error">بارگذاری آمار ناموفق بود. صفحه را تازه کنید.</p>
      )}
      {!analytics && analyticsStatus !== 'error' && <p className="muted">در حال بارگذاری آمار…</p>}

      {analytics && (
        <>
          <TopMetricsSummary analytics={analytics} />
          <SalesTrendChart analytics={analytics} className="statistics__chart-card" />
        </>
      )}

      <AccountUsagePanel cache={cache} rangeState={rangeState} />
      <CardBalancingPanel cache={cache} rangeState={rangeState} />
    </section>
  );
}
