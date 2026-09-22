/**
 * «سود و زیان» — Sam, 2026-09-22:
 *
 *   «سرویس الماس چقدر فروش داشته و چقدر ما براش هزینه کردیم، اعم از تبلیغات و
 *    سرور و …، و در آخر سودی که ساخته چقدره؟»
 *   «ما ۳ نفریم و ماهیانه سود برمی‌داریم — معلومه من چقدر گرفتم؟»
 *
 * Three cards, in the order the questions are asked:
 *
 *   1. the statement — sales, corrections, gifts, costs, profit, and only then
 *      the partners' draws and what is left. A draw is the profit being
 *      divided; it is never a cost, and this page is where that shows.
 *   2. per service — what each sold, what it cost, what it made. A cost named
 *      for a category or a panel is spread over its services by sales; a cost
 *      for the whole shop is shown once, under the table, and not spread.
 *   3. per partner — his percent of the profit, what he drew, what is left.
 *
 * Every figure is added up by the server (`packages/domain/src/shopProfit.ts`)
 * from the orders and the ledger over the window chosen here; nothing on this
 * page is stored.
 */

import { useEffect, useState } from 'react';
import { formatJalali, jalaliToIsoDate, toJalali, type JalaliDate } from '@shikoo/contracts';
import { api, ApiError, type ShopProfit, type StatsRange } from '../api.js';
import { count, toman } from '../format.js';
import { pathForPage } from '../route.js';
import { RangeBar } from './StatsPage.js';

const fa = (ms: number) => formatJalali(ms);
const pct = (n: number | null) =>
  n === null ? '—' : `${n.toLocaleString('fa-IR', { maximumFractionDigits: 1 })}٪`;
/** Money out, shown as the positive amount it is, with a minus the eye can find. */
const minus = (irr: number) => (irr === 0 ? toman(0) : `− ${toman(irr)}`);

export function ProfitPage() {
  const [range, setRange] = useState<StatsRange>('month');
  const [jDay, setJDay] = useState<JalaliDate>(() => toJalali(Date.now()));
  const [jFrom, setJFrom] = useState<JalaliDate>(() => toJalali(Date.now() - 60 * 86_400_000));
  const [jTo, setJTo] = useState<JalaliDate>(() => toJalali(Date.now()));
  const [data, setData] = useState<ShopProfit | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const day = jalaliToIsoDate(jDay);
  const from = jalaliToIsoDate(jFrom);
  const to = jalaliToIsoDate(jTo);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    setErr(null);
    api
      .shopProfit(range, range === 'between' ? from : day, range === 'between' ? to : undefined)
      .then((d) => alive && setData(d))
      .catch((e: unknown) =>
        alive &&
        setErr(
          e instanceof ApiError && e.code === 'forbidden'
            ? 'سود و زیان بخشی از دفتر فروشگاه است و برای نقش «فقط خواندن» نمایش داده نمی‌شود.'
            : e instanceof Error
              ? e.message
              : String(e),
        ),
      )
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [range, day, from, to]);

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">سود و زیان</h2>
          <div className="page-head__sub">
            {data
              ? data.startMs === null
                ? 'از ابتدا تا همین لحظه'
                : `${fa(data.startMs)} تا ${fa(data.endMs! - 1)}`
              : 'فروش، هزینه و سود — کل فروشگاه، هر سرویس، هر شریک'}
          </div>
        </div>
      </div>

      <RangeBar
        range={range}
        onRange={setRange}
        jDay={jDay}
        onDay={setJDay}
        jFrom={jFrom}
        onFrom={setJFrom}
        jTo={jTo}
        onTo={setJTo}
      />

      {err && <div className="alert alert-error">{err}</div>}
      {!data && !err && <p className="muted">در حال بارگذاری…</p>}

      {data && (
        <div style={{ opacity: busy ? 0.55 : 1, transition: 'opacity .15s' }}>
          <Statement d={data} />
          <Services d={data} />
          <Partners d={data} />
        </div>
      )}
    </>
  );
}

function Statement({ d }: { d: ShopProfit }) {
  const line = (label: string, hint: string, value: string, strong = false) => (
    <tr>
      <td>
        {strong ? <strong>{label}</strong> : label}
        <div className="muted" style={{ fontSize: 11 }}>
          {hint}
        </div>
      </td>
      <td style={{ textAlign: 'end', whiteSpace: 'nowrap' }}>{strong ? <strong>{value}</strong> : value}</td>
    </tr>
  );
  return (
    <div className="card">
      <div className="card__head">
        <div className="card__title">صورت سود و زیان</div>
      </div>
      <div className="table-wrap">
        <table className="app-table">
          <tbody>
            {line('فروش', 'خرید، تمدید و افزودنی — فقط سفارش‌های تکمیل‌شده، بدون شارژ کیف پول', toman(d.salesIrr))}
            {line('اصلاح درآمد', 'فیش فیک، عدم واریزی، تکراری — از «هزینه‌ها»', toman(d.revenueFixIrr))}
            {line('درآمد دستی', 'فروشی که دستی ثبت شده', toman(d.manualIncomeIrr))}
            {line('درآمد خالص', 'جمع سه سطر بالا', toman(d.revenueIrr), true)}
            {line(
              'هدیهٔ کیف پول',
              'پورسانت معرف، کش‌بک تمدید، کد هدیه — اعتباری که فروشگاه داده و مشتری با آن خرید می‌کند',
              minus(d.giftsIrr),
            )}
            {line(
              'هزینه‌های سرویس‌ها',
              'هزینه‌هایی که به یک دسته، سرویس یا پنل وصل‌اند — تفکیکشان در جدول پایین',
              minus(d.serviceExpensesIrr),
            )}
            {line('هزینه‌های مشترک', 'هزینه‌هایی که مال همهٔ فروشگاه‌اند', minus(d.sharedExpensesIrr))}
            {line('سود', 'درآمد خالص منهای هدیه و هزینه — آنچه برای تقسیم هست', toman(d.profitIrr), true)}
            {line('برداشت شرکا', 'سهمی که شرکا در همین بازه برداشته‌اند — هزینه نیست', minus(d.drawsIrr))}
            {line('ماندهٔ سود', 'سودی که هنوز برداشته نشده', toman(d.retainedIrr), true)}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ marginBottom: 0 }}>
        هزینه‌ها به تاریخ خرجشان حساب می‌شوند، فروش به تاریخ تکمیل سفارش. ردیف‌های باطل‌شده در هیچ عددی نیستند.{' '}
        <a href={pathForPage('expenses')}>ردیف‌های «هزینه‌ها»</a>
      </p>
    </div>
  );
}

function Services({ d }: { d: ShopProfit }) {
  const legacy = d.services.find((s) => s.productId === null);
  return (
    <div className="card" style={{ marginBlockStart: 16 }}>
      <div className="card__head">
        <div>
          <div className="card__title">سود هر سرویس</div>
          <div className="page-head__sub">
            هزینهٔ یک دسته (مثلاً V2ray) یا یک پنل بین سرویس‌هایش به نسبت فروش همین بازه پخش می‌شود
          </div>
        </div>
      </div>
      <div className="table-wrap">
        <table className="app-table">
          <thead>
            <tr>
              <th>سرویس</th>
              <th>فروش</th>
              <th>هزینه</th>
              <th>هدیهٔ کیف پول</th>
              <th>سود</th>
              <th>حاشیه</th>
            </tr>
          </thead>
          <tbody>
            {d.services.length === 0 && (
              <tr>
                <td className="empty" colSpan={6}>
                  در این بازه فروش یا هزینه‌ای به هیچ سرویسی نخورده.
                </td>
              </tr>
            )}
            {d.services.map((s) => (
              <tr key={s.productId ?? 'legacy'}>
                <td>
                  {s.name}
                  {s.categoryName && (
                    <div className="muted" style={{ fontSize: 11 }}>
                      {s.categoryName}
                    </div>
                  )}
                </td>
                <td>{toman(s.revenueIrr)}</td>
                <td>{s.expensesIrr ? minus(s.expensesIrr) : '—'}</td>
                <td>{s.giftsIrr ? minus(s.giftsIrr) : '—'}</td>
                <td>
                  <span className={s.profitIrr < 0 ? 'badge badge-block' : 'badge badge-active'}>{toman(s.profitIrr)}</span>
                </td>
                <td>{pct(s.marginPercent)}</td>
              </tr>
            ))}
            {d.unallocated.map((u) => (
              <tr key={`u-${u.name}`}>
                <td>
                  {u.name}
                  <div className="muted" style={{ fontSize: 11 }}>
                    هزینه به دسته یا پنلی خورده که سرویسی زیرش نیست
                  </div>
                </td>
                <td>—</td>
                <td>{minus(u.irr)}</td>
                <td>—</td>
                <td>—</td>
                <td>—</td>
              </tr>
            ))}
            <tr>
              <td>
                هزینه‌های مشترک
                <div className="muted" style={{ fontSize: 11 }}>
                  مال همهٔ فروشگاه — روی سرویس‌ها پخش نمی‌شود؛ هدیه‌ها کد هدیه و گردونه‌اند که به سفارشی وصل نیستند
                </div>
              </td>
              <td>—</td>
              <td>{minus(d.sharedExpensesIrr)}</td>
              <td>{d.sharedGiftsIrr ? minus(d.sharedGiftsIrr) : '—'}</td>
              <td>—</td>
              <td>—</td>
            </tr>
          </tbody>
        </table>
      </div>
      {legacy && (
        <p className="muted" style={{ marginBottom: 0 }}>
          «{legacy.name}» فروش‌هایی است که از ربات قدیمی آمده‌اند و نام سرویس ندارند ({toman(legacy.revenueIrr)}
          ). هزینه‌ای به آن‌ها وصل نیست، پس سودشان بیشتر از واقع نشان داده می‌شود.
        </p>
      )}
    </div>
  );
}

function Partners({ d }: { d: ShopProfit }) {
  return (
    <div className="card" style={{ marginBlockStart: 16 }}>
      <div className="card__head">
        <div>
          <div className="card__title">سهم شرکا</div>
          <div className="page-head__sub">سهم هر شریک از «سود» همین بازه، منهای آنچه در همین بازه برداشته</div>
        </div>
        <a className="btn" href={pathForPage('parties')}>
          اشخاص
        </a>
      </div>
      <div className="table-wrap">
        <table className="app-table">
          <thead>
            <tr>
              <th>شریک</th>
              <th>درصد</th>
              <th>سهم از سود</th>
              <th>برداشته</th>
              <th>مانده</th>
            </tr>
          </thead>
          <tbody>
            {d.partners.length === 0 && (
              <tr>
                <td className="empty" colSpan={5}>
                  شریکی تعریف نشده — در «اشخاص» خودت و شرکایت را با نقش «شریک» و درصد سهم اضافه کن.
                </td>
              </tr>
            )}
            {d.partners.map((p) => (
              <tr key={p.partyId}>
                <td>
                  <a href={`${pathForPage('expenses')}?party=${p.partyId}`}>{p.name}</a>
                </td>
                <td>{p.sharePercent === null ? '—' : `${count(p.sharePercent)}٪`}</td>
                <td>{p.sharePercent === null ? '—' : toman(p.shareIrr)}</td>
                <td>{p.drawnIrr ? toman(p.drawnIrr) : '—'}</td>
                <td>
                  {p.sharePercent === null ? (
                    '—'
                  ) : (
                    <span className={p.balanceIrr < 0 ? 'badge badge-block' : 'badge badge-active'}>
                      {toman(p.balanceIrr)}
                    </span>
                  )}
                  {p.sharePercent !== null && (
                    <div className="muted" style={{ fontSize: 11 }}>
                      {p.balanceIrr < 0 ? 'بیشتر از سهمش برداشته' : 'طلب از سود این بازه'}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {d.partners.length > 0 && d.undividedPercent > 0 && (
        <p className="muted" style={{ marginBottom: 0 }}>
          {count(d.undividedPercent)}٪ از سود به کسی نسبت داده نشده. درصد هر شریک را در «اشخاص» بنویس.
        </p>
      )}
    </div>
  );
}
