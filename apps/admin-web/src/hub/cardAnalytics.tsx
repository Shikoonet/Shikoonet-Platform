import type { Cache } from './query.js';
import { count } from '../format.js';
import { formatTomanFromIrr } from './format.js';
import type { CardAnalyticsResponse } from './analytics.js';
import { type HistoryRangeState, appendHistoryRangeQuery } from './paymentReview.js';

function cardUsageLabel(item: CardAnalyticsResponse['items'][number]): string {
  const hint = item.accountHint ? `**** ${item.accountHint}` : item.displayName;
  const owner = item.ownerLabel?.trim() || item.displayName;
  return `${item.cardMasked} · ${hint} · ${owner}`;
}

/**
 * Why a card is out of rotation, in the language the screen is written in.
 *
 * The server sends these as keys — `account_deactivated`, `card_disabled` — and
 * this row used to print them verbatim, so a Persian screen answered «چرا کارت
 * من کار نمی‌کند» with an English identifier. The keys are the API's, not the
 * operator's.
 *
 * The fallback is the raw key rather than a shrug: an unmapped reason is a
 * server the panel has not caught up with, and showing it is how somebody
 * notices. `card_not_mapped` is the newest, and it is the one that says the
 * card itself is gone — see issue #86.
 */
const EXCLUSION_REASON_FA: Record<string, string> = {
  card_not_mapped: 'این کارت دیگر در فهرست کارت‌ها نیست — پولش این‌جاست، خودش نه',
  card_disabled: 'خودِ کارت خاموش است',
  account_deactivated: 'حساب این کارت غیرفعال شده است',
  account_muted: 'حساب این کارت بی‌صدا است',
  account_declined: 'حساب این کارت رد شده است',
  account_pending: 'حساب این کارت هنوز تایید نشده است',
};

function exclusionReasonFa(reason: string): string {
  return EXCLUSION_REASON_FA[reason] ?? reason;
}

const RANK = new Intl.NumberFormat('fa-IR', { minimumIntegerDigits: 2, useGrouping: false });

function formatRank(index: number): string {
  return RANK.format(index + 1);
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
    return <p className="error">بارگذاری تشخیص توازن کارت‌ها ناموفق بود.</p>;
  }
  if (!data) return <p className="muted">در حال بارگذاری تشخیص توازن کارت‌ها…</p>;

  const zeroUseEligible = data.items.filter((i) => i.purchaseCount === 0 && i.hubEligible);

  return (
    <section className="account-usage-ranking card-balancing-panel" aria-label="توازن کارت‌ها">
      <header className="account-usage-ranking__header">
        <div>
          <h3 className="account-usage-ranking__title">توازن کارت‌ها (تشخیصی)</h3>
          <p className="muted card-balancing-panel__note">{data.note}</p>
        </div>
        <span className="account-usage-ranking__cols muted" aria-hidden>
          <span>کارت</span>
          <span>خرید</span>
          <span>واجد شرایط</span>
        </span>
      </header>
      <p className="muted card-balancing-panel__summary">
        فاصلهٔ بیشترین تا کمترین: {count(data.distribution.gap)} · کارت‌های واجد شرایط بدون هیچ
        خرید: {count(zeroUseEligible.length)}
      </p>
      {data.items.length === 0 ? (
        <p className="payments-empty payments-empty--inline" role="status">
          <span className="payments-empty__mark" aria-hidden>
            ✓
          </span>
          هیچ کارت نگاشت‌شده‌ای نیست.
        </p>
      ) : (
        <ul className="account-usage-list" aria-label="رتبه‌بندی توازن کارت‌ها">
          {data.items.map((item, index) => (
            <li key={item.cardDigits} className="account-usage-row">
              <span className="account-usage-row__rank" aria-hidden>
                {formatRank(index)}
              </span>
              <div className="account-usage-row__body">
                <div className="account-usage-row__head">
                  <strong className="account-usage-row__label">{cardUsageLabel(item)}</strong>
                  <span className="account-usage-row__purchases">
                    {count(item.purchaseCount)} خرید
                  </span>
                  {/* «چقدر به این کارت رفت، و از چند نفر» — the question Sam
                      opened this work with. Its own count sits with it because
                      «خرید» beside it is the bot-verified subset used to judge
                      rotation, and an amount read against that count would be
                      two populations under one row. Toman, like every other
                      money figure the operator sees; the store is IRR. */}
                  <span
                    className="account-usage-row__takings"
                    title={`${count(item.verifiedCount)} پرداخت تاییدشده از ${count(
                      item.uniqueCustomers,
                    )} نفر`}
                  >
                    {formatTomanFromIrr(item.takingsIrr)} · {count(item.uniqueCustomers)} نفر
                  </span>
                  {/* Only shown when it is not 1. A weight beside every card
                      would be noise; a weight beside the one card being pushed
                      is the reminder to set it back once the count catches up. */}
                  {item.displayWeight > 1 && (
                    <span className="badge" title="وزن چرخش — در صفحهٔ حساب‌ها تنظیم می‌شود">
                      {count(item.displayWeight)}× بیشتر نشان داده می‌شود
                    </span>
                  )}
                  <span className="account-usage-row__balance">
                    {item.hubEligible ? (
                      <span className="muted">واجد شرایط</span>
                    ) : (
                      <span className="muted" title={exclusionReasonFa(item.exclusionReason)}>
                        کنار گذاشته‌شده
                      </span>
                    )}
                  </span>
                </div>
                {/* Six rolling windows, side by side rather than behind a
                    picker: whether a card is warming up or going quiet is a
                    shape across them, and six clicks would ask an operator to
                    hold that shape in their head. The labels come from the
                    server with the numbers, so they cannot fall out of step. */}
                {/* Guarded, and the guard is about blast radius rather than
                    types: this strip is a diagnostic sitting inside a bigger
                    view, and a server that stopped sending `windows` must not
                    be able to take the purchase counts and the eligibility
                    column down with it. Rendering nothing here still leaves
                    the row readable. */}
                <dl className="card-activity" aria-label={`تراکنش‌های ${item.cardMasked}`}>
                  {(data.windows ?? []).map((w) => (
                    <div key={w.key} className="card-activity__cell">
                      <dt className="card-activity__label">{w.label}</dt>
                      <dd
                        className={
                          item.activity[w.key] > 0
                            ? 'card-activity__value'
                            : 'card-activity__value card-activity__value--zero'
                        }
                      >
                        {count(item.activity[w.key] ?? 0)}
                      </dd>
                    </div>
                  ))}
                </dl>
                <div className="account-usage-row__bar-track" aria-hidden>
                  <div
                    className="account-usage-row__bar-fill"
                    style={{
                      width: `${Math.max(item.purchaseCount > 0 ? 4 : 0, item.purchaseBarPercent)}%`,
                    }}
                  />
                </div>
                {!item.hubEligible && (
                  <p className="muted card-balancing-panel__reason">
                    {exclusionReasonFa(item.exclusionReason)}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
