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
import { formatJalali, jalaliToIsoDate, toJalali, type JalaliDate } from '@shikoo/contracts';
import { DateField } from '../DateField.js';
import {
  api,
  type CustomerListItem,
  type RevenueTotals,
  type ShopStatsResponse,
  type StatsRange,
} from '../api.js';
import { Icon } from '../icons.js';
import { count, toman, tomanCompact } from '../format.js';

/** How many wallets «بیشترین موجودی» lists. A glance, not a report. */
const TOP_WALLETS = 10;

/** The seven buttons, in the order the legacy screen lists them. */
const RANGES: Array<{ id: StatsRange; label: string }> = [
  { id: 'all', label: 'آمار کل' },
  { id: '1h', label: 'یک ساعت اخیر' },
  { id: 'today', label: 'امروز' },
  { id: 'yesterday', label: 'دیروز' },
  { id: 'month', label: 'ماه جاری' },
  { id: 'prev_month', label: 'ماه گذشته' },
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
  /**
   * The books and the wallets, from the two routes that already own them.
   *
   * They are separate requests rather than more fields on `/stats` because the
   * boundary in `access.ts` is a path: `/revenue-adjustments` and `/customers`
   * are both closed to a READ_ONLY operator, and the aggregate `/stats` is
   * open to anyone signed in. Folding what the shop spends and who holds the
   * most credit into the open route would hand a reader exactly the two things
   * that list was written to keep from them.
   *
   * `null` therefore means «not shown to you», and the section says so rather
   * than rendering an error — a reader has not done anything wrong.
   */
  const [ledger, setLedger] = useState<{ window: RevenueTotals | null; life: RevenueTotals } | null>(
    null,
  );
  const [topWallets, setTopWallets] = useState<CustomerListItem[] | null>(null);

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

    api
      .revenueAdjustments({
        page: 1,
        // One row, because only the totals are wanted here. `pageSize: 0` is
        // refused by the route's own schema, and asking for fifty rows to throw
        // them away is fifty rows of somebody's spending over the wire.
        pageSize: 1,
        range,
        ...(range === 'between'
          ? { rangeDay: jalaliToIsoDate(jFrom), rangeTo: jalaliToIsoDate(jTo) }
          : { rangeDay: day }),
      })
      .then((r) => alive && setLedger({ window: r.rangeTotals, life: r.lifetime }))
      .catch(() => alive && setLedger(null));

    // Not ranged: a wallet balance is what is in it now, and «بیشترین موجودی
    // در مهر» is not a question the ledger can answer — an entry is dated but
    // a balance is not.
    api
      .customers({ page: 1, pageSize: TOP_WALLETS, sort: 'balance' })
      .then((r) => alive && setTopWallets(r.items))
      .catch(() => alive && setTopWallets(null));

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
          {/*
            First on the page, because it is the first question anybody opens
            this screen to ask. Everything below it is a part of one of these
            three figures, which is why they are stated before they are broken
            up: «درآمد چیه؟ هزینه‌ها چیه؟ مانده چقدره؟» — Sam, 2026-08-30.
          */}
          <Section
            title="دفتر فروشگاه"
            sub={
              ledger === null
                ? 'برای دیدن این بخش دسترسی بالاتری لازم است'
                : ledger.window === null
                  ? 'از ابتدا تا همین لحظه'
                  : `${fa(data.startMs!)} تا ${fa(data.endMs! - 1)}`
            }
          >
            {ledger === null ? (
              <p className="muted">
                هزینه‌ها بخشی از دفتر فروشگاه‌اند و برای نقش «فقط خواندن» نمایش داده نمی‌شوند.
              </p>
            ) : (
              (() => {
                // The lifetime figures when the range is «آمار کل», which has no
                // bounds to filter on. Both come from the same route in the same
                // response, so the two can never be a window and a lifetime
                // subtracted from one another.
                const books = ledger.window ?? ledger.life;
                // Every figure below is stored signed, so the net is a sum and
                // not a subtraction. `earnedIrr` is the orders; the three from
                // the ledger are what an admin did to that figure by hand.
                const net = data.earnedIrr + books.netIrr;
                return (
                  <div className="stats-grid">
                    <Stat
                      tone="tone-green"
                      icon="money"
                      value={tomanCompact(data.earnedIrr)}
                      label="درآمد"
                      foot="فروش + تمدید + افزودنی، فقط سفارش‌های تکمیل‌شده"
                    />
                    <Stat
                      tone="tone-orange"
                      icon="receipt"
                      value={tomanCompact(books.expensesIrr)}
                      label="هزینه‌ها"
                      foot="تبلیغات، سرور، تسویه — از دفتر «هزینه‌ها»"
                    />
                    {/* This card said «برگشتی و اعتبار» until 2026-08-30 and
                        showed every positive row, which on the production data
                        was the shop's hand-recorded reseller income — labelled
                        as returns. The two are now separate cards because they
                        are opposite things. */}
                    <Stat
                      tone="tone-orange"
                      icon="receipt"
                      value={tomanCompact(books.revenueFixIrr)}
                      label="اصلاح درآمد"
                      foot="فیش فیک، عدم واریزی، تکراری"
                    />
                    <Stat
                      tone="tone-blue"
                      icon="money"
                      value={tomanCompact(books.manualIncomeIrr)}
                      label="درآمد دستی"
                      foot="فروش ریسلری که دستی ثبت شده"
                    />
                    <Stat
                      tone={net < 0 ? 'tone-orange' : 'tone-green'}
                      icon="bars"
                      value={tomanCompact(net)}
                      label="مانده"
                      foot={`${toman(data.earnedIrr)} به‌علاوهٔ دفتر`}
                    />
                  </div>
                );
              })()
            )}
            <p className="muted" style={{ marginBottom: 0, marginTop: 12, lineHeight: 1.9 }}>
              شارژ کیف پول در «درآمد» نیست: پولی که مشتری به کیف پولش می‌ریزد هنوز چیزی
              نخریده، و شمردنش این‌جا یک ریال را دو بار می‌شمارد — یک بار موقع واریز و یک
              بار موقع خرید.
            </p>
          </Section>

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
                tone="tone-blue"
                icon="package"
                value={count(data.addonsCount)}
                label="تعداد افزودنی"
                foot="حجم و زمان اضافه روی سرویس موجود"
              />
              <Stat
                tone="tone-blue"
                icon="money"
                value={tomanCompact(data.addonsIrr)}
                label="جمع افزودنی"
                foot={exact(data.addonsIrr)}
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
              {/* The wallet used to be an eighth card here. It moved to its own
                  section below, where the total sits beside the people it is
                  owed to — one figure in one place, still under a heading that
                  says the period does not change it. */}
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

          {/*
            «چقدر پول داخل کیف پول مردم هست؟ کی بیشترین مقدار رو داره؟» — the
            total was already on this page, buried among six other «هم‌اکنون»
            cards with nothing to say who it belongs to. A liability of 25
            million Toman spread over 484 people and a single reseller 5.9
            million under are different situations, and only the list tells
            them apart.
          */}
          <Section
            title="کیف پول مشتریان"
            sub="بدهی فروشگاه به مشتری‌ها — موجودی هم‌اکنون، نه در بازهٔ انتخابی"
          >
            <div className="stats-grid" style={{ marginBottom: 16 }}>
              <Stat
                tone="tone-orange"
                icon="wallet"
                value={tomanCompact(data.walletHeldIrr)}
                label="جمع اعتبار مشتریان"
                foot={exact(data.walletHeldIrr)}
              />
              <Stat
                tone={data.walletDebtors > 0 ? 'tone-orange' : 'tone-green'}
                icon="wallet"
                value={tomanCompact(data.walletOwedToShopIrr)}
                label="بدهی مشتریان به فروشگاه"
                foot={
                  data.walletDebtors > 0
                    ? // The exact figure, not just the count. This line said
                      // «۱۱٬۰۰۰٬۰۰۰ ریال» once, on a panel where nothing else
                      // is Rial — a tenfold misread hiding in a footnote.
                      `${toman(data.walletOwedToShopIrr)} در ${count(data.walletDebtors)} کیف پول`
                    : 'هیچ کیف پولی زیر صفر نیست'
                }
              />
            </div>

            {topWallets === null ? (
              <p className="muted">
                نام مشتری‌ها برای نقش «فقط خواندن» نمایش داده نمی‌شود؛ جمع بالا در دسترس است.
              </p>
            ) : topWallets.length === 0 ? (
              <p className="muted">هنوز هیچ کیف پولی موجودی ندارد.</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>مشتری</th>
                      <th>شناسهٔ تلگرام</th>
                      <th>موجودی</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topWallets.map((w) => (
                      <tr key={w.id}>
                        {/* A customer with no Telegram username is the common
                            case here — 2,924 rows store the literal
                            'NOT_USERNAME' and the import drops it — so the id
                            beside it is the identifier that always exists. */}
                        <td>{w.username ? `@${w.username}` : '—'}</td>
                        <td>{String(w.telegramId)}</td>
                        <td>{toman(w.balanceIrr)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
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
