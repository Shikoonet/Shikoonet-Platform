import type { Cache } from './query.js';
import { count } from '../format.js';
import { formatCompactIrr, type AccountAnalyticsResponse } from './analytics.js';
import { type HistoryRangeState, appendHistoryRangeQuery } from './paymentReview.js';

function accountUsageLabel(a: AccountAnalyticsResponse['items'][number]): string {
  const hint = a.accountHint ? `**** ${a.accountHint}` : '****';
  const owner = a.ownerLabel?.trim() || a.displayName;
  return `${hint} · ${owner}`;
}

// Two digits so the ranks line up in a column; `minimumIntegerDigits` rather
// than `padStart` because the pad character has to be a Persian zero too.
const RANK = new Intl.NumberFormat('fa-IR', { minimumIntegerDigits: 2, useGrouping: false });

function formatRank(index: number): string {
  return RANK.format(index + 1);
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
    return <p className="error">بارگذاری میزان استفاده از حساب‌ها ناموفق بود.</p>;
  }
  if (!data) return <p className="muted">در حال بارگذاری میزان استفاده از حساب‌ها…</p>;

  return (
    <section className="account-usage-ranking" aria-label="میزان استفاده از حساب‌ها">
      <header className="account-usage-ranking__header">
        <h3 className="account-usage-ranking__title">میزان استفاده از حساب‌ها</h3>
        <span className="account-usage-ranking__cols muted" aria-hidden>
          <span>حساب</span>
          <span>خرید</span>
          <span>موجودی</span>
        </span>
      </header>
      {data.items.length === 0 ? (
        <p className="payments-empty payments-empty--inline" role="status">
          <span className="payments-empty__mark" aria-hidden>
            ✓
          </span>
          در این بازه فعالیتی روی حساب‌ها نبوده.
        </p>
      ) : (
        <ul className="account-usage-list" aria-label="رتبه‌بندی استفاده از حساب‌ها">
          {data.items.map((a, index) => (
            <li key={a.accountId} className="account-usage-row">
              <span className="account-usage-row__rank" aria-hidden>
                {formatRank(index)}
              </span>
              <div className="account-usage-row__body">
                <div className="account-usage-row__head">
                  <strong className="account-usage-row__label">{accountUsageLabel(a)}</strong>
                  <span className="account-usage-row__purchases">
                    {count(a.purchaseCount)} خرید
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
                    style={{
                      width: `${Math.max(a.purchaseCount > 0 ? 4 : 0, a.purchaseBarPercent)}%`,
                    }}
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
