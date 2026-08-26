/**
 * سرویس‌ها — what the shop sells, in the shape a customer buys it.
 *
 * ## What this replaces, and why
 *
 * `ProductsPage` listed one row per PLAN and called itself «محصولات». Three
 * things about that were wrong in a way an operator could not work around:
 *
 *   - **The service was never a row.** The customer picks a service first —
 *     پلاتینیوم, طلایی, معمولی — and that thing existed on the old screen only
 *     as a repeated grey sub-line under each of its plans. The only way to
 *     reach it was to open one of its plans and scroll.
 *   - **Building one took two screens.** The group was made in «مدیریت پنل‌ها»
 *     and the thing that sells it in «محصولات», and nothing said the second step
 *     existed. Sam ticked the panel's group column three times, saved, and
 *     watched the bot not change — because that column is a fallback nothing
 *     was using.
 *   - **One word meant three things.** «سرویس» was the customer's subscription
 *     in the sidebar, the product in the panel screen, and the tier in the plan
 *     form. «گروه» was both a panel group and the reseller/ordinary audience
 *     column. «لوکیشن» was a panel.
 *
 * So: one row per service, its configs inside it, and «سرویس تازه» does the
 * whole job from one card — makes the group on the panel, hangs the service off
 * it, and adds the first config.
 *
 * ## The vocabulary, fixed
 *
 * **پنل** is a PasarGuard. **سرویس** is what the customer picks first (a
 * `products` row, its tier written in `attrs.group_ids`). **کانفیگ** is one
 * price line (`product_plans`). **اشتراک** is what a customer owns after
 * buying. Nothing on this screen uses any other word for any of those.
 *
 * ## What is asked of the panel, and what is not
 *
 * Group NAMES and whether they can deliver anything are facts about the panel,
 * so they are asked of it — once per panel on the page, after the list has
 * already drawn. A sleeping panel costs one column, not the screen. The service
 * rows themselves come from `/catalog`, which touches nothing but Postgres.
 */

import { useEffect, useRef, useState } from 'react';
import { configName } from '@shikoo/contracts';
import {
  api,
  ApiError,
  type CatalogStatus,
  type CategoryRow,
  type ConfigRow,
  type PanelGroupItem,
  type PanelGroups,
  type ProviderOption,
  type ServiceRow,
} from '../api.js';
import { count, irrToToman, toman } from '../format.js';
import { anyHosted, GroupForm, InboundCount, InboundPicker } from '../groups.js';
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

/** The `kind` values `products.kind` allows, in the operator's words. */
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

function isInUse(e: unknown): e is ApiError {
  return e instanceof ApiError && e.code === 'in_use';
}

/** The server's refusal sentence, which already names what is attached. */
type Refused = { detail: string } | null;

/** An empty box is NULL — unmetered, no expiry, no ceiling. Never zero. */
function orNull(text: string): number | null {
  return text.trim() === '' ? null : Number(text);
}

/** A code out of a Persian name: the operator should not have to invent one. */
function slug(name: string): string {
  const ascii = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function CatalogPage() {
  const w = useAdminWriteProps();
  const [rows, setRows] = useState<ServiceRow[]>([]);
  const [panels, setPanels] = useState<ProviderOption[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [typed, setTyped] = useState('');
  const [status, setStatus] = useState('');
  const [panelId, setPanelId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [editing, setEditing] = useState<ServiceRow | null>(null);

  /** Group listings per panel, filled in after the list draws. */
  const [groups, setGroups] = useState<Record<number, PanelGroups | null>>({});
  const asked = useRef(new Set<number>());

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const data = await api.catalog({
        page,
        pageSize: PAGE_SIZE,
        // Spread rather than `undefined`: `exactOptionalPropertyTypes` is on,
        // and an absent filter is absent rather than present-and-empty.
        ...(q ? { q } : {}),
        ...(status ? { status } : {}),
        ...(panelId ? { providerId: Number(panelId) } : {}),
      });
      setRows(data.items);
      setPanels(data.panels);
      setTotal(data.total);
    } catch (e) {
      setErr(message(e));
    } finally {
      setLoading(false);
    }
  }

  async function loadCategories() {
    try {
      const data = await api.productCategories();
      setCategories(data.items);
    } catch {
      // The category picker is a convenience; the screen works without it.
    }
  }

  useEffect(() => {
    void load();
  }, [page, q, status, panelId]);

  useEffect(() => {
    void loadCategories();
  }, []);

  // Ask each panel on this page for its groups, once. `asked` is a ref rather
  // than a check against `groups`, because writing into `groups` would re-run
  // this effect and a failed panel would be asked forever.
  useEffect(() => {
    for (const row of rows) {
      const id = row.panel?.id;
      if (id === undefined || asked.current.has(id)) continue;
      asked.current.add(id);
      api
        .panelGroups(id)
        .then((data) => setGroups((g) => ({ ...g, [id]: data })))
        .catch(() => setGroups((g) => ({ ...g, [id]: null })));
    }
  }, [rows]);

  function refresh() {
    // A group may have been made or renamed, so the panel answers are stale.
    asked.current.clear();
    setGroups({});
    void load();
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const configCount = rows.reduce((n, r) => n + r.configs.length, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">سرویس‌ها</div>
          <div className="page-head__sub">
            {count(total)} سرویس · {count(configCount)} کانفیگ در این صفحه
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setCreating(!creating)}
          {...w}
        >
          {creating ? 'بستن' : 'سرویس تازه'}
        </button>
      </div>

      <p className="muted" style={{ marginBlockStart: 0 }}>
        هر <b>سرویس</b> همان چیزی است که مشتری اول انتخاب می‌کند — پلاتینیوم، طلایی، معمولی — و
        هر <b>کانفیگ</b> یک ردیف قیمت داخل آن. سرویس روی یک <b>گروهِ پنل</b> ساخته می‌شود و
        همان گروه تعیین می‌کند مشتری چه کانفیگ‌هایی تحویل می‌گیرد. سرویسی که هیچ کانفیگی نداشته
        باشد در ربات دیده نمی‌شود.
      </p>

      {err && <div className="alert alert-error">{err}</div>}

      {creating && (
        <NewServiceCard
          panels={panels}
          categories={categories}
          onCategoryAdded={() => void loadCategories()}
          onCreated={() => {
            setCreating(false);
            refresh();
          }}
        />
      )}

      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setQ(typed.trim());
        }}
      >
        <div className="grow">
          <label className="form-label" htmlFor="cat-q">
            جست‌وجو
          </label>
          <input
            id="cat-q"
            className="form-control"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="نام سرویس، کد، یا نام یک کانفیگ"
          />
        </div>
        <div>
          <label className="form-label" htmlFor="cat-panel">
            پنل
          </label>
          <select
            id="cat-panel"
            className="form-control"
            value={panelId}
            onChange={(e) => {
              setPage(1);
              setPanelId(e.target.value);
            }}
          >
            <option value="">همهٔ پنل‌ها</option>
            {panels.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="form-label" htmlFor="cat-status">
            وضعیت سرویس
          </label>
          <select
            id="cat-status"
            className="form-control"
            value={status}
            onChange={(e) => {
              setPage(1);
              setStatus(e.target.value);
            }}
          >
            <option value="">همه</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_FA[s]}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn">
          جست‌وجو
        </button>
      </form>

      <div className="table-wrap">
        <table className="app-table">
          <thead>
            <tr>
              <th>سرویس</th>
              <th>پنل</th>
              <th>گروه</th>
              <th>تحویل</th>
              <th>کانفیگ‌ها</th>
              <th>مخاطب</th>
              <th>وضعیت</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="empty" colSpan={8}>
                  {loading ? '…' : 'هیچ سرویسی نیست. با «سرویس تازه» اولی را بسازید.'}
                </td>
              </tr>
            )}
            {rows.map((service) => (
              <ServiceRows
                key={service.id}
                service={service}
                data={service.panel ? groups[service.panel.id] : null}
                open={open === service.id}
                onToggle={() => setOpen(open === service.id ? null : service.id)}
                onEdit={() => setEditing(service)}
                onChanged={refresh}
              />
            ))}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="pager">
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

      {editing && (
        <ServiceDrawer
          service={editing}
          panels={panels}
          categories={categories}
          onCategoryAdded={() => void loadCategories()}
          onClose={() => setEditing(null)}
          onChanged={refresh}
          onGone={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// One service, and its configs underneath it
// ---------------------------------------------------------------------------

/**
 * The groups this service delivers into, by name.
 *
 * Ids are what the database stores and are useless on a screen: «۶» tells an
 * operator nothing and «پلاتینیوم» tells them everything. The id is still
 * printed small, because it is what the panel's own UI shows.
 *
 * `null` groupIds means the service made no choice and the panel's default
 * applies — which is said out loud, because it is the case that surprised
 * everybody: a service with no level of its own lands in every group the panel
 * has ticked, which nobody chose on purpose.
 */
function GroupCell({ service, data }: { service: ServiceRow; data: PanelGroups | null | undefined }) {
  if (service.panel === null) return <span className="muted">—</span>;
  if (data === undefined) return <span className="muted">…</span>;
  if (data === null) return <span className="muted">پنل جواب نداد</span>;

  const inherited = service.groupIds === null;
  const ids = service.groupIds ?? data.selected;
  if (ids.length === 0) {
    // Not «چیزی تحویل نمی‌دهد», which this said until it was read on a real
    // screen. `marzban.ts` omits `group_ids` from the create when nothing is
    // chosen, so what the customer receives is then the PANEL's own default —
    // which we have not asked and cannot state. Naming the fact (nothing is
    // chosen) is true; naming the consequence would be a guess in red.
    return <span className="badge badge-warning">گروهی انتخاب نشده</span>;
  }
  return (
    <>
      {inherited && <div className="page-head__sub">پیش‌فرض پنل</div>}
      {ids.map((id) => {
        const g = data.available?.find((x) => x.id === id);
        return (
          <div key={id}>
            {g ? g.name : <span className="badge badge-block">روی پنل نیست</span>}{' '}
            <span className="muted ltr">#{id}</span>
          </div>
        );
      })}
    </>
  );
}

/** How much of what this service promises actually reaches a customer. */
function DeliveryCell({
  service,
  data,
}: {
  service: ServiceRow;
  data: PanelGroups | null | undefined;
}) {
  if (service.panel === null) {
    return <span className="badge badge-block">بدون پنل — فروخته نمی‌شود</span>;
  }
  if (data === undefined) return <span className="muted">…</span>;
  if (data === null) return <span className="muted">—</span>;

  const ids = service.groupIds ?? data.selected;
  const found: PanelGroupItem[] = [];
  const missing: number[] = [];
  for (const id of ids) {
    const g = data.available?.find((x) => x.id === id);
    if (g) found.push(g);
    else missing.push(id);
  }

  /*
   * A group we sell that the panel does not have.
   *
   * This alarm used to live on «مدیریت پنل‌ها» › «گروه‌ها», where it named a
   * group id. Here it names the SERVICE — which is the thing that breaks, and
   * the thing an operator can act on. PasarGuard answers `404 Group not found`
   * and the adapter treats that as non-retryable, so every purchase of this
   * service fails and refunds in front of the customer.
   *
   * The ids were already being computed and silently dropped: the loop kept
   * what it found and said «—» if it found nothing, so a service pointing
   * entirely at deleted groups looked exactly like a service with no groups.
   */
  if (missing.length > 0) {
    return (
      <div className="tone-orange">
        <strong>
          {missing.length === 1
            ? `گروه ${missing[0]} روی پنل نیست`
            : `${missing.length} گروه روی پنل نیست`}
        </strong>
        <div className="muted">هر خریدی از این سرویس شکست می‌خورد.</div>
      </div>
    );
  }

  if (found.length === 0) return <span className="muted">گروهی انتخاب نشده</span>;
  return (
    <>
      {/* One line per group, and the group named when there is more than one.
          Seen on the live panel on 2026-08-24: four groups rendered inline came
          out as «۱۲۲۱» — four separate counts read as one four-digit number,
          in the column that is supposed to say whether a customer gets
          anything. Nothing in a unit test could see it; the browser could. */}
      {found.map((g) => (
        <div key={g.id}>
          {found.length > 1 && <span className="muted">{g.name}: </span>}
          <InboundCount group={g} unit=" اینباند" />
        </div>
      ))}
    </>
  );
}

function ServiceRows({
  service,
  data,
  open,
  onToggle,
  onEdit,
  onChanged,
}: {
  service: ServiceRow;
  data: PanelGroups | null | undefined;
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onChanged: () => void;
}) {
  return (
    <>
      <tr>
        <td>
          <div>{service.name}</div>
          <div className="page-head__sub ltr">{service.code}</div>
        </td>
        <td>{service.panel?.name ?? <span className="muted">بدون پنل</span>}</td>
        <td>
          <GroupCell service={service} data={data} />
        </td>
        <td>
          <DeliveryCell service={service} data={data} />
        </td>
        <td>
          <button type="button" className="btn btn-sm" onClick={onToggle}>
            {count(service.configs.length)} کانفیگ {open ? '▲' : '▼'}
          </button>
        </td>
        <td>
          {service.resellersOnly ? (
            <span className="badge badge-info">نماینده</span>
          ) : (
            <span className="badge">عادی</span>
          )}
        </td>
        <td>
          <span className={STATUS_BADGE[service.status] ?? 'badge'}>
            {STATUS_FA[service.status] ?? service.status}
          </span>
        </td>
        <td>
          <div className="row-actions">
            <button type="button" className="btn btn-sm" onClick={onEdit}>
              ویرایش سرویس
            </button>
          </div>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8}>
            <ConfigList service={service} onChanged={onChanged} />
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Configs
// ---------------------------------------------------------------------------

function ConfigList({ service, onChanged }: { service: ServiceRow; onChanged: () => void }) {
  const w = useAdminWriteProps();
  const [editing, setEditing] = useState<ConfigRow | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <div style={{ paddingBlock: 8 }}>
      <table className="app-table">
        <thead>
          <tr>
            <th>کانفیگ</th>
            <th>قیمت</th>
            <th>حجم</th>
            <th>مدت</th>
            <th>سقف کاربر</th>
            <th>وضعیت</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {service.configs.length === 0 && (
            <tr>
              <td className="empty" colSpan={7}>
                این سرویس هیچ کانفیگی ندارد، پس در ربات دیده نمی‌شود.
              </td>
            </tr>
          )}
          {service.configs.map((cf) => (
            <tr key={cf.id}>
              <td>{cf.name}</td>
              <td>{toman(cf.priceIrr)}</td>
              <td>{cf.volumeGb === null ? 'نامحدود' : `${count(cf.volumeGb)} گیگ`}</td>
              <td>{cf.durationDays === null ? 'بدون انقضا' : `${count(cf.durationDays)} روز`}</td>
              <td>{cf.userLimit === null ? 'بی‌سقف' : count(cf.userLimit)}</td>
              <td>
                <span className={STATUS_BADGE[cf.status] ?? 'badge'}>
                  {STATUS_FA[cf.status] ?? cf.status}
                </span>
              </td>
              <td>
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setEditing(editing?.id === cf.id ? null : cf)}
                  >
                    ویرایش
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editing && (
        <ConfigDrawer
          config={editing}
          onClose={() => setEditing(null)}
          onChanged={onChanged}
          onGone={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}

      {!adding && (
        <button
          type="button"
          className="btn btn-sm"
          style={{ marginBlockStart: 8 }}
          onClick={() => setAdding(true)}
          {...w}
        >
          + کانفیگ تازه
        </button>
      )}
      {adding && (
        <NewConfigCard
          service={service}
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

/**
 * The four fields a config is, and the name they write for you.
 *
 * The legacy shop had nowhere to put volume or duration, so the operator typed
 * the whole label by hand — «1ماهه-20گیگ-چند کاربر-119.000ت» — price included.
 * We have the columns, so `configName` composes the label from them and the box
 * stays editable for the «✨تانل اختصاصی✨» cases.
 *
 * The suggestion stops the moment the operator types in the name box. An
 * autofill that keeps overwriting what somebody just wrote is worse than no
 * autofill.
 */
function useConfigDraft(initial?: ConfigRow) {
  const [name, setName] = useState(initial?.name ?? '');
  const [touched, setTouched] = useState(initial !== undefined);
  const [priceToman, setPriceToman] = useState(
    initial ? String(irrToToman(initial.priceIrr)) : '',
  );
  const [volume, setVolume] = useState(
    initial && initial.volumeGb !== null ? String(initial.volumeGb) : '',
  );
  const [days, setDays] = useState(
    initial && initial.durationDays !== null ? String(initial.durationDays) : '',
  );
  const [users, setUsers] = useState(
    initial && initial.userLimit !== null ? String(initial.userLimit) : '',
  );

  const shape = {
    volumeGb: orNull(volume),
    durationDays: orNull(days),
    userLimit: orNull(users),
  };
  const suggested = configName(shape);
  // Nothing filled in yet is not a config anybody would name «بدون انقضا -
  // نامحدود - چند کاربر», so the box stays empty until there is something to
  // describe.
  const described = volume !== '' || days !== '' || users !== '';

  useEffect(() => {
    if (!touched && described) setName(suggested);
  }, [suggested, touched, described]);

  const typed = Number(priceToman);
  const priceIrr =
    priceToman.trim() !== '' && Number.isFinite(typed) ? Math.round(typed) * 10 : null;

  return {
    name,
    setName: (v: string) => {
      setTouched(true);
      setName(v);
    },
    rename: () => setName(suggested),
    suggested,
    priceToman,
    setPriceToman,
    priceIrr,
    volume,
    setVolume,
    days,
    setDays,
    users,
    setUsers,
    shape,
  };
}

type Draft = ReturnType<typeof useConfigDraft>;

function ConfigFields({ idPrefix, draft }: { idPrefix: string; draft: Draft }) {
  return (
    <div className="filters">
      <div>
        <label className="form-label" htmlFor={`${idPrefix}-days`}>
          مدت (روز)
        </label>
        <input
          id={`${idPrefix}-days`}
          className="form-control ltr"
          type="number"
          value={draft.days}
          onChange={(e) => draft.setDays(e.target.value)}
          placeholder="بدون انقضا"
        />
      </div>
      <div>
        <label className="form-label" htmlFor={`${idPrefix}-volume`}>
          حجم (گیگ)
        </label>
        <input
          id={`${idPrefix}-volume`}
          className="form-control ltr"
          type="number"
          value={draft.volume}
          onChange={(e) => draft.setVolume(e.target.value)}
          placeholder="نامحدود"
        />
      </div>
      <div>
        <label className="form-label" htmlFor={`${idPrefix}-users`}>
          سقف کاربر
        </label>
        <input
          id={`${idPrefix}-users`}
          className="form-control ltr"
          type="number"
          value={draft.users}
          onChange={(e) => draft.setUsers(e.target.value)}
          placeholder="بی‌سقف"
        />
      </div>
      <div>
        <label className="form-label" htmlFor={`${idPrefix}-price`}>
          قیمت (تومان)
        </label>
        <input
          id={`${idPrefix}-price`}
          className="form-control ltr"
          type="number"
          value={draft.priceToman}
          onChange={(e) => draft.setPriceToman(e.target.value)}
        />
      </div>
      <div className="grow">
        <label className="form-label" htmlFor={`${idPrefix}-name`}>
          نامی که مشتری می‌بیند
        </label>
        <input
          id={`${idPrefix}-name`}
          className="form-control"
          maxLength={120}
          value={draft.name}
          onChange={(e) => draft.setName(e.target.value)}
          placeholder={draft.suggested}
        />
        {draft.name !== draft.suggested && (
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginBlockStart: 4 }}
            onClick={draft.rename}
          >
            نام را از مشخصات بساز
          </button>
        )}
      </div>
    </div>
  );
}

/** «قیمت را ننویسید» — said once, where the name is typed. */
function PriceNote() {
  return (
    <p className="muted">
      قیمت را داخل نام ننویسید. ربات خودش قیمت روز را آخر دکمه می‌گذارد، و برای مشتریِ
      تخفیف‌دار قیمتِ خودش را — کاری که ربات قدیمی نمی‌کرد و دکمه یک عدد می‌گفت و صندوق عدد
      دیگری.
    </p>
  );
}

function NewConfigCard({
  service,
  onClose,
  onCreated,
}: {
  service: ServiceRow;
  onClose: () => void;
  onCreated: () => void;
}) {
  const w = useAdminWriteProps();
  const draft = useConfigDraft();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add() {
    if (draft.priceIrr === null || draft.priceIrr < 0) {
      setErr('قیمت را به تومان و بدون علامت وارد کنید.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.createPlan(service.id, {
        name: draft.name.trim() === '' ? draft.suggested : draft.name.trim(),
        priceIrr: draft.priceIrr,
        durationDays: draft.shape.durationDays,
        volumeGb: draft.shape.volumeGb,
        userLimit: draft.shape.userLimit,
      });
      onCreated();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBlockStart: 8 }}>
      <div className="card__head">
        <span className="card__title">کانفیگ تازه برای «{service.name}»</span>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          بستن
        </button>
      </div>
      {err && <div className="alert alert-error">{err}</div>}
      <ConfigFields idPrefix="nc" draft={draft} />
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy}
        onClick={() => void add()}
        {...w}
      >
        افزودن
      </button>
      <PriceNote />
    </div>
  );
}

function ConfigDrawer({
  config,
  onClose,
  onChanged,
  onGone,
}: {
  config: ConfigRow;
  onClose: () => void;
  onChanged: () => void;
  onGone: () => void;
}) {
  const w = useAdminWriteProps();
  const draft = useConfigDraft(config);
  const [sortOrder, setSortOrder] = useState(String(config.sortOrder));
  const [status, setStatus] = useState<string>(config.status);
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
    if (draft.priceIrr === null || draft.priceIrr < 0) {
      setErr('قیمت را به تومان و بدون علامت وارد کنید.');
      return;
    }
    begin();
    try {
      // Only what changed, so an untouched box cannot overwrite a value
      // somebody else edited in the meantime.
      const patch: Parameters<typeof api.updatePlan>[1] = {};
      if (draft.name.trim() !== config.name) patch.name = draft.name.trim();
      if (draft.priceIrr !== config.priceIrr) patch.priceIrr = draft.priceIrr;
      if (draft.shape.durationDays !== config.durationDays) {
        patch.durationDays = draft.shape.durationDays;
      }
      if (draft.shape.volumeGb !== config.volumeGb) patch.volumeGb = draft.shape.volumeGb;
      if (draft.shape.userLimit !== config.userLimit) patch.userLimit = draft.shape.userLimit;
      if (Number(sortOrder) !== config.sortOrder) patch.sortOrder = Number(sortOrder);
      if (status !== config.status) patch.status = status as CatalogStatus;

      if (Object.keys(patch).length === 0) {
        setDone('چیزی تغییر نکرده بود.');
        return;
      }
      await api.updatePlan(config.id, patch);
      setDone('ذخیره شد.');
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
      await api.deletePlan(config.id);
      onGone();
    } catch (e) {
      if (isInUse(e)) setRefused({ detail: e.detail ?? '' });
      else setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    begin();
    try {
      await api.updatePlan(config.id, { status: 'DISABLED' });
      setStatus('DISABLED');
      setDone('کانفیگ غیرفعال شد و از ربات برداشته شد.');
      onChanged();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBlockStart: 8 }}>
      <div className="card__head">
        <span className="card__title">{config.name}</span>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          بستن
        </button>
      </div>

      {err && <div className="alert alert-error">{err}</div>}
      {refused && <Refusal detail={refused.detail} busy={busy} onArchive={() => void archive()} />}
      {done && <div className="alert alert-info">{done}</div>}

      <ConfigFields idPrefix="cf" draft={draft} />
      <div className="filters">
        <div>
          <label className="form-label" htmlFor="cf-order">
            ترتیب
          </label>
          <input
            id="cf-order"
            className="form-control ltr"
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="cf-status">
            وضعیت
          </label>
          <select
            id="cf-status"
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
          disabled={busy}
          onClick={() => void save()}
          {...w}
        >
          ذخیره
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() => void remove()}
          {...w}
        >
          حذف کانفیگ
        </button>
      </div>
      <p className="muted">
        {count(config.ordersCount)} سفارش روی این کانفیگ ثبت شده است. اگر چیزی به آن وصل باشد
        حذف انجام نمی‌شود و همان‌جا گفته می‌شود چه چیزی وصل است. تغییر قیمت با ایمیل شما در دفتر
        ثبت می‌شود.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Making a service — one card, three writes
// ---------------------------------------------------------------------------

/**
 * Choose the group this service delivers into, or make it here.
 *
 * Making it here is the whole point. The group lived on the panel screen and
 * the service on this one, and an operator who made the first without the
 * second had built something no customer could ever see — with nothing saying
 * so on either screen.
 */
function GroupChooser({
  panelId,
  mode,
  setMode,
  groupId,
  setGroupId,
  groupName,
  setGroupName,
  tags,
  toggleTag,
}: {
  panelId: string;
  mode: 'existing' | 'new';
  setMode: (m: 'existing' | 'new') => void;
  groupId: string;
  setGroupId: (v: string) => void;
  groupName: string;
  setGroupName: (v: string) => void;
  tags: string[];
  toggleTag: (tag: string) => void;
}) {
  const w = useAdminWriteProps();
  const [available, setAvailable] = useState<PanelGroupItem[] | null>(null);
  /**
   * The groups the PANEL itself is ticked for, in «مدیریت پنل‌ها».
   *
   * Shown, never enforced. A service may sell a group the panel does not name
   * as its default — that is the whole point of the level. But picking one
   * silently is how «پلاتینیوم» ended up beside a panel that had never been set
   * up for it, so the ones outside the panel's own list say so.
   */
  const [panelDefault, setPanelDefault] = useState<number[]>([]);
  const [inbounds, setInbounds] = useState<Array<{ tag: string; hosted?: boolean }> | null>(null);
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    setAvailable(null);
    setPanelDefault([]);
    setInbounds(null);
    setReason(null);
    if (panelId === '') return;
    const id = Number(panelId);
    api
      .panelGroups(id)
      .then((d) => {
        setAvailable(d.available);
        setPanelDefault(d.selected);
        if (d.available === null) setReason(d.reason ?? null);
      })
      .catch((e) => setReason(message(e)));
    api
      .panelInbounds(id)
      .then((d) => setInbounds(d.inbounds))
      .catch(() => setInbounds(null));
  }, [panelId]);

  if (panelId === '') {
    return <p className="muted">اول پنل را انتخاب کنید تا گروه‌هایش خوانده شود.</p>;
  }

  return (
    <>
      <label className="form-label" style={{ marginBlockStart: 8 }}>
        گروهِ این سرویس روی پنل
      </label>
      <p className="muted" style={{ marginBlockStart: 0 }}>
        گروه همان چیزی است که تعیین می‌کند مشتری چه کانفیگ‌هایی می‌گیرد. یک پنل می‌تواند چند
        سطح بفروشد — پلاتینیوم، طلایی، معمولی — بی‌آنکه پنل تازه‌ای بسازید.
      </p>

      <div className="filters">
        <div>
          <label className="form-label" htmlFor="ns-mode">
            گروه
          </label>
          <select
            id="ns-mode"
            className="form-control"
            value={mode}
            onChange={(e) => setMode(e.target.value as 'existing' | 'new')}
          >
            <option value="existing">گروهی که هست</option>
            <option value="new">گروه تازه بساز</option>
          </select>
        </div>
        {mode === 'existing' ? (
          <div className="grow">
            <label className="form-label" htmlFor="ns-group">
              کدام گروه
            </label>
            <select
              id="ns-group"
              className="form-control"
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
            >
              <option value="">انتخاب کنید</option>
              {(available ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                  {panelDefault.includes(g.id) ? ' — پیش‌فرض این پنل' : ''}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="grow">
            <label className="form-label" htmlFor="ns-group-name">
              نام گروه تازه
            </label>
            <input
              id="ns-group-name"
              className="form-control"
              maxLength={120}
              placeholder="پلاتینیوم"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
            />
          </div>
        )}
      </div>

      {available === null && mode === 'existing' && (
        <div className="alert alert-warning">
          فهرست گروه‌ها از پنل خوانده نشد{reason ? ` — ${reason}` : ''}.
        </div>
      )}

      {mode === 'new' && (
        <>
          <label className="form-label" style={{ marginBlockStart: 8 }}>
            اینباندهای این گروه
          </label>
          <InboundPicker
            inbounds={inbounds}
            reason={reason}
            chosen={tags}
            onToggle={toggleTag}
            disabledProps={w}
          />
          {/* Before the save, not after. A tier whose inbounds have no host
              costs more than the cheap one and hands the customer the same
              thing, and nothing downstream ever complains. */}
          {tags.length > 0 && !anyHosted(inbounds, tags) && (
            <div className="alert alert-warning">
              هیچ‌کدام از اینباندهای انتخاب‌شده هاست ندارد — مشتریِ این سرویس هیچ کانفیگی
              نمی‌گیرد.
            </div>
          )}
        </>
      )}
    </>
  );
}

/**
 * The groups on this panel: which one this service sells, and the ability to
 * make or change one without leaving.
 *
 * The list is asked of the PANEL, not typed and not remembered. That is the
 * whole point of it: group 42 was in the legacy configuration and had been
 * deleted from the live panel, and PasarGuard answers a create with
 * `404 Group not found` — non-retryable — so every VIP order would have gone
 * FAILED and refunded on the first day of cutover. A number frozen in our
 * config cannot notice that; a list the panel supplies can.
 *
 * Editing lives here rather than on the panel screen because this is where an
 * operator is when they find out the group is wrong: looking at the service
 * that sells it.
 */
function GroupManager({
  panelId,
  selected,
  onToggle,
  onChanged,
}: {
  panelId: number;
  selected: number[] | null;
  onToggle: (id: number) => void;
  onChanged: () => void;
}) {
  const w = useAdminWriteProps();
  const [available, setAvailable] = useState<PanelGroupItem[] | null>(null);
  const [inbounds, setInbounds] = useState<Array<{ tag: string; hosted?: boolean }> | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [formName, setFormName] = useState('');
  const [formTags, setFormTags] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setAvailable(null);
    setReason(null);
    try {
      const d = await api.panelGroups(panelId);
      setAvailable(d.available);
      if (d.available === null) setReason(d.reason ?? null);
    } catch (e) {
      setReason(message(e));
    }
    try {
      const d = await api.panelInbounds(panelId);
      setInbounds(d.inbounds);
    } catch {
      setInbounds(null);
    }
  }

  useEffect(() => {
    void load();
  }, [panelId]);

  function toggleTag(tag: string) {
    setFormTags(formTags.includes(tag) ? formTags.filter((t) => t !== tag) : [...formTags, tag]);
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      if (editing === 0) {
        const { group } = await api.createPanelGroup(panelId, {
          name: formName.trim(),
          inboundTags: formTags,
        });
        setDone(`گروه «${group.name}» روی پنل ساخته شد.`);
      } else if (editing !== null) {
        await api.updatePanelGroup(panelId, editing, {
          name: formName.trim(),
          inboundTags: formTags,
        });
        setDone('گروه روی پنل ذخیره شد.');
      }
      setEditing(null);
      await load();
      onChanged();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Empty a group into another one before it is retired.
   *
   * The count in the confirm is the panel's own `memberCount`, already on this
   * screen — asking the server for a preview would be a second number that can
   * disagree with the one the operator is looking at.
   */
  async function move(g: PanelGroupItem, toId: number) {
    const to = (available ?? []).find((x) => x.id === toId);
    const members = g.memberCount ?? 0;
    if (
      !window.confirm(
        `${count(members)} حساب از «${g.name}» به «${to?.name ?? `#${count(toId)}`}» منتقل شود؟ ` +
          'روی خودِ حساب‌ها چیز دیگری عوض نمی‌شود — نه حجم، نه تاریخ. ' +
          'گروه‌های دیگری که هر حساب دارد سرِ جایشان می‌مانند.',
      )
    ) {
      return;
    }
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      const r = await api.movePanelGroupMembers(panelId, g.id, toId);
      setDone(
        r.moved === 0
          ? `هیچ حسابی در «${g.name}» نبود — چیزی جابه‌جا نشد.`
          : `${count(r.moved)} حساب از «${g.name}» به «${to?.name ?? `#${count(toId)}`}» رفت. حالا می‌شود «${g.name}» را حذف کرد.`,
      );
      await load();
      onChanged();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(g: PanelGroupItem) {
    // The server refuses a group anything sells, with a sentence naming what.
    // This confirm is for the other case: a group nothing sells yet, whose
    // members are real accounts on the panel.
    const members = g.memberCount ?? 0;
    const question =
      members > 0
        ? `گروه «${g.name}» روی پنل ${count(members)} عضو دارد و بعد از حذف، کانفیگ‌های این گروه دیگر به آن‌ها نمی‌رسد. ` +
          'اگر می‌خواهی نگهشان داری، اول «انتقال اعضا» را بزن. با این حال حذف شود؟'
        : `گروه «${g.name}» از خودِ پنل حذف شود؟`;
    if (!window.confirm(question)) return;
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      await api.deletePanelGroup(panelId, g.id);
      setDone(`گروه «${g.name}» از پنل حذف شد.`);
      await load();
      onChanged();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {err && <div className="alert alert-error">{err}</div>}
      {done && <div className="alert alert-ok">{done}</div>}

      {available === null ? (
        <p className="muted">
          فهرست گروه‌ها از پنل خوانده نشد{reason ? ` — ${reason}` : ''}. آن‌چه ذخیره است:{' '}
          <span className="ltr">{selected === null ? 'پیش‌فرض پنل' : selected.join('، ')}</span>
        </p>
      ) : (
        <>
          <div className="pick-list">
            {available.map((g) => {
              const on = (selected ?? []).includes(g.id);
              return (
                <label key={g.id} className={on ? 'pick pick--on' : 'pick'}>
                  <input type="checkbox" checked={on} onChange={() => onToggle(g.id)} {...w} />
                  <span>
                    {g.name} <span className="muted ltr">#{g.id}</span>
                    <div className="page-head__sub">
                      <InboundCount group={g} />
                    </div>
                  </span>
                </label>
              );
            })}
          </div>

          {editing === null && (
            <div className="filters" style={{ marginBlockStart: 8 }}>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => {
                  setEditing(0);
                  setFormName('');
                  setFormTags([]);
                  setDone(null);
                }}
                {...w}
              >
                + گروه تازه روی پنل
              </button>
              {available.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => {
                    setEditing(g.id);
                    setFormName(g.name);
                    setFormTags([...(g.inboundTags ?? [])]);
                    setDone(null);
                  }}
                  {...w}
                >
                  ویرایش «{g.name}»
                </button>
              ))}
            </div>
          )}

          {editing !== null && (
            <>
              <GroupForm
                id={`gm-${editing}`}
                title={editing === 0 ? 'گروه تازه روی پنل' : 'ویرایش گروه'}
                name={formName}
                setName={setFormName}
                tags={formTags}
                toggleTag={toggleTag}
                inbounds={inbounds}
                inboundsReason={reason}
                busy={busy}
                submitLabel={editing === 0 ? 'بساز' : 'ذخیره روی پنل'}
                onSubmit={() => void submit()}
                onCancel={() => setEditing(null)}
                w={w}
              />
              {editing !== 0 && (
                <>
                  <MoveMembers
                    group={available.find((x) => x.id === editing) ?? null}
                    others={available.filter((x) => x.id !== editing)}
                    busy={busy}
                    onMove={(g, toId) => void move(g, toId)}
                    w={w}
                  />
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    disabled={busy}
                    onClick={() => {
                      const g = available.find((x) => x.id === editing);
                      if (g) void remove(g);
                    }}
                    {...w}
                  >
                    حذف این گروه از پنل
                  </button>
                </>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

/**
 * «انتقال اعضا» — the step that belongs in front of retiring a tier.
 *
 * Drawn only when there is something to move and somewhere to move it. A picker
 * with no options, or one offered for an empty group, is the kind of control an
 * operator learns to ignore — and this is the one they must not ignore, because
 * the thing it prevents is invisible at the moment it happens.
 *
 * The member count is the panel's own, the same number in the list above. It can
 * be absent — `memberCount` is optional because not every panel reports it — and
 * absent is not zero: the move is still offered, because refusing to offer it
 * over a missing count is how members get stranded.
 */
function MoveMembers({
  group,
  others,
  busy,
  onMove,
  w,
}: {
  group: PanelGroupItem | null;
  others: PanelGroupItem[];
  busy: boolean;
  onMove: (group: PanelGroupItem, toId: number) => void;
  w: Record<string, unknown>;
}) {
  const [to, setTo] = useState('');
  if (group === null || others.length === 0) return null;
  if (group.memberCount === 0) return null;

  return (
    <div className="filters" style={{ marginBlockStart: 8 }}>
      <label className="field">
        <span>انتقال اعضا به</span>
        <select value={to} onChange={(e) => setTo(e.target.value)} {...w}>
          <option value="">— گروه مقصد —</option>
          {others.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} #{count(g.id)}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="btn btn-sm"
        disabled={busy || to === ''}
        onClick={() => onMove(group, Number(to))}
        {...w}
      >
        انتقال{group.memberCount === undefined ? '' : ` ${count(group.memberCount)} حساب`}
      </button>
    </div>
  );
}

function NewServiceCard({
  panels,
  categories,
  onCategoryAdded,
  onCreated,
}: {
  panels: ProviderOption[];
  categories: CategoryRow[];
  onCategoryAdded: () => void;
  onCreated: () => void;
}) {
  const w = useAdminWriteProps();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [codeTouched, setCodeTouched] = useState(false);
  const [kind, setKind] = useState('vpn');
  const [panelId, setPanelId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [description, setDescription] = useState('');
  const [resellersOnly, setResellersOnly] = useState(false);
  const [oncePerUser, setOncePerUser] = useState(false);
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [groupId, setGroupId] = useState('');
  const [groupName, setGroupName] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const draft = useConfigDraft();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const suggestedCode = slug(name) || 'service';
  useEffect(() => {
    if (!codeTouched) setCode(suggestedCode);
  }, [suggestedCode, codeTouched]);

  function toggleTag(tag: string) {
    setTags(tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag]);
  }

  /**
   * Three writes, and this is deliberately not atomic — so it says so.
   *
   * Making a group is an HTTP call to the panel, not an INSERT, so it cannot
   * sit inside the transaction that makes the service. What CAN be done is to
   * never leave the operator guessing which of the three happened: each failure
   * names what already exists and what it means.
   */
  async function create() {
    if (name.trim() === '' || code.trim() === '') {
      setErr('نام سرویس و کد لازم است.');
      return;
    }
    if (panelId === '') {
      setErr('سرویس بدون پنل در ربات دیده نمی‌شود. پنل را انتخاب کنید.');
      return;
    }
    setBusy(true);
    setErr(null);

    let chosen: number | null = groupId === '' ? null : Number(groupId);
    let madeGroup: string | null = null;
    if (mode === 'new') {
      if (groupName.trim() === '') {
        setErr('نام گروه تازه را بنویسید.');
        setBusy(false);
        return;
      }
      try {
        const { group } = await api.createPanelGroup(Number(panelId), {
          name: groupName.trim(),
          inboundTags: tags,
        });
        chosen = group.id;
        madeGroup = group.name;
      } catch (e) {
        setErr(`گروه روی پنل ساخته نشد: ${message(e)}`);
        setBusy(false);
        return;
      }
    }
    if (chosen === null) {
      setErr('گروه را انتخاب کنید — بدون آن معلوم نیست مشتری چه تحویل می‌گیرد.');
      setBusy(false);
      return;
    }

    let productId: number;
    try {
      const created = await api.createProduct({
        code: code.trim(),
        name: name.trim(),
        kind,
        providerId: Number(panelId),
        categoryId: categoryId === '' ? null : Number(categoryId),
        description: description.trim() === '' ? null : description.trim(),
        resellersOnly,
        oncePerUser,
        groupIds: [chosen],
      });
      productId = created.productId;
    } catch (e) {
      setErr(
        madeGroup === null
          ? `سرویس ساخته نشد: ${message(e)}`
          : `گروه «${madeGroup}» روی پنل ساخته شد ولی سرویس ساخته نشد، پس هیچ‌کس آن گروه را نمی‌فروشد: ${message(e)}`,
      );
      setBusy(false);
      return;
    }

    if (draft.priceIrr !== null) {
      try {
        await api.createPlan(productId, {
          name: draft.name.trim() === '' ? draft.suggested : draft.name.trim(),
          priceIrr: draft.priceIrr,
          durationDays: draft.shape.durationDays,
          volumeGb: draft.shape.volumeGb,
          userLimit: draft.shape.userLimit,
        });
      } catch (e) {
        setErr(
          `سرویس «${name.trim()}» ساخته شد ولی کانفیگ اضافه نشد — تا کانفیگی نداشته باشد در ربات دیده نمی‌شود: ${message(e)}`,
        );
        setBusy(false);
        onCreated();
        return;
      }
    }
    setBusy(false);
    onCreated();
  }

  return (
    <div className="card">
      <div className="card__head">
        <span className="card__title">سرویس تازه</span>
      </div>
      {err && <div className="alert alert-error">{err}</div>}

      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="ns-name">
            نام سرویس — همان که مشتری می‌بیند
          </label>
          <input
            id="ns-name"
            className="form-control"
            maxLength={160}
            placeholder="پلاتینیوم"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="ns-code">
            کد
          </label>
          <input
            id="ns-code"
            className="form-control ltr"
            maxLength={64}
            value={code}
            onChange={(e) => {
              setCodeTouched(true);
              setCode(e.target.value);
            }}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="ns-kind">
            نوع
          </label>
          <select
            id="ns-kind"
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
        <PanelPicker id="ns-panel" value={panelId} onChange={setPanelId} panels={panels} />
        <CategoryPicker
          id="ns-cat"
          value={categoryId}
          onChange={setCategoryId}
          categories={categories}
          onAdded={onCategoryAdded}
        />
      </div>

      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="ns-desc">
            توضیح
          </label>
          <input
            id="ns-desc"
            className="form-control"
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <Flags
          idPrefix="ns"
          resellersOnly={resellersOnly}
          oncePerUser={oncePerUser}
          onResellers={setResellersOnly}
          onOnce={setOncePerUser}
        />
      </div>

      <GroupChooser
        panelId={panelId}
        mode={mode}
        setMode={setMode}
        groupId={groupId}
        setGroupId={setGroupId}
        groupName={groupName}
        setGroupName={setGroupName}
        tags={tags}
        toggleTag={toggleTag}
      />

      <h4>اولین کانفیگ</h4>
      <ConfigFields idPrefix="ns-cf" draft={draft} />

      <button
        type="button"
        className="btn btn-primary"
        disabled={busy}
        onClick={() => void create()}
        {...w}
      >
        ساختن
      </button>
      <PriceNote />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editing a service
// ---------------------------------------------------------------------------

function ServiceDrawer({
  service,
  panels,
  categories,
  onCategoryAdded,
  onClose,
  onChanged,
  onGone,
}: {
  service: ServiceRow;
  panels: ProviderOption[];
  categories: CategoryRow[];
  onCategoryAdded: () => void;
  onClose: () => void;
  onChanged: () => void;
  onGone: () => void;
}) {
  const w = useAdminWriteProps();
  const [code, setCode] = useState(service.code);
  const [name, setName] = useState(service.name);
  const [kind, setKind] = useState(service.kind);
  const [panelId, setPanelId] = useState(service.panel ? String(service.panel.id) : '');
  const [categoryId, setCategoryId] = useState(
    service.categoryId === null ? '' : String(service.categoryId),
  );
  const [description, setDescription] = useState(service.description ?? '');
  const [resellersOnly, setResellersOnly] = useState(service.resellersOnly);
  const [oncePerUser, setOncePerUser] = useState(service.oncePerUser);
  const [groupIds, setGroupIds] = useState<number[] | null>(service.groupIds);
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

  function toggleGroup(id: number) {
    const current = groupIds ?? [];
    const next = current.includes(id) ? current.filter((g) => g !== id) : [...current, id];
    setGroupIds(next);
  }

  async function save() {
    begin();
    try {
      await api.updateProduct(service.id, {
        code: code.trim(),
        name: name.trim(),
        kind,
        providerId: panelId === '' ? null : Number(panelId),
        categoryId: categoryId === '' ? null : Number(categoryId),
        description: description.trim() === '' ? null : description.trim(),
        resellersOnly,
        oncePerUser,
        groupIds,
      });
      setDone('سرویس ذخیره شد.');
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
      await api.setProductStatus(service.id, next);
      setDone(`سرویس «${service.name}» ${STATUS_FA[next]} شد.`);
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
      await api.deleteProduct(service.id);
      onGone();
    } catch (e) {
      if (isInUse(e)) setRefused({ detail: e.detail ?? '' });
      else setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBlockStart: 16 }}>
      <div className="card__head">
        <span className="card__title">
          سرویس «{service.name}» <span className="muted">{service.panel?.name ?? 'بدون پنل'}</span>
        </span>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          بستن
        </button>
      </div>

      {err && <div className="alert alert-error">{err}</div>}
      {refused && (
        <Refusal detail={refused.detail} busy={busy} onArchive={() => void setStatus('DISABLED')} />
      )}
      {done && <div className="alert alert-info">{done}</div>}

      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="sv-name">
            نام سرویس
          </label>
          <input
            id="sv-name"
            className="form-control"
            maxLength={160}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="sv-code">
            کد
          </label>
          <input
            id="sv-code"
            className="form-control ltr"
            maxLength={64}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="sv-kind">
            نوع
          </label>
          <select
            id="sv-kind"
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
        <PanelPicker id="sv-panel" value={panelId} onChange={setPanelId} panels={panels} />
        <CategoryPicker
          id="sv-cat"
          value={categoryId}
          onChange={setCategoryId}
          categories={categories}
          onAdded={onCategoryAdded}
        />
      </div>

      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="sv-desc">
            توضیح
          </label>
          <input
            id="sv-desc"
            className="form-control"
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <Flags
          idPrefix="sv"
          resellersOnly={resellersOnly}
          oncePerUser={oncePerUser}
          onResellers={setResellersOnly}
          onOnce={setOncePerUser}
        />
      </div>

      <label className="form-label" style={{ marginBlockStart: 8 }}>
        گروهِ این سرویس روی پنل
      </label>
      {panelId === '' ? (
        <p className="muted">این سرویس پنلی ندارد، پس چیزی تحویل نمی‌دهد.</p>
      ) : (
        <GroupManager
          panelId={Number(panelId)}
          selected={groupIds}
          onToggle={toggleGroup}
          onChanged={onChanged}
        />
      )}
      {groupIds === null && (
        <p className="muted">
          این سرویس گروه خودش را ندارد و پیش‌فرض پنل رویش اعمال می‌شود. یکی را تیک بزنید تا
          خودش تصمیم بگیرد.
        </p>
      )}
      {groupIds !== null && groupIds.length === 0 && (
        <div className="alert alert-warning">
          هیچ گروهی انتخاب نشده. این سرویس ساخته می‌شود ولی مشتری هیچ کانفیگی نمی‌گیرد.
        </div>
      )}

      <div style={{ marginBlockStart: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void save()}
          {...w}
        >
          ذخیرهٔ سرویس
        </button>
      </div>

      <div className="filters" style={{ marginBlockStart: 12 }}>
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            className="btn btn-sm"
            disabled={busy || service.status === s}
            onClick={() => void setStatus(s)}
            {...w}
          >
            {STATUS_FA[s]}
          </button>
        ))}
        <button
          type="button"
          className="btn btn-sm btn-danger"
          disabled={busy}
          onClick={() => void remove()}
          {...w}
        >
          حذف سرویس
        </button>
      </div>
      <p className="muted">
        «غیرفعال» سرویس را از ربات برمی‌دارد و تاریخچهٔ فروش دست‌نخورده می‌ماند. حذف فقط وقتی
        انجام می‌شود که هیچ سفارشی و هیچ اشتراکی به آن وصل نباشد.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

/**
 * What a delete was refused for, and the button that does what was meant.
 *
 * The server's sentence names the counts; this adds the one move that always
 * works — «غیرفعال» takes the row out of the bot, and the orders keep pointing
 * at it.
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

/** The panel a service is sold on. Called «لوکیشن» until 2026-08-24. */
function PanelPicker({
  id,
  value,
  onChange,
  panels,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  panels: ProviderOption[];
}) {
  return (
    <div>
      <label className="form-label" htmlFor={id}>
        پنل
      </label>
      <select
        id={id}
        className="form-control"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">بدون پنل</option>
        {panels.map((p) => (
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
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function add() {
    if (adding.trim() === '') return;
    setBusy(true);
    try {
      const { category } = await api.createCategory(adding.trim());
      onChange(String(category.id));
      setAdding('');
      setOpen(false);
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
      {/* Folded away until asked for.
          `.filters` aligns its cells to the BOTTOM, so an always-open add-box
          made this one cell two rows taller than every other and pushed «پنل»
          and its «افزودن» button onto a line of their own. A category is added
          a few times a year; the form was crooked every time it was opened. */}
      {!open ? (
        <button
          type="button"
          className="btn btn-sm"
          style={{ marginBlockStart: 4 }}
          onClick={() => setOpen(true)}
        >
          + دستهٔ تازه
        </button>
      ) : (
        <div style={{ display: 'flex', gap: 6, marginBlockStart: 4 }}>
          <input
            className="form-control"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            placeholder="دستهٔ تازه"
            aria-label="دستهٔ تازه"
            autoFocus
          />
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void add()}>
            افزودن
          </button>
        </div>
      )}
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
        {/*
         * The same column as before — `products.once_per_user` — under the name
         * of what it actually does.
         *
         * «هر مشتری یک بار» reads as "one copy per customer", and it is not
         * that. The bot's predicate hides the service from anyone who owns ANY
         * subscription (`catalog.ts:51-63`), so it is a first-timers-only flag
         * and always has been. Sam asked for a tick that shows a service only to
         * customers who have never bought — and it existed, wearing a name that
         * described a different feature.
         *
         * No migration, no change to the bot. A label and a sentence.
         */}
        <label className="form-label" htmlFor={`${idPrefix}-once`}>
          فقط برای مشتری‌های اولین‌بار
        </label>
        <input
          id={`${idPrefix}-once`}
          type="checkbox"
          checked={oncePerUser}
          onChange={(e) => onOnce(e.target.checked)}
        />
        <p className="muted">
          تا وقتی مشتری هیچ سرویسی نخریده این را می‌بیند؛ بعد از اولین خرید، برایش ناپدید می‌شود —
          پس تمدیدش باید از سرویس دیگری روی همان پنل انجام شود.
        </p>
      </div>
    </>
  );
}
