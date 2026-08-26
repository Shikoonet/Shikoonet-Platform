/**
 * محصولات — one row per sellable thing, the way the panel we are replacing
 * lists it.
 *
 * WHY THIS EXISTS NEXT TO «سرویس‌ها» RATHER THAN INSTEAD OF IT. Faoxima's
 * catalogue is one table, because in its schema a second duration is a second
 * `product` row: name, price, volume, days, panel, user group, category, all
 * on one line. That is the right unit for pricing work, and it is what an admin
 * asked for. It is NOT the right unit for building a service, because the panel
 * and the groups an account joins are decided once for a whole family of
 * configs — which is why «سرویس‌ها» stays and this page links into it.
 *
 * So the two levels stay in the database and only the SCREEN is flat. Which
 * makes one thing this page has to say out loud: four of the fields on a row
 * belong to the service, not to the row, and editing them from here edits every
 * sibling config too. The modal says so with the number, before the save.
 *
 * FILTERS ARE THE SERVER'S. Faoxima filters in the browser over rows it has
 * already loaded, and loads the whole table to make that work
 * (`panel/js/datatable.js:121-163`). That is honest on eight rows and a lie on
 * eight hundred: this list is paged, so a browser-side filter would hide
 * matches on page two while the total above still counted them.
 */

import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type CategoryRow,
  type PlanRow,
  type ProviderOption,
  type ServiceRow,
  type CatalogStatus,
} from '../api.js';
import { count, toman } from '../format.js';
import { useAdminWriteProps } from '../role.js';
import { LayoutEditor } from './LayoutEditor.js';

const PAGE_SIZE = 25;

const STATUS_FA: Record<string, string> = {
  ACTIVE: 'در فروشگاه',
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
    if (e.code === 'in_use') return e.detail ?? 'چیزی به این ردیف وصل است.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

/** NULL volume is unmetered and 0 is a free gigabyte allowance — not the same. */
function volume(gb: number | null): string {
  return gb === null ? 'نامحدود' : `${count(gb)} گیگ`;
}

function duration(days: number | null): string {
  return days === null ? 'بی‌انقضا' : `${count(days)} روز`;
}

export function ProductsPage() {
  const w = useAdminWriteProps();
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [providerId, setProviderId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [resellers, setResellers] = useState('');

  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<PlanRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [arranging, setArranging] = useState(false);

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
        ...(categoryId ? { categoryId: Number(categoryId) } : {}),
        ...(resellers ? { resellersOnly: resellers === 'yes' } : {}),
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

  async function loadCategories() {
    try {
      setCategories((await api.productCategories()).items);
    } catch {
      // The filter loses its options and the table still works. A category list
      // that failed to load is not a reason to show nothing.
    }
  }

  useEffect(() => {
    void loadCategories();
  }, []);

  useEffect(() => {
    void load(page);
  }, [page, status, providerId, categoryId, resellers]);

  async function remove(r: PlanRow) {
    if (!window.confirm(`«${r.name}» حذف شود؟`)) return;
    try {
      await api.deletePlan(r.id);
      await load();
    } catch (e) {
      setErr(message(e));
    }
  }

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const chosenCategory = categoryId ? categories.find((c) => c.id === Number(categoryId)) : null;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">محصولات</div>
          <div className="page-head__sub">{count(total)} محصول</div>
        </div>
        <div className="filters" style={{ marginBlock: 0 }}>
          {/* Arranging is per category, because a shop screen IS a category —
              there is no screen that shows the whole catalogue at once. */}
          <button
            type="button"
            className="btn"
            disabled={!chosenCategory}
            title={chosenCategory ? '' : 'اول یک دسته‌بندی را انتخاب کنید'}
            onClick={() => setArranging((v) => !v)}
          >
            {arranging ? 'بستن چیدمان' : 'چیدمان و ترتیب'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setAdding((v) => !v)}
            {...w}
          >
            {adding ? 'بستن فرم' : 'افزودن محصول +'}
          </button>
        </div>
      </div>

      {adding && (
        <AddProduct
          onDone={() => {
            setAdding(false);
            setPage(1);
            void load(1);
          }}
        />
      )}

      {arranging && chosenCategory && (
        <div className="card">
          <h4>چیدمان «{chosenCategory.name}» در ربات</h4>
          <ArrangeCategory category={chosenCategory} onSaved={() => void load()} />
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
            <label className="form-label" htmlFor="prod-q">
              جست‌وجو
            </label>
            <input
              id="prod-q"
              className="form-control"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="نام محصول یا سرویس"
            />
          </div>
          <div>
            <label className="form-label" htmlFor="prod-cat">
              دسته‌بندی
            </label>
            <select
              id="prod-cat"
              className="form-control"
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value);
                setArranging(false);
                setPage(1);
              }}
            >
              <option value="">همه</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
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
            <label className="form-label" htmlFor="prod-group">
              گروه کاربری
            </label>
            <select
              id="prod-group"
              className="form-control"
              value={resellers}
              onChange={(e) => {
                setResellers(e.target.value);
                setPage(1);
              }}
            >
              <option value="">همه</option>
              <option value="no">مشتری عادی</option>
              <option value="yes">فقط نماینده</option>
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
              <option value="ACTIVE">در فروشگاه</option>
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
                    محصولی با این فیلترها پیدا نشد.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="ltr">{r.id}</td>
                  <td>
                    <div>{r.name}</div>
                    <div className="page-head__sub">{r.product.name}</div>
                  </td>
                  <td>{toman(r.priceIrr)}</td>
                  <td>{volume(r.volumeGb)}</td>
                  <td>{duration(r.durationDays)}</td>
                  <td>{r.provider?.name ?? '—'}</td>
                  <td>
                    {r.product.resellersOnly ? (
                      <span className="badge badge-info">فقط نماینده</span>
                    ) : (
                      'مشتری عادی'
                    )}
                  </td>
                  <td>{r.categoryName ?? '—'}</td>
                  <td>
                    <span className={STATUS_BADGE[r.status] ?? 'badge'}>
                      {STATUS_FA[r.status] ?? r.status}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setEditing(r)}
                      {...w}
                    >
                      ویرایش
                    </button>{' '}
                    {/* A config with sales cannot be deleted — the route
                        refuses it inside the DELETE so the sales history
                        cannot be detached. «غیرفعال» is the button that
                        works there, and the modal offers it. */}
                    {r.ordersCount === 0 && (
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => void remove(r)}
                        {...w}
                      >
                        حذف
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="filters">
          <button
            type="button"
            className="btn btn-sm"
            disabled={page <= 1 || loading}
            onClick={() => setPage(page - 1)}
          >
            قبلی
          </button>
          <span className="muted">
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

      {editing && (
        <EditProduct
          row={editing}
          providers={providers}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </>
  );
}

/**
 * The arrangement of one category, fetched as its own list.
 *
 * A save has to name the WHOLE screen — the server refuses a partial one,
 * because the rows it was not told about would keep their old positions and
 * interleave — so this asks for every config in the category rather than
 * arranging whatever happened to be on the current page of the table above.
 */
function ArrangeCategory({ category, onSaved }: { category: CategoryRow; onSaved: () => void }) {
  const [items, setItems] = useState<PlanRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setErr(null);
    try {
      // One page big enough for a whole category. A shop screen longer than
      // this is refused by `MAX_CATALOG_ROWS` long before it gets here.
      const d = await api.products({ categoryId: category.id, page: 1, pageSize: 100 });
      setItems(d.items);
    } catch (e) {
      setErr(message(e));
    }
  }

  useEffect(() => {
    void load();
  }, [category.id]);

  if (err) return <div className="alert alert-error">{err}</div>;
  if (!items) return <p className="muted">در حال خواندن…</p>;

  return (
    <LayoutEditor
      scope={`category:${category.id}`}
      note={
        'همان صفحه‌ای که مشتری بعد از انتخاب این دسته‌بندی می‌بیند. محصولِ پنهان و محصولی که ' +
        'برای آن مشتری خریدنی نیست این‌جا هست ولی به او نشان داده نمی‌شود؛ ردیفش بسته می‌شود و ' +
        'بقیهٔ ردیف‌ها سرِ جایشان می‌مانند. ترتیبِ همین کارت‌ها ترتیب دکمه‌هاست.'
      }
      items={items.map((r) => ({
        id: r.id,
        label: r.name,
        hint: `${toman(r.priceIrr)}${r.status === 'ACTIVE' ? '' : ` · ${STATUS_FA[r.status] ?? r.status}`}`,
        rowIndex: r.rowIndex,
      }))}
      onSaved={() => {
        void load();
        onSaved();
      }}
    />
  );
}

/**
 * A new priced row on a service that already exists.
 *
 * «افزودن محصول» here means what it means in Faoxima — one more sellable
 * combination — not a new service. A service decides the panel and the groups
 * an account joins, and building one is «سرویس‌ها»'s job; duplicating that
 * form here would be a second place for the tier to be chosen.
 */
function AddProduct({ onDone }: { onDone: () => void }) {
  const w = useAdminWriteProps();
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [productId, setProductId] = useState('');
  const [name, setName] = useState('');
  const [priceToman, setPriceToman] = useState('');
  const [volumeGb, setVolumeGb] = useState('');
  const [durationDays, setDurationDays] = useState('30');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const d = await api.catalog({ page: 1, pageSize: 100 });
        setServices(d.items);
      } catch (e) {
        setErr(message(e));
      }
    })();
  }, []);

  async function save() {
    if (productId === '' || name.trim() === '') return;
    setBusy(true);
    setErr(null);
    try {
      await api.createPlan(Number(productId), {
        name: name.trim(),
        // Typed in Toman, stored in Rial. The multiplication lives at this edge
        // and nowhere else.
        priceIrr: Math.round(Number(priceToman) * 10),
        // Empty means NULL — unmetered, and no expiry. Neither is zero.
        volumeGb: volumeGb.trim() === '' ? null : Number(volumeGb),
        durationDays: durationDays.trim() === '' ? null : Number(durationDays),
      });
      onDone();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  const chosen = services.find((s) => s.id === Number(productId));

  return (
    <div className="card">
      <h4>محصول تازه</h4>
      {err && <div className="alert alert-error">{err}</div>}
      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="add-service">
            سرویس
          </label>
          <select
            id="add-service"
            className="form-control"
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
          >
            <option value="">— انتخاب کنید —</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.categoryName ? ` · ${s.categoryName}` : ''}
              </option>
            ))}
          </select>
          {chosen && (
            <p className="muted" style={{ marginBlockEnd: 0 }}>
              لوکیشن و گروه کاربری و دسته‌بندی را همین سرویس تعیین می‌کند:{' '}
              {chosen.panel?.name ?? 'بدون پنل'} ·{' '}
              {chosen.resellersOnly ? 'فقط نماینده' : 'مشتری عادی'} ·{' '}
              {chosen.categoryName ?? 'بدون دسته‌بندی'}
            </p>
          )}
        </div>
      </div>
      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="add-name">
            نام محصول
          </label>
          <input
            id="add-name"
            className="form-control"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            placeholder="مثلاً: ۳۰ روزه - ۵۰ گیگ"
          />
        </div>
        <div>
          <label className="form-label" htmlFor="add-price">
            قیمت (تومان)
          </label>
          <input
            id="add-price"
            className="form-control ltr"
            type="number"
            min={0}
            value={priceToman}
            onChange={(e) => setPriceToman(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="add-vol">
            حجم (گیگ)
          </label>
          <input
            id="add-vol"
            className="form-control ltr"
            type="number"
            min={0}
            value={volumeGb}
            onChange={(e) => setVolumeGb(e.target.value)}
            placeholder="نامحدود"
          />
        </div>
        <div>
          <label className="form-label" htmlFor="add-days">
            زمان (روز)
          </label>
          <input
            id="add-days"
            className="form-control ltr"
            type="number"
            min={1}
            value={durationDays}
            onChange={(e) => setDurationDays(e.target.value)}
            placeholder="بی‌انقضا"
          />
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || productId === '' || name.trim() === ''}
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
 * One row's fields, on both of the levels they really live on.
 *
 * The four fields below the line belong to the SERVICE. Changing one of them
 * from here changes it for every config of that service, and the count in the
 * heading is the whole reason this modal is worth its size: on a flat table an
 * admin has no way of knowing that «لوکیشن» is not a property of the line they
 * are looking at.
 */
function EditProduct({
  row,
  providers,
  categories,
  onClose,
  onSaved,
}: {
  row: PlanRow;
  providers: ProviderOption[];
  categories: CategoryRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const w = useAdminWriteProps();
  const [name, setName] = useState(row.name);
  const [priceToman, setPriceToman] = useState(String(Math.trunc(row.priceIrr / 10)));
  const [volumeGb, setVolumeGb] = useState(row.volumeGb === null ? '' : String(row.volumeGb));
  const [durationDays, setDurationDays] = useState(
    row.durationDays === null ? '' : String(row.durationDays),
  );
  const [status, setStatus] = useState<CatalogStatus>(row.status as CatalogStatus);

  const [providerId, setProviderId] = useState(
    row.provider === null ? '' : String(row.provider.id),
  );
  const [categoryId, setCategoryId] = useState(String(row.product.categoryId ?? ''));
  const [resellersOnly, setResellersOnly] = useState(row.product.resellersOnly);

  const [siblings, setSiblings] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // How many configs share the service-level fields. Read rather than guessed:
  // the sentence below is the only warning an admin gets before an edit that
  // reaches rows they are not looking at.
  useEffect(() => {
    void (async () => {
      try {
        const d = await api.catalog({ page: 1, pageSize: 100 });
        const service = d.items.find((s) => s.id === row.product.id);
        setSiblings(service?.configs.length ?? null);
      } catch {
        setSiblings(null);
      }
    })();
  }, [row.product.id]);

  const serviceChanged =
    providerId !== (row.provider === null ? '' : String(row.provider.id)) ||
    categoryId !== String(row.product.categoryId ?? '') ||
    resellersOnly !== row.product.resellersOnly;

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api.updatePlan(row.id, {
        name: name.trim(),
        priceIrr: Math.round(Number(priceToman) * 10),
        volumeGb: volumeGb.trim() === '' ? null : Number(volumeGb),
        durationDays: durationDays.trim() === '' ? null : Number(durationDays),
        status,
      });
      // Only when one of them actually moved: an unchanged `updateProduct`
      // still writes an audit row saying a service was edited, and an audit
      // trail full of no-op edits is one nobody reads.
      if (serviceChanged) {
        await api.updateProduct(row.product.id, {
          code: row.product.code,
          name: row.product.name,
          kind: row.product.kind,
          providerId: providerId === '' ? null : Number(providerId),
          categoryId: Number(categoryId),
          description: row.product.description,
          resellersOnly,
          oncePerUser: row.product.oncePerUser,
          groupIds: row.product.groupIds,
        });
      }
      onSaved();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-body" onClick={(e) => e.stopPropagation()}>
        <div className="page-head">
          <div>
            <div className="page-head__title">{row.name}</div>
            <div className="page-head__sub">
              {row.product.name}
              {row.ordersCount > 0 && ` · ${count(row.ordersCount)} سفارش`}
            </div>
          </div>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            بستن
          </button>
        </div>

        {err && <div className="alert alert-error">{err}</div>}

        <div className="filters">
          <div className="grow">
            <label className="form-label" htmlFor="ed-name">
              نام محصول
            </label>
            <input
              id="ed-name"
              className="form-control"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="form-label" htmlFor="ed-price">
              قیمت (تومان)
            </label>
            <input
              id="ed-price"
              className="form-control ltr"
              type="number"
              min={0}
              value={priceToman}
              onChange={(e) => setPriceToman(e.target.value)}
            />
          </div>
        </div>
        <div className="filters">
          <div>
            <label className="form-label" htmlFor="ed-vol">
              حجم (گیگ)
            </label>
            <input
              id="ed-vol"
              className="form-control ltr"
              type="number"
              min={0}
              value={volumeGb}
              onChange={(e) => setVolumeGb(e.target.value)}
              placeholder="نامحدود"
            />
          </div>
          <div>
            <label className="form-label" htmlFor="ed-days">
              زمان (روز)
            </label>
            <input
              id="ed-days"
              className="form-control ltr"
              type="number"
              min={1}
              value={durationDays}
              onChange={(e) => setDurationDays(e.target.value)}
              placeholder="بی‌انقضا"
            />
          </div>
          <div>
            <label className="form-label" htmlFor="ed-status">
              وضعیت
            </label>
            <select
              id="ed-status"
              className="form-control"
              value={status}
              onChange={(e) => setStatus(e.target.value as CatalogStatus)}
            >
              <option value="ACTIVE">در فروشگاه</option>
              <option value="HIDDEN">پنهان</option>
              <option value="DISABLED">غیرفعال</option>
            </select>
          </div>
        </div>

        <h4>روی کلِ سرویس «{row.product.name}»</h4>
        <p className="muted" style={{ marginBlockStart: 0 }}>
          {siblings === null
            ? 'این خانه‌ها روی سرویس می‌نشینند، نه روی همین ردیف — پس روی همهٔ کانفیگ‌های این سرویس اثر می‌گذارند.'
            : `این سه خانه روی سرویس می‌نشینند، نه روی همین ردیف — عوض‌کردنشان روی هر ${count(siblings)} کانفیگِ «${row.product.name}» اثر می‌گذارد.`}
        </p>
        <div className="filters">
          <div>
            <label className="form-label" htmlFor="ed-panel">
              لوکیشن
            </label>
            <select
              id="ed-panel"
              className="form-control"
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
            >
              <option value="">بدون پنل</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="form-label" htmlFor="ed-cat">
              دسته‌بندی
            </label>
            <select
              id="ed-cat"
              className="form-control"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="form-label" htmlFor="ed-group">
              گروه کاربری
            </label>
            <select
              id="ed-group"
              className="form-control"
              value={resellersOnly ? 'yes' : 'no'}
              onChange={(e) => setResellersOnly(e.target.value === 'yes')}
            >
              <option value="no">مشتری عادی</option>
              <option value="yes">فقط نماینده</option>
            </select>
          </div>
        </div>
        <p className="muted">
          گروه‌های پنل — آنچه تعیین می‌کند مشتری واقعاً چه کانفیگی می‌گیرد — در «سرویس‌ها» انتخاب
          می‌شوند.
        </p>

        <div className="filters">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || categoryId === ''}
            onClick={() => void save()}
            {...w}
          >
            ذخیره
          </button>
          <button type="button" className="btn" onClick={onClose}>
            انصراف
          </button>
        </div>
      </div>
    </div>
  );
}
