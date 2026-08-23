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
import type { PanelTestResult } from '../api.js';

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
 * Both halves are named rather than one «تنظیم نشده». They used to be fixed in
 * different places — the address on this screen, the credential only in the
 * server's environment — which is why this screen could describe the problem
 * and not let anybody solve it. Since 2026-08-23 both are fixed here.
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
  const [creating, setCreating] = useState(false);
  const aw = useAdminWriteProps();

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
        {/* Spread last, so it overrides `disabled` only for a role the server
            is going to refuse anyway — see role.tsx. */}
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setOpenId(null);
            setCreating(true);
          }}
          disabled={creating}
          {...aw}
        >
          پنل تازه
        </button>
      </div>

      {creating && (
        <PanelCreator
          onClose={() => setCreating(false)}
          onCreated={() => {
            void load();
          }}
        />
      )}

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
          رمز پنل هیچ‌جا نشان داده نمی‌شود — رمزنگاری‌شده ذخیره می‌شود و فقط سرویس‌هایی که تحویل
          می‌دهند می‌توانند بازش کنند. برای گذاشتن یا عوض‌کردنش «ویرایش» را باز کنید.
        </p>
      </div>

      {open && (
        <PanelEditor panel={open} onClose={() => setOpenId(null)} onChanged={() => void load()} />
      )}
    </>
  );
}

/**
 * تست ارتباط — one control, used by the create form and by the editor.
 *
 * Shared rather than written twice because the two must not disagree about
 * what counts as a pass. The server answers three distinguishable things and
 * all three are rendered differently on purpose:
 *
 *   authenticated — reached it AND logged in. The only green.
 *   reachable     — reached it, login refused. The password is wrong, not the address.
 *   untestable    — a kind with nothing to log into. Deliberately NOT a tick: a
 *                   green here would teach an operator to trust a mark that
 *                   means nothing.
 */
function ConnectionTest({
  run,
  disabled,
}: {
  run: () => Promise<PanelTestResult>;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PanelTestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      setResult(await run());
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginBlockStart: 12 }}>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => void go()}
        disabled={busy || disabled}
      >
        {busy ? 'در حال تست…' : 'تست ارتباط با پنل'}
      </button>
      {err && (
        <div className="alert alert-error" style={{ marginBlockStart: 8 }}>
          {err}
        </div>
      )}
      {result && (
        <div
          className={`alert ${result.authenticated ? 'alert-ok' : 'alert-error'}`}
          style={{ marginBlockStart: 8 }}
        >
          {result.authenticated ? (
            <>
              ارتباط برقرار شد و ورود موفق بود
              {typeof result.accounts === 'number' && ` — ${count(result.accounts)} حساب روی پنل`}
            </>
          ) : result.untestable ? (
            <>{result.reason}</>
          ) : result.reachable ? (
            <>پنل جواب داد ولی ورود پذیرفته نشد — نام کاربری یا رمز درست نیست.</>
          ) : result.reason === 'no_base_url' ? (
            <>آدرس پنل وارد نشده است.</>
          ) : result.reason === 'no_credential' ? (
            <>این پنل هنوز رمزی ندارد.</>
          ) : (
            <>به پنل نرسیدیم — آدرس اشتباه است یا پنل بالا نیست.</>
          )}
        </div>
      )}
    </div>
  );
}

/** The nine `kind`s the schema's CHECK allows, with the names an admin reads. */
const KINDS: ReadonlyArray<{ value: string; label: string; login: boolean }> = [
  { value: 'pasarguard', label: 'پاسارگارد', login: true },
  { value: 'marzban', label: 'مرزبان', login: true },
  { value: 'marzneshin', label: 'مرزنشین', login: true },
  { value: 'hiddify', label: 'هیدیفای', login: true },
  { value: 'xui', label: 'X-UI', login: true },
  { value: 'wireguard', label: 'وایرگارد', login: true },
  { value: 'spotify', label: 'اسپاتیفای', login: true },
  { value: 'ai_account', label: 'حساب هوش مصنوعی', login: false },
  { value: 'manual', label: 'دستی', login: false },
];

function PanelCreator({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState('pasarguard');
  const [baseUrl, setBaseUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const needsLogin = KINDS.find((k) => k.value === kind)?.login ?? true;
  const hasCredential = username.trim() !== '' && password !== '';

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      await api.createPanel({
        code: code.trim(),
        name: name.trim(),
        kind,
        baseUrl: baseUrl.trim() === '' ? null : baseUrl.trim(),
        ...(hasCredential ? { credential: { username: username.trim(), password } } : {}),
      });
      onCreated();
      onClose();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBlockStart: 16 }}>
      <div className="card__head">
        <span className="card__title">پنل تازه</span>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          بستن
        </button>
      </div>

      {err && <div className="alert alert-error">{err}</div>}

      {/* `filters` + `grow` + `form-label` + `form-control` — the same classes
          PanelEditor uses. An earlier version of this form invented
          `form-grid` and `input`, neither of which exists in theme.css, so
          every field rendered unstyled on one cramped row. Reading the
          screenshot is what caught it; the markup looked reasonable. */}
      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="new-panel-code">
            کد پنل
          </label>
          <input
            id="new-panel-code"
            className="form-control ltr"
            type="text"
            maxLength={60}
            placeholder="test-panel"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        <div className="grow">
          <label className="form-label" htmlFor="new-panel-name">
            نام
          </label>
          <input
            id="new-panel-name"
            className="form-control"
            type="text"
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="new-panel-kind">
            نوع
          </label>
          <select
            id="new-panel-kind"
            className="form-control"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="muted">کد پنل حروف کوچک انگلیسی، رقم و خط تیره است و بعداً عوض نمی‌شود.</p>

      {needsLogin && (
        <div className="filters">
          <div className="grow">
            <label className="form-label" htmlFor="new-panel-url">
              آدرس پنل
            </label>
            <input
              id="new-panel-url"
              className="form-control ltr"
              type="text"
              placeholder="https://panel.example.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div className="grow">
            <label className="form-label" htmlFor="new-panel-user">
              نام کاربری پنل
            </label>
            <input
              id="new-panel-user"
              className="form-control ltr"
              type="text"
              autoComplete="off"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="grow">
            <label className="form-label" htmlFor="new-panel-pass">
              رمز پنل
            </label>
            <input
              id="new-panel-pass"
              className="form-control ltr"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        </div>
      )}

      {needsLogin && (
        <p className="muted">رمز رمزنگاری‌شده ذخیره می‌شود و هیچ صفحه‌ای دوباره نشانش نمی‌دهد.</p>
      )}

      {/* Before saving, deliberately: a panel saved and only then found broken
          is ACTIVE for however long it takes somebody to notice. */}
      {needsLogin && (
        <ConnectionTest
          disabled={baseUrl.trim() === '' || !hasCredential}
          run={() =>
            api.testPanel(0, {
              baseUrl: baseUrl.trim(),
              kind,
              credential: { username: username.trim(), password },
            })
          }
        />
      )}

      {needsLogin && !hasCredential && (
        <div className="alert" style={{ marginBlockStart: 8 }}>
          بدون رمز، پنل <b>غیرفعال</b> ساخته می‌شود — چون پنلی که نتواند وارد شود، سفارشِ پرداخت‌شده
          را رد می‌کند و پول مشتری برمی‌گردد.
        </div>
      )}

      <div style={{ marginBlockStart: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void create()}
          disabled={busy || code.trim() === '' || name.trim() === ''}
        >
          {busy ? 'در حال ساخت…' : 'ساخت پنل'}
        </button>
      </div>
    </div>
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
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
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

  async function saveCredential() {
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      await api.setPanelCredential(panel.id, { username: username.trim(), password });
      setPassword('');
      setDone('رمز پنل ذخیره شد.');
      onChanged();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
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
      <p className="muted">ظرفیت خالی یعنی نامحدود. آدرس و نوع پنل از این‌جا عوض نمی‌شوند.</p>

      <h4>ارتباط با پنل</h4>
      {/* Uses the STORED credential when the two boxes are empty, so pressing
          it on an untouched panel answers the question an operator actually
          has: does this panel work right now. */}
      <ConnectionTest run={() => api.testPanel(panel.id, {})} />

      <h4>رمز پنل</h4>
      <p className="muted">
        رمز فعلی هیچ‌جا نشان داده نمی‌شود — رمزنگاری‌شده ذخیره شده و فقط سرویس‌هایی که تحویل می‌دهند
        می‌توانند بازش کنند. برای عوض‌کردن، رمز تازه را این‌جا بنویسید.
      </p>
      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="panel-username">
            نام کاربری پنل
          </label>
          <input
            id="panel-username"
            className="form-control ltr"
            type="text"
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="grow">
          <label className="form-label" htmlFor="panel-password">
            رمز تازه
          </label>
          <input
            id="panel-password"
            className="form-control ltr"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || username.trim() === '' || password === ''}
          onClick={() => void saveCredential()}
          {...w}
        >
          ذخیرهٔ رمز
        </button>
      </div>
      {/* Testing what was TYPED, before it replaces what is stored. Pressing
          «ذخیرهٔ رمز» on a wrong password takes the panel down silently — it
          stays ACTIVE and every order on it starts failing. */}
      <ConnectionTest
        disabled={username.trim() === '' || password === ''}
        run={() =>
          api.testPanel(panel.id, {
            credential: { username: username.trim(), password },
          })
        }
      />

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
