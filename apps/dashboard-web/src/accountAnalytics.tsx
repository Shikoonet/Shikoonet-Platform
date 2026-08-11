import type { Cache } from './query.js';
import { formatCompactIrr, type AccountAnalyticsResponse } from './analytics.js';
import { type HistoryRangeState, appendHistoryRangeQuery } from './paymentReview.js';

function accountUsageLabel(a: AccountAnalyticsResponse['items'][number]): string {
  const hint = a.accountHint ? `**** ${a.accountHint}` : '****';
  const owner = a.ownerLabel?.trim() || a.displayName;
  return `${hint} · ${owner}`;
}

function formatRank(index: number): string {
  return String(index + 1).padStart(2, '0');
}

export function AccountUsagePanel({
  cache,
  rangeState,
}: {
  cache: Cache;
  rangeState: HistoryRangeState;
}) {
  const qs = new URLSearchParams();
  appendHistoryRangeQuery(qs, rangeState);
  const key = `accounts.analytics:${qs.toString()}`;
  const { data, status } = cache.useQuery<AccountAnalyticsResponse>(key, {
    fetcher: async (signal) => {
      const r = await fetch(`/api/v1/accounts/analytics?${qs}`, { signal });
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
  });

  if (status === 'error') {
    return <p className="error">Could not load account usage.</p>;
  }
  if (!data) return <p className="muted">Loading account usage…</p>;

  return (
    <section className="account-usage-ranking" aria-label="Account usage">
      <header className="account-usage-ranking__header">
        <h3 className="account-usage-ranking__title">Account usage</h3>
        <span className="account-usage-ranking__cols muted" aria-hidden>
          <span>Account</span>
          <span>Purchases</span>
          <span>Balance</span>
        </span>
      </header>
      {data.items.length === 0 ? (
        <p className="payments-empty payments-empty--inline" role="status">
          <span className="payments-empty__mark" aria-hidden>
            ✓
          </span>
          No account activity in this range.
        </p>
      ) : (
        <ul className="account-usage-list" aria-label="Account usage ranking">
          {data.items.map((a, index) => (
            <li key={a.accountId} className="account-usage-row">
              <span className="account-usage-row__rank" aria-hidden>
                {formatRank(index)}
              </span>
              <div className="account-usage-row__body">
                <div className="account-usage-row__head">
                  <strong className="account-usage-row__label">{accountUsageLabel(a)}</strong>
                  <span className="account-usage-row__purchases">
                    {a.purchaseCount} {a.purchaseCount === 1 ? 'purchase' : 'purchases'}
                  </span>
                  <span className="account-usage-row__balance tabular-nums">
                    {a.currentBalanceIrr != null ? (
                      formatCompactIrr(a.currentBalanceIrr)
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </span>
                </div>
                <div className="account-usage-row__bar-track" aria-hidden>
                  <div
                    className="account-usage-row__bar-fill"
                    style={{ width: `${Math.max(a.purchaseCount > 0 ? 4 : 0, a.purchaseBarPercent)}%` }}
                  />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
