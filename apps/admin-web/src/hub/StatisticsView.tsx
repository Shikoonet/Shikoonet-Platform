import { useState } from 'react';
import type { Cache } from './query.js';
import { HistoryDateNav } from './historyRangeNav.js';
import { HeaderSlot } from './shikoonetShell.js';
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
      {/* The date control goes to the panel's one header, exactly as
          «پرداخت‌ها» sends its own. What used to be here was a second header
          carrying a second copy of «آمار مالی» and a second date control, so
          this screen served four `header` elements and the title twice — the
          two-shells problem slice 5 set out to end, still standing on the one
          screen its test did not visit. */}
      <HeaderSlot slot="dateNav">
        <HistoryDateNav value={rangeState} onChange={setRangeState} />
      </HeaderSlot>

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
