/**
 * مدیریت پنل‌ها — the servers that actually deliver what the shop sells.
 *
 * `panel/panels.php` puts the panel's username, password and API token on the
 * same form as its name. This screen has no credential field, because the API
 * has no credential route: `secret_ref` names a secret in the runtime store and
 * `config` carries a shared secret provisioning has to send, so neither ever
 * reaches the browser. All this page knows is whether a credential exists.
 *
 * What it adds instead is the number the PHP screen does not have: how many
 * live subscriptions sit on each panel. Disabling a panel is routine or
 * catastrophic depending entirely on that figure, and over there an admin finds
 * it out from the customers.
 */

import { useEffect, useState } from 'react';
import { api, ApiError, type PanelItem } from '../api.js';
import { count } from '../format.js';
import { useAdminWriteProps } from '../role.js';

const STATUS_FA: Record<string, string> = { ACTIVE: 'فعال', DISABLED: 'غیرفعال' };

/**
 * `kind` is the adapter that fulfils an order.
 *
 * `pasarguard` and `marzban` are two names on one wire protocol, and the
 * distinction is real: Mirzabot stored a PasarGuard panel as `type='marzban'`
 * with `version_panel='1'`, so every production row imported as `marzban` is
 * actually PasarGuard. Both are listed because a classic Marzban could still
 * be added, and then the label has to tell them apart.
 */
const KIND_FA: Record<string, string> = {
  pasarguard: 'پاسارگارد',
  marzban: 'مرزبان',
  marzneshin: 'مرزنشین',
  hiddify: 'هیدیفای',
  xui: 'X-UI',
  wireguard: 'وایرگارد',
  ai_account: 'اکانت هوش مصنوعی',
  spotify: 'اسپاتیفای',
  manual: 'دستی',
};

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'برای این کار دسترسی ادمین لازم است.';
    if (e.code === 'admin_access_not_configured') return 'درِ دسترسی ادمین تنظیم نشده است.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Kinds that reach a panel over the network, and so cannot work without an
 * address and a credential.
 *
 * `manual` fulfils by hand and `ai_account`/`spotify` are handed over from the
 * shelf, so a missing `base_url` on those is not a fault — it is the normal
 * state. Listing the remote ones explicitly, rather than testing for `!==
 * 'manual'`, is what keeps a newly added local kind from being flagged as
 * broken the day it ships.
 */
const REACHES_A_PANEL: ReadonlySet<string> = new Set([
  'pasarguard',
  'marzban',
  'marzneshin',
  'hiddify',
  'xui',
  'wireguard',
]);

/**
 * Why an ACTIVE panel still cannot fulfil an order, or null when it can.
 *
 * The status column reported the admin's *intent* and nothing else: walking
 * this screen on 2026-08-22 showed `sim-vip` — PasarGuard, five products, five
 * live services — as «فعال» in green with no address and no credential. It
 * cannot provision anything. `marzban.ts:147` answers that state with
 * `retryable: false`, which is right and means the customer pays, waits, and
 * is refunded with a «تماس بگیرید» — a lost sale and a support conversation
 * that the row itself already had enough information to prevent.
 *
 * Both halves are named rather than one «تنظیم نشده», because the two are
 * fixed in different places: the address on this screen, the credential only
 * in the server's secret store.
 */
function cannotDeliver(p: {
  kind: string;
  status: string;
  baseUrl: string | null;
  hasSecretRef: boolean;
}): string | null {
  if (p.status !== 'ACTIVE' || !REACHES_A_PANEL.has(p.kind)) return null;
  const missing = [...(p.baseUrl ? [] : ['آدرس']), ...(p.hasSecretRef ? [] : ['اعتبارنامه'])];
  return missing.length === 0 ? null : `بدون ${missing.join(' و ')}`;
}

/** The address without its scheme — the list is about identity, not linking. */
function host(url: string | null): string {
  if (!url) return '—';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function PanelsPage() {
  const [rows, setRows] = useState<PanelItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      setRows((await api.panels()).items);
    } catch (e) {
      setErr(message(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const open = rows.find((r) => r.id === openId) ?? null;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">مدیریت پنل‌ها</div>
          <div className="page-head__sub">{count(rows.length)} پنل</div>
        </div>
      </div>

      <div className="card">
        {err && <div className="alert alert-error">{err}</div>}

        <div className="table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>نام پنل</th>
                <th>نوع</th>
                <th>آدرس</th>
                <th>ظرفیت</th>
                <th>محصولات</th>
                <th>سرویس زنده</th>
                <th>اعتبارنامه</th>
                <th>وضعیت</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading && (
                <tr>
                  <td className="empty" colSpan={9}>
                    هیچ پنلی ثبت نشده است.
                  </td>
                </tr>
              )}
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div>{p.name}</div>
                    <div className="page-head__sub ltr">{p.code}</div>
                  </td>
                  <td>{KIND_FA[p.kind] ?? p.kind}</td>
                  <td className="ltr">{host(p.baseUrl)}</td>
                  {/* NULL capacity is unlimited — the legacy 'unlimited' string. */}
                  <td>{p.capacity === null ? 'نامحدود' : count(p.capacity)}</td>
                  <td>
                    {count(p.productCount)} محصول · {count(p.planCount)} پلن
                  </td>
                  <td>{count(p.liveSubscriptions)}</td>
                  <td>
                    {p.hasSecretRef ? (
                      <span className="badge badge-active">ثبت شده</span>
                    ) : (
                      <span className="badge badge-block">ندارد</span>
                    )}
                  </td>
                  <td>
                    {/* «فعال» is what the admin asked for; whether it can act
                        on that is a second question this cell now answers. */}
                    <span
                      className={
                        p.status === 'ACTIVE' && cannotDeliver(p) === null
                          ? 'badge badge-active'
                          : 'badge badge-block'
                      }
                    >
                      {STATUS_FA[p.status] ?? p.status}
                    </span>
                    {cannotDeliver(p) !== null && (
                      <div className="page-head__sub">
                        {cannotDeliver(p)} — سفارشی از این پنل تحویل نمی‌شود
                      </div>
                    )}
                  </td>
                  <td>
                    <button type="button" className="btn btn-sm" onClick={() => setOpenId(p.id)}>
                      ویرایش
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="muted">
          نام کاربری، رمز و توکن پنل این‌جا نه نشان داده می‌شوند و نه قابل تغییرند — در secret store
          سرور می‌مانند و هیچ مسیری در این پنل نمی‌تواند بنویسدشان.
        </p>
      </div>

      {open && (
        <PanelEditor panel={open} onClose={() => setOpenId(null)} onChanged={() => void load()} />
      )}
    </>
  );
}

function PanelEditor({
  panel,
  onClose,
  onChanged,
}: {
  panel: PanelItem;
  onClose: () => void;
  onChanged: () => void;
}) {
  const w = useAdminWriteProps();
  const [name, setName] = useState(panel.name);
  const [capacity, setCapacity] = useState(panel.capacity === null ? '' : String(panel.capacity));
  const [sortOrder, setSortOrder] = useState(String(panel.sortOrder));
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(patch: Parameters<typeof api.updatePanel>[1], okMessage: string) {
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      await api.updatePanel(panel.id, patch);
      setDone(okMessage);
      onChanged();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const patch: Parameters<typeof api.updatePanel>[1] = {};
    if (name.trim() !== panel.name) patch.name = name.trim();
    const nextCapacity = capacity.trim() === '' ? null : Number(capacity);
    if (nextCapacity !== panel.capacity) patch.capacity = nextCapacity;
    const nextSort = Number(sortOrder);
    if (Number.isFinite(nextSort) && nextSort !== panel.sortOrder) patch.sortOrder = nextSort;
    if (Object.keys(patch).length === 0) {
      setDone('چیزی تغییر نکرده بود.');
      return;
    }
    await send(patch, 'ذخیره شد.');
  }

  async function toggleStatus() {
    const next = panel.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    if (
      next === 'DISABLED' &&
      panel.liveSubscriptions > 0 &&
      !window.confirm(
        `${panel.liveSubscriptions.toLocaleString('fa-IR')} سرویس زنده روی این پنل است و تمدیدشان از کار می‌افتد. غیرفعال شود؟`,
      )
    ) {
      return;
    }
    await send({ status: next }, next === 'DISABLED' ? 'پنل غیرفعال شد.' : 'پنل فعال شد.');
  }

  return (
    <div className="card" style={{ marginBlockStart: 16 }}>
      <div className="card__head">
        <span className="card__title">
          {panel.name} <span className="muted ltr">{panel.code}</span>
        </span>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          بستن
        </button>
      </div>

      {err && <div className="alert alert-error">{err}</div>}
      {done && <div className="alert alert-info">{done}</div>}

      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="panel-name">
            نام پنل
          </label>
          <input
            id="panel-name"
            className="form-control"
            type="text"
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="panel-capacity">
            ظرفیت
          </label>
          <input
            id="panel-capacity"
            className="form-control ltr"
            type="number"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            placeholder="نامحدود"
          />
        </div>
        <div>
          <label className="form-label" htmlFor="panel-sort">
            ترتیب نمایش
          </label>
          <input
            id="panel-sort"
            className="form-control ltr"
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
          />
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
      </div>
      <p className="muted">
        ظرفیت خالی یعنی نامحدود. آدرس، نوع پنل و اعتبارنامه از این‌جا عوض نمی‌شوند.
      </p>

      <h4>وضعیت</h4>
      <p className="muted" style={{ marginBlockStart: 0 }}>
        {count(panel.liveSubscriptions)} سرویس زنده و {count(panel.planCount)} پلن روی این پنل است.
        غیرفعال‌کردن، پنل را از خرید و تمدید برمی‌دارد؛ سرویس‌های فروخته‌شده پاک نمی‌شوند.
      </p>
      <div className="filters">
        <button
          type="button"
          className={panel.status === 'ACTIVE' ? 'btn btn-danger' : 'btn btn-primary'}
          disabled={busy}
          onClick={() => void toggleStatus()}
          {...w}
        >
          {panel.status === 'ACTIVE' ? 'غیرفعال کن' : 'فعال کن'}
        </button>
      </div>
    </div>
  );
}
