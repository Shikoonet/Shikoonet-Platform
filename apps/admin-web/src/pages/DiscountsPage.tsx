/**
 * کدهای تخفیف — the codes, what is left of them, and who spent them.
 *
 * The state badge comes from the server. It is derived there from the same
 * three conditions the bot applies when a customer types the code, so this
 * screen renders a decision rather than making a second one that could disagree
 * with the answer the customer gets.
 *
 * There is no delete button. `discount_redemptions.code_id` cascades, so
 * deleting a code erases the record of everyone who used it — including the
 * rows that stop a customer using it twice. «باطل کردن» sets the expiry to now,
 * which is what the bot already treats as spent.
 *
 * Amounts are typed and shown in Toman; the API speaks integer Rial.
 */

import { useEffect, useState } from 'react';
import { api, ApiError, type DiscountItem, type RedemptionRow } from '../api.js';
import { count, dateTime, endOfTehranDay, toman } from '../format.js';

const PAGE_SIZE = 25;

const KIND_FA: Record<string, string> = {
  GIFT_BALANCE: 'شارژ کیف پول',
  PERCENT_OFF: 'درصدی',
  AMOUNT_OFF: 'مبلغ ثابت',
};

const STATE_FA: Record<string, string> = {
  USABLE: 'قابل استفاده',
  EXPIRED: 'منقضی',
  USED_UP: 'تمام شده',
};

const STATE_BADGE: Record<string, string> = {
  USABLE: 'badge badge-active',
  EXPIRED: 'badge badge-block',
  USED_UP: 'badge badge-info',
};

const APPLIES_FA: Record<string, string> = { ALL: 'همه', BUY: 'خرید', RENEW: 'تمدید' };

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'برای این کار دسترسی ادمین لازم است.';
    if (e.code === 'code_exists') {
      return `کدی با همین حروف از قبل هست${e.detail ? `: ${e.detail}` : ''} — ربات کدها را بدون حساسیت به بزرگی حروف می‌خواند.`;
    }
    if (e.code === 'unknown_product') return 'محصول انتخاب‌شده وجود ندارد.';
    if (e.code === 'unknown_panel') return 'پنل انتخاب‌شده وجود ندارد.';
    if (e.code === 'admin_access_not_configured') return 'درِ دسترسی ادمین تنظیم نشده است.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

/** The value a code carries, in the unit that code uses. */
function value(d: DiscountItem): string {
  if (d.kind === 'PERCENT_OFF') return `${count(d.percent ?? 0)}٪`;
  return toman(d.amountIrr);
}

export function DiscountsPage() {
  const [rows, setRows] = useState<DiscountItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  async function load(toPage = page) {
    setLoading(true);
    setErr(null);
    try {
      const d = await api.discounts({
        page: toPage,
        pageSize: PAGE_SIZE,
        ...(q.trim() ? { q: q.trim() } : {}),
        ...(state ? { state } : {}),
      });
      setRows(d.items);
      setTotal(d.total);
    } catch (e) {
      setErr(message(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(page);
  }, [page, state]);

  async function expire(d: DiscountItem) {
    if (!window.confirm(`کد «${d.code}» باطل شود؟ کسانی که استفاده کرده‌اند دست‌نخورده می‌مانند.`)) {
      return;
    }
    try {
      await api.expireDiscount(d.id);
      await load();
    } catch (e) {
      setErr(message(e));
    }
  }

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const open = rows.find((r) => r.id === openId) ?? null;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">کدهای تخفیف</div>
          <div className="page-head__sub">{count(total)} کد</div>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setCreating((v) => !v)}>
          {creating ? 'بستن فرم' : 'کد جدید'}
        </button>
      </div>

      {creating && (
        <CreateForm
          onDone={() => {
            setCreating(false);
            setPage(1);
            void load(1);
          }}
        />
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
            <label className="form-label" htmlFor="disc-q">
              جست‌وجو
            </label>
            <input
              id="disc-q"
              className="form-control ltr"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="بخشی از کد"
            />
          </div>
          <div>
            <label className="form-label" htmlFor="disc-state">
              وضعیت
            </label>
            <select
              id="disc-state"
              className="form-control"
              value={state}
              onChange={(e) => {
                setState(e.target.value);
                setPage(1);
              }}
            >
              <option value="">همه</option>
              <option value="USABLE">قابل استفاده</option>
              <option value="EXPIRED">منقضی</option>
              <option value="USED_UP">تمام شده</option>
            </select>
          </div>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            جست‌وجو
          </button>
        </form>

        {err && <div className="alert alert-error">{err}</div>}
        {state && (
          <p className="muted">
            وضعیت محاسبه‌شده است، نه ستون — این فیلتر روی همین صفحه اعمال می‌شود و شمارِ بالا کل
            کدهای مطابق جست‌وجوست.
          </p>
        )}

        <div className="table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>کد</th>
                <th>نوع</th>
                <th>مقدار</th>
                <th>مصرف</th>
                <th>کاربرد</th>
                <th>محدودیت</th>
                <th>انقضا</th>
                <th>وضعیت</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading && (
                <tr>
                  <td className="empty" colSpan={9}>
                    کدی با این جست‌وجو پیدا نشد.
                  </td>
                </tr>
              )}
              {rows.map((d) => (
                <tr key={d.id}>
                  <td className="ltr">{d.code}</td>
                  <td>{KIND_FA[d.kind] ?? d.kind}</td>
                  <td>{value(d)}</td>
                  <td>
                    {/* NULL maxUses is unlimited, not zero remaining. */}
                    {count(d.used)}
                    {d.maxUses === null ? ' از نامحدود' : ` از ${count(d.maxUses)}`}
                  </td>
                  <td>{APPLIES_FA[d.appliesTo] ?? d.appliesTo}</td>
                  <td>
                    {d.firstPurchaseOnly && <span className="badge badge-info">خرید اول</span>}
                    {d.resellersOnly && <span className="badge badge-info">نماینده</span>}
                    {d.product && <span className="badge">{d.product.name}</span>}
                    {d.provider && <span className="badge">{d.provider.name}</span>}
                    {!d.firstPurchaseOnly && !d.resellersOnly && !d.product && !d.provider && '—'}
                  </td>
                  <td>{d.expiresAt === null ? 'بدون انقضا' : dateTime(d.expiresAt)}</td>
                  <td>
                    <span className={STATE_BADGE[d.state] ?? 'badge'}>
                      {STATE_FA[d.state] ?? d.state}
                    </span>
                  </td>
                  <td>
                    <button type="button" className="btn btn-sm" onClick={() => setOpenId(d.id)}>
                      مصرف‌کننده‌ها
                    </button>{' '}
                    {d.state !== 'EXPIRED' && (
                      <button type="button" className="btn btn-sm" onClick={() => void expire(d)}>
                        باطل کن
                      </button>
                    )}
                  </td>
                </tr>
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

      {open && <Redemptions code={open} onClose={() => setOpenId(null)} />}
    </>
  );
}

function CreateForm({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const [kind, setKind] = useState('PERCENT_OFF');
  const [amountToman, setAmountToman] = useState('');
  const [percent, setPercent] = useState('');
  const [maxUses, setMaxUses] = useState('');
  /**
   * When the code stops working, as a plain date.
   *
   * There was no field here until 2026-08-22, and the route has accepted
   * `expiresAt` the whole time — so every code made from this panel lived for
   * ever while all 33 in the production dump carry an expiry. An admin could
   * not reproduce what they already do.
   *
   * A date and not a datetime: nobody has ever wanted a code to stop at 14:37.
   * It is sent as the end of that day in Tehran, so a code «until 1 Shahrivar»
   * works all of 1 Shahrivar — the alternative reads as a day short.
   */
  const [expiresOn, setExpiresOn] = useState('');
  const [appliesTo, setAppliesTo] = useState('ALL');
  const [firstPurchaseOnly, setFirst] = useState(false);
  const [resellersOnly, setResellers] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isGift = kind === 'GIFT_BALANCE';
  const isPercent = kind === 'PERCENT_OFF';

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const typedAmount = Number(amountToman);
      await api.createDiscount({
        code: code.trim(),
        kind,
        // Toman in the form, Rial on the wire — the one conversion, in one line.
        ...(isPercent ? { percent: Number(percent) } : { amountIrr: Math.round(typedAmount) * 10 }),
        ...(maxUses.trim() ? { maxUses: Number(maxUses) } : {}),
        ...(expiresOn ? { expiresAt: endOfTehranDay(expiresOn) } : {}),
        // A gift credits a wallet and is never applied to a purchase, so the
        // server refuses these on one; the form does not offer them either.
        ...(isGift ? {} : { appliesTo, firstPurchaseOnly, resellersOnly }),
      });
      onDone();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card__head">
        <span className="card__title">کد جدید</span>
      </div>
      {err && <div className="alert alert-error">{err}</div>}

      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="new-code">
            کد
          </label>
          <input
            id="new-code"
            className="form-control ltr"
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="OFF15"
          />
        </div>
        <div>
          <label className="form-label" htmlFor="new-kind">
            نوع
          </label>
          <select
            id="new-kind"
            className="form-control"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="PERCENT_OFF">درصدی</option>
            <option value="AMOUNT_OFF">مبلغ ثابت</option>
            <option value="GIFT_BALANCE">شارژ کیف پول</option>
          </select>
        </div>
        {isPercent ? (
          <div>
            <label className="form-label" htmlFor="new-percent">
              درصد
            </label>
            <input
              id="new-percent"
              className="form-control ltr"
              type="number"
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
            />
          </div>
        ) : (
          <div>
            <label className="form-label" htmlFor="new-amount">
              مبلغ (تومان)
            </label>
            <input
              id="new-amount"
              className="form-control ltr"
              type="number"
              value={amountToman}
              onChange={(e) => setAmountToman(e.target.value)}
            />
          </div>
        )}
        <div>
          <label className="form-label" htmlFor="new-max">
            سقف مصرف
          </label>
          <input
            id="new-max"
            className="form-control ltr"
            type="number"
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
            placeholder="نامحدود"
          />
        </div>
        <div>
          <label className="form-label" htmlFor="new-expires">
            انقضا
          </label>
          <input
            id="new-expires"
            className="form-control ltr"
            type="date"
            value={expiresOn}
            onChange={(e) => setExpiresOn(e.target.value)}
          />
        </div>
        {!isGift && (
          <div>
            <label className="form-label" htmlFor="new-applies">
              کاربرد
            </label>
            <select
              id="new-applies"
              className="form-control"
              value={appliesTo}
              onChange={(e) => setAppliesTo(e.target.value)}
            >
              <option value="ALL">خرید و تمدید</option>
              <option value="BUY">فقط خرید</option>
              <option value="RENEW">فقط تمدید</option>
            </select>
          </div>
        )}
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
          ساخت
        </button>
      </div>

      {!isGift && (
        <div className="filters">
          <label className="form-label">
            <input
              type="checkbox"
              checked={firstPurchaseOnly}
              onChange={(e) => setFirst(e.target.checked)}
            />{' '}
            فقط خرید اول
          </label>
          <label className="form-label">
            <input
              type="checkbox"
              checked={resellersOnly}
              onChange={(e) => setResellers(e.target.checked)}
            />{' '}
            فقط نماینده‌ها
          </label>
        </div>
      )}

      <p className="muted">
        {isGift
          ? 'کد هدیه کیف پول را شارژ می‌کند و روی خرید اعمال نمی‌شود، پس محدود کردنش به محصول یا پنل معنا ندارد.'
          : 'کد بدون حساسیت به بزرگی حروف خوانده می‌شود؛ دو کد که فقط در حروف فرق دارند پذیرفته نمی‌شوند.'}
      </p>
    </div>
  );
}

function Redemptions({ code, onClose }: { code: DiscountItem; onClose: () => void }) {
  const [rows, setRows] = useState<RedemptionRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setRows((await api.redemptions(code.id)).items);
      } catch (e) {
        setErr(message(e));
      }
    })();
  }, [code.id]);

  return (
    <div className="card" style={{ marginBlockStart: 16 }}>
      <div className="card__head">
        <span className="card__title">
          مصرف‌کننده‌های <span className="ltr">{code.code}</span>
        </span>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          بستن
        </button>
      </div>
      {err && <div className="alert alert-error">{err}</div>}
      <div className="table-wrap">
        <table className="app-table">
          <thead>
            <tr>
              <th>کاربر</th>
              <th>مبلغ</th>
              <th>زمان</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="empty" colSpan={3}>
                  هنوز کسی این کد را استفاده نکرده است.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="ltr">{r.username ? `@${r.username}` : r.telegramId}</td>
                <td>{toman(r.amountIrr)}</td>
                <td>{dateTime(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
