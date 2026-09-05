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

import { useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type BulkStockResult,
  type CategoryRow,
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
  return planLabel(s.productName, s.planName);
}

/**
 * The same rule for the pickers, which list plans rather than shelves.
 *
 * A shelf built from «قفسهٔ تازه» names its service and its product the same
 * thing, so the picker read «اسپاتیفای — اسپاتیفای». Collapsed, one shelf is
 * one line; a service with several plans still shows which plan it is.
 */
function planLabel(productName: string, planName: string): string {
  return productName === planName ? planName : `${productName} — ${planName}`;
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
  const [making, setMaking] = useState(false);
  const [categories, setCategories] = useState<CategoryRow[]>([]);

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
    // A shelf has to be filed under a category or it has no button anywhere in
    // the shop, so the «قفسهٔ تازه» form needs the list before it can ask.
    void api
      .productCategories()
      .then((r) => setCategories(r.items))
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
  /*
   * Two different things, and they were one red box until the shelf list began
   * showing shelves that had never been filled.
   *
   * A shelf that HAS sold and is now empty is the alarm this screen was built
   * for: customers are buying that product and the next one gets nothing. A
   * shelf with nothing on either side is simply not stocked yet — the normal
   * state of a service somebody created an hour ago, and on a fresh database
   * that is every one of them. Red on all of them is a screen that cries wolf,
   * and `sections.spec.ts` caught it doing exactly that: it walks every section
   * and treats a visible `.alert-error` as a broken screen.
   */
  const ranDry = shelves.filter((s) => s.available === 0 && s.used > 0);
  const neverFilled = shelves.filter((s) => s.available === 0 && s.used === 0);

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
          <button type="button" className="btn btn-primary" onClick={() => setMaking(true)} {...w}>
            قفسهٔ تازه
          </button>{' '}
          <button type="button" className="btn" onClick={() => setBulk(true)} {...w}>
            افزودن گروهی
          </button>{' '}
          <button type="button" className="btn" onClick={() => setAdding(true)} {...w}>
            افزودن کانفیگ
          </button>
        </div>
      </div>

      {ranDry.length > 0 && (
        <div className="alert alert-error">
          این قفسه‌ها فروخته‌اند و ته کشیده‌اند: {ranDry.map(shelfLabel).join('، ')} — مشتری بعدی
          پول می‌دهد و چیزی نمی‌گیرد تا کسی دستی آماده‌اش کند.
        </div>
      )}

      {neverFilled.length > 0 && (
        <div className="alert alert-warning">
          این قفسه‌ها هنوز پر نشده‌اند: {neverFilled.map(shelfLabel).join('، ')}.
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
                  {planLabel(p.product.name, p.name)}
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

      {making && (
        <NewShelfForm
          categories={categories}
          onClose={() => setMaking(false)}
          onMade={(name) => {
            setMaking(false);
            setDone(`قفسهٔ «${name}» ساخته شد — حالا اکانت‌هایش را بگذار.`);
            void load();
            void api.products({ page: 1, pageSize: 100 }).then((r) => setPlans(r.items));
            setBulk(true);
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
                {planLabel(p.product.name, p.name)}
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
 * «قفسهٔ تازه» — a name and a price, and the shelf exists.
 *
 * A shelf is a plan on a service on a panel, and reaching one through those
 * three screens means answering questions about panels and services to make a
 * box of Spotify accounts. Asked here as the two things a shelf actually is;
 * the server builds the rest in one transaction.
 */
function NewShelfForm({
  categories,
  onClose,
  onMade,
}: {
  categories: CategoryRow[];
  onClose: () => void;
  onMade: (name: string) => void;
}) {
  const w = useAdminWriteProps();
  const [name, setName] = useState('');
  const [kind, setKind] = useState('other');
  const [priceToman, setPriceToman] = useState('');
  const [durationDays, setDurationDays] = useState('30');
  const [categoryId, setCategoryId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function make() {
    setBusy(true);
    setErr(null);
    try {
      await api.createShelf({
        name: name.trim(),
        kind,
        // Toman on the screen, IRR in the database, and the ×10 happens here
        // the same way every other price form in this panel does it.
        priceIrr: Math.round(Number(priceToman) * 10),
        durationDays: durationDays.trim() === '' ? null : Number(durationDays),
        categoryId: Number(categoryId),
      });
      onMade(name.trim());
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBlockStart: 16 }}>
      <div className="card__head">
        <span className="card__title">قفسهٔ تازه</span>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          بستن
        </button>
      </div>

      {err && <div className="alert alert-error">{err}</div>}

      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="shelf-name">
            اسم قفسه — همان که مشتری می‌بیند
          </label>
          <input
            id="shelf-name"
            className="form-control"
            type="text"
            maxLength={120}
            placeholder="اسپاتیفای، اوپن‌وی‌پی‌ان، چت‌جی‌پی‌تی…"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="shelf-kind">
            چه چیزی می‌فروشد
          </label>
          <select
            id="shelf-kind"
            className="form-control"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="other">سایر</option>
            <option value="ai_account">اکانت هوش مصنوعی</option>
            <option value="spotify">اسپاتیفای</option>
            <option value="vpn">وی‌پی‌ان</option>
            <option value="manual">دستی</option>
          </select>
        </div>
      </div>

      <div className="filters">
        <div>
          <label className="form-label" htmlFor="shelf-price">
            قیمت (تومان)
          </label>
          <input
            id="shelf-price"
            className="form-control"
            type="number"
            min={0}
            value={priceToman}
            onChange={(e) => setPriceToman(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="shelf-days">
            مدت (روز)
          </label>
          <input
            id="shelf-days"
            className="form-control"
            type="number"
            min={1}
            placeholder="بی‌انقضا"
            value={durationDays}
            onChange={(e) => setDurationDays(e.target.value)}
          />
        </div>
        <div className="grow">
          <label className="form-label" htmlFor="shelf-cat">
            دسته‌بندی
          </label>
          <select
            id="shelf-cat"
            className="form-control"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">انتخاب کنید…</option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="muted">
        پنلِ این قفسه خودش ساخته می‌شود و تحویلش دستی است — یعنی هرچه در قفسه بگذاری همان به مشتری
        می‌رسد. هر قفسه پنل خودش را دارد، پس یک ایمیل می‌تواند هم‌زمان در قفسهٔ اسپاتیفای و
        چت‌جی‌پی‌تی باشد.
      </p>

      <div className="filters" style={{ marginBlockStart: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || name.trim() === '' || priceToman.trim() === '' || categoryId === ''}
          onClick={() => void make()}
          {...w}
        >
          ساختن قفسه
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
  /**
   * Which input the pending file read belongs to.
   *
   * `File.text()` resolves whenever it resolves. Pick a big file, then pick a
   * small one — or start typing in the box — and the first read can land after
   * the second, quietly replacing what the operator is looking at. They press
   * «افزودن به قفسه» on the text they can see, and a different set of accounts
   * goes onto the shelf. Every input that supersedes a read bumps this, and a
   * read that comes back stale is dropped.
   */
  const readGeneration = useRef(0);

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
                {planLabel(p.product.name, p.name)}
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
              // Measured after decoding, not from `f.size`. The route caps the
              // body at 200k CHARACTERS and a byte count is a different number
              // in UTF-8 — a Persian note or an email with non-ASCII in it is
              // two or three bytes a character, so a byte check refuses files
              // the server would have taken.
              if (f) {
                const mine = ++readGeneration.current;
                setErr(null);
                void f
                  .text()
                  .then((next) => {
                    if (mine !== readGeneration.current) return;
                    if (next.length > 200_000) {
                      setErr('فایل بلندتر از ۲۰۰٬۰۰۰ نویسه است — تکه‌تکه‌اش کن.');
                      return;
                    }
                    setText(next);
                  })
                  .catch(() => {
                    if (mine === readGeneration.current) setErr('فایل خوانده نشد.');
                  });
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
        onChange={(e) => {
          // Typing wins over a file still being read — see `readGeneration`.
          readGeneration.current += 1;
          setText(e.target.value);
        }}
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
