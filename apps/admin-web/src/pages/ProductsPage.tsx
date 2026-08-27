/**
 * محصولات — one row per sellable thing, the way the panel being replaced lists
 * it.
 *
 * WHY THIS EXISTS NEXT TO «سرویس‌ها» RATHER THAN INSTEAD OF IT. Faoxima's
 * catalogue is one table, because in its schema a second duration is a second
 * `product` row: name, price, volume, days, panel, user group, category, all on
 * one line. That is the right unit for pricing work, and it is what an admin
 * asked for. It is NOT the right unit for building a service, because the panel
 * and the groups an account joins are decided once for a whole family of
 * configs — which is why «سرویس‌ها» stays and this page links into it.
 *
 * So the two levels stay in the database and only the SCREEN is flat. Which
 * makes one thing this page has to say out loud: three of the fields on a row
 * belong to the service, not to the row, and editing them from here edits every
 * sibling config too. The edit form says so with the number, before the save.
 *
 * FILTERS ARE THE SERVER'S. Faoxima filters in the browser over rows it has
 * already loaded, and loads the whole table to make that work
 * (`panel/js/datatable.js:121-163`). Honest on eight rows and a lie on eight
 * hundred: this list is paged, so a browser-side filter would hide matches on
 * page two while the total above still counted them.
 *
 * TYPOGRAPHY IS THE HIERARCHY. Nine columns of the same weight is a wall, which
 * is what the first version of this screen was. The name and the price carry
 * weight; volume, days and the id are dim tabular numbers; everything else is a
 * badge or plain text. An admin scanning this is looking for a price.
 */

import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type ButtonStyle,
  type CategoryRow,
  type PlanRow,
  type ProviderOption,
  type ServiceRow,
  type CatalogStatus,
} from '../api.js';
import {
  whyNotSellable,
  notSellableFa,
  notSellableShortFa,
  type NotSellable,
} from '@shikoo/contracts';
import { count, toman } from '../format.js';
import { useAdminWriteProps } from '../role.js';
import { BadgeField, badgeValue } from './BadgeField.js';

const PAGE_SIZE = 25;

/**
 * What the shop can do with this row — the column that used to draw
 * `product_plans.status` and call it «در فروشگاه».
 *
 * A row is «در فروشگاه» only when a customer could really buy it. Everything
 * else names the reason in the operator's own words, because the fix differs
 * completely between «پنل خاموش» (go and switch a panel back on) and «پنهان»
 * (this one row).
 *
 * Both reasons are drawn when there are two: a config that is hidden AND sits on
 * a dead panel needs both, and showing one at a time is how the second is found
 * in production.
 */
function SellState({ row }: { row: PlanRow }) {
  const reasons: NotSellable[] = whyNotSellable({
    planStatus: row.status,
    productStatus: row.product.status,
    panel: row.provider
      ? {
          name: row.provider.name ?? '—',
          status: row.provider.status ?? 'DISABLED',
          capacity: row.provider.capacity,
          liveSubscriptions: row.provider.liveSubscriptions,
        }
      : null,
  });

  if (reasons.length === 0) return <span className="num--dim">در فروشگاه</span>;

  return (
    <div className="tone-orange" title={reasons.map(notSellableFa).join(' ')}>
      <strong>فروخته نمی‌شود</strong>
      <div className="page-head__sub">{reasons.map(notSellableShortFa).join(' · ')}</div>
    </div>
  );
}

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

export function ProductsPage({ onGo }: { onGo: (id: 'categories') => void }) {
  const w = useAdminWriteProps();
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [sellableTotal, setSellableTotal] = useState(0);
  const [page, setPage] = useState(1);

  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  /*
   * Seeded from the address bar, so «مدیریت پنل‌ها» can send an operator here
   * already filtered to one panel. `useRoute`'s `navigate(id, search)` writes
   * the query; this reads it once, on mount, which is when this screen is
   * created by that navigation.
   */
  const [providerId, setProviderId] = useState(
    () => new URLSearchParams(window.location.search).get('providerId') ?? '',
  );
  const [categoryId, setCategoryId] = useState('');
  const [resellers, setResellers] = useState('');
  const [sellable, setSellable] = useState('');

  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<PlanRow | null>(null);
  const [adding, setAdding] = useState(false);

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
        ...(sellable ? { sellable: sellable === 'yes' } : {}),
      });
      setRows(d.items);
      setTotal(d.total);
      setSellableTotal(d.sellableTotal);
      setProviders(d.providers);
    } catch (e) {
      setErr(message(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        setCategories((await api.productCategories()).items);
      } catch {
        // The filter loses its options and the table still works. A category
        // list that failed to load is not a reason to show nothing.
      }
    })();
  }, []);

  useEffect(() => {
    void load(page);
  }, [page, status, providerId, categoryId, resellers, sellable]);

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
  const filtered = Boolean(
    q.trim() || status || providerId || categoryId || resellers || sellable,
  );

  function clear() {
    setQ('');
    setStatus('');
    setProviderId('');
    setCategoryId('');
    setResellers('');
    setSellable('');
    setPage(1);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">محصولات</div>
          <div className="page-head__sub">
            {count(total)} محصول ·{' '}
            {/* The number the shop's owner was actually looking for. «۱۶ محصول»
                said nothing when three of them were on sale, and every badge in
                the table below agreed with the sixteen. */}
            <strong className={sellableTotal === 0 ? 'tone-danger' : ''}>
              {count(sellableTotal)} قابل خرید
            </strong>
            {chosenCategory ? ` · ${chosenCategory.name}` : ''}
          </div>
        </div>
        <div className="row-actions">
          {/* Was disabled until a category filter was chosen, which read as a
              broken button — the first thing the shop's owner said about this
              screen. Arranging now has exactly one home, «دسته‌بندی‌ها», because
              a shop screen IS a category; this is the signpost to it. */}
          <button type="button" className="btn" onClick={() => onGo('categories')}>
            چیدمان در ربات
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setAdding((v) => !v)}
            {...w}
          >
            {adding ? 'بستن' : 'محصول تازه'}
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

      <div className="card">
        <form
          className="toolbar"
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
            <label className="form-label" htmlFor="prod-sellable">
              فروش
            </label>
            {/* The filter that follows the header's «۳ قابل خرید»: an operator
                who reads that number wants the other thirteen, and wants them
                without guessing which of five things is wrong with each. */}
            <select
              id="prod-sellable"
              className="form-control"
              value={sellable}
              onChange={(e) => {
                setSellable(e.target.value);
                setPage(1);
              }}
            >
              <option value="">همه</option>
              <option value="yes">قابل خرید</option>
              <option value="no">فروخته نمی‌شود</option>
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
          {/* Drawn only when there is something to clear. A permanent «پاک کن»
              beside five «همه» dropdowns is a button that does nothing most of
              the time, which is how an admin learns to stop reading a toolbar. */}
          {filtered && (
            <button type="button" className="btn" onClick={clear}>
              پاک‌کردن فیلترها
            </button>
          )}
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
                <th className="cell-actions" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading && (
                <tr>
                  <td className="empty" colSpan={10}>
                    {filtered
                      ? 'محصولی با این فیلترها نیست. فیلترها را پاک کنید یا کلمهٔ دیگری بزنید.'
                      : 'هنوز محصولی ساخته نشده. «محصول تازه» یک قیمت روی یکی از سرویس‌ها می‌گذارد.'}
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="ltr num num--dim">{r.id}</td>
                  <td className="cell-name">
                    {/* In front of the name, because that is where the bot
                        draws it — a badge listed in its own column would be
                        the one place it is not read the way it is sold. */}
                    <div>
                      {r.badge && <span>{r.badge} </span>}
                      {r.name}
                    </div>
                    {/* Only when it says something the line above did not. A
                        migrated row's plan IS its product — the importer wrote
                        the same string into both — so on those rows the first
                        version of this printed the same words twice. */}
                    {r.product.name !== r.name && (
                      <div className="page-head__sub">{r.product.name}</div>
                    )}
                  </td>
                  <td className="num num--strong">{toman(r.priceIrr)}</td>
                  <td className="num num--dim">{volume(r.volumeGb)}</td>
                  <td className="num num--dim">{duration(r.durationDays)}</td>
                  <td title={r.provider?.name ?? ''}>
                    <span className="trunc">{r.provider?.name ?? '—'}</span>
                  </td>
                  <td className="cell-tight">
                    {r.product.resellersOnly ? (
                      <span className="badge badge-info">فقط نماینده</span>
                    ) : (
                      <span className="num--dim">مشتری عادی</span>
                    )}
                  </td>
                  <td title={r.categoryName ?? ''}>
                    <span className="trunc">{r.categoryName ?? '—'}</span>
                  </td>
                  <td className="cell-tight">
                    <SellState row={r} />
                  </td>
                  <td className="cell-actions">
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setEditing(r)}
                        {...w}
                      >
                        ویرایش
                      </button>
                      {/* A config with sales cannot be deleted — the route
                          refuses it inside the DELETE so the sales history
                          cannot be detached. «غیرفعال» in the edit form is the
                          button that works there. */}
                      {r.ordersCount === 0 && (
                        <button
                          type="button"
                          className="btn btn-sm btn-quiet-danger"
                          onClick={() => void remove(r)}
                          {...w}
                        >
                          حذف
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {lastPage > 1 && (
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
        )}
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
 * A new priced row on a service that already exists.
 *
 * «محصول تازه» here means what it means in Faoxima — one more sellable
 * combination — not a new service. A service decides the panel and the groups
 * an account joins, and building one is «سرویس‌ها»'s job; duplicating that form
 * here would be a second place for the tier to be chosen.
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
        setServices((await api.catalog({ page: 1, pageSize: 100 })).items);
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
    <div className="card" style={{ marginBlockEnd: 20 }}>
      <div className="card__head">
        <div className="card__title">محصول تازه</div>
        <div className="page-head__sub">یک قیمت روی سرویسی که از قبل ساخته شده</div>
      </div>
      {err && <div className="alert alert-error">{err}</div>}
      <div className="toolbar" style={{ borderBlockEnd: 'none', paddingBlockEnd: 0 }}>
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
        </div>
      </div>
      {chosen && (
        <p className="muted" style={{ marginBlockStart: 0 }}>
          لوکیشن، گروه کاربری و دسته‌بندیِ این محصول را همین سرویس تعیین می‌کند:{' '}
          {chosen.panel?.name ?? 'بدون پنل'} ·{' '}
          {chosen.resellersOnly ? 'فقط نماینده' : 'مشتری عادی'} ·{' '}
          {chosen.categoryName ?? 'بدون دسته‌بندی'}
        </p>
      )}
      <div className="toolbar" style={{ borderBlockEnd: 'none', paddingBlockEnd: 0 }}>
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
            placeholder="۳۰ روزه - ۵۰ گیگ"
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
          بساز
        </button>
      </div>
    </div>
  );
}

/**
 * One row's fields, on both of the levels they really live on.
 *
 * The three fields below the line belong to the SERVICE. Changing one of them
 * from here changes it for every config of that service, and the count in the
 * sentence above them is the whole reason this dialogue is worth its size: on a
 * flat table an admin has no way of knowing that «لوکیشن» is not a property of
 * the line they are looking at.
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
  const [badge, setBadge] = useState(row.badge ?? '');
  const [buttonStyle, setButtonStyle] = useState<ButtonStyle | null>(row.buttonStyle);
  const [priceToman, setPriceToman] = useState(String(Math.trunc(row.priceIrr / 10)));
  const [volumeGb, setVolumeGb] = useState(row.volumeGb === null ? '' : String(row.volumeGb));
  const [durationDays, setDurationDays] = useState(
    row.durationDays === null ? '' : String(row.durationDays),
  );
  const [status, setStatus] = useState<CatalogStatus>(row.status as CatalogStatus);

  const [providerId, setProviderId] = useState(row.provider === null ? '' : String(row.provider.id));
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
        setSiblings(d.items.find((s) => s.id === row.product.id)?.configs.length ?? null);
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
        badge: badgeValue(badge),
        buttonStyle,
        priceIrr: Math.round(Number(priceToman) * 10),
        volumeGb: volumeGb.trim() === '' ? null : Number(volumeGb),
        durationDays: durationDays.trim() === '' ? null : Number(durationDays),
        status,
      });
      // Only when one of them actually moved: an unchanged `updateProduct` still
      // writes an audit row saying a service was edited, and an audit trail full
      // of no-op edits is one nobody reads.
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
      <form
        className="modal-body"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="modal-head">
          <div>
            <div className="modal-head__title">{row.name}</div>
            <div className="page-head__sub">
              {row.product.name}
              {row.ordersCount > 0 ? ` · ${count(row.ordersCount)} سفارش` : ''}
            </div>
          </div>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            بستن
          </button>
        </div>

        {err && <div className="alert alert-error">{err}</div>}

        <div className="toolbar" style={{ borderBlockEnd: 'none', paddingBlockEnd: 0 }}>
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
        <div className="toolbar" style={{ borderBlockEnd: 'none', paddingBlockEnd: 0 }}>
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
        <div className="toolbar" style={{ borderBlockEnd: 'none', paddingBlockEnd: 0 }}>
          <div className="grow">
            <BadgeField
              id="ed-badge"
              value={badge}
              onChange={setBadge}
              style={buttonStyle}
              onStyleChange={setButtonStyle}
              preview={`${badge.trim() === '' ? '' : `${badge.trim()} `}${name.trim() || row.name} — ${toman(
                Math.round(Number(priceToman) * 10),
              )}`}
            />
          </div>
        </div>

        <h4 style={{ marginBlockEnd: 4 }}>روی کلِ سرویس «{row.product.name}»</h4>
        <p className="muted" style={{ marginBlockStart: 0 }}>
          {siblings === null || siblings <= 1
            ? 'این سه خانه روی سرویس می‌نشینند، نه روی همین ردیف.'
            : `این سه خانه روی سرویس می‌نشینند، نه روی همین ردیف — عوض‌کردنشان روی هر ${count(siblings)} محصولِ این سرویس اثر می‌گذارد.`}
        </p>
        <div className="toolbar" style={{ borderBlockEnd: 'none', paddingBlockEnd: 0 }}>
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

        <div className="modal-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || categoryId === '' || name.trim() === ''}
            {...w}
          >
            ذخیره
          </button>
          <button type="button" className="btn" onClick={onClose}>
            انصراف
          </button>
        </div>
      </form>
    </div>
  );
}
