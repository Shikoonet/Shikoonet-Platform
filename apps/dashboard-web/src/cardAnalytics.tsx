import type { Cache } from './query.js';
import type { CardAnalyticsResponse } from './analytics.js';
import { type HistoryRangeState, appendHistoryRangeQuery } from './paymentReview.js';

function cardUsageLabel(item: CardAnalyticsResponse['items'][number]): string {
  const hint = item.accountHint ? `**** ${item.accountHint}` : item.displayName;
  const owner = item.ownerLabel?.trim() || item.displayName;
  return `${item.cardMasked} · ${hint} · ${owner}`;
}

function formatRank(index: number): string {
  return String(index + 1).padStart(2, '0');
}

export function CardBalancingPanel({
  cache,
  rangeState,
}: {
  cache: Cache;
  rangeState: HistoryRangeState;
}) {
  const qs = new URLSearchParams();
  appendHistoryRangeQuery(qs, rangeState);
  const key = `cards.analytics:${qs.toString()}`;
  const { data, status } = cache.useQuery<CardAnalyticsResponse>(key, {
    fetcher: async (signal) => {
      const r = await fetch(`/api/v1/cards/analytics?${qs}`, { signal });
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
  });

  if (status === 'error') {
    return <p className="error">Could not load card balancing diagnostic.</p>;
  }
  if (!data) return <p className="muted">Loading card balancing diagnostic…</p>;

  const zeroUseEligible = data.items.filter((i) => i.purchaseCount === 0 && i.hubEligible);

  return (
    <section className="account-usage-ranking card-balancing-panel" aria-label="Card balancing diagnostic">
      <header className="account-usage-ranking__header">
        <div>
          <h3 className="account-usage-ranking__title">Card balancing (diagnostic)</h3>
          <p className="muted card-balancing-panel__note">{data.note}</p>
        </div>
        <span className="account-usage-ranking__cols muted" aria-hidden>
          <span>Card</span>
          <span>Hub purchases</span>
          <span>Eligible</span>
        </span>
      </header>
      <p className="muted card-balancing-panel__summary">
        Range: {data.range} · max−min gap: {data.distribution.gap} · zero-use Hub-eligible cards:{' '}
        {zeroUseEligible.length}
      </p>
      {data.items.length === 0 ? (
        <p className="payments-empty payments-empty--inline" role="status">
          <span className="payments-empty__mark" aria-hidden>
            ✓
          </span>
          No mapped cards in Hub.
        </p>
      ) : (
        <ul className="account-usage-list" aria-label="Card balancing ranking">
          {data.items.map((item, index) => (
            <li key={item.cardDigits} className="account-usage-row">
              <span className="account-usage-row__rank" aria-hidden>
                {formatRank(index)}
              </span>
              <div className="account-usage-row__body">
                <div className="account-usage-row__head">
                  <strong className="account-usage-row__label">{cardUsageLabel(item)}</strong>
                  <span className="account-usage-row__purchases">
                    {item.purchaseCount} {item.purchaseCount === 1 ? 'purchase' : 'purchases'}
                  </span>
                  {/* Only shown when it is not 1. A weight beside every card
                      would be noise; a weight beside the one card being pushed
                      is the reminder to set it back once the count catches up. */}
                  {item.displayWeight > 1 && (
                    <span className="badge" title="Rotation weight — set on the account screen">
                      shown {item.displayWeight}× as often
                    </span>
                  )}
                  <span className="account-usage-row__balance">
                    {item.hubEligible ? (
                      <span className="muted">eligible</span>
                    ) : (
                      <span className="muted" title={item.exclusionReason}>
                        excluded
                      </span>
                    )}
                  </span>
                </div>
                <div className="account-usage-row__bar-track" aria-hidden>
                  <div
                    className="account-usage-row__bar-fill"
                    style={{
                      width: `${Math.max(item.purchaseCount > 0 ? 4 : 0, item.purchaseBarPercent)}%`,
                    }}
                  />
                </div>
                {!item.hubEligible && (
                  <p className="muted card-balancing-panel__reason">{item.exclusionReason}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
