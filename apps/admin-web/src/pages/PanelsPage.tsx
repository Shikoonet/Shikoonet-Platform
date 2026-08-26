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
 * ──────────────────────────────────────────────────────────────────────────────────
 * Rebuilt again on 2026-08-26, to the shape of «فاکسیما» — a Mirzabot fork Sam
 * pointed at, kept for reference in `legacy/faoxima`. What came across:
 *
 *   - the list is CARDS, not rows. A panel is an address, a login and a
 *     decision about what it sells; a table of counts made an operator open
 *     each one to see any of that.
 *   - one MODAL does both adding and editing, instead of a create form and a
 *     four-tab editor that shared no code and drifted apart. The editor could
 *     not set an address at all, so a panel that moved host could only be
 *     deleted and rebuilt — which loses the id every sold subscription
 *     points at.
 *   - «پسورد جدید (خالی = بدون تغییر)» — the only sane wording for a field that
 *     writes a secret it cannot read back.
 *   - «وضعیت خودکار»: the save probes the panel and lets the answer decide
 *     ACTIVE/DISABLED. Before this, a panel with a typo in its address was
 *     created ACTIVE and the first customer to buy from it paid, waited, and
 *     was refunded.
 *   - a DELETE button, which this screen has never had.
 *
 * Three things deliberately did NOT come across:
 *
 *   1. The password. فاکسیما prints `wod5••••` and the first four characters
 *      are real. Ours says only whether one exists.
 *   2. Its delete. `legacy/faoxima/panel/panels.php:1219` counts the services
 *      pointing at the panel, deletes anyway, and reports «N سرویس بدون پنل
 *      ماندند» afterwards. On our schema `subscriptions.provider_id` is
 *      `ON DELETE SET NULL`, so Postgres would not even raise. Ours refuses
 *      first, inside the DELETE statement.
 *   3. Its four card toggles. Each writes a legacy column that NOTHING in this
 *      bot reads — and one of them, «inboundها فعال», does not mean what it
 *      says in فاکسیما either: it writes `inboundstatus`, which is «strip the
 *      inbounds when the service expires».
 *
 * And the thing this screen gains that فاکسیما has no equivalent for: the panel
 * is asked for its GROUPS, and the ticks decide what a purchase joins. That is
 * the tier the customer is sold — «پلاتینیوم» is a group with more inbounds in
 * it — and until today the only way to set it was SQL by hand.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError, type PanelItem } from '../api.js';
import { count } from '../format.js';
import { Icon } from '../icons.js';
import { useAdminWriteProps } from '../role.js';
import type { PanelGroupItem, PanelGroups, PanelHostItem, PanelTestResult } from '../api.js';

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


/**
 * گروه‌های پنل — the ticks that decide what a purchase joins.
 *
 * This section existed, was removed on 2026-08-24, and is back. The note that
 * removed it said the column it writes is "never" read by delivery, which
 * contradicted itself: the column IS the provider config, and `groupIdsFor`
 * reads exactly that after the plan's attrs. `provisioning.test.ts` has a green
 * case named «the panel default» that proves it against the body a fake panel
 * received.
 *
 * What was actually wrong was the value it stored. Every saved selection on the
 * practice box was `[]`, and `[]` is not nullish, so it beat the panel
 * underneath it and the create body carried `group_ids: []` — PasarGuard reads
 * that as «this account belongs to no group», strips every inbound, and the
 * subscription link keeps resolving while returning nothing. So no ticks now
 * REMOVES the key rather than storing an empty list, and the screen says which
 * of the two it means.
 *
 * A selected id the panel does not have is still drawn, marked, and tickable.
 * Hiding it would remove the only warning that the «group 42» failure — a
 * migrated selection pointing at a group deleted from the panel, every order
 * failing and refunding in front of the customer — is armed again.
 */
function PanelGroupsSection({ panel }: { panel: PanelItem }) {
  const w = useAdminWriteProps();
  const [available, setAvailable] = useState<PanelGroupItem[] | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [saved, setSaved] = useState<number[]>([]);
  const [overrides, setOverrides] = useState<PanelGroups['plans']>([]);
  const [inherit, setInherit] = useState<PanelGroups['inherit']>([]);
  const [untestable, setUntestable] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    setErr(null);
    try {
      const d = await api.panelGroups(panel.id);
      setAvailable(d.available);
      setSelected(d.selected);
      setSaved(d.selected);
      setOverrides(d.plans);
      setInherit(d.inherit);
      setUntestable(d.untestable === true);
      setReason(d.reason ?? null);
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, [panel.id]);

  async function save() {
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      await api.setPanelGroups(panel.id, selected);
      setSaved(selected);
      setDone(
        selected.length === 0
          ? 'ذخیره شد — این پنل دیگر گروهی نام نمی‌برد و هر سرویس باید گروه خودش را داشته باشد.'
          : `ذخیره شد — ${count(selected.length)} گروه.`,
      );
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: number) {
    setDone(null);
    setSelected((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));
  }

  if (untestable) {
    return (
      <p className="muted" style={{ marginBlockStart: 0 }}>
        یک پنل «{KIND_FA[panel.kind] ?? panel.kind}» گروه ندارد — تحویلش از این راه نمی‌گذرد.
      </p>
    );
  }

  // Ticked ids the panel does not have. This is the alarm and must never be
  // dropped from the list.
  const missing = selected.filter((id) => (available ?? []).every((g) => g.id !== id));
  const dirty = selected.length !== saved.length || selected.some((id) => !saved.includes(id));

  return (
    <>
      <p className="muted" style={{ marginBlockStart: 0 }}>
        گروه همان چیزی است که تعیین می‌کند مشتری چه کانفیگ‌هایی می‌گیرد. این تیک‌ها{' '}
        <b>پیش‌فرضِ این پنل</b> هستند: هر سرویسی که گروه خودش را نداشته باشد با همین‌ها تحویل
        می‌شود.
      </p>

      {err && <div className="alert alert-error">{err}</div>}
      {done && <div className="alert alert-ok">{done}</div>}

      {available === null ? (
        <div className="alert alert-warning">
          گروه‌ها از پنل خوانده نشد{reason ? ` — ${reason}` : ''}. تیک‌های ذخیره‌شده دست‌نخورده
          می‌مانند؛ فهرستِ خالی نشان‌دادن یعنی دعوت به «درست‌کردن» چیزی که درست است.
        </div>
      ) : (
        <div className="pick-list">
          {available.length === 0 && missing.length === 0 && (
            <div className="empty">این پنل هیچ گروهی ندارد.</div>
          )}
          {available.map((g) => (
            <label key={g.id} className={`pick ${selected.includes(g.id) ? 'pick--on' : ''}`}>
              <input
                type="checkbox"
                checked={selected.includes(g.id)}
                onChange={() => toggle(g.id)}
                {...w}
              />
              <span>
                <b>{g.name}</b> <span className="ltr muted">#{g.id}</span>
                {typeof g.memberCount === 'number' && (
                  <span className="muted"> · {count(g.memberCount)} کاربر</span>
                )}
                {g.disabled && <span className="badge badge-warning">روی پنل خاموش است</span>}
                {g.inboundTags && g.inboundTags.length > 0 && (
                  <div className="ltr muted" style={{ fontSize: 12 }}>
                    {g.inboundTags.join(' · ')}
                  </div>
                )}
                {/* The number the customer feels, not the number in the
                    listing. An inbound with no host counts toward every total
                    and hands over nothing. */}
                {g.deliverableInbounds === 0 && (
                  <span className="badge badge-block">
                    هیچ اینباندش هاست ندارد — کانفیگ نمی‌دهد
                  </span>
                )}
              </span>
            </label>
          ))}
          {missing.map((id) => (
            <label key={`missing-${id}`} className="pick pick--on">
              <input type="checkbox" checked onChange={() => toggle(id)} {...w} />
              <span>
                <b className="ltr">#{id}</b>{' '}
                <span className="badge badge-block">این گروه روی پنل نیست</span>
                <div className="muted" style={{ fontSize: 12 }}>
                  هر خریدی که این گروه را بخواهد با «Group not found» رد و بازپرداخت می‌شود.
                </div>
              </span>
            </label>
          ))}
        </div>
      )}

      <div className="filters" style={{ marginBlockStart: 10 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !dirty}
          onClick={() => void save()}
          {...w}
        >
          ذخیرهٔ گروه‌ها
        </button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void load()}>
          تازه‌سازی از پنل
        </button>
      </div>

      {/*
        What the ticks actually decide, said out loud. An empty `inherit` means
        every service names its own group and these ticks change nothing — which
        is precisely the state that got this section deleted once, discovered by
        an operator saving three times and seeing no effect.
      */}
      <p className="muted" style={{ marginBlockStart: 8 }}>
        {inherit.length === 0 ? (
          <>
            هیچ سرویسی روی این پنل به این تیک‌ها تکیه ندارد — همه گروه خودشان را دارند، پس این‌ها
            فعلاً هیچ خریدی را تصمیم نمی‌گیرند.
          </>
        ) : (
          <>
            {count(inherit.length)} سرویس با همین تیک‌ها تحویل می‌شود
            {inherit.length <= 4 && `: ${inherit.map((s) => s.name).join('، ')}`}.
          </>
        )}
        {overrides.length > 0 && <> {count(overrides.length)} سرویس گروه خودش را دارد.</>}
      </p>
    </>
  );
}

/**
 * A section of the modal that starts closed.
 *
 * `<details>` rather than a `useState` toggle: it remembers nothing, needs no
 * code, and is keyboard-operable and findable by the browser's own in-page
 * search without any of that being written here.
 */
function Fold({
  title,
  open,
  children,
}: {
  title: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={open} style={{ marginBlockStart: 14 }}>
      <summary
        style={{ cursor: 'pointer', fontWeight: 700, padding: '8px 0', color: 'var(--accent)' }}
      >
        {title}
      </summary>
      <div style={{ paddingBlockStart: 6 }}>{children}</div>
    </details>
  );
}

/**
 * افزودن / ویرایش پنل — one modal for both.
 *
 * There used to be a create form and a separate four-tab editor. They collected
 * different fields, validated differently, and only one of them could set an
 * address — so a panel that moved host could not be repaired, only deleted and
 * rebuilt, which loses the id every sold subscription points at.
 *
 * The password field is write-only and says so: «خالی = بدون تغییر». There is
 * no route in this app that reads a stored panel password back, so an empty box
 * cannot mean "clear it" — it can only mean "leave whatever is there".
 */
function PanelModal({
  panel,
  onClose,
  onSaved,
}: {
  /** null = adding. */
  panel: PanelItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const w = useAdminWriteProps();
  const editing = panel !== null;

  const [code, setCode] = useState('');
  const [name, setName] = useState(panel?.name ?? '');
  const [kind, setKind] = useState(panel?.kind ?? 'pasarguard');
  const [baseUrl, setBaseUrl] = useState(panel?.baseUrl ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [autoStatus, setAutoStatus] = useState(true);
  const [renewMode, setRenewMode] = useState<'ADD' | 'RESET'>(panel?.renewMode ?? 'RESET');
  const [renewEnabled, setRenewEnabled] = useState(panel?.renewEnabled ?? true);
  const [capacity, setCapacity] = useState(
    panel?.capacity === null || panel?.capacity === undefined ? '' : String(panel.capacity),
  );
  const [sortOrder, setSortOrder] = useState(String(panel?.sortOrder ?? 0));

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const needsLogin = KINDS.find((k) => k.value === kind)?.login ?? true;

  async function save() {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      if (!editing) {
        const created = await api.createPanel({
          code: code.trim(),
          name: name.trim(),
          kind,
          baseUrl: baseUrl.trim() === '' ? null : baseUrl.trim(),
          ...(username.trim() !== '' && password !== ''
            ? { credential: { username: username.trim(), password } }
            : {}),
        });
        setNote(statusNote(created.panel, created.probe));
        onSaved();
        return;
      }

      // The credential first: if it fails, the auto-status probe below would be
      // answering about the OLD password and would switch a good panel off.
      if (username.trim() !== '' && password !== '') {
        await api.setPanelCredential(panel.id, { username: username.trim(), password });
      }

      const capacityValue = capacity.trim() === '' ? null : Number(capacity);
      if (capacityValue !== null && !Number.isInteger(capacityValue)) {
        setErr('محدودیت ساخت اکانت باید عدد باشد — خالی یعنی بی‌نهایت.');
        return;
      }
      const updated = await api.updatePanel(panel.id, {
        name: name.trim(),
        baseUrl: baseUrl.trim() === '' ? null : baseUrl.trim(),
        capacity: capacityValue,
        sortOrder: Number(sortOrder) || 0,
        renewMode,
        renewEnabled,
        ...(autoStatus ? { autoStatus: true } : {}),
      });
      setNote(statusNote(updated.panel, updated.probe));
      setPassword('');
      onSaved();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-body" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-head__title">{editing ? 'ویرایش پنل' : 'افزودن پنل جدید'}</span>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            ✕
          </button>
        </div>

        {err && <div className="alert alert-error">{err}</div>}
        {note && <div className="alert alert-info">{note}</div>}

        {!editing && (
          <>
            <label className="form-label" htmlFor="panel-code">
              کد پنل
            </label>
            <input
              id="panel-code"
              className="form-control ltr"
              type="text"
              maxLength={60}
              placeholder="pasargad-1"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              {...w}
            />
            <p className="muted" style={{ marginBlockStart: 4 }}>
              حروف کوچک انگلیسی، رقم و خط تیره. بعد از ساخت عوض نمی‌شود، چون نامِ متغیر محیطیِ
              اعتبارنامه هم هست.
            </p>
          </>
        )}

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
          {...w}
        />

        <label className="form-label" htmlFor="panel-kind" style={{ marginBlockStart: 10 }}>
          نوع پنل
        </label>
        <select
          id="panel-kind"
          className="form-control"
          value={kind}
          disabled={editing}
          onChange={(e) => setKind(e.target.value)}
          {...w}
        >
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        {editing && (
          <p className="muted" style={{ marginBlockStart: 4 }}>
            نوع پنل عوض نمی‌شود — آداپتوری که سرویس‌های فروخته‌شده با آن ساخته شده‌اند همین است.
          </p>
        )}

        {needsLogin && (
          <>
            <label className="form-label" htmlFor="panel-url" style={{ marginBlockStart: 10 }}>
              آدرس پنل
            </label>
            <input
              id="panel-url"
              className="form-control ltr"
              type="text"
              placeholder="https://panel.example.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              {...w}
            />

            <div className="filters" style={{ marginBlockStart: 10 }}>
              <div className="grow">
                <label className="form-label" htmlFor="panel-user">
                  یوزرنیم
                </label>
                <input
                  id="panel-user"
                  className="form-control ltr"
                  type="text"
                  autoComplete="off"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  {...w}
                />
              </div>
              <div className="grow">
                <label className="form-label" htmlFor="panel-pass">
                  {editing ? 'پسورد جدید ' : 'پسورد '}
                  {editing && <span className="muted">(خالی = بدون تغییر)</span>}
                </label>
                <input
                  id="panel-pass"
                  className="form-control ltr"
                  type="password"
                  autoComplete="new-password"
                  placeholder={editing ? 'برای تغییر پسورد، این‌جا تایپ کنید' : ''}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  {...w}
                />
              </div>
            </div>
            {editing && panel.hasSecretRef && (
              <p className="muted" style={{ marginBlockStart: 4 }}>
                رمزی ذخیره شده است. هیچ‌جای این پنل آن را پس نمی‌دهد — فقط سرویس‌هایی که تحویل
                می‌دهند می‌توانند بازش کنند.
              </p>
            )}

            {editing && (
              <label className="pick" style={{ marginBlockStart: 10 }}>
                <input
                  type="checkbox"
                  checked={autoStatus}
                  onChange={(e) => setAutoStatus(e.target.checked)}
                  {...w}
                />
                <span>
                  <b>وضعیت خودکار</b>
                  <div className="muted" style={{ fontSize: 12 }}>
                    پس از ذخیره، اگر آدرس و اعتبارنامهٔ پنل کار کند فعال و در غیر این صورت غیرفعال
                    می‌شود. سوییچ دستیِ روی کارت همیشه بر این مقدم است.
                  </div>
                </span>
              </label>
            )}

            <ConnectionTest
              label="تست اتصال"
              hint="آن‌چه در خانه‌های بالاست را می‌آزماید، بدون اینکه چیزی ذخیره کند."
              run={() =>
                api.testPanel(editing ? panel.id : 0, {
                  kind,
                  baseUrl: baseUrl.trim(),
                  ...(username.trim() !== '' && password !== ''
                    ? { credential: { username: username.trim(), password } }
                    : {}),
                })
              }
            />
          </>
        )}

        <Fold title="⚙ تنظیمات پیشرفتهٔ پنل">
          <div className="filters">
            <div className="grow">
              <label className="form-label" htmlFor="panel-renew-mode">
                روش تمدید سرویس
              </label>
              <select
                id="panel-renew-mode"
                className="form-control"
                value={renewMode}
                onChange={(e) => setRenewMode(e.target.value as 'ADD' | 'RESET')}
                {...w}
              >
                <option value="RESET">ریست حجم و زمان</option>
                <option value="ADD">اضافه‌شدن حجم و زمان به قبلی</option>
              </select>
            </div>
            <div className="grow">
              <label className="form-label" htmlFor="panel-renew-enabled">
                وضعیت تمدید
              </label>
              <select
                id="panel-renew-enabled"
                className="form-control"
                value={renewEnabled ? '1' : '0'}
                onChange={(e) => setRenewEnabled(e.target.value === '1')}
                {...w}
              >
                <option value="1">تمدید باز است</option>
                <option value="0">تمدید بسته است</option>
              </select>
            </div>
          </div>
          <p className="muted" style={{ marginBlockStart: 4 }}>
            «ریست» یعنی حجم و زمان از نو شروع می‌شود؛ «اضافه‌شدن» یعنی باقی‌ماندهٔ مشتری روی
            دورهٔ تازه سوار می‌شود. اشتباهِ این یکی حجمی را که مشتری پولش را داده پاک می‌کند.
          </p>

          {editing && (
            <div className="filters" style={{ marginBlockStart: 10 }}>
              <div className="grow">
                <label className="form-label" htmlFor="panel-capacity">
                  محدودیت ساخت اکانت
                </label>
                <input
                  id="panel-capacity"
                  className="form-control ltr"
                  type="text"
                  inputMode="numeric"
                  placeholder="بی‌نهایت"
                  value={capacity}
                  onChange={(e) => setCapacity(e.target.value)}
                  {...w}
                />
              </div>
              <div className="grow">
                <label className="form-label" htmlFor="panel-sort">
                  ترتیب نمایش
                </label>
                <input
                  id="panel-sort"
                  className="form-control ltr"
                  type="text"
                  inputMode="numeric"
                  value={sortOrder}
                  onChange={(e) => setSortOrder(e.target.value)}
                  {...w}
                />
              </div>
            </div>
          )}
          {editing && (
            <p className="muted" style={{ marginBlockStart: 4 }}>
              خالی یعنی بی‌نهایت. سقف روی <b>اشتراک‌های زندهٔ</b> این پنل شمرده می‌شود؛ وقتی پر شود
              سرویس‌های این پنل از فهرست خرید برداشته می‌شوند و تمدیدها دست‌نخورده می‌مانند.
            </p>
          )}
        </Fold>

        {/*
          Only for a saved panel, and each in its own fold. Sam asked for the
          groups view to show groups and nothing else — hosts are a different
          question about the same panel, and this screen is still the only place
          they can be managed at all.
        */}
        {editing && needsLogin && (
          <>
            <Fold title="گروه‌های پنل" open>
              <PanelGroupsSection panel={panel} />
            </Fold>
            <Fold title="هاست‌ها">
              <PanelHostsSection panel={panel} />
            </Fold>
          </>
        )}

        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || name.trim() === '' || (!editing && code.trim() === '')}
            onClick={() => void save()}
            {...w}
          >
            {busy ? 'در حال ذخیره…' : 'ذخیره'}
          </button>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            انصراف
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Why a panel came out of a save switched off.
 *
 * The status is decided by the server, and without this the screen could only
 * report that it moved — leaving the operator to press «تست اتصال» to learn
 * what the save already knew.
 */
function statusNote(panel: PanelItem, probe: PanelTestResult | undefined): string {
  if (panel.status === 'ACTIVE') return 'ذخیره شد.';
  if (!probe) return 'ذخیره شد — این پنل غیرفعال است و سفارشی از آن تحویل نمی‌شود.';
  if (probe.reason === 'no_credential') return 'ذخیره شد و غیرفعال ماند — هنوز رمزی ندارد.';
  if (probe.reason === 'no_base_url') return 'ذخیره شد و غیرفعال ماند — هنوز آدرسی ندارد.';
  if (probe.reachable) {
    return 'ذخیره شد و غیرفعال شد — پنل جواب داد ولی ورود پذیرفته نشد. یوزرنیم یا رمز درست نیست.';
  }
  return 'ذخیره شد و غیرفعال شد — به آدرس پنل نرسیدیم. آدرس اشتباه است یا پنل بالا نیست.';
}

/**
 * حذف پنل — the confirmation, and the refusal when it cannot happen.
 *
 * The refusal comes from the server, in one statement with the delete, and it
 * names the counts. That wording is the whole value: «in_use» alone sends an
 * operator hunting for a button that will never work, and the shop this screen
 * is modelled on does not refuse at all — it deletes and then reports how many
 * customer services it orphaned.
 */
function DeletePanelModal({
  panel,
  onClose,
  onDeleted,
}: {
  panel: PanelItem;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const w = useAdminWriteProps();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setErr(null);
    try {
      await api.deletePanel(panel.id);
      onDeleted();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-body modal-body--danger" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-head__title">حذف پنل</span>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            ✕
          </button>
        </div>

        <p>
          پنل «<b>{panel.name}</b>» از فهرست پنل‌ها حذف شود؟
        </p>
        <p className="muted">
          روی خودِ پنل هیچ چیزی دست نمی‌خورد — اکانت‌هایی که آن‌جا ساخته شده‌اند کار می‌کنند. این
          فقط ردیفِ ما را برمی‌دارد. اگر سرویس یا اشتراک زنده‌ای روی این پنل باشد، حذف انجام
          نمی‌شود و دلیلش گفته می‌شود.
        </p>

        {err && <div className="alert alert-error">{err}</div>}

        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() => void go()}
            {...w}
          >
            {busy ? 'در حال حذف…' : 'حذف کن'}
          </button>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            انصراف
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One panel, as a card.
 *
 * The address, whether a credential exists, and the readiness verdict are on
 * the face of it, because those three decide whether a paid order on this panel
 * will be delivered and the table put all of them behind a «مدیریت» click.
 */
function PanelCard({
  panel,
  onEdit,
  onDelete,
  onToggle,
  busy,
}: {
  panel: PanelItem;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
  busy: boolean;
}) {
  const w = useAdminWriteProps();
  const r = readiness(panel);
  const remote = REACHES_A_PANEL.has(panel.kind);

  return (
    <div className="card">
      <div className="panel-card__head">
        <div className="panel-card__name">
          <span>{panel.name}</span>
          <span className="badge badge-info">{KIND_FA[panel.kind] ?? panel.kind}</span>
          <span className={TONE_CLASS[r.tone]}>{r.label}</span>
        </div>
        <div className="filters" style={{ margin: 0 }}>
          <button type="button" className="btn btn-sm" onClick={onEdit} {...w}>
            <Icon name="pencil" size={14} /> ویرایش
          </button>
          <button type="button" className="btn btn-sm btn-danger" onClick={onDelete} {...w}>
            <Icon name="trash" size={14} /> حذف
          </button>
        </div>
      </div>

      {r.why && (
        <div className="alert alert-warning" style={{ marginBlockEnd: 10 }}>
          {r.why}
        </div>
      )}

      {remote ? (
        <>
          <div className="info-line">
            <span className="info-line__k">آدرس:</span>
            <span className="info-line__v ltr">{panel.baseUrl ?? '—'}</span>
          </div>
          <div className="info-line">
            <span className="info-line__k">رمز:</span>
            <span className="info-line__v">
              {/* Not the first four characters, which is what فاکسیما shows.
                  Whether one exists is the only fact this screen has. */}
              {panel.hasSecretRef ? 'ذخیره شده' : 'ندارد'}
            </span>
          </div>
        </>
      ) : (
        <div className="info-line">
          <span className="info-line__v muted">
            تحویل این پنل دستی است — آدرس و رمز ندارد و نبودشان ایراد نیست.
          </span>
        </div>
      )}

      <div className="info-line">
        <span className="info-line__k">تمدید:</span>
        <span className="info-line__v">
          {!panel.renewEnabled
            ? 'بسته'
            : panel.renewMode === 'ADD'
              ? 'اضافه‌شدن حجم و زمان'
              : 'ریست حجم و زمان'}
        </span>
      </div>

      <div className="panel-card__foot">
        <div className="filters" style={{ margin: 0, justifyContent: 'space-between' }}>
          <span>
            {count(panel.productCount)} سرویس · {count(panel.planCount)} کانفیگ ·{' '}
            {count(panel.liveSubscriptions)} اشتراک زنده
            {panel.capacity !== null && ` · سقف ${count(panel.capacity)}`}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={onToggle}
            title="سوییچ دستی — بر «وضعیت خودکار» مقدم است"
            {...w}
          >
            {panel.status === 'ACTIVE' ? 'غیرفعال کن' : 'فعال کن'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function PanelsPage() {
  const [rows, setRows] = useState<PanelItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'cards' | 'table'>('cards');
  const [editing, setEditing] = useState<PanelItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<PanelItem | null>(null);
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

  async function toggleStatus(p: PanelItem) {
    if (
      p.status === 'ACTIVE' &&
      p.liveSubscriptions > 0 &&
      !window.confirm(
        `«${p.name}» ${p.liveSubscriptions.toLocaleString('fa-IR')} اشتراک زنده دارد. غیرفعال‌کردن، پنل را از خرید و تمدید برمی‌دارد؛ سرویس‌های فروخته‌شده پاک نمی‌شوند. ادامه؟`,
      )
    ) {
      return;
    }
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      // `status` explicitly, with no `autoStatus`: the manual switch has to work
      // on a panel that is currently unreachable, which is exactly when somebody
      // reaches for it.
      await api.updatePanel(p.id, { status: p.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' });
      await load();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

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
        <div className="filters" style={{ margin: 0 }}>
          <div className="view-toggle" role="group" aria-label="نمای نمایش">
            <button
              type="button"
              className={`view-toggle__btn ${view === 'cards' ? 'active' : ''}`}
              onClick={() => setView('cards')}
            >
              کارتی
            </button>
            <button
              type="button"
              className={`view-toggle__btn ${view === 'table' ? 'active' : ''}`}
              onClick={() => setView('table')}
            >
              جدولی
            </button>
          </div>
          {/* Spread last, so it overrides `disabled` only for a role the server
              is going to refuse anyway — see role.tsx. */}
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setCreating(true)}
            {...aw}
          >
            افزودن پنل جدید +
          </button>
        </div>
      </div>

      {err && <div className="alert alert-error">{err}</div>}
      {done && <div className="alert alert-ok">{done}</div>}

      {loading && rows.length === 0 && <div className="empty">در حال خواندن…</div>}

      {view === 'cards' ? (
        <div className="grid-2">
          {rows.map((p) => (
            <PanelCard
              key={p.id}
              panel={p}
              busy={busy}
              onEdit={() => setEditing(p)}
              onDelete={() => setDeleting(p)}
              onToggle={() => void toggleStatus(p)}
            />
          ))}
        </div>
      ) : (
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
                      <b>{p.name}</b>
                      <div className="ltr muted" style={{ fontSize: 12 }}>
                        {p.code} · {host(p.baseUrl)}
                      </div>
                    </td>
                    <td>{KIND_FA[p.kind] ?? p.kind}</td>
                    <td>
                      <span className={TONE_CLASS[r.tone]}>{r.label}</span>
                      {r.why && (
                        <div className="muted" style={{ fontSize: 12 }}>
                          {r.why}
                        </div>
                      )}
                    </td>
                    <td>
                      {count(p.liveSubscriptions)}
                      {p.capacity !== null && (
                        <span className="muted"> / {count(p.capacity)}</span>
                      )}
                    </td>
                    <td>
                      {count(p.productCount)} سرویس، {count(p.planCount)} کانفیگ
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setEditing(p)}
                        {...aw}
                      >
                        ویرایش
                      </button>{' '}
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => setDeleting(p)}
                        {...aw}
                      >
                        حذف
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(creating || editing !== null) && (
        <PanelModal
          panel={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            void load().then(() => {
              // Re-read the open panel from the fresh list, so the modal that
              // stays open is not showing the values from before the save.
              setEditing((prev) => (prev === null ? null : prev));
            });
          }}
        />
      )}

      {deleting !== null && (
        <DeletePanelModal
          panel={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            const name = deleting.name;
            setDeleting(null);
            setDone(`پنل «${name}» حذف شد.`);
            void load();
          }}
        />
      )}
    </>
  );
}
