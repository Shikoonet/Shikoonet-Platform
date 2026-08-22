/**
 * محصولات — the shelf: every sellable combination, and what it costs.
 *
 * The columns are the ones `panel/product.php` shows, in its order, because an
 * admin reads this screen daily and the words are already in their hands:
 * شناسه · نام محصول · قیمت · حجم · زمان · لوکیشن · گروه کاربری · دسته‌بندی.
 *
 * The delete button is here, and it is honest about what it can do. The PHP
 * panel's delete detaches every order ever placed on the plan — `orders.plan_id`
 * is `ON DELETE SET NULL` — and reports success. Here the server refuses with a
 * count of what is attached, and this screen turns that refusal into the action
 * the admin actually wanted: «غیرفعال», which takes the row out of the bot and
 * leaves the sales history pointing at it.
 *
 * Prices are typed and shown in Toman; the API speaks integer Rial. The
 * conversion lives in `format.ts` and in the one line here that builds the
 * request.
 */

import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type CatalogStatus,
  type CategoryRow,
  type PlanRow,
  type ProviderOption,
} from '../api.js';
import { count, irrToToman, toman } from '../format.js';
import { useAdminWriteProps } from '../role.js';

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

/** The `kind` values `products.kind` allows, in the admin's words. */
const KIND_FA: Record<string, string> = {
  vpn: 'وی‌پی‌ان',
  ai_account: 'اکانت هوش مصنوعی',
  spotify: 'اسپاتیفای',
  manual: 'دستی',
  other: 'سایر',
};

const STATUSES: CatalogStatus[] = ['ACTIVE', 'HIDDEN', 'DISABLED'];

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

/** An empty box is NULL, which is unmetered or no-expiry — never zero. */
function orNull(text: string): number | null {
  return text.trim() === '' ? null : Number(text);
}

export function ProductsPage() {
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [providerId, setProviderId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const w = useAdminWriteProps();

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

  async function loadCategories() {
    try {
      setCategories((await api.productCategories()).items);
    } catch {
      // A reader without the categories can still price a plan; the selector
      // just has nothing but «بدون دسته‌بندی» in it.
    }
  }

  useEffect(() => {
    void load(page);
    // Not on `q`: the box searches when submitted, not on every keystroke.
  }, [page, status, providerId]);

  useEffect(() => {
    void loadCategories();
  }, []);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const open = rows.find((r) => r.id === openId) ?? null;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">محصولات</div>
          <div className="page-head__sub">{count(total)} پلن فروش</div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setCreating(!creating);
            setOpenId(null);
          }}
          {...w}
        >
          {creating ? 'بستن' : 'محصول تازه'}
        </button>
      </div>

      {creating && (
        <NewProductCard
          providers={providers}
          categories={categories}
          onCategoryAdded={loadCategories}
          onCreated={() => {
            setCreating(false);
            void load(1);
            setPage(1);
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
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setOpenId(p.id);
                          setCreating(false);
                        }}
                      >
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

      {open && (
        <PlanDrawer
          key={open.id}
          plan={open}
          providers={providers}
          categories={categories}
          onCategoryAdded={loadCategories}
          onClose={() => setOpenId(null)}
          onGone={() => {
            setOpenId(null);
            void load();
          }}
          onChanged={() => void load()}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// A refusal the admin can act on
// ---------------------------------------------------------------------------

/**
 * What a delete was refused for, and the button that does what was meant.
 *
 * The server's sentence names the counts; this adds the one move that always
 * works — «غیرفعال» takes the row off the shelf and out of the bot, and the
 * orders keep pointing at it.
 */
function Refusal({
  detail,
  onArchive,
  busy,
}: {
  detail: string;
  onArchive: (() => void) | null;
  busy: boolean;
}) {
  return (
    <div className="alert alert-error">
      <div>{detail}</div>
      {onArchive && (
        <button type="button" className="btn btn-sm" disabled={busy} onClick={onArchive}>
          به‌جایش غیرفعال کن
        </button>
      )}
    </div>
  );
}

function isInUse(e: unknown): e is ApiError {
  return e instanceof ApiError && e.code === 'in_use';
}

/** The server's refusal sentence, which already names what is attached. */
type Refused = { detail: string } | null;

// ---------------------------------------------------------------------------
// Creating a product
// ---------------------------------------------------------------------------

function NewProductCard({
  providers,
  categories,
  onCategoryAdded,
  onCreated,
}: {
  providers: ProviderOption[];
  categories: CategoryRow[];
  onCategoryAdded: () => void;
  onCreated: () => void;
}) {
  const w = useAdminWriteProps();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState('vpn');
  const [providerId, setProviderId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [description, setDescription] = useState('');
  const [resellersOnly, setResellersOnly] = useState(false);
  const [oncePerUser, setOncePerUser] = useState(false);
  const [planName, setPlanName] = useState('');
  const [planPrice, setPlanPrice] = useState('');
  const [planDays, setPlanDays] = useState('');
  const [planVolume, setPlanVolume] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      const { productId } = await api.createProduct({
        code: code.trim(),
        name: name.trim(),
        kind,
        providerId: providerId === '' ? null : Number(providerId),
        categoryId: categoryId === '' ? null : Number(categoryId),
        description: description.trim() === '' ? null : description.trim(),
        resellersOnly,
        oncePerUser,
      });
      // A product with no plan is invisible to the bot, so the first plan is
      // part of creating rather than a second trip. It is still optional — a
      // shop that wants the product on the shelf before pricing it can skip it.
      if (planName.trim() !== '' && planPrice.trim() !== '') {
        await api.createPlan(productId, {
          name: planName.trim(),
          priceIrr: Math.round(Number(planPrice)) * 10,
          durationDays: orNull(planDays),
          volumeGb: orNull(planVolume),
        });
      }
      onCreated();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card__head">
        <span className="card__title">محصول تازه</span>
      </div>
      {err && <div className="alert alert-error">{err}</div>}

      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="np-name">
            نام محصول
          </label>
          <input
            id="np-name"
            className="form-control"
            maxLength={160}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="np-code">
            کد
          </label>
          <input
            id="np-code"
            className="form-control ltr"
            maxLength={64}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="de-vip"
          />
        </div>
        <div>
          <label className="form-label" htmlFor="np-kind">
            نوع
          </label>
          <select
            id="np-kind"
            className="form-control"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            {Object.entries(KIND_FA).map(([k, fa]) => (
              <option key={k} value={k}>
                {fa}
              </option>
            ))}
          </select>
        </div>
        <PanelPicker id="np-panel" value={providerId} onChange={setProviderId} providers={providers} />
        <CategoryPicker
          id="np-cat"
          value={categoryId}
          onChange={setCategoryId}
          categories={categories}
          onAdded={onCategoryAdded}
        />
      </div>

      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="np-desc">
            توضیح
          </label>
          <input
            id="np-desc"
            className="form-control"
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <Flags
          idPrefix="np"
          resellersOnly={resellersOnly}
          oncePerUser={oncePerUser}
          onResellers={setResellersOnly}
          onOnce={setOncePerUser}
        />
      </div>

      <h4>اولین پلن</h4>
      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="np-plan">
            نام پلن
          </label>
          <input
            id="np-plan"
            className="form-control"
            maxLength={120}
            value={planName}
            onChange={(e) => setPlanName(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="np-price">
            قیمت (تومان)
          </label>
          <input
            id="np-price"
            className="form-control ltr"
            type="number"
            value={planPrice}
            onChange={(e) => setPlanPrice(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="np-vol">
            حجم (گیگ)
          </label>
          <input
            id="np-vol"
            className="form-control ltr"
            type="number"
            value={planVolume}
            onChange={(e) => setPlanVolume(e.target.value)}
            placeholder="نامحدود"
          />
        </div>
        <div>
          <label className="form-label" htmlFor="np-days">
            زمان (روز)
          </label>
          <input
            id="np-days"
            className="form-control ltr"
            type="number"
            value={planDays}
            onChange={(e) => setPlanDays(e.target.value)}
            placeholder="بدون انقضا"
          />
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || code.trim() === '' || name.trim() === ''}
          onClick={() => void create()}
          {...w}
        >
          ساختن
        </button>
      </div>
      <p className="muted">
        خالی گذاشتن حجم یعنی نامحدود و خالی گذاشتن زمان یعنی بدون انقضا — هیچ‌کدام با صفر یکی
        نیستند. تا وقتی محصول پلنی نداشته باشد در ربات دیده نمی‌شود.
      </p>
    </div>
  );
}

function PanelPicker({
  id,
  value,
  onChange,
  providers,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  providers: ProviderOption[];
}) {
  return (
    <div>
      <label className="form-label" htmlFor={id}>
        لوکیشن
      </label>
      <select
        id={id}
        className="form-control"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">بدون پنل</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function CategoryPicker({
  id,
  value,
  onChange,
  categories,
  onAdded,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  categories: CategoryRow[];
  onAdded: () => void;
}) {
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);

  async function add() {
    if (adding.trim() === '') return;
    setBusy(true);
    try {
      const { category } = await api.createCategory(adding.trim());
      onChange(String(category.id));
      setAdding('');
      onAdded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label className="form-label" htmlFor={id}>
        دسته‌بندی
      </label>
      <select
        id={id}
        className="form-control"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">بدون دسته‌بندی</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <div className="filters" style={{ marginBlockStart: 4 }}>
        <input
          className="form-control"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          placeholder="دستهٔ تازه"
          aria-label="دستهٔ تازه"
        />
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void add()}>
          افزودن
        </button>
      </div>
    </div>
  );
}

function Flags({
  idPrefix,
  resellersOnly,
  oncePerUser,
  onResellers,
  onOnce,
}: {
  idPrefix: string;
  resellersOnly: boolean;
  oncePerUser: boolean;
  onResellers: (v: boolean) => void;
  onOnce: (v: boolean) => void;
}) {
  return (
    <>
      <div>
        <label className="form-label" htmlFor={`${idPrefix}-resellers`}>
          فقط نماینده‌ها
        </label>
        <input
          id={`${idPrefix}-resellers`}
          type="checkbox"
          checked={resellersOnly}
          onChange={(e) => onResellers(e.target.checked)}
        />
      </div>
      <div>
        <label className="form-label" htmlFor={`${idPrefix}-once`}>
          هر مشتری یک بار
        </label>
        <input
          id={`${idPrefix}-once`}
          type="checkbox"
          checked={oncePerUser}
          onChange={(e) => onOnce(e.target.checked)}
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Editing one plan, its product, and adding another plan
// ---------------------------------------------------------------------------

function PlanDrawer({
  plan,
  providers,
  categories,
  onCategoryAdded,
  onClose,
  onChanged,
  onGone,
}: {
  plan: PlanRow;
  providers: ProviderOption[];
  categories: CategoryRow[];
  onCategoryAdded: () => void;
  onClose: () => void;
  onChanged: () => void;
  onGone: () => void;
}) {
  const w = useAdminWriteProps();
  const [name, setName] = useState(plan.name);
  const [priceToman, setPriceToman] = useState(String(irrToToman(plan.priceIrr)));
  const [days, setDays] = useState(plan.durationDays === null ? '' : String(plan.durationDays));
  const [volume, setVolume] = useState(plan.volumeGb === null ? '' : String(plan.volumeGb));
  const [userLimit, setUserLimit] = useState(plan.userLimit === null ? '' : String(plan.userLimit));
  const [sortOrder, setSortOrder] = useState(String(plan.sortOrder));
  const [status, setStatus] = useState<string>(plan.status);
  const [err, setErr] = useState<string | null>(null);
  const [refused, setRefused] = useState<Refused>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const typedPrice = Number(priceToman);
  const priceIrr =
    priceToman.trim() !== '' && Number.isFinite(typedPrice) ? Math.round(typedPrice) * 10 : null;

  function begin() {
    setBusy(true);
    setErr(null);
    setRefused(null);
    setDone(null);
  }

  async function save() {
    if (priceIrr === null || priceIrr < 0) {
      setErr('قیمت را به تومان و بدون علامت وارد کنید.');
      return;
    }
    begin();
    try {
      // Only what actually changed is sent, so an untouched field cannot
      // overwrite a value somebody else edited in the meantime.
      const patch: Parameters<typeof api.updatePlan>[1] = {};
      if (name.trim() !== plan.name) patch.name = name.trim();
      if (priceIrr !== plan.priceIrr) patch.priceIrr = priceIrr;
      const nextDays = orNull(days);
      if (nextDays !== plan.durationDays) patch.durationDays = nextDays;
      const nextVolume = orNull(volume);
      if (nextVolume !== plan.volumeGb) patch.volumeGb = nextVolume;
      const nextLimit = orNull(userLimit);
      if (nextLimit !== plan.userLimit) patch.userLimit = nextLimit;
      if (Number(sortOrder) !== plan.sortOrder) patch.sortOrder = Number(sortOrder);
      if (status !== plan.status) patch.status = status as CatalogStatus;

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

  async function removePlan() {
    begin();
    try {
      await api.deletePlan(plan.id);
      onGone();
    } catch (e) {
      if (isInUse(e)) setRefused({ detail: e.detail ?? '' });
      else setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function archivePlan() {
    begin();
    try {
      await api.updatePlan(plan.id, { status: 'DISABLED' });
      setStatus('DISABLED');
      setDone('پلن غیرفعال شد و از ربات برداشته شد.');
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
      {refused && (
        <Refusal detail={refused.detail} busy={busy} onArchive={() => void archivePlan()} />
      )}
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
          <label className="form-label" htmlFor="plan-users">
            سقف کاربر
          </label>
          <input
            id="plan-users"
            className="form-control ltr"
            type="number"
            value={userLimit}
            onChange={(e) => setUserLimit(e.target.value)}
            placeholder="بی‌سقف"
          />
        </div>
        <div>
          <label className="form-label" htmlFor="plan-order">
            ترتیب
          </label>
          <input
            id="plan-order"
            className="form-control ltr"
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
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
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_FA[s]}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void save()}
          disabled={busy}
          {...w}
        >
          ذخیره
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void removePlan()}
          disabled={busy}
          {...w}
        >
          حذف پلن
        </button>
      </div>
      <p className="muted">
        {count(plan.ordersCount)} سفارش روی این پلن ثبت شده است. اگر چیزی به پلن وصل باشد حذف
        انجام نمی‌شود و همان‌جا گفته می‌شود چه چیزی وصل است. تغییر قیمت با ایمیل شما در دفتر ثبت
        می‌شود.
      </p>

      <ProductSection
        plan={plan}
        providers={providers}
        categories={categories}
        onCategoryAdded={onCategoryAdded}
        onChanged={onChanged}
        onGone={onGone}
      />
    </div>
  );
}

function ProductSection({
  plan,
  providers,
  categories,
  onCategoryAdded,
  onChanged,
  onGone,
}: {
  plan: PlanRow;
  providers: ProviderOption[];
  categories: CategoryRow[];
  onCategoryAdded: () => void;
  onChanged: () => void;
  onGone: () => void;
}) {
  const w = useAdminWriteProps();
  const p = plan.product;
  const [code, setCode] = useState(p.code);
  const [name, setName] = useState(p.name);
  const [kind, setKind] = useState(p.kind);
  const [providerId, setProviderId] = useState(plan.provider ? String(plan.provider.id) : '');
  const [categoryId, setCategoryId] = useState(p.categoryId === null ? '' : String(p.categoryId));
  const [description, setDescription] = useState(p.description ?? '');
  const [resellersOnly, setResellersOnly] = useState(p.resellersOnly);
  const [oncePerUser, setOncePerUser] = useState(p.oncePerUser);
  const [newPlanName, setNewPlanName] = useState('');
  const [newPlanPrice, setNewPlanPrice] = useState('');
  const [newPlanDays, setNewPlanDays] = useState('');
  const [newPlanVolume, setNewPlanVolume] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [refused, setRefused] = useState<Refused>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function begin() {
    setBusy(true);
    setErr(null);
    setRefused(null);
    setDone(null);
  }

  async function save() {
    begin();
    try {
      await api.updateProduct(p.id, {
        code: code.trim(),
        name: name.trim(),
        kind,
        providerId: providerId === '' ? null : Number(providerId),
        categoryId: categoryId === '' ? null : Number(categoryId),
        description: description.trim() === '' ? null : description.trim(),
        resellersOnly,
        oncePerUser,
      });
      setDone('محصول ذخیره شد.');
      onChanged();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(next: CatalogStatus) {
    begin();
    try {
      await api.setProductStatus(p.id, next);
      setDone(`محصول «${p.name}» ${STATUS_FA[next]} شد.`);
      onChanged();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    begin();
    try {
      await api.deleteProduct(p.id);
      onGone();
    } catch (e) {
      if (isInUse(e)) setRefused({ detail: e.detail ?? '' });
      else setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function addPlan() {
    begin();
    try {
      await api.createPlan(p.id, {
        name: newPlanName.trim(),
        priceIrr: Math.round(Number(newPlanPrice)) * 10,
        durationDays: orNull(newPlanDays),
        volumeGb: orNull(newPlanVolume),
      });
      setNewPlanName('');
      setNewPlanPrice('');
      setNewPlanDays('');
      setNewPlanVolume('');
      setDone('پلن تازه اضافه شد.');
      onChanged();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h4>محصول «{p.name}»</h4>
      {err && <div className="alert alert-error">{err}</div>}
      {refused && (
        <Refusal detail={refused.detail} busy={busy} onArchive={() => void setStatus('DISABLED')} />
      )}
      {done && <div className="alert alert-info">{done}</div>}

      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="pr-name">
            نام محصول
          </label>
          <input
            id="pr-name"
            className="form-control"
            maxLength={160}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="pr-code">
            کد
          </label>
          <input
            id="pr-code"
            className="form-control ltr"
            maxLength={64}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="pr-kind">
            نوع
          </label>
          <select
            id="pr-kind"
            className="form-control"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            {Object.entries(KIND_FA).map(([k, fa]) => (
              <option key={k} value={k}>
                {fa}
              </option>
            ))}
          </select>
        </div>
        <PanelPicker id="pr-panel" value={providerId} onChange={setProviderId} providers={providers} />
        <CategoryPicker
          id="pr-cat"
          value={categoryId}
          onChange={setCategoryId}
          categories={categories}
          onAdded={onCategoryAdded}
        />
      </div>

      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="pr-desc">
            توضیح
          </label>
          <input
            id="pr-desc"
            className="form-control"
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <Flags
          idPrefix="pr"
          resellersOnly={resellersOnly}
          oncePerUser={oncePerUser}
          onResellers={setResellersOnly}
          onOnce={setOncePerUser}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void save()}
          {...w}
        >
          ذخیرهٔ محصول
        </button>
      </div>

      <div className="filters">
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            className={s === p.status ? 'btn btn-primary' : 'btn'}
            disabled={busy || s === p.status}
            onClick={() => void setStatus(s)}
            {...w}
          >
            {STATUS_FA[s]}
          </button>
        ))}
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() => void remove()}
          {...w}
        >
          حذف محصول
        </button>
      </div>
      <p className="muted">
        حذف محصول پلن‌هایش را هم می‌برد. اگر روی هر کدام از پلن‌ها سفارش، سرویس، کانفیگ انبار یا کد
        تخفیفی باشد حذف انجام نمی‌شود — «غیرفعال» همان کار را بدون از دست رفتن تاریخچه انجام
        می‌دهد.
      </p>

      <h4>پلن تازه برای این محصول</h4>
      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="ap-name">
            نام پلن
          </label>
          <input
            id="ap-name"
            className="form-control"
            maxLength={120}
            value={newPlanName}
            onChange={(e) => setNewPlanName(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="ap-price">
            قیمت (تومان)
          </label>
          <input
            id="ap-price"
            className="form-control ltr"
            type="number"
            value={newPlanPrice}
            onChange={(e) => setNewPlanPrice(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="ap-vol">
            حجم (گیگ)
          </label>
          <input
            id="ap-vol"
            className="form-control ltr"
            type="number"
            value={newPlanVolume}
            onChange={(e) => setNewPlanVolume(e.target.value)}
            placeholder="نامحدود"
          />
        </div>
        <div>
          <label className="form-label" htmlFor="ap-days">
            زمان (روز)
          </label>
          <input
            id="ap-days"
            className="form-control ltr"
            type="number"
            value={newPlanDays}
            onChange={(e) => setNewPlanDays(e.target.value)}
            placeholder="بدون انقضا"
          />
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || newPlanName.trim() === '' || newPlanPrice.trim() === ''}
          onClick={() => void addPlan()}
          {...w}
        >
          افزودن پلن
        </button>
      </div>
    </>
  );
}
