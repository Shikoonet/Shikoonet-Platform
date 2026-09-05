/**
 * قفسهٔ انبار — the pre-made configs that keep the shop selling when a panel is
 * down.
 *
 * The shelf has existed since migration 0010 and the bot has sold from it since;
 * `docs/STATUS.md` said "no interface for filling it" the whole time, and
 * filling it meant an `INSERT` by hand. This is that interface, and the numbers
 * at the top are the reason it exists: a shelf nobody can see the depth of is a
 * shelf that runs out during an outage, which is the one moment it was for.
 *
 * The panel is not a field on this form. A config belongs to a plan, and the
 * plan's product already names the panel it lives on — letting an admin pick
 * both is letting them file an account on a server the customer did not buy.
 */

import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type BulkStockResult,
  type PlanRow,
  type ShelfCount,
  type StockRow,
} from '../api.js';
import { count } from '../format.js';
import { useAdminWriteProps } from '../role.js';

const STATUS_FA: Record<string, string> = {
  AVAILABLE: 'روی قفسه',
  USED: 'فروخته شده',
  RETIRED: 'بازنشسته',
};

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'برای این کار دسترسی ادمین لازم است.';
    if (e.code === 'admin_access_not_configured') return 'درِ دسترسی ادمین تنظیم نشده است.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

const PAGE_SIZE = 50;

/**
 * What to call a shelf in one line.
 *
 * The service names it — «چت‌جی‌پی‌تی پلاس» — and the plan only separates two
 * shelves of the same service. Named by plan alone, three shelves on three
 * different services all read «یک‌ماهه», which tells an operator nothing about
 * which one to go and fill.
 */
function shelfLabel(s: ShelfCount): string {
  return s.productName === s.planName ? s.planName : `${s.productName} — ${s.planName}`;
}

export function StockPage() {
  const w = useAdminWriteProps();
  const [rows, setRows] = useState<StockRow[]>([]);
  const [shelves, setShelves] = useState<ShelfCount[]>([]);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [status, setStatus] = useState('');
  const [planId, setPlanId] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /**
   * Which shelf rows have had their link revealed, by id.
   *
   * The API has served `subscriptionUrl` to an ADMIN for AVAILABLE rows since
   * this screen was written — `stockRoutes.ts` decides it and `stock.test.ts`
   * asserts an admin gets it and a reviewer does not. Nothing ever rendered it,
   * so the credential arrived in the browser on every page load and was used by
   * nobody, and an admin who wanted to check a config before selling it had to
   * open the database.
   *
   * Behind a press rather than on the page, because the row is a working
   * account: a screen an operator leaves open should not have every unsold
   * config sitting on it in plain text, and a shoulder or a screen-share is the
   * ordinary way that goes wrong. Per-row and not a global toggle for the same
   * reason.
   */
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set());
  const [adding, setAdding] = useState(false);
  const [bulk, setBulk] = useState(false);

  async function load() {
    setErr(null);
    try {
      const res = await api.stock({
        page,
        pageSize: PAGE_SIZE,
        ...(planId === '' ? {} : { planId: Number(planId) }),
        ...(status === '' ? {} : { status }),
      });
      setRows(res.items);
      setShelves(res.shelves);
      setTotal(res.total);
    } catch (e) {
      setErr(message(e));
    }
  }

  useEffect(() => {
    void load();
  }, [page, planId, status]);

  useEffect(() => {
    // The picker needs every sellable plan, not the page of stock rows. 100 is
    // the products route's own ceiling — asking for more is a 400, which is how
    // this was found: the picker came back empty and the page looked fine.
    void api
      .products({ page: 1, pageSize: 100 })
      .then((r) => setPlans(r.items))
      .catch((e) => setErr(message(e)));
  }, []);

  async function act(what: 'retire' | 'delete', row: StockRow) {
    const ask =
      what === 'retire'
        ? `«${row.remoteUsername}» بازنشسته شود؟ دیگر به هیچ سفارشی داده نمی‌شود.`
        : `«${row.remoteUsername}» برای همیشه حذف شود؟`;
    if (!window.confirm(ask)) return;
    setErr(null);
    setDone(null);
    try {
      if (what === 'retire') await api.retireStock(row.id);
      else await api.deleteStock(row.id);
      setDone(what === 'retire' ? 'بازنشسته شد.' : 'حذف شد.');
      await load();
    } catch (e) {
      setErr(message(e));
    }
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const empty = shelves.filter((s) => s.available === 0);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">قفسهٔ انبار</div>
          <div className="page-head__sub">
            {count(shelves.reduce((n, s) => n + s.available, 0))} اکانت آماده روی{' '}
            {count(shelves.length)} قفسه
          </div>
        </div>
        <div>
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)} {...w}>
            افزودن کانفیگ
          </button>{' '}
          <button type="button" className="btn" onClick={() => setBulk(true)} {...w}>
            افزودن گروهی
          </button>
        </div>
      </div>

      {empty.length > 0 && (
        <div className="alert alert-error">
          این قفسه‌ها خالی‌اند: {empty.map(shelfLabel).join('، ')} — محصولی که از قفسه تحویل
          می‌شود و قفسه‌اش خالی است، فروخته می‌شود و به دست مشتری نمی‌رسد تا کسی دستی آماده‌اش
          کند.
        </div>
      )}

      <div className="card">
        {err && <div className="alert alert-error">{err}</div>}
        {done && <div className="alert alert-info">{done}</div>}

        <div className="table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>قفسه</th>
                <th>آماده</th>
                <th>فروخته‌شده</th>
              </tr>
            </thead>
            <tbody>
              {shelves.length === 0 && (
                <tr>
                  <td className="empty" colSpan={3}>
                    هنوز هیچ قفسه‌ای نیست — یک سرویس روی پنلی بساز که تحویلش دستی یا از قفسه است.
                  </td>
                </tr>
              )}
              {shelves.map((s) => (
                <tr key={s.planId}>
                  <td>
                    {/* The service first: it is what names the shelf. The plan
                        underneath only tells two shelves of one service apart. */}
                    <div>{s.productName}</div>
                    <div className="page-head__sub">{s.planName}</div>
                  </td>
                  <td>
                    <span
                      className={s.available === 0 ? 'badge badge-block' : 'badge badge-active'}
                    >
                      {count(s.available)}
                    </span>
                  </td>
                  <td>{count(s.used)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBlockStart: 16 }}>
        <div className="filters">
          <div>
            <label className="form-label" htmlFor="stock-plan">
              کانفیگ
            </label>
            <select
              id="stock-plan"
              className="form-control"
              value={planId}
              onChange={(e) => {
                setPage(1);
                setPlanId(e.target.value);
              }}
            >
              <option value="">همه</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.product.name} — {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="form-label" htmlFor="stock-status">
              وضعیت
            </label>
            <select
              id="stock-status"
              className="form-control"
              value={status}
              onChange={(e) => {
                setPage(1);
                setStatus(e.target.value);
              }}
            >
              <option value="">همه</option>
              <option value="AVAILABLE">روی قفسه</option>
              <option value="USED">فروخته شده</option>
              <option value="RETIRED">بازنشسته</option>
            </select>
          </div>
        </div>

        <div className="table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>نام کاربری روی پنل</th>
                <th>کانفیگ</th>
                <th>پنل</th>
                <th>وضعیت</th>
                <th>سفارش</th>
                <th>اعتبارنامه</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td className="empty" colSpan={7}>
                    چیزی با این فیلترها نیست.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="ltr">{r.remoteUsername}</td>
                  <td>{r.planName}</td>
                  <td>{r.providerName}</td>
                  <td>
                    <span
                      className={
                        r.status === 'AVAILABLE' ? 'badge badge-active' : 'badge badge-block'
                      }
                    >
                      {STATUS_FA[r.status] ?? r.status}
                    </span>
                  </td>
                  <td className="ltr">{r.orderPublicId ?? '—'}</td>
                  <td className="ltr">
                    {r.subscriptionUrl === null && r.secret === null ? (
                      // Null for a sold or retired row and for anyone who is
                      // not an ADMIN. Nothing to press, and nothing to explain:
                      // the paragraph under the table says why.
                      '—'
                    ) : revealed.has(r.id) ? (
                      <code className="stock-link">{r.subscriptionUrl ?? r.secret}</code>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setRevealed((was) => new Set(was).add(r.id))}
                      >
                        نمایش
                      </button>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={r.status !== 'AVAILABLE'}
                      onClick={() => void act('retire', r)}
                      {...w}
                    >
                      بازنشسته
                    </button>{' '}
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={r.status === 'USED'}
                      title={r.status === 'USED' ? 'فروخته شده — تاریخچهٔ سفارش است' : ''}
                      onClick={() => void act('delete', r)}
                      {...w}
                    >
                      حذف
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {pages > 1 && (
          <div className="filters">
            <button
              type="button"
              className="btn btn-sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              قبلی
            </button>
            <span className="muted">
              صفحهٔ {count(page)} از {count(pages)}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={page >= pages}
              onClick={() => setPage(page + 1)}
            >
              بعدی
            </button>
          </div>
        )}

        <p className="muted">
          لینک اشتراک و گذرواژه اعتبارنامه‌اند: هرکس داشته باشدشان سرویس را دارد. فقط برای
          ردیف‌های روی قفسه و فقط به ادمین فرستاده می‌شوند، و تا وقتی «نمایش» را نزنی روی صفحه
          نمی‌آیند.
        </p>
      </div>

      {adding && (
        <StockForm
          plans={plans}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            setDone('کانفیگ به قفسه اضافه شد.');
            void load();
          }}
        />
      )}

      {bulk && (
        <BulkStockForm plans={plans} onClose={() => setBulk(false)} onFilled={() => void load()} />
      )}
    </>
  );
}

function StockForm({
  plans,
  onClose,
  onAdded,
}: {
  plans: PlanRow[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const w = useAdminWriteProps();
  const [planId, setPlanId] = useState('');
  const [username, setUsername] = useState('');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const plan = plans.find((p) => String(p.id) === planId) ?? null;

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api.addStock({
        planId: Number(planId),
        remoteUsername: username.trim(),
        subscriptionUrl: url.trim(),
        note: note.trim() === '' ? null : note.trim(),
      });
      onAdded();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBlockStart: 16 }}>
      <div className="card__head">
        <span className="card__title">افزودن کانفیگ به قفسه</span>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          بستن
        </button>
      </div>

      {err && <div className="alert alert-error">{err}</div>}

      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="add-plan">
            کانفیگ
          </label>
          <select
            id="add-plan"
            className="form-control"
            value={planId}
            onChange={(e) => setPlanId(e.target.value)}
          >
            <option value="">انتخاب کنید…</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.product.name} — {p.name}
              </option>
            ))}
          </select>
          {/* Shown, not chosen: the plan's product already names the panel. */}
          <div className="page-head__sub">
            {plan ? `پنل: ${plan.provider?.name ?? '—'}` : 'پنل از روی کانفیگ تعیین می‌شود'}
          </div>
        </div>
        <div className="grow">
          <label className="form-label" htmlFor="add-username">
            نام کاربری روی پنل
          </label>
          <input
            id="add-username"
            className="form-control ltr"
            type="text"
            maxLength={200}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
      </div>

      <label className="form-label" htmlFor="add-url">
        لینک اشتراک
      </label>
      <input
        id="add-url"
        className="form-control ltr"
        type="url"
        maxLength={2000}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />

      <label className="form-label" htmlFor="add-note">
        یادداشت
      </label>
      <input
        id="add-note"
        className="form-control"
        type="text"
        maxLength={500}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      <div className="filters" style={{ marginBlockStart: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || planId === '' || username.trim() === '' || url.trim() === ''}
          onClick={() => void save()}
          {...w}
        >
          افزودن
        </button>
      </div>
    </div>
  );
}

/**
 * A whole shelf-load at once: paste an export, or pick the file and it lands in
 * the same textarea. Parsing and every per-line verdict live server-side; this
 * form only carries the text and shows what came back. The form stays open
 * after a send on purpose — the skipped lines ARE the result, and closing over
 * them is how a half-loaded shelf goes unnoticed.
 */
function BulkStockForm({
  plans,
  onClose,
  onFilled,
}: {
  plans: PlanRow[];
  onClose: () => void;
  onFilled: () => void;
}) {
  const w = useAdminWriteProps();
  const [planId, setPlanId] = useState('');
  const [text, setText] = useState('');
  const [result, setResult] = useState<BulkStockResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const plan = plans.find((p) => String(p.id) === planId) ?? null;

  async function send() {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const res = await api.addStockBulk({ planId: Number(planId), text });
      setResult(res);
      if (res.added > 0) onFilled();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBlockStart: 16 }}>
      <div className="card__head">
        <span className="card__title">افزودن گروهی به قفسه</span>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          بستن
        </button>
      </div>

      {err && <div className="alert alert-error">{err}</div>}
      {result && (
        <div className={result.skipped.length > 0 ? 'alert alert-error' : 'alert alert-info'}>
          {count(result.added)} ردیف به قفسه اضافه شد
          {result.skipped.length > 0 ? ` و ${count(result.skipped.length)} ردیف رد شد:` : '.'}
        </div>
      )}
      {result && result.skipped.length > 0 && (
        <ul className="muted">
          {result.skipped.map((s) => (
            <li key={s.line}>
              سطر {count(s.line)}
              {s.username ? (
                <>
                  {' '}
                  (<span className="ltr">{s.username}</span>)
                </>
              ) : null}
              : {s.reason}
            </li>
          ))}
        </ul>
      )}

      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="bulk-plan">
            کانفیگ
          </label>
          <select
            id="bulk-plan"
            className="form-control"
            value={planId}
            onChange={(e) => setPlanId(e.target.value)}
          >
            <option value="">انتخاب کنید…</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.product.name} — {p.name}
              </option>
            ))}
          </select>
          <div className="page-head__sub">
            {plan ? `پنل: ${plan.provider?.name ?? '—'}` : 'پنل از روی کانفیگ تعیین می‌شود'}
          </div>
        </div>
        <div className="grow">
          <label className="form-label" htmlFor="bulk-file">
            فایل CSV یا متنی
          </label>
          <input
            id="bulk-file"
            className="form-control"
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            onChange={(e) => {
              const f = e.target.files?.[0];
              // Refused here rather than by the server, which would answer a
              // 400 about a body length nobody chose. 200k is the route's cap.
              if (f && f.size > 200_000) {
                setErr('فایل بزرگ‌تر از ۲۰۰ کیلوبایت است — تکه‌تکه‌اش کن.');
              } else if (f) {
                setErr(null);
                void f
                  .text()
                  .then(setText)
                  .catch(() => setErr('فایل خوانده نشد.'));
              }
              // Same file twice must fire onChange again.
              e.target.value = '';
            }}
          />
        </div>
      </div>

      <label className="form-label" htmlFor="bulk-text">
        هر سطر یک اکانت: «نام‌کاربری,گذرواژه» یا «نام‌کاربری,لینک اشتراک»
      </label>
      <textarea
        id="bulk-text"
        className="form-control ltr"
        rows={8}
        placeholder={'user@example.com,secret123\nuser2@example.com,secret456'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      <div className="filters" style={{ marginBlockStart: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || planId === '' || text.trim() === ''}
          onClick={() => void send()}
          {...w}
        >
          افزودن به قفسه
        </button>
      </div>
    </div>
  );
}
