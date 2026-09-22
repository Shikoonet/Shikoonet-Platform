/**
 * «زیرمجموعه‌ها» — who brings customers, and what it is worth.
 *
 * The customer card lists the people ONE customer brought. That answers «who
 * did this one bring» and nothing else: with 178 referrers among 17k
 * customers there was no way to find a referrer without already knowing one.
 * Sam, 2026-09-19: «بتونم به تفصیل کاربرانی که زیرمجموعه دارن رو ببینم، فیلتر
 * کنم، اطلاعات بگیرم، با کلیک به پروفایلشون برم».
 *
 * One row per referrer, from `/api/v1/admin/referrers`; the sums are the
 * server's, counted the way the commission rule counts (see the route). A row
 * opens in place to show the referrals themselves — the same rows the card
 * shows, from the same endpoint, so the two screens cannot disagree — and
 * every handle is a `CustomerLink` to the card.
 */

import { useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type CustomerReferralRow,
  type ReferrerRow,
  type ReferrerSort,
  type ReferrerTotals,
} from '../api.js';
import { CustomerLink } from '../CustomerLink.js';
import { Stat } from '../Stat.js';
import { count, dateTime, toman, tomanCompact } from '../format.js';

const PAGE_SIZE = 25;

/** «از کی» as a choice rather than a date box: the question is always «این
 * هفته / این ماه / این فصل», not a particular day. */
const SINCE_DAYS: Record<string, number> = { '7': 7, '30': 30, '90': 90 };

function sinceDate(key: string): string | undefined {
  const days = SINCE_DAYS[key];
  if (!days) return undefined;
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function message(e: unknown): string {
  if (e instanceof ApiError) return `خطا: ${e.code}`;
  return e instanceof Error ? e.message : String(e);
}

export function ReferralsPage() {
  const [rows, setRows] = useState<ReferrerRow[]>([]);
  const [totals, setTotals] = useState<ReferrerTotals | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [buyers, setBuyers] = useState<'' | 'yes' | 'no'>('');
  const [min, setMin] = useState('');
  const [since, setSince] = useState('');
  const [sort, setSort] = useState<ReferrerSort>('invited');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  // A sort change and a page change can be in flight together; only the last
  // one asked for may draw, or the older answer lands on the newer controls.
  const seq = useRef(0);

  async function load(toPage = page) {
    const mine = ++seq.current;
    setLoading(true);
    setErr(null);
    try {
      const minN = Number(min);
      const sinceIso = sinceDate(since);
      const d = await api.referrers({
        page: toPage,
        pageSize: PAGE_SIZE,
        sort,
        ...(q.trim() ? { q: q.trim() } : {}),
        ...(buyers ? { buyers } : {}),
        ...(Number.isInteger(minN) && minN > 1 ? { min: minN } : {}),
        ...(sinceIso ? { since: sinceIso } : {}),
      });
      if (mine !== seq.current) return;
      setRows(d.items);
      setTotals(d.totals);
      setTotal(d.total);
    } catch (e) {
      if (mine !== seq.current) return;
      setErr(message(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load(page);
    // Not on `q` or `min`: those are typed and submitted, not applied per key.
  }, [page, buyers, since, sort]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">زیرمجموعه‌ها</h2>
          <div className="page-head__sub">
            {totals ? `${count(totals.referrers)} معرف · ${count(totals.invited)} زیرمجموعه` : '…'}
          </div>
        </div>
      </div>

      {/* Over the FILTERED set — the server counts the same rows the table
          shows, so «این ماه» above and «این ماه» below are one question. */}
      {totals && (
        <div className="stats-grid">
          <Stat tone="tone-blue" icon="users" value={count(totals.referrers)} label="معرف" />
          <Stat
            tone="tone-blue"
            icon="send"
            value={count(totals.invited)}
            label="زیرمجموعه"
            foot={`${count(totals.buyers)} نفر خرید کرده‌اند`}
          />
          <Stat
            tone="tone-green"
            icon="receipt"
            value={tomanCompact(totals.boughtIrr)}
            label="خرید زیرمجموعه‌ها"
          />
          <Stat
            tone="tone-green"
            icon="wallet"
            value={tomanCompact(totals.commissionIrr)}
            label="پورسانت پرداخت‌شده"
            foot="از خرید اول و تمدیدهای زیرمجموعه‌ها"
          />
        </div>
      )}

      <div className="card">
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            void load(1);
          }}
        >
          <div className="grow">
            <label className="form-label" htmlFor="ref-q">
              معرف
            </label>
            <input
              id="ref-q"
              className="form-control ltr"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="آیدی عددی یا @نام‌کاربری"
            />
          </div>
          <div>
            <label className="form-label" htmlFor="ref-buyers">
              خرید زیرمجموعه
            </label>
            <select
              id="ref-buyers"
              className="form-control"
              value={buyers}
              onChange={(e) => {
                setBuyers(e.target.value as '' | 'yes' | 'no');
                setPage(1);
              }}
            >
              <option value="">همه</option>
              <option value="yes">دست‌کم یکی خریده</option>
              <option value="no">هیچ‌کدام نخریده</option>
            </select>
          </div>
          <div>
            <label className="form-label" htmlFor="ref-min">
              حداقل زیرمجموعه
            </label>
            <input
              id="ref-min"
              className="form-control ltr"
              type="number"
              min={1}
              value={min}
              onChange={(e) => setMin(e.target.value)}
              placeholder="۱"
              style={{ width: 96 }}
            />
          </div>
          <div>
            <label className="form-label" htmlFor="ref-since">
              عضویت زیرمجموعه
            </label>
            <select
              id="ref-since"
              className="form-control"
              value={since}
              onChange={(e) => {
                setSince(e.target.value);
                setPage(1);
              }}
            >
              <option value="">از ابتدا</option>
              <option value="7">۷ روز اخیر</option>
              <option value="30">۳۰ روز اخیر</option>
              <option value="90">۹۰ روز اخیر</option>
            </select>
          </div>
          <div>
            <label className="form-label" htmlFor="ref-sort">
              ترتیب
            </label>
            <select
              id="ref-sort"
              className="form-control"
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as ReferrerSort);
                setPage(1);
              }}
            >
              <option value="invited">بیشترین زیرمجموعه</option>
              <option value="buyers">بیشترین خریدار</option>
              <option value="bought">بیشترین خرید</option>
              <option value="commission">بیشترین پورسانت</option>
              <option value="recent">تازه‌ترین عضویت</option>
            </select>
          </div>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            جست‌وجو
          </button>
        </form>

        {err && <div className="alert alert-error">{err}</div>}

        <div className="table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>معرف</th>
                <th>آیدی عددی</th>
                <th>زیرمجموعه</th>
                <th>خریدار</th>
                <th>خرید زیرمجموعه‌ها</th>
                <th>پورسانت</th>
                <th>آخرین عضویت</th>
                <th>موجودی</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading && (
                <tr>
                  <td className="empty" colSpan={9}>
                    معرفی با این شرط‌ها پیدا نشد.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <ReferrerRows
                  key={r.id}
                  row={r}
                  open={openId === r.id}
                  onToggle={() => setOpenId(openId === r.id ? null : r.id)}
                />
              ))}
            </tbody>
          </table>
        </div>

        <div className="pager">
          <button
            type="button"
            className="btn btn-sm"
            disabled={page <= 1 || loading}
            onClick={() => setPage(page - 1)}
          >
            قبلی
          </button>
          <span>
            صفحهٔ {count(page)} از {count(lastPage)}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={page >= lastPage || loading}
            onClick={() => setPage(page + 1)}
          >
            بعدی
          </button>
        </div>
      </div>
    </>
  );
}

/** One referrer, and under it — when opened — the people they brought. */
function ReferrerRows({
  row,
  open,
  onToggle,
}: {
  row: ReferrerRow;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr>
        <td>
          <CustomerLink customer={row} />
          {row.status === 'BLOCKED' && <span className="badge badge-block">مسدود</span>}
        </td>
        <td className="ltr">{row.telegramId}</td>
        <td>{count(row.invited)}</td>
        <td>{count(row.buyers)}</td>
        <td>{toman(row.boughtIrr)}</td>
        <td>{toman(row.commissionIrr)}</td>
        <td>{dateTime(row.lastJoinedAt)}</td>
        <td className={row.balanceIrr < 0 ? 'negative' : undefined}>{toman(row.balanceIrr)}</td>
        <td>
          <button type="button" className="btn btn-sm" onClick={onToggle} aria-expanded={open}>
            {open ? 'بستن' : 'زیرمجموعه‌ها'}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={9} style={{ padding: '0 0 12px' }}>
            <Referrals id={row.id} />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The card's own «زیرمجموعه‌ها» rows, from the card's own endpoint. Fetched
 * on open rather than shipped with the list: a page of 25 referrers is 25
 * requests nobody asked for otherwise, and the list already has the sums.
 */
function Referrals({ id }: { id: number }) {
  const [rows, setRows] = useState<CustomerReferralRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setRows(null);
    api
      .customer(id)
      .then((d) => live && setRows(d.referral.referrals))
      .catch((e) => live && setErr(message(e)));
    return () => {
      live = false;
    };
  }, [id]);
  if (err) return <div className="alert alert-error">{err}</div>;
  if (rows === null) return <div className="muted">در حال خواندن…</div>;
  return (
    <table className="app-table" data-testid="referrals-of">
      <thead>
        <tr>
          <th>کاربر</th>
          <th>آیدی عددی</th>
          <th>عضویت</th>
          <th>خریدها</th>
          <th>پورسانت به معرف</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>
              <CustomerLink customer={r} />
            </td>
            <td className="ltr">{r.telegramId}</td>
            <td>{dateTime(r.joinedAt)}</td>
            <td>
              {r.purchases === 0 ? '—' : `${count(r.purchases)} · ${toman(r.boughtIrr)}`}
            </td>
            <td>{r.commissionIrr === 0 ? '—' : toman(r.commissionIrr)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
