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
 *   3. the partners — the profit split (a decision, by percent) and each
 *      partner's running account: every share minus every draw.
 *
 * Every figure is added up by the server (`packages/domain/src/shopProfit.ts`)
 * from the orders and the ledger over the window chosen here; nothing on this
 * page is stored.
 */

import { Fragment, useEffect, useState } from 'react';
import { formatJalali, jalaliToIsoDate, toJalali, type JalaliDate } from '@shikoo/contracts';
import { api, ApiError, type PartnerAccount, type ProfitSplit, type ShopProfit, type StatsRange } from '../api.js';
import { api as hubApi, type AccountListItem } from '../hub/api.js';
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
                : `${fa(data.startMs)} تا ${fa(data.endMs! - 1)}` +
                  (data.booksStartMs !== null && data.startMs <= data.booksStartMs
                    ? ' — از شروع دفتر؛ پیش از آن حساب نمی‌شود'
                    : '')
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
                  مال همهٔ فروشگاه، پخش نمی‌شود
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

/**
 * «تقسیم سود» and the partners' running accounts (0095).
 *
 * Sam, 1 Mehr 1405: at the end of the month Pouyan says «۴۰ میلیون تقسیم
 * می‌کنم», and one partner already took 5 million mid-month. The split is a
 * decision — what each is now owed, by his percent — and the payment is a
 * «برداشت شریک» row, whenever the money actually leaves. The table is the
 * running account: every share minus every draw, from month to month.
 */
function Partners({ d }: { d: ShopProfit }) {
  const [splits, setSplits] = useState<ProfitSplit[]>([]);
  const [accounts, setAccounts] = useState<PartnerAccount[]>([]);
  const [bankAccounts, setBankAccounts] = useState<AccountListItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [paying, setPaying] = useState<number | null>(null);

  useEffect(() => {
    api
      .profitSplits()
      .then((r) => {
        setSplits(r.items);
        setAccounts(r.accounts);
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, [reload]);
  useEffect(() => {
    hubApi
      .accounts()
      .then((r) => setBankAccounts(r.items.filter((a) => a.active)))
      .catch(() => setBankAccounts([]));
  }, []);
  const refresh = (msg: string) => {
    setErr(null);
    setDone(msg);
    setPaying(null);
    setReload((n) => n + 1);
  };

  return (
    <div className="card" style={{ marginBlockStart: 16 }} data-testid="partners">
      <div className="card__head">
        <div>
          <div className="card__title">شرکا — تقسیم سود و حساب هر نفر</div>
          <div className="page-head__sub">
            مانده = جمع سهم‌هایی که تا حالا تقسیم شده، منهای هرچه برداشته — ماه به ماه ادامه دارد
          </div>
        </div>
        <a className="btn" href={pathForPage('parties')}>
          اشخاص و درصدها
        </a>
      </div>
      {err && <div className="alert alert-error">{err}</div>}
      {done && (
        <div className="alert alert-ok" role="status" onClick={() => setDone(null)}>
          {done}
        </div>
      )}
      <div className="table-wrap">
        <table className="app-table">
          <thead>
            <tr>
              <th>شریک</th>
              <th>درصد</th>
              <th>سهم‌های تقسیم‌شده</th>
              <th>برداشته</th>
              <th>مانده</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 && (
              <tr>
                <td className="empty" colSpan={6}>
                  شریکی تعریف نشده — در «اشخاص» خودت و شرکایت را با نقش «شریک» و درصد سهم اضافه کن.
                </td>
              </tr>
            )}
            {accounts.map((p) => (
              <Fragment key={p.partyId}>
                <tr>
                  <td>
                    <a href={`${pathForPage('expenses')}?party=${p.partyId}`}>{p.name}</a>
                  </td>
                  <td>{p.sharePercent === null ? '—' : pct(p.sharePercent)}</td>
                  <td>{p.allottedIrr ? toman(p.allottedIrr) : '—'}</td>
                  <td>{p.drawnIrr ? toman(p.drawnIrr) : '—'}</td>
                  <td>
                    <span className={p.balanceIrr < 0 ? 'badge badge-block' : 'badge badge-active'}>
                      {toman(Math.abs(p.balanceIrr))}
                    </span>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {p.balanceIrr > 0
                        ? 'باید به او پرداخت شود'
                        : p.balanceIrr < 0
                          ? 'بیشتر از سهمش گرفته — از تقسیم بعدی کم می‌شود'
                          : 'تسویه'}
                    </div>
                  </td>
                  <td>
                    {p.active && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setPaying(paying === p.partyId ? null : p.partyId)}
                      >
                        پرداخت
                      </button>
                    )}
                  </td>
                </tr>
                {paying === p.partyId && (
                  <tr>
                    <td colSpan={6}>
                      <PayForm partner={p} bankAccounts={bankAccounts} onDone={refresh} onError={setErr} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <SplitForm d={d} onDone={refresh} onError={setErr} />
      <SplitHistory splits={splits} onVoided={() => refresh('تقسیم باطل شد.')} onError={setErr} />
    </div>
  );
}

/** The window's first and last Tehran day, as the split records them. */
function windowDays(d: ShopProfit): { from: string; to: string } {
  const today = jalaliToIsoDate(toJalali(Date.now()));
  return {
    from: d.startMs === null ? today : jalaliToIsoDate(toJalali(d.startMs)),
    to: d.endMs === null ? today : jalaliToIsoDate(toJalali(Math.min(d.endMs - 1, Date.now()))),
  };
}

const tomanOf = (irr: number) => Math.round(irr / 10);
const dayFa = (iso: string) => fa(Date.parse(`${iso}T12:00:00Z`));

function SplitForm({ d, onDone, onError }: { d: ShopProfit; onDone: (m: string) => void; onError: (m: string) => void }) {
  const { from, to } = windowDays(d);
  const [total, setTotal] = useState('');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<
    Array<{ partyId: number; name: string; sharePercent: number | null; amountToman: number }> | null
  >(null);
  const [busy, setBusy] = useState(false);
  // A new window is a new decision: an old preview must not be saved under it.
  useEffect(() => setPreview(null), [from, to]);

  const totalToman = parseToman(total);
  async function run(save: boolean) {
    setBusy(true);
    try {
      const r = await api.addProfitSplit({
        fromDay: from,
        toDay: to,
        ...(save && preview
          ? { shares: preview.map((s) => ({ partyId: s.partyId, amountToman: s.amountToman })) }
          : { totalToman: totalToman! }),
        ...(note.trim() ? { note: note.trim() } : {}),
        dryRun: !save,
      });
      if (save) {
        setPreview(null);
        setTotal('');
        setNote('');
        onDone(`تقسیم ثبت شد: ${toman(r.totalIrr)} بین ${count(r.shares.length)} شریک.`);
      } else {
        setPreview(
          r.shares.map((s) => ({
            partyId: s.partyId,
            name: s.name,
            sharePercent: s.sharePercent,
            amountToman: tomanOf(s.amountIrr),
          })),
        );
      }
    } catch (e) {
      onError(
        e instanceof ApiError && e.code === 'no_partner_shares'
          ? 'هیچ شریکی درصد سهم ندارد — اول در «اشخاص» درصد هر شریک را بنویس.'
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setBusy(false);
    }
  }
  const previewTotal = preview?.reduce((a, s) => a + s.amountToman, 0) ?? 0;

  return (
    <div style={{ marginBlockStart: 16 }} data-testid="split-form">
      <div className="card__title" style={{ fontSize: 15 }}>
        تقسیم سود — {dayFa(from)} تا {dayFa(to)}
      </div>
      <p className="muted" style={{ marginBlock: 4 }}>
        سود این دوره {toman(d.profitIrr)} است. مبلغی را که می‌خواهید تقسیم کنید بنویس؛ به نسبت درصد هر شریک پخش
        می‌شود و به «سهم‌های تقسیم‌شده»ی او اضافه می‌شود. تقسیم پولی جابه‌جا نمی‌کند — پرداخت را با دکمهٔ «پرداخت»
        ثبت کن.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label>
          <span className="form-label">مبلغ تقسیم (تومان)</span>
          <input
            className="form-control"
            inputMode="numeric"
            aria-label="مبلغ تقسیم (تومان)"
            value={total}
            onChange={(e) => {
              setTotal(e.target.value);
              setPreview(null);
            }}
          />
        </label>
        <label style={{ flex: 1, minWidth: 160 }}>
          <span className="form-label">یادداشت (اختیاری)</span>
          <input
            className="form-control"
            aria-label="یادداشت تقسیم"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <button type="button" className="btn" disabled={busy || !totalToman} onClick={() => run(false)}>
          پیش‌نمایش
        </button>
      </div>
      {preview && (
        <>
          <table className="app-table" style={{ marginBlockStart: 8 }} data-testid="split-preview">
            <thead>
              <tr>
                <th>شریک</th>
                <th>درصد</th>
                <th>سهم (تومان)</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((s, i) => (
                <tr key={s.partyId}>
                  <td>{s.name}</td>
                  <td>{s.sharePercent === null ? '—' : pct(s.sharePercent)}</td>
                  <td>
                    <input
                      className="form-control"
                      inputMode="numeric"
                      aria-label={`سهم ${s.name}`}
                      value={s.amountToman.toLocaleString('fa-IR')}
                      onChange={(e) => {
                        const v = parseToman(e.target.value) ?? 0;
                        setPreview(preview.map((x, j) => (j === i ? { ...x, amountToman: v } : x)));
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBlockStart: 8 }}>
            <span>جمع: {toman(previewTotal * 10)}</span>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || previewTotal <= 0}
              onClick={() => run(true)}
            >
              ثبت تقسیم
            </button>
            <button type="button" className="btn" onClick={() => setPreview(null)}>
              انصراف
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function PayForm({
  partner,
  bankAccounts,
  onDone,
  onError,
}: {
  partner: PartnerAccount;
  bankAccounts: AccountListItem[];
  onDone: (m: string) => void;
  onError: (m: string) => void;
}) {
  const [amount, setAmount] = useState(
    partner.balanceIrr > 0 ? tomanOf(partner.balanceIrr).toLocaleString('fa-IR') : '',
  );
  const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const amountToman = parseToman(amount);
  async function pay() {
    setBusy(true);
    try {
      await api.addRevenueAdjustment({
        kind: 'PARTNER_DRAW',
        amountToman: amountToman!,
        partyId: partner.partyId,
        note: `پرداخت سهم سود — ${partner.name}`,
        ...(accountId ? { financialAccountId: accountId } : {}),
      });
      onDone(`پرداخت ${toman(amountToman! * 10)} به ${partner.name} به‌عنوان «برداشت شریک» ثبت شد.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }} data-testid="pay-form">
      <label>
        <span className="form-label">مبلغ پرداخت (تومان)</span>
        <input
          className="form-control"
          inputMode="numeric"
          aria-label="مبلغ پرداخت (تومان)"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <label>
        <span className="form-label">از حساب (اختیاری)</span>
        <select
          className="form-control"
          aria-label="از حساب"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        >
          <option value="">—</option>
          {bankAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.display_name}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="btn btn-primary" disabled={busy || !amountToman} onClick={pay}>
        ثبت پرداخت امروز
      </button>
    </div>
  );
}

function SplitHistory({
  splits,
  onVoided,
  onError,
}: {
  splits: ProfitSplit[];
  onVoided: () => void;
  onError: (m: string) => void;
}) {
  const [confirming, setConfirming] = useState<number | null>(null);
  if (splits.length === 0) return null;
  return (
    <div style={{ marginBlockStart: 16 }}>
      <div className="card__title" style={{ fontSize: 15 }}>
        تقسیم‌های ثبت‌شده
      </div>
      <div className="table-wrap">
        <table className="app-table" data-testid="split-history">
          <thead>
            <tr>
              <th>دوره</th>
              <th>جمع</th>
              <th>سهم‌ها</th>
              <th>سود دوره در آن روز</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {splits.map((s) => (
              <tr key={s.id} style={s.voidedAt ? { opacity: 0.5 } : undefined}>
                <td>
                  {dayFa(s.fromDay)} تا {dayFa(s.toDay)}
                  {s.note && (
                    <div className="muted" style={{ fontSize: 11 }}>
                      {s.note}
                    </div>
                  )}
                </td>
                <td>{toman(s.totalIrr)}</td>
                <td>{s.shares.map((x) => `${x.name}: ${toman(x.amountIrr)}`).join('، ')}</td>
                <td>{s.profitIrr === null ? '—' : toman(s.profitIrr)}</td>
                <td>
                  {s.voidedAt ? (
                    <span className="badge">باطل شده</span>
                  ) : confirming === s.id ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() =>
                          api
                            .voidProfitSplit(s.id)
                            .then(onVoided)
                            .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
                            .finally(() => setConfirming(null))
                        }
                      >
                        بله، باطل کن
                      </button>{' '}
                      <button type="button" className="btn btn-sm" onClick={() => setConfirming(null)}>
                        انصراف
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn btn-sm" onClick={() => setConfirming(s.id)}>
                      باطل
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** «۱۳٬۳۳۳٬۳۳۳» or «13,333,333» → 13333333; anything else → null. */
function parseToman(raw: string): number | null {
  const digits = raw
    .replace(/[۰-۹]/g, (c) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)))
    .replace(/[٠-٩]/g, (c) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)))
    .replace(/[,٬\s]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  const n = Number(digits);
  return n > 0 ? n : null;
}
