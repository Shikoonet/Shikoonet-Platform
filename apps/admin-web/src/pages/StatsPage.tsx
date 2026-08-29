/**
 * «آمار فروشگاه» — the screen the PHP bot draws under «📊 آمار کلی ربات».
 *
 * Two things about it are different from the screen it replaces, and both are
 * on purpose.
 *
 * **Stocks and flows are separated.** The legacy puts eighteen figures under
 * one row of period buttons, and roughly half of them are running totals that a
 * period cannot change — the wallet balance, the live services, the panel
 * count. Reading a balance under «یک ساعت اخیر» as an hour's takings is an easy
 * mistake to make once and an expensive one to make twice, so the two live in
 * separate sections and the second says «هم‌اکنون» in its heading.
 *
 * **Two figures are missing, and say why.** «نمایندگان نوع N/N2» and
 * «اکانت‌های تست» have no equivalent here — the reasons come from the server so
 * that the page and the API cannot drift into disagreeing about it. A zero
 * would read as «none this month», which is the one thing they must not say.
 */

import { useEffect, useState } from 'react';
import {
  JALALI_MONTHS,
  formatJalali,
  jalaliMonthLength,
  jalaliToIsoDate,
  toJalali,
  type JalaliDate,
} from '@shikoo/contracts';
import { api, type ShopStatsResponse, type StatsRange } from '../api.js';
import { Icon } from '../icons.js';
import { count, toman, tomanCompact } from '../format.js';

/** The seven buttons, in the order the legacy screen lists them. */
const RANGES: Array<{ id: StatsRange; label: string }> = [
  { id: 'all', label: 'آمار کل' },
  { id: '1h', label: 'یک ساعت اخیر' },
  { id: 'today', label: 'امروز' },
  { id: 'yesterday', label: 'دیروز' },
  { id: 'month', label: 'ماه شمسی' },
  { id: 'prev_month', label: 'ماه قبل' },
  { id: 'day', label: 'تاریخ مشخص' },
  { id: 'between', label: 'بازهٔ دلخواه' },
];

/**
 * `payments.method` in Persian.
 *
 * An unknown method falls through to its own raw value rather than to a dash:
 * a method this map has not caught up with is a real payment that really
 * happened, and hiding its name would leave money on the screen with nothing
 * saying where it came from.
 */
const METHOD_FA: Record<string, string> = {
  CARD_TO_CARD: 'کارت به کارت',
  CRYPTO: 'رمزارز',
  TELEGRAM_STARS: 'استارز تلگرام',
  GATEWAY: 'درگاه بانکی',
  WALLET: 'کیف پول',
};

/**
 * The exact figure, for the line under a compacted one — or nothing when the
 * two would read the same. The exact digits are here so an admin can compare
 * against the old bot's screen; repeating «۰» twice serves nobody.
 */
const exact = (irr: number): string | undefined =>
  // `tomanCompact` only abbreviates from a thousand Toman up; below that it
  // already prints every digit. Comparing the two formatted strings does not
  // work — they always differ by their suffix, «ت» against «تومان» — which is
  // why «۰ ت» was shown with «۰ تومان» underneath it.
  Math.abs(irr) >= 10_000 ? toman(irr) : undefined;

const pctText = (n: number) => `${n.toLocaleString('fa-IR', { maximumFractionDigits: 2 })}٪`;

export function StatsPage() {
  const [range, setRange] = useState<StatsRange>('all');
  // Held as a Jalali date because that is what the operator picks. The wire
  // format stays Gregorian `YYYY-MM-DD` — `statsRangeBounds` already parses it
  // and is tested against it, and moving a calendar onto the query string would
  // be a second thing to get wrong for no gain.
  const [jDay, setJDay] = useState<JalaliDate>(() => toJalali(Date.now()));
  /**
   * «بازهٔ دلخواه» opens on the last two months rather than on today–today.
   * A custom range that starts as a single day shows an empty screen and looks
   * broken; two months is a window that has something in it for most shops.
   */
  const [jFrom, setJFrom] = useState<JalaliDate>(() => toJalali(Date.now() - 60 * 86_400_000));
  const [jTo, setJTo] = useState<JalaliDate>(() => toJalali(Date.now()));
  const day = jalaliToIsoDate(jDay);
  const [data, setData] = useState<ShopStatsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    setErr(null);
    api
      .stats(
        range,
        range === 'between' ? jalaliToIsoDate(jFrom) : day,
        range === 'between' ? jalaliToIsoDate(jTo) : undefined,
      )
      .then((d) => alive && setData(d))
      .catch((e: unknown) => alive && setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
    // The Jalali objects are the source of truth; the ISO strings below are
    // derived from them, so depending on the strings keeps this from re-firing
    // when a new object with the same date is built.
  }, [range, day, jalaliToIsoDate(jFrom), jalaliToIsoDate(jTo)]);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">آمار فروشگاه</div>
          <div className="page-head__sub">
            همان اعدادی که ربات قدیمی زیر «آمار کلی ربات» نشان می‌دهد
          </div>
        </div>
      </div>

      {/* Two rows, not one. Eight buttons and two date fields on a single
          wrapping line put «تا» alone on a second row flush to the left, which
          read as a broken layout rather than as the other half of a pair. */}
      <div className="toolbar statsbar">
        <div className="statsbar__ranges">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`btn ${range === r.id ? 'btn-primary' : ''}`}
              onClick={() => setRange(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>

        {(range === 'day' || range === 'between') && (
          <div className="statsbar__dates">
            {range === 'day' ? (
              <DateField label="تاریخ" value={jDay} onChange={setJDay} />
            ) : (
              <>
                <DateField label="از" value={jFrom} onChange={setJFrom} />
                <DateField label="تا" value={jTo} onChange={setJTo} />
              </>
            )}
          </div>
        )}
      </div>

      {err && <div className="alert alert-error">{err}</div>}
      {!data && !err && <p className="muted">در حال بارگذاری…</p>}

      {data && (
        <div style={{ opacity: busy ? 0.55 : 1, transition: 'opacity .15s' }}>
          <Section
            title="در این بازه"
            sub={
              data.startMs === null
                ? 'از اولین فروش تا همین لحظه'
                : // The end is exclusive — «تا ۸ آبان ۰:۰۰» for a window the
                  // operator asked to run to the 7th. Correct arithmetic, and it
                  // reads as a day they did not choose, so the label names the
                  // last instant actually inside instead.
                  `${fa(data.startMs)} تا ${fa(data.endMs! - 1)}`
            }
          >
            <div className="stats-grid">
              <Stat tone="tone-green" icon="receipt" value={count(data.salesCount)} label="تعداد فروش" />
              <Stat
                tone="tone-green"
                icon="money"
                value={tomanCompact(data.salesIrr)}
                label="جمع فروش"
                foot={exact(data.salesIrr)}
              />
              <Stat tone="tone-blue" icon="receipt" value={count(data.renewalsCount)} label="تعداد تمدید" />
              <Stat
                tone="tone-blue"
                icon="money"
                value={tomanCompact(data.renewalsIrr)}
                label="جمع تمدید"
                foot={exact(data.renewalsIrr)}
              />
              <Stat
                tone="tone-orange"
                icon="wallet"
                value={tomanCompact(data.topupsIrr)}
                label="شارژ کیف پول"
                foot={exact(data.topupsIrr)}
              />
              <Stat
                tone="tone-blue"
                icon="users"
                value={count(data.newCustomers)}
                label="کاربران تازه"
              />
              <Stat
                tone="tone-green"
                icon="users"
                value={count(data.buyers)}
                label="کاربران دارای خرید"
                foot="شارژ کیف پول به‌تنهایی خرید حساب نمی‌شود"
              />
              <Stat
                tone="tone-orange"
                icon="bars"
                value={pctText(data.conversionPercent)}
                label="نرخ تبدیل به مشتری"
                foot="خریداران ÷ کاربران تازهٔ همین بازه"
              />
              <Stat
                tone="tone-blue"
                icon="money"
                value={tomanCompact(data.avgPerBuyerIrr)}
                label="میانگین خرید هر مشتری"
              />
              <Stat
                tone="tone-orange"
                icon="bars"
                value={pctText(data.renewalSharePercent)}
                label="درصد تمدید از فروش"
              />
              <Stat
                tone="tone-green"
                icon="bars"
                value={tomanCompact(data.projectedMonthlyIrr)}
                label="درآمد پیش‌بینی‌شدهٔ ماهانه"
                foot={`میانگین ${count(data.projectionDays)} روزهٔ همین بازه × ۳۰`}
              />
            </div>
          </Section>

          <Section
            title="هم‌اکنون"
            sub="این‌ها موجودی‌اند، نه جریان — با عوض‌شدن بازه تغییر نمی‌کنند"
          >
            <div className="stats-grid">
              <Stat tone="tone-blue" icon="users" value={count(data.customersTotal)} label="کل کاربران" />
              <Stat
                tone="tone-green"
                icon="package"
                value={count(data.activeSubscriptions)}
                label="سرویس‌های فعال"
              />
              <Stat
                tone="tone-green"
                icon="money"
                value={tomanCompact(data.activeSubscriptionsIrr)}
                label="ارزش سرویس‌های فعال"
              />
              <Stat
                tone="tone-orange"
                icon="wallet"
                value={tomanCompact(data.walletHeldIrr)}
                label="موجودی کل کاربران"
                foot={
                  data.walletDebtors > 0
                    ? `${toman(data.walletOwedToShopIrr)} بدهی از ${count(data.walletDebtors)} کیف پول`
                    : 'هیچ کیف پولی زیر صفر نیست'
                }
              />
              <Stat tone="tone-blue" icon="users" value={count(data.resellers)} label="نمایندگان" />
              <Stat tone="tone-blue" icon="server" value={count(data.panels)} label="پنل‌ها" />
              <Stat
                tone="tone-orange"
                icon="money"
                value={count(data.claimsWaiting)}
                label="پرداخت در انتظار بررسی"
              />
            </div>
          </Section>

          <Section title="درگاه‌های پرداخت" sub="پرداخت‌های موفق در همین بازه">
            {data.gateways.length === 0 ? (
              <p className="muted">در این بازه هیچ پرداخت موفقی ثبت نشده.</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>درگاه</th>
                      <th>تعداد پرداخت موفق</th>
                      <th>جمع پرداختی‌ها</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.gateways.map((g) => (
                      <tr key={g.method}>
                        <td>{METHOD_FA[g.method] ?? g.method}</td>
                        <td>{count(g.count)}</td>
                        <td>{toman(g.irr)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {data.notMeasured.length > 0 && (
            <Section
              title="آنچه این‌جا شمرده نمی‌شود"
              sub="ربات قدیمی این‌ها را دارد؛ ما به‌جای صفرِ گمراه‌کننده، دلیلش را می‌گوییم"
            >
              <ul className="muted" style={{ margin: 0, paddingInlineStart: 18, lineHeight: 2 }}>
                {data.notMeasured.map((n) => (
                  <li key={n.label}>
                    <strong>{n.label}</strong> — {n.reason}
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Tehran wall clock in the Jalali calendar — the one the reader thinks in, and
 * the one every boundary on this page was computed in.
 */
const fa = (ms: number) => formatJalali(ms, true);

/**
 * One Jalali date: day, month, year.
 *
 * Three selects rather than a calendar widget, and rather than the browser's
 * `<input type="date">` — that one renders a Gregorian picker whatever the page
 * language is, so choosing «۷ شهریور» meant hunting for 29 August. Selects need
 * no dependency, work on a phone, and cannot offer a date that does not exist:
 * the day list is the month's real length, asked of the calendar rather than
 * assumed.
 *
 * **The DOM order is the reading order.** The page is RTL, so day first in the
 * markup puts day furthest right — ۷ | شهریور | ۱۴۰۵, the order the date is
 * spoken in Persian. Writing year-first put the year under the reader's thumb
 * and read backwards.
 */
function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: JalaliDate;
  onChange: (d: JalaliDate) => void;
}) {
  const today = toJalali(Date.now());
  const years = [today.year - 3, today.year - 2, today.year - 1, today.year];
  const length = jalaliMonthLength(value.year, value.month);

  /**
   * Clamped, because 31 Farvardin exists and 31 Mehr does not.
   *
   * Without this, picking 31 Farvardin and then switching to Mehr asks for a
   * date the calendar has no answer for, and `jalaliToEpochMs` throws rather
   * than guessing — correctly, but on a screen the operator is looking at.
   */
  const move = (next: Partial<JalaliDate>) => {
    const merged = { ...value, ...next };
    onChange({ ...merged, day: Math.min(merged.day, jalaliMonthLength(merged.year, merged.month)) });
  };

  return (
    <div className="datefield">
      <span className="datefield__label">{label}</span>
      <div className="datefield__row">
        <select
          className="form-control"
          data-part="day"
          aria-label={`روز ${label}`}
          value={value.day}
          onChange={(e) => move({ day: Number(e.target.value) })}
        >
          {Array.from({ length }, (_, i) => i + 1).map((d) => (
            <option key={d} value={d}>
              {d.toLocaleString('fa-IR')}
            </option>
          ))}
        </select>
        <select
          className="form-control"
          data-part="month"
          aria-label={`ماه ${label}`}
          value={value.month}
          onChange={(e) => move({ month: Number(e.target.value) })}
        >
          {JALALI_MONTHS.map((name, i) => (
            <option key={name} value={i + 1}>
              {name}
            </option>
          ))}
        </select>
        <select
          className="form-control"
          data-part="year"
          aria-label={`سال ${label}`}
          value={value.year}
          onChange={(e) => move({ year: Number(e.target.value) })}
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y.toLocaleString('fa-IR', { useGrouping: false })}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function Section({
  title,
  sub,
  children,
}: {
  title: string;
  sub: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card__head">
        <div>
          <div className="card__title">{title}</div>
          <div className="page-head__sub">{sub}</div>
        </div>
      </div>
      <div className="card__body">{children}</div>
    </div>
  );
}

function Stat({
  tone,
  icon,
  value,
  label,
  foot,
}: {
  tone: string;
  icon: string;
  value: string;
  label: string;
  foot?: string | undefined;
}) {
  return (
    <div className={`stat-card ${tone}`}>
      <div>
        <div className="stat-card__value">{value}</div>
        <div className="stat-card__label">{label}</div>
        {foot && (
          <div className="stat-card__label" style={{ fontSize: 11, opacity: 0.75 }}>
            {foot}
          </div>
        )}
      </div>
      <span className="stat-card__icon">
        <Icon name={icon} size={24} />
      </span>
    </div>
  );
}
