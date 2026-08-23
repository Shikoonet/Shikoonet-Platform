/**
 * مدیریت پنل‌ها — the servers that actually deliver what the shop sells.
 *
 * `panel/panels.php` puts the panel's username, password and API token on the
 * same form as its name. This screen takes a password too, since 2026-08-23 —
 * it had to, because the alternative was that panels could only be added by
 * editing the bot's environment in Coolify and redeploying. What it does NOT do
 * is give one back: the password is sealed on the way in and no route here
 * reads one out, so the only thing this page ever knows about a stored
 * credential is that it exists.
 *
 * `config` still never reaches the browser either — it carries a hysteria
 * shared secret provisioning has to send. The one part of it this screen does
 * show is `group_ids`, because that is not a secret; it is the number that
 * decides what a paying customer receives.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Rebuilt 2026-08-23 after Sam walked it: «اصلا ui و ux خوبی نداره و بیشتر آدم
 * رو به اشتباه میندازه». Four things were actively misleading rather than
 * merely plain, and each fix below is answering one of them:
 *
 *   1. The status cell drew «فعال» in GREEN and then wrote «بدون آدرس — سفارشی
 *      از این پنل تحویل نمی‌شود» underneath it. Two cells arguing. Now one
 *      column answers one question — can this panel fulfil an order — and the
 *      colour is that answer, not the admin's intent.
 *   2. The editor was a single card holding four unrelated forms, with three
 *      «ذخیره» buttons at three depths all reporting into one message bar at
 *      the very top. Pressing «ذخیرهٔ گروه‌ها» put its result a screen and a
 *      half away. Now: tabs, and each tab owns its own buttons and its own
 *      result line.
 *   3. TWO buttons both reading «تست ارتباط با پنل» sat on that card, one
 *      testing the stored password and one testing the typed one. Nothing on
 *      either said which. They are now named for what they test.
 *   4. `alert-ok` — the class the passing connection test asked for — did not
 *      exist in theme.css, so success rendered in the same neutral grey as a
 *      notice. Added there rather than worked around here.
 *
 * And the thing that was missing rather than wrong: groups could be TICKED but
 * not made. A group is the product tier — «پلاتینیوم» is a group with more
 * inbounds in it — so a shop that cannot create one cannot add a tier without
 * somebody opening the panel's own web UI. It can now.
 */

import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type PanelItem } from '../api.js';
import { count } from '../format.js';
import { useAdminWriteProps } from '../role.js';
import { InboundCount } from '../groups.js';
import type { PanelGroups, PanelHostItem, PanelTestResult } from '../api.js';

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
 * One sentence about whether a paid order on this panel will be delivered.
 *
 * This replaces a status column that reported the admin's *intent* and a
 * separate credential column that reported one input to it. Walking the screen
 * on 2026-08-22 showed `sim-vip` — PasarGuard, five products, five live
 * services — as «فعال» in green, with no address and no credential, next to a
 * red «ندارد» two cells over. It cannot provision anything, and the green was
 * the biggest thing on the row.
 *
 * `marzban.ts` answers that state with `retryable: false`, which is right and
 * means the customer pays, waits, and is refunded with a «تماس بگیرید» — a lost
 * sale and a support conversation that the row itself already had enough
 * information to prevent. So the row says it, once, in the colour it means.
 */
type Readiness = { tone: 'ok' | 'warn' | 'bad'; label: string; why: string | null };

function readiness(p: {
  kind: string;
  status: string;
  baseUrl: string | null;
  hasSecretRef: boolean;
}): Readiness {
  if (p.status !== 'ACTIVE') {
    return { tone: 'warn', label: 'غیرفعال', why: 'از خرید و تمدید برداشته شده' };
  }
  if (!REACHES_A_PANEL.has(p.kind)) return { tone: 'ok', label: 'فعال', why: null };
  // Both halves are named rather than one «تنظیم نشده», because they used to be
  // fixed in different places and an operator has to know which one to open.
  const missing = [...(p.baseUrl ? [] : ['آدرس']), ...(p.hasSecretRef ? [] : ['رمز'])];
  if (missing.length > 0) {
    return { tone: 'bad', label: 'تحویل نمی‌دهد', why: `${missing.join(' و ')} ندارد` };
  }
  return { tone: 'ok', label: 'آمادهٔ تحویل', why: null };
}

const TONE_CLASS: Record<Readiness['tone'], string> = {
  ok: 'badge badge-active',
  warn: 'badge badge-warning',
  bad: 'badge badge-block',
};

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
  const broken = rows.filter((r) => readiness(r).tone === 'bad').length;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">مدیریت پنل‌ها</div>
          <div className="page-head__sub">
            {count(rows.length)} پنل
            {broken > 0 && ` — ${count(broken)} تای‌شان سفارش تحویل نمی‌دهند`}
          </div>
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

      {/* Both editors sit ABOVE the list. They used to render underneath it, so
          pressing «ویرایش» on a row near the top scrolled nothing and changed
          nothing an operator could see — the form they had just asked for was
          off the bottom of the screen. */}
      {creating && (
        <PanelCreator
          onClose={() => setCreating(false)}
          onCreated={() => {
            void load();
          }}
        />
      )}

      {open && (
        <PanelEditor
          key={open.id}
          panel={open}
          onClose={() => setOpenId(null)}
          onChanged={() => void load()}
        />
      )}

      <div className="card">
        {err && <div className="alert alert-error">{err}</div>}

        <div className="table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>پنل</th>
                <th>نوع</th>
                <th>وضعیت</th>
                <th>اشتراک زنده</th>
                <th>می‌فروشد</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading && (
                <tr>
                  <td className="empty" colSpan={6}>
                    هیچ پنلی ثبت نشده است.
                  </td>
                </tr>
              )}
              {rows.map((p) => {
                const r = readiness(p);
                return (
                  <tr key={p.id}>
                    <td>
                      <div>{p.name}</div>
                      <div className="page-head__sub ltr">
                        {p.code} · {host(p.baseUrl)}
                      </div>
                    </td>
                    <td>{KIND_FA[p.kind] ?? p.kind}</td>
                    <td>
                      <span className={TONE_CLASS[r.tone]}>{r.label}</span>
                      {r.why !== null && <div className="page-head__sub">{r.why}</div>}
                    </td>
                    {/* Capacity is only meaningful beside what is on it, and
                        NULL capacity is unlimited — the legacy 'unlimited'. */}
                    <td className="ltr">
                      {count(p.liveSubscriptions)}
                      <span className="muted">
                        {p.capacity === null ? ' / ∞' : ` / ${count(p.capacity)}`}
                      </span>
                    </td>
                    <td>
                      {count(p.productCount)} سرویس · {count(p.planCount)} کانفیگ
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setCreating(false);
                          setOpenId(p.id);
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                      >
                        مدیریت
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="muted">
          رمز پنل هیچ‌جا نشان داده نمی‌شود — رمزنگاری‌شده ذخیره می‌شود و فقط سرویس‌هایی که تحویل
          می‌دهند می‌توانند بازش کنند. برای گذاشتن یا عوض‌کردنش «مدیریت» را باز کنید.
        </p>
      </div>
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
 *
 * `label` is required rather than defaulted. Two of these live on one card —
 * one testing the stored credential, one testing what has just been typed — and
 * while both read «تست ارتباط با پنل» there was no way to tell from the screen
 * which question was being answered, or which answer belonged to which button.
 */
function ConnectionTest({
  label,
  hint,
  run,
  disabled,
}: {
  label: string;
  hint?: string;
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
        {busy ? 'در حال تست…' : label}
      </button>
      {hint !== undefined && (
        <div className="page-head__sub" style={{ marginBlockStart: 4 }}>
          {hint}
        </div>
      )}
      {err && (
        <div className="alert alert-error" style={{ marginBlockStart: 8 }}>
          {err}
        </div>
      )}
      {result && (
        <div
          className={`alert ${
            result.authenticated ? 'alert-ok' : result.untestable ? 'alert-info' : 'alert-error'
          }`}
          style={{ marginBlockStart: 8 }}
        >
          {result.authenticated ? (
            <>
              ارتباط برقرار شد و ورود موفق بود
              {typeof result.groups === 'number' && ` — ${count(result.groups)} گروه روی پنل`}
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
    <div className="card" style={{ marginBlockEnd: 16 }}>
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
        <>
          {/* The legacy wizard printed these rules and trusted the operator to
              apply them by hand. The server applies them now — this paragraph
              is the courtesy of saying so, not the guard. */}
          <p className="muted">
            آدرس را بدون <span className="ltr">/dashboard</span> و بدون{' '}
            <span className="ltr">/</span> آخر بنویسید، و اگر پورت ۴۴۳ است لازم نیست وارد شود.
            هرکدام را فراموش کنید خودمان برمی‌داریم — ولی <span className="ltr">http</span> یا{' '}
            <span className="ltr">https</span> باید باشد، چون حدس‌زدنش یا رمز را لخت می‌فرستد یا روی
            گواهی می‌شکند.
          </p>
          <p className="muted">رمز رمزنگاری‌شده ذخیره می‌شود و هیچ صفحه‌ای دوباره نشانش نمی‌دهد.</p>
        </>
      )}

      {/* Before saving, deliberately: a panel saved and only then found broken
          is ACTIVE for however long it takes somebody to notice. */}
      {needsLogin && (
        <ConnectionTest
          label="تست ارتباط، قبل از ساخت"
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
        <div className="alert alert-warning" style={{ marginBlockStart: 8 }}>
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

/**
 * گروه‌های پنل — what this panel HAS, and who sells it.
 *
 * A report, not an editor. Until 2026-08-24 this tab also carried a tick column
 * («پیش‌فرض پنل»), a save button, and create/edit/delete for the groups
 * themselves — which made it the second half of a job whose first half was on
 * another screen, with nothing on either saying so. An operator ticked a group
 * here three times, saved, and watched the bot not change: the ticks are a
 * FALLBACK that only reaches a customer through a service which has chosen no
 * level of its own, and every service on that panel had chosen one.
 *
 * All of that moved to «سرویس‌ها», next to the service that sells the group.
 * What stays is the half only this screen can answer, because it is about the
 * panel rather than about our rows:
 *
 *   - what the panel actually has, asked of the panel
 *   - how much of each group reaches a customer (an inbound with no host is in
 *     every listing and delivers nothing)
 *   - **a group we send that the panel does not have** — the group-42 case.
 *     PasarGuard answers a create with `404 Group not found` and the adapter
 *     calls that non-retryable, so every order on that level would go FAILED
 *     and refund. A number frozen in our config cannot notice; this can.
 */
export function PanelGroupsSection({
  panel,
  onProblem,
}: {
  panel: PanelItem;
  onProblem: (has: boolean) => void;
}) {
  const [data, setData] = useState<PanelGroups | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .panelGroups(panel.id)
      .then((next) => {
        if (live) setData(next);
      })
      .catch((e) => {
        if (live) setErr(message(e));
      });
    return () => {
      live = false;
    };
  }, [panel.id]);

  const available = data?.available ?? null;
  // Ids we send that the panel does not have. This is the group-42 case, and it
  // is the reason this tab still exists.
  const missing =
    available === null || data === null
      ? []
      : data.selected.filter((id) => !available.some((g) => g.id === id));

  useEffect(() => {
    onProblem(missing.length > 0);
  }, [missing.length]);

  if (err !== null) return <div className="alert alert-error">{err}</div>;
  if (data === null) return <p className="muted">…</p>;

  /** Which of our services sell this group, so the row answers «چه کسی؟». */
  function soldBy(id: number): string[] {
    const via: string[] = [];
    const riders = data?.inherit ?? [];
    if (data !== null && data.selected.includes(id) && riders.length > 0) {
      via.push(`پیش‌فرض پنل (${riders.map((p) => p.name).join('، ')})`);
    }
    for (const pl of data?.plans ?? []) {
      if (!Array.isArray(pl.groups) || !(pl.groups as unknown[]).includes(id)) continue;
      via.push(pl.level === 'PRODUCT' ? `سرویس ${pl.name}` : `کانفیگ ${pl.name}`);
    }
    return via;
  }

  return (
    <>
      <p className="muted" style={{ marginBlockStart: 0 }}>
        این‌ها گروه‌هایی هستند که <b>خودِ پنل</b> دارد — فهرست از پنل خوانده می‌شود، نه از
        تنظیمات ما. ساختن، ویرایش و الصاق اینباند در صفحهٔ <b>«سرویس‌ها»</b> انجام می‌شود، کنار
        همان سرویسی که گروه را می‌فروشد.
      </p>

      {available === null ? (
        <div className="alert alert-error">
          فهرست گروه‌ها از پنل خوانده نشد{data.reason ? ` — ${data.reason}` : ''}.
        </div>
      ) : (
        <>
          {missing.length > 0 && (
            <div className="alert alert-error">
              گروه {missing.join('، ')} در تنظیمات این پنل هست ولی <b>روی خودِ پنل وجود ندارد</b>.
              هر خریدی که این گروه را بفرستد شکست می‌خورد و پول مشتری برمی‌گردد.
            </div>
          )}

          <div className="table-wrap" style={{ marginBlockStart: 12 }}>
            <table className="app-table">
              <thead>
                <tr>
                  <th>گروه</th>
                  <th>شناسه</th>
                  <th>اینباند</th>
                  <th>اعضا</th>
                  <th>فروخته می‌شود در</th>
                </tr>
              </thead>
              <tbody>
                {available.length === 0 && (
                  <tr>
                    <td className="empty" colSpan={5}>
                      این پنل هیچ گروهی ندارد. اولی را از «سرویس‌ها» بسازید.
                    </td>
                  </tr>
                )}
                {available.map((g) => {
                  const via = soldBy(g.id);
                  return (
                    <tr key={g.id}>
                      <td>
                        <div>{g.name}</div>
                        {g.inboundTags && g.inboundTags.length > 0 && (
                          <div className="page-head__sub ltr">{g.inboundTags.join(' · ')}</div>
                        )}
                        {g.disabled === true && (
                          <span className="badge badge-warning">روی پنل خاموش است</span>
                        )}
                      </td>
                      <td className="ltr">{g.id}</td>
                      <td>
                        <InboundCount group={g} />
                      </td>
                      <td>{g.memberCount === undefined ? '—' : count(g.memberCount)}</td>
                      <td>
                        {via.length === 0 ? (
                          <span className="muted">فروخته نمی‌شود</span>
                        ) : (
                          via.join('، ')
                        )}
                      </td>
                    </tr>
                  );
                })}
                {missing.map((id) => (
                  <tr key={`missing-${id}`}>
                    <td>
                      <span className="badge badge-block">روی پنل نیست</span>
                    </td>
                    <td className="ltr">{id}</td>
                    <td>—</td>
                    <td>—</td>
                    <td>{soldBy(id).join('، ') || <span className="muted">فروخته نمی‌شود</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

/**
 * اینباندها — and what «ساختن» one actually means here.
 *
 * The panel has no inbound endpoint. `POST /api/inbound` is 404 and
 * `/api/inbounds` is 405, asked on 2026-08-23: an inbound is a section of the
 * panel's Xray core config, and the only way to add one is to rewrite that
 * whole config. A dashboard that offers a button for that can take every
 * customer's proxy down with one bad edit, not one tier — so it does not offer
 * one.
 *
 * What was actually missing is the HOST, and it is the half that decides
 * delivery. A host points at an inbound and carries the address the customer
 * connects to; an inbound with no host is in every listing, counts toward every
 * total, and hands the customer nothing. That was measured the hard way: a
 * `vip` group with two inbounds delivered exactly what a `normal` group with
 * one delivered, until a host went on the second and the same subscription link
 * went to two configs with nothing re-delivered.
 *
 * So the screen shows the inbounds the panel HAS, and lets an address be added
 * to any of them. That is the whole of what an operator building a tier needs,
 * and it is honest about which of the two things it is doing.
 */
function PanelHostsSection({ panel }: { panel: PanelItem }) {
  const w = useAdminWriteProps();
  const [hosts, setHosts] = useState<PanelHostItem[] | null>(null);
  const [inbounds, setInbounds] = useState<Array<{ tag: string; hosted?: boolean }> | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [remark, setRemark] = useState('');
  const [address, setAddress] = useState('');
  const noticeRef = useRef<HTMLDivElement | null>(null);

  async function load() {
    setBusy(true);
    try {
      const [h, i] = await Promise.all([api.panelHosts(panel.id), api.panelInbounds(panel.id)]);
      setHosts(h.hosts);
      setInbounds(i.inbounds);
      setReason(h.reason ?? i.reason ?? null);
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, [panel.id]);

  useEffect(() => {
    if (err !== null || done !== null) {
      noticeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [err, done]);

  async function create() {
    if (adding === null) return;
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      const host = await api.createPanelHost(panel.id, {
        remark: remark.trim(),
        inboundTag: adding,
        // Empty is a real answer and the panel accepts it: the host then
        // resolves to the panel's own address, which is what a single-server
        // shop wants and what somebody leaving the box blank means.
        addresses: address.trim() === '' ? [] : address.split(',').map((a) => a.trim()),
      });
      setDone(`هاست «${host.host.remark}» روی «${adding}» ساخته شد — این اینباند حالا کانفیگ می‌دهد.`);
      setAdding(null);
      setRemark('');
      setAddress('');
      await load();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(h: PanelHostItem) {
    if (
      !window.confirm(
        `هاست «${h.remark}» روی «${h.inboundTag}» حذف شود؟ اگر آخرین هاست این اینباند باشد، مشتری‌های آن اینباند یک کانفیگ کمتر می‌گیرند.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      await api.deletePanelHost(panel.id, h.id);
      setDone(`هاست «${h.remark}» حذف شد.`);
      await load();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="muted" style={{ marginBlockStart: 0 }}>
        اینباند را پنل در تنظیمات Xray خودش تعریف می‌کند و از این‌جا ساخته نمی‌شود — API ندارد، و
        دست‌بردن در آن تنظیمات یعنی ریسکِ قطع‌شدن سرویسِ همهٔ مشتری‌ها، نه یک سطح. آن‌چه از این‌جا
        ساخته می‌شود <b>هاست</b> است: آدرسی که روی یک اینباند می‌نشیند. اینباندی که هاست ندارد در
        همهٔ فهرست‌ها هست و در اشتراک مشتری <b>نیست</b>.
      </p>

      <div ref={noticeRef}>
        {err && <div className="alert alert-error">{err}</div>}
        {done && <div className="alert alert-ok">{done}</div>}
      </div>

      {inbounds === null ? (
        <div className="alert alert-warning">
          فهرست اینباندها از پنل خوانده نشد{reason ? ` — ${reason}` : ''}.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>اینباند</th>
                <th>هاست‌ها</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {inbounds.length === 0 && (
                <tr>
                  <td className="empty" colSpan={3}>
                    این پنل هیچ اینباندی ندارد.
                  </td>
                </tr>
              )}
              {inbounds.map((i) => {
                const mine = (hosts ?? []).filter((h) => h.inboundTag === i.tag);
                const live = mine.filter((h) => !h.disabled);
                return (
                  <tr key={i.tag}>
                    <td>
                      <div className="ltr">{i.tag}</div>
                      {live.length === 0 && (
                        <span className="badge badge-block">به مشتری کانفیگ نمی‌دهد</span>
                      )}
                    </td>
                    <td>
                      {mine.length === 0 ? (
                        <span className="muted">هیچ</span>
                      ) : (
                        mine.map((h) => (
                          <div key={h.id} style={{ marginBlockEnd: 4 }}>
                            {/* One `ltr` span around the whole pair, not two
                                side by side. Two of them in an RTL row put the
                                second BEFORE the first and swallowed the
                                separator — «www.shikoneet.comtest-host» on the
                                live screen, which reads as one broken string
                                rather than a name and an address. Seen in the
                                screenshot; the markup looked fine. */}
                            <span className="ltr">
                              {h.remark}
                              {h.addresses.length > 0 && (
                                <span className="muted"> · {h.addresses.join(', ')}</span>
                              )}
                            </span>{' '}
                            {h.disabled && <span className="badge badge-warning">خاموش</span>}{' '}
                            <button
                              type="button"
                              className="btn btn-sm btn-danger"
                              onClick={() => void remove(h)}
                              {...w}
                            >
                              حذف
                            </button>
                          </div>
                        ))
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setAdding(i.tag);
                          setRemark('');
                          setAddress('');
                          setDone(null);
                        }}
                        {...w}
                      >
                        + هاست
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {adding !== null && (
        <div className="card" style={{ marginBlock: 12 }}>
          <div className="card__head">
            <span className="card__title">
              هاست تازه روی <span className="ltr">{adding}</span>
            </span>
            <button type="button" className="btn btn-sm" onClick={() => setAdding(null)}>
              انصراف
            </button>
          </div>
          <div className="filters">
            <div className="grow">
              <label className="form-label" htmlFor="host-remark">
                نام هاست
              </label>
              <input
                id="host-remark"
                className="form-control"
                type="text"
                maxLength={120}
                placeholder="آلمان-۱"
                value={remark}
                onChange={(e) => setRemark(e.target.value)}
                {...w}
              />
            </div>
            <div className="grow">
              <label className="form-label" htmlFor="host-address">
                آدرس
              </label>
              <input
                id="host-address"
                className="form-control ltr"
                type="text"
                placeholder="de1.example.com"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                {...w}
              />
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || remark.trim() === ''}
              onClick={() => void create()}
              {...w}
            >
              بساز
            </button>
          </div>
          <p className="muted">
            آدرس خالی یعنی همان آدرس خودِ پنل، که برای فروشگاهِ تک‌سروری همان چیزی است که می‌خواهید.
            چند آدرس را با ویرگول جدا کنید.
          </p>
        </div>
      )}
    </>
  );
}

type Tab = 'info' | 'link' | 'inbounds' | 'groups' | 'status';

const TAB_FA: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'info', label: 'اطلاعات' },
  { id: 'link', label: 'اتصال و رمز' },
  { id: 'inbounds', label: 'اینباند و هاست' },
  { id: 'groups', label: 'گروه‌ها' },
  { id: 'status', label: 'وضعیت' },
];

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
  const [tab, setTab] = useState<Tab>('info');
  const [name, setName] = useState(panel.name);
  const [capacity, setCapacity] = useState(panel.capacity === null ? '' : String(panel.capacity));
  const [sortOrder, setSortOrder] = useState(String(panel.sortOrder));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [groupProblem, setGroupProblem] = useState(false);

  const r = readiness(panel);
  // Which tabs hold something an operator has to see. Tabs hide things, and the
  // one thing that must never be hidden is the reason a paid order will fail —
  // so a fault marks its own tab from the moment the card opens.
  const flagged: Record<Tab, boolean> = {
    info: false,
    link: r.tone === 'bad',
    inbounds: false,
    groups: groupProblem,
    status: false,
  };

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
        `${panel.liveSubscriptions.toLocaleString('fa-IR')} اشتراک زنده روی این پنل است و تمدیدشان از کار می‌افتد. غیرفعال شود؟`,
      )
    ) {
      return;
    }
    await send({ status: next }, next === 'DISABLED' ? 'پنل غیرفعال شد.' : 'پنل فعال شد.');
  }

  return (
    <div className="card" style={{ marginBlockEnd: 16 }}>
      <div className="card__head">
        <span className="card__title">
          {panel.name} <span className="muted ltr">{panel.code}</span>{' '}
          <span className={TONE_CLASS[r.tone]}>{r.label}</span>
        </span>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          بستن
        </button>
      </div>

      <div className="tabs">
        {TAB_FA.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? 'tab tab--on' : 'tab'}
            onClick={() => {
              setTab(t.id);
              setErr(null);
              setDone(null);
            }}
          >
            {t.label}
            {flagged[t.id] && <span className="tab__dot" aria-label="مشکل دارد" />}
          </button>
        ))}
      </div>

      {/* One message bar per card, but reset on every tab switch, so a «ذخیره
          شد» from another tab can never sit above a form it has nothing to do
          with. That reading — the result of a button pressed a screen and a
          half away — is the one this card used to invite. */}
      {err && <div className="alert alert-error">{err}</div>}
      {done && <div className="alert alert-ok">{done}</div>}

      {tab === 'info' && (
        <>
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
            ظرفیت خالی یعنی نامحدود. الان {count(panel.liveSubscriptions)} اشتراک زنده،{' '}
            {count(panel.productCount)} سرویس و {count(panel.planCount)} کانفیگ روی این پنل است. آدرس و
            نوع پنل از این‌جا عوض نمی‌شوند.
          </p>
        </>
      )}

      {tab === 'link' && (
        <>
          <p className="muted" style={{ marginBlockStart: 0 }}>
            آدرس: <span className="ltr">{panel.baseUrl ?? '—'}</span>
          </p>
          {r.tone === 'bad' && (
            <div className="alert alert-error">
              {r.why} — تا وقتی این درست نشود، هر سفارشِ پرداخت‌شده روی این پنل رد می‌شود و پول
              مشتری برمی‌گردد.
            </div>
          )}

          {/* Uses the STORED credential, so pressing it on an untouched panel
              answers the question an operator actually has: does this panel
              work right now. */}
          <ConnectionTest
            label="تست با رمزِ ذخیره‌شده"
            hint="همان رمزی که ربات هنگام تحویل استفاده می‌کند."
            run={() => api.testPanel(panel.id, {})}
          />

          <h4>عوض‌کردن رمز</h4>
          <p className="muted">
            رمز فعلی هیچ‌جا نشان داده نمی‌شود — رمزنگاری‌شده ذخیره شده و فقط سرویس‌هایی که تحویل
            می‌دهند می‌توانند بازش کنند.
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
            label="تست رمزی که نوشتم، قبل از ذخیره"
            hint="آن‌چه در دو خانهٔ بالاست را می‌آزماید، بدون اینکه رمز ذخیره‌شده را عوض کند."
            disabled={username.trim() === '' || password === ''}
            run={() =>
              api.testPanel(panel.id, {
                credential: { username: username.trim(), password },
              })
            }
          />
        </>
      )}

      {tab === 'inbounds' && <PanelHostsSection panel={panel} />}

      {/* Mounted even while another tab is showing, so its own alerts stay its
          own and the tab flag above is truthful from the moment the card opens
          — a missing group must not wait for somebody to click «گروه‌ها». */}
      <div style={{ display: tab === 'groups' ? undefined : 'none' }}>
        <PanelGroupsSection panel={panel} onProblem={setGroupProblem} />
      </div>

      {tab === 'status' && (
        <>
          <p className="muted" style={{ marginBlockStart: 0 }}>
            {count(panel.liveSubscriptions)} اشتراک زنده و {count(panel.planCount)} کانفیگ روی این پنل
            است. غیرفعال‌کردن، پنل را از خرید و تمدید برمی‌دارد؛ سرویس‌های فروخته‌شده پاک نمی‌شوند.
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
        </>
      )}
    </div>
  );
}
