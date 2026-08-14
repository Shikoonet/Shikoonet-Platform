/**
 * محصولات — the shelf: every sellable combination, and what it costs.
 *
 * The columns are the ones `panel/product.php` shows, in its order, because an
 * admin reads this screen daily and the words are already in their hands:
 * شناسه · نام محصول · قیمت · حجم · زمان · لوکیشن · گروه کاربری · دسته‌بندی.
 *
 * What is not carried over is the delete button. `orders.plan_id` is
 * `ON DELETE SET NULL`, so deleting a plan quietly detaches every order ever
 * placed on it and the sales history forgets what was sold. «غیرفعال» takes it
 * off the shelf and out of the bot while the orders keep their plan. The row
 * shows how many orders are attached so the choice is informed rather than
 * blind.
 *
 * Prices are typed and shown in Toman; the API speaks integer Rial. The
 * conversion lives in `format.ts` and in the one line here that builds the
 * request.
 */

import { useEffect, useState } from 'react';
import { api, ApiError, type PlanRow, type ProviderOption } from '../api.js';
import { count, irrToToman, toman } from '../format.js';

const PAGE_SIZE = 25;

const STATUS_FA: Record<string, string> = {
  ACTIVE: 'فعال',
  HIDDEN: 'پنهان',
  DISABLED: 'غیرفعال',
};

const STATUS_BADGE: Record<string, string> = {
  ACTIVE: 'badge badge-active',
  HIDDEN: 'badge badge-info',
  DISABLED: 'badge badge-block',
};

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'برای این کار دسترسی ادمین لازم است.';
    if (e.code === 'admin_access_not_configured') return 'درِ دسترسی ادمین تنظیم نشده است.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

/** «نماینده» is a real product flag (`resellers_only`), not a display choice. */
function audience(p: PlanRow): { label: string; cls: string } {
  if (p.product.resellersOnly) return { label: 'نماینده', cls: 'badge badge-info' };
  return { label: 'عادی', cls: 'badge' };
}

export function ProductsPage() {
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [providerId, setProviderId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  async function load(toPage = page) {
    setLoading(true);
    setErr(null);
    try {
      const d = await api.products({
        page: toPage,
        pageSize: PAGE_SIZE,
        ...(q.trim() ? { q: q.trim() } : {}),
        ...(status ? { status } : {}),
        ...(providerId ? { providerId: Number(providerId) } : {}),
      });
      setRows(d.items);
      setTotal(d.total);
      setProviders(d.providers);
    } catch (e) {
      setErr(message(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(page);
    // Not on `q`: the box searches when submitted, not on every keystroke.
  }, [page, status, providerId]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const open = rows.find((r) => r.id === openId) ?? null;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">محصولات</div>
          <div className="page-head__sub">{count(total)} پلن فروش</div>
        </div>
      </div>

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
            <label className="form-label" htmlFor="prod-q">
              جست‌وجو
            </label>
            <input
              id="prod-q"
              className="form-control"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="نام محصول یا پلن"
            />
          </div>
          <div>
            <label className="form-label" htmlFor="prod-panel">
              لوکیشن
            </label>
            <select
              id="prod-panel"
              className="form-control"
              value={providerId}
              onChange={(e) => {
                setProviderId(e.target.value);
                setPage(1);
              }}
            >
              <option value="">همه</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="form-label" htmlFor="prod-status">
              وضعیت
            </label>
            <select
              id="prod-status"
              className="form-control"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">همه</option>
              <option value="ACTIVE">فعال</option>
              <option value="HIDDEN">پنهان</option>
              <option value="DISABLED">غیرفعال</option>
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
                <th>شناسه</th>
                <th>نام محصول</th>
                <th>قیمت</th>
                <th>حجم</th>
                <th>زمان</th>
                <th>لوکیشن</th>
                <th>گروه کاربری</th>
                <th>دسته‌بندی</th>
                <th>وضعیت</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading && (
                <tr>
                  <td className="empty" colSpan={10}>
                    محصولی با این جست‌وجو پیدا نشد.
                  </td>
                </tr>
              )}
              {rows.map((p) => {
                const aud = audience(p);
                return (
                  <tr key={p.id}>
                    <td className="ltr">{p.id}</td>
                    <td>
                      <div>{p.name}</div>
                      {p.product.name !== p.name && (
                        <div className="page-head__sub">{p.product.name}</div>
                      )}
                    </td>
                    <td>{toman(p.priceIrr)}</td>
                    {/* NULL volume is unmetered, which is not zero. */}
                    <td>{p.volumeGb === null ? 'نامحدود' : `${count(p.volumeGb)} گیگ`}</td>
                    <td>{p.durationDays === null ? 'بدون انقضا' : `${count(p.durationDays)} روز`}</td>
                    <td>{p.provider?.name ?? '—'}</td>
                    <td>
                      <span className={aud.cls}>{aud.label}</span>
                    </td>
                    <td>{p.categoryName ?? '—'}</td>
                    <td>
                      <span className={STATUS_BADGE[p.status] ?? 'badge'}>
                        {STATUS_FA[p.status] ?? p.status}
                      </span>
                      {p.product.status !== 'ACTIVE' && (
                        <span className="badge badge-block">محصول {STATUS_FA[p.product.status]}</span>
                      )}
                    </td>
                    <td>
                      <button type="button" className="btn btn-sm" onClick={() => setOpenId(p.id)}>
                        ویرایش
                      </button>
                    </td>
                  </tr>
                );
              })}
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

      {open && <PlanDrawer plan={open} onClose={() => setOpenId(null)} onChanged={() => void load()} />}
    </>
  );
}

function PlanDrawer({
  plan,
  onClose,
  onChanged,
}: {
  plan: PlanRow;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState(plan.name);
  const [priceToman, setPriceToman] = useState(String(irrToToman(plan.priceIrr)));
  const [days, setDays] = useState(plan.durationDays === null ? '' : String(plan.durationDays));
  const [volume, setVolume] = useState(plan.volumeGb === null ? '' : String(plan.volumeGb));
  const [status, setStatus] = useState(plan.status);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const typedPrice = Number(priceToman);
  const priceIrr =
    priceToman.trim() !== '' && Number.isFinite(typedPrice) ? Math.round(typedPrice) * 10 : null;

  async function save() {
    if (priceIrr === null || priceIrr < 0) {
      setErr('قیمت را به تومان و بدون علامت وارد کنید.');
      return;
    }
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      // Only what actually changed is sent, so an untouched field cannot
      // overwrite a value somebody else edited in the meantime.
      const patch: Parameters<typeof api.updatePlan>[1] = {};
      if (name.trim() !== plan.name) patch.name = name.trim();
      if (priceIrr !== plan.priceIrr) patch.priceIrr = priceIrr;
      const nextDays = days.trim() === '' ? null : Number(days);
      if (nextDays !== plan.durationDays) patch.durationDays = nextDays;
      const nextVolume = volume.trim() === '' ? null : Number(volume);
      if (nextVolume !== plan.volumeGb) patch.volumeGb = nextVolume;
      if (status !== plan.status) patch.status = status as 'ACTIVE' | 'HIDDEN' | 'DISABLED';

      if (Object.keys(patch).length === 0) {
        setDone('چیزی تغییر نکرده بود.');
        return;
      }
      await api.updatePlan(plan.id, patch);
      setDone('ذخیره شد.');
      onChanged();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function setProductStatus(next: 'ACTIVE' | 'HIDDEN' | 'DISABLED') {
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      await api.setProductStatus(plan.product.id, next);
      setDone(`محصول «${plan.product.name}» ${STATUS_FA[next]} شد.`);
      onChanged();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBlockStart: 16 }}>
      <div className="card__head">
        <span className="card__title">
          {plan.name}{' '}
          {/* A plan named after its product is the common case in this
              catalogue; printing both would just say it twice. */}
          {plan.product.name !== plan.name && (
            <span className="muted">{plan.product.name} · </span>
          )}
          <span className="muted">{plan.provider?.name ?? 'بدون پنل'}</span>
        </span>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          بستن
        </button>
      </div>

      {err && <div className="alert alert-error">{err}</div>}
      {done && <div className="alert alert-info">{done}</div>}

      <h4>مشخصات پلن</h4>
      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="plan-name">
            نام پلن
          </label>
          <input
            id="plan-name"
            className="form-control"
            type="text"
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="plan-price">
            قیمت (تومان)
          </label>
          <input
            id="plan-price"
            className="form-control ltr"
            type="number"
            value={priceToman}
            onChange={(e) => setPriceToman(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="plan-volume">
            حجم (گیگ)
          </label>
          <input
            id="plan-volume"
            className="form-control ltr"
            type="number"
            value={volume}
            onChange={(e) => setVolume(e.target.value)}
            placeholder="نامحدود"
          />
        </div>
        <div>
          <label className="form-label" htmlFor="plan-days">
            زمان (روز)
          </label>
          <input
            id="plan-days"
            className="form-control ltr"
            type="number"
            value={days}
            onChange={(e) => setDays(e.target.value)}
            placeholder="بدون انقضا"
          />
        </div>
        <div>
          <label className="form-label" htmlFor="plan-status">
            وضعیت
          </label>
          <select
            id="plan-status"
            className="form-control"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="ACTIVE">فعال</option>
            <option value="HIDDEN">پنهان</option>
            <option value="DISABLED">غیرفعال</option>
          </select>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy}>
          ذخیره
        </button>
      </div>
      <p className="muted">
        خالی گذاشتن حجم یعنی نامحدود و خالی گذاشتن زمان یعنی بدون انقضا — هیچ‌کدام با صفر یکی
        نیستند. تغییر قیمت با ایمیل شما در دفتر ثبت می‌شود.
      </p>

      <h4>محصول «{plan.product.name}»</h4>
      <p className="muted" style={{ marginBlockStart: 0 }}>
        {count(plan.ordersCount)} سفارش روی این پلن ثبت شده است. حذف در کار نیست — تاریخچهٔ فروش به
        همین ردیف وصل است. «غیرفعال» محصول را از ربات برمی‌دارد و سفارش‌های گذشته سر جایشان
        می‌مانند.
      </p>
      <div className="filters">
        {(['ACTIVE', 'HIDDEN', 'DISABLED'] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={s === plan.product.status ? 'btn btn-primary' : 'btn'}
            disabled={busy || s === plan.product.status}
            onClick={() => void setProductStatus(s)}
          >
            {STATUS_FA[s]}
          </button>
        ))}
      </div>
    </div>
  );
}
