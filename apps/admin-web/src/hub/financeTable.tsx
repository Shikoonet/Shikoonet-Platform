/**
 * «حساب‌ها و کارت‌ها» — the one table on «آمار مالی».
 *
 * Sam, 2026-09-12, asked what he wants from this screen: «کارت‌ها و حساب‌ها
 * را به تفکیک ببینم؛ بازه را انتخاب کنم و ببینم چقدر پول واردش شده، چند تا
 * تراکنش؛ جمع هر کارت، جمع همهٔ کارت‌ها؛ چقدر ربات بوده، چقدر دستی، چقدر
 * نماینده». Before this there were two blocks — a ranking of accounts by one
 * number and a «توازن کارت‌ها» diagnostic with six rolling-window columns that
 * ignored the range picker above them — and neither answered that list.
 *
 * One table now: an account row, its cards indented under it, unmapped cards
 * in a group of their own, and a total row from the same `/analytics` call
 * the tiles use — so the total is the server's, not a sum of the rows shown.
 * Every number follows the page's range. The rolling windows are gone; the
 * range picker is the window.
 *
 * And the rows must be able to REACH that total. On 2026-09-13 Sam read
 * «جمع همه ۲۹۱ میلیون» over three rows that summed to thirty: the other 261
 * million sat on thirteen accounts he had switched off, plus one deposit that
 * resolved to no account, and the table listed accounts in service only. So
 * switched-off accounts now follow the live ones under their own heading, and
 * money that reached no account gets the last row before the total. A total
 * the rows cannot add up to is a number nobody can check.
 */

import type { Cache } from './query.js';
import { count } from '../format.js';
import { formatTomanFromIrr } from './format.js';
import {
  formatCompactIrr,
  type AccountAnalyticsItem,
  type AccountAnalyticsResponse,
  type AnalyticsResponse,
  type CardAnalyticsItem,
  type CardAnalyticsResponse,
} from './analytics.js';
import { type HistoryRangeState, appendHistoryRangeQuery } from './paymentReview.js';

/**
 * Why a card is out of rotation, in the language the screen is written in.
 *
 * The server sends these as keys — `account_deactivated`, `card_disabled` — and
 * the old panel once printed them verbatim, so a Persian screen answered «چرا
 * کارت من کار نمی‌کند» with an English identifier. The fallback is the raw key
 * rather than a shrug: an unmapped reason is a server the panel has not caught
 * up with, and showing it is how somebody notices.
 */
const EXCLUSION_REASON_FA: Record<string, string> = {
  card_not_mapped: 'این کارت دیگر در فهرست کارت‌ها نیست — پولش این‌جاست، خودش نه',
  card_disabled: 'خودِ کارت خاموش است',
  account_deactivated: 'حساب این کارت غیرفعال شده است',
  account_muted: 'حساب این کارت بی‌صدا است',
  account_declined: 'حساب این کارت رد شده است',
  account_pending: 'حساب این کارت هنوز تایید نشده است',
};

export function exclusionReasonFa(reason: string): string {
  return EXCLUSION_REASON_FA[reason] ?? reason;
}

function accountLabel(a: AccountAnalyticsItem): string {
  const hint = a.accountHint ? `**** ${a.accountHint}` : '****';
  const owner = a.ownerLabel?.trim() || a.displayName;
  return `${hint} · ${owner}`;
}

/** Amount on top, how many deposits made it underneath. */
function Money({ irr, n, unit = 'تراکنش' }: { irr: number; n?: number; unit?: string }) {
  if (irr === 0 && !n) return <td className="fin-table__num fin-table__num--zero">—</td>;
  return (
    <td className="fin-table__num tabular-nums">
      <strong>{formatTomanFromIrr(irr)}</strong>
      {n != null && (
        <small className="muted">
          {count(n)} {unit}
        </small>
      )}
    </td>
  );
}

function Blank({ title }: { title?: string }) {
  return (
    <td className="fin-table__num fin-table__num--zero" title={title}>
      —
    </td>
  );
}

function CardRow({ c }: { c: CardAnalyticsItem }) {
  return (
    <tr className="fin-table__card" data-card={c.cardDigits}>
      <th scope="row" className="fin-table__name">
        <span className="fin-table__card-mask tabular-nums" dir="ltr">
          {c.cardMasked}
        </span>
        {!c.hubEligible && (
          <span className="fin-table__tag" title={exclusionReasonFa(c.exclusionReason)}>
            کنار گذاشته‌شده
          </span>
        )}
      </th>
      <Blank title="واریز بانکی روی حساب ثبت می‌شود، نه کارت" />
      <Blank title="برداشت روی حساب ثبت می‌شود، نه کارت" />
      <Money irr={c.takingsIrr} n={c.verifiedCount} />
      <Money irr={c.botAmountIrr} n={c.botCount} />
      <Money irr={c.manualAmountIrr} n={c.manualCount} />
      <Blank title="بانک نمی‌گوید واریز نماینده به کدام کارت رفت" />
      <Blank />
      <Blank />
    </tr>
  );
}

function AccountRow({ a, cards }: { a: AccountAnalyticsItem; cards: CardAnalyticsItem[] }) {
  return (
    <>
      <tr className="fin-table__account">
        <th scope="row" className="fin-table__name">
          <strong>{accountLabel(a)}</strong>
          <small className="muted">
            {a.bankName}
            {!a.active && ' · غیرفعال'}
            {a.status !== 'ACTIVE' && ` · ${a.status}`}
          </small>
        </th>
        <Money irr={a.bankInflowIrr} n={a.bankInflowCount} />
        <Money irr={a.bankOutflowIrr ?? 0} n={a.bankOutflowCount ?? 0} />
        <Money irr={a.salesAmountIrr} n={a.salesCount} />
        <Money irr={a.botAmountIrr} n={a.botCount} />
        <Money irr={a.manualAmountIrr} n={a.manualCount} />
        <Money irr={a.resellerAmountIrr} n={a.resellerCount} />
        <Money irr={a.unassignedIncomeIrr} n={a.unassignedIncomeCount} />
        <td className="fin-table__num tabular-nums">
          {a.currentBalanceIrr != null ? (
            <strong>{formatCompactIrr(a.currentBalanceIrr)}</strong>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
      </tr>
      {cards.map((c) => (
        <CardRow key={c.cardDigits} c={c} />
      ))}
    </>
  );
}

export function FinanceTable({
  cache,
  rangeState,
  analytics,
}: {
  cache: Cache;
  rangeState: HistoryRangeState;
  analytics: AnalyticsResponse | undefined;
}) {
  const qs = new URLSearchParams();
  appendHistoryRangeQuery(qs, rangeState);
  const accounts = cache.useQuery<AccountAnalyticsResponse>(`accounts.analytics:${qs}`, {
    fetcher: async (signal) => {
      const r = await fetch(`/api/v1/accounts/analytics?${qs}`, { signal });
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
  });
  const cards = cache.useQuery<CardAnalyticsResponse>(`cards.analytics:${qs}`, {
    fetcher: async (signal) => {
      const r = await fetch(`/api/v1/cards/analytics?${qs}`, { signal });
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
  });

  if (accounts.status === 'error' || cards.status === 'error') {
    return <p className="error">بارگذاری حساب‌ها و کارت‌ها ناموفق بود.</p>;
  }
  if (!accounts.data || !cards.data) {
    return <p className="muted">در حال بارگذاری حساب‌ها و کارت‌ها…</p>;
  }

  const byAccount = new Map<string, CardAnalyticsItem[]>();
  const orphans: CardAnalyticsItem[] = [];
  for (const c of cards.data.items) {
    if (!c.accountId) {
      orphans.push(c);
      continue;
    }
    const list = byAccount.get(c.accountId) ?? [];
    list.push(c);
    byAccount.set(c.accountId, list);
  }
  const gap = cards.data.distribution.gap;
  // `active === false`, not `!active`: a response from before the flag
  // existed (a cached one, an older server) still lists live accounts only.
  const live = accounts.data.items.filter((a) => a.active !== false);
  const archived = accounts.data.items.filter((a) => a.active === false);
  const nowhere = accounts.data.unaccounted ?? { bankInflowIrr: 0, bankInflowCount: 0, unassignedIncomeIrr: 0, unassignedIncomeCount: 0 };

  return (
    <section className="fin-table-wrap" aria-label="حساب‌ها و کارت‌ها">
      <header className="fin-table__header">
        <h3 className="section-heading">حساب‌ها و کارت‌ها</h3>
        <p className="muted">
          هر حساب یک ردیف، کارت‌هایش زیر آن. همهٔ اعداد در بازهٔ انتخاب‌شده.
        </p>
      </header>
      <div className="fin-table__scroll">
        <table className="fin-table">
          <thead>
            <tr>
              <th scope="col">حساب / کارت</th>
              <th scope="col">واریز بانکی</th>
              {/* What left, per the bank. Off-books movements (a loan, a
                  transfer to our other account) are in neither column; the
                  balance beside them is the bank's own and already has it. */}
              <th scope="col">برداشت</th>
              <th scope="col">فروش تاییدشده</th>
              <th scope="col">تایید ربات</th>
              <th scope="col">تایید دستی</th>
              <th scope="col">نمایندگی</th>
              {/* Not «تخصیص‌نیافته»: a sale verified by hand without a bank
                  row leaves its deposit here, and that read as an error until
                  the column said what it counts — deposits nothing consumed. */}
              <th scope="col">واریزیِ وصل‌نشده</th>
              <th scope="col">موجودی فعلی</th>
            </tr>
          </thead>
          <tbody>
            {live.map((a) => (
              <AccountRow key={a.accountId} a={a} cards={byAccount.get(a.accountId) ?? []} />
            ))}
            {archived.length > 0 && (
              <>
                <tr className="fin-table__account fin-table__account--orphans">
                  <th scope="row" className="fin-table__name" colSpan={9}>
                    <strong>حساب‌های غیرفعال</strong>
                    <small className="muted">
                      خاموش شده‌اند و ربات کارتی از آن‌ها نمی‌دهد — پولی که به آن‌ها رسیده همین‌جاست
                    </small>
                  </th>
                </tr>
                {archived.map((a) => (
                  <AccountRow key={a.accountId} a={a} cards={byAccount.get(a.accountId) ?? []} />
                ))}
              </>
            )}
            {orphans.length > 0 && (
              <>
                <tr className="fin-table__account fin-table__account--orphans">
                  <th scope="row" className="fin-table__name" colSpan={9}>
                    <strong>کارت‌های نگاشت‌نشده</strong>
                    <small className="muted">{exclusionReasonFa('card_not_mapped')}</small>
                  </th>
                </tr>
                {orphans.map((c) => (
                  <CardRow key={c.cardDigits} c={c} />
                ))}
              </>
            )}
            {nowhere.bankInflowCount > 0 && (
              <tr className="fin-table__account fin-table__account--orphans">
                <th scope="row" className="fin-table__name">
                  <strong>واریزی بدون حساب</strong>
                  <small className="muted">
                    پیامک به هیچ حسابی نرسید — در «تراکنش‌ها» حسابش را تعیین کنید
                  </small>
                </th>
                <Money irr={nowhere.bankInflowIrr} n={nowhere.bankInflowCount} />
                <Money irr={nowhere.bankOutflowIrr ?? 0} n={nowhere.bankOutflowCount ?? 0} />
                <Blank />
                <Blank />
                <Blank />
                <Blank />
                <Money irr={nowhere.unassignedIncomeIrr} n={nowhere.unassignedIncomeCount} />
                <Blank />
              </tr>
            )}
          </tbody>
          {analytics && (
            <tfoot>
              <tr className="fin-table__total">
                <th scope="row" className="fin-table__name">
                  جمع همه
                </th>
                <Money irr={analytics.bankInflowIrr} />
                <Money irr={analytics.bankOutflowIrr ?? 0} />
                <Money irr={analytics.sales.amountIrr} n={analytics.sales.count} />
                <Money irr={analytics.botAutoVerified.amountIrr} n={analytics.botAutoVerified.count} />
                <Money irr={analytics.manualVerified.amountIrr} n={analytics.manualVerified.count} />
                <Money irr={analytics.reseller.amountIrr} n={analytics.reseller.count} />
                <Money irr={analytics.unassignedIncome.amountIrr} n={analytics.unassignedIncome.count} />
                <td className="fin-table__num tabular-nums">
                  <strong>{formatCompactIrr(analytics.balances.totalKnownIrr)}</strong>
                  <small className="muted">
                    {count(analytics.balances.knownAccounts)} از{' '}
                    {count(analytics.balances.totalActiveAccounts)} حساب
                  </small>
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <p className="fin-table__foot muted">
        فاصلهٔ پرکارترین تا کم‌کارترین کارتِ در گردش: {count(gap)} فروش
        {gap > 0 && ' — کارتی که خیلی عقب است را در «بانک‌ها» وزن بدهید.'}
      </p>
    </section>
  );
}
