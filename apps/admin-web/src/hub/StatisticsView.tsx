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
      <header className="page-header">
        <div className="page-header__text">
          <h2 className="page-header__title">آمار مالی</h2>
          <p className="page-header__subtitle muted">فروش و فعالیت حساب‌ها</p>
        </div>
        <div className="page-header__actions">
          <HistoryDateNav value={rangeState} onChange={setRangeState} />
        </div>
      </header>

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
