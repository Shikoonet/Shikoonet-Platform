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

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError, type PanelItem } from '../api.js';
import { count } from '../format.js';
import { Icon } from '../icons.js';
import { useAdminWriteProps } from '../role.js';
import type {
  PanelGroups,
  PanelHiddenUser,
  PanelTestResult,
  PanelTierPrices,
  PanelUsernameMode,
} from '../api.js';

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

/**
 * The panel's groups, asked for ONCE per modal.
 *
 * Two folds need this same list and they mean opposite things by it:
 * «گروه‌های پنل» is what a purchase joins, «گروه اکانت غیرفعال» is where an
 * ended one is moved. Two fetchers would be two requests to somebody else's
 * panel per open, answering at different moments — so the one section that had
 * this state now takes it as a prop instead of holding it.
 */
interface PanelGroupsState {
  /** null while it has not answered yet. `data.available` null is «could not ask». */
  data: PanelGroups | null;
  err: string | null;
  busy: boolean;
  reload: () => void;
}

function usePanelGroups(panelId: number | null): PanelGroupsState {
  const [data, setData] = useState<PanelGroups | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    if (panelId === null) return;
    setBusy(true);
    setErr(null);
    void api
      .panelGroups(panelId)
      .then(setData)
      .catch((e: unknown) => setErr(message(e)))
      .finally(() => setBusy(false));
  }, [panelId]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, err, busy, reload };
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
function PanelGroupsSection({ panel, groups }: { panel: PanelItem; groups: PanelGroupsState }) {
  const w = useAdminWriteProps();
  const [selected, setSelected] = useState<number[]>([]);
  const [saved, setSaved] = useState<number[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const available = groups.data?.available ?? null;
  const untestable = groups.data?.untestable === true;
  const reason = groups.data?.reason ?? null;
  const overrides = groups.data?.plans ?? [];
  const inherit = groups.data?.inherit ?? [];
  const busy = saving || groups.busy;

  // What the server says is stored is where the ticks start — every time it is
  // re-read, so «تازه‌سازی از پنل» throws away an unsaved selection the same way
  // re-opening the modal does.
  useEffect(() => {
    if (!groups.data) return;
    setSelected(groups.data.selected);
    setSaved(groups.data.selected);
  }, [groups.data]);

  async function save() {
    setSaving(true);
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
      setSaving(false);
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

      {(groups.err ?? err) !== null && (
        <div className="alert alert-error">{groups.err ?? err}</div>
      )}
      {done && <div className="alert alert-ok">{done}</div>}

      {available === null ? (
        <div className="alert alert-warning">
          گروه‌ها از پنل خوانده نشد{reason ? ` — ${reason}` : ''}. تیک‌های ذخیره‌شده دست‌نخورده
          می‌مانند؛ فهرستِ خالی نشان‌دادن یعنی دعوت به «درست‌کردن» چیزی که درست است.
          {/*
            And what those ticks ARE, by number. Walking an unreachable panel is
            how this gap showed: the warning said the saved selection was safe
            without ever saying what it was, so the one screen that could have
            named «۴۲ و ۲» — the ids on the migrated VIP panel, one of which the
            panel no longer has — showed nothing at all. This is the state where
            that matters most, because the panel cannot be asked.
          */}
          {selected.length > 0 && (
            <div style={{ marginBlockStart: 6 }}>
              الان این گروه‌ها فرستاده می‌شوند:{' '}
              <b className="ltr">{selected.map((id) => `#${id}`).join(' · ')}</b> — و تا وقتی پنل
              جواب ندهد نمی‌دانیم روی پنل هستند یا نه.
            </div>
          )}
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
        <button type="button" className="btn btn-sm" disabled={busy} onClick={groups.reload}>
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
        {/*
          Three states, not two. A panel with no services at all and a panel
          whose every service overrides these ticks are both "the ticks decide
          nothing", and saying it the same way about both is wrong the way the
          old status column was wrong: it names a cause that is not the cause.
          Walking a freshly-added panel in the browser is what showed it — it
          read «همه گروه خودشان را دارند» about a panel that had no services.
        */}
        {panel.productCount === 0 ? (
          <>
            هنوز سرویسی روی این پنل نیست. این تیک‌ها پیش‌فرضِ سرویس‌هایی هستند که بعداً این‌جا
            ساخته می‌شوند.
          </>
        ) : inherit.length === 0 ? (
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
 * ⚙️ گروه اکانت غیرفعال — where an ended account is moved instead of left alone.
 *
 * The same list and the same chips as «گروه‌های پنل», out of the same fetch.
 * What differs is who writes it: this selection is part of the modal's form and
 * goes out with the modal's own «ذخیره», because it is one field of the panel
 * row rather than a list with a save of its own.
 */
function PanelDowngradeGroups({
  groups,
  value,
  onChange,
}: {
  groups: PanelGroupsState;
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  const w = useAdminWriteProps();
  const available = groups.data?.available ?? null;
  const reason = groups.data?.reason ?? null;

  function toggle(id: number) {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  }

  // A ticked id the panel does not have, kept drawn for the same reason the
  // section above keeps it: hiding it removes the only warning that every
  // downgrade will fail against a group that is gone.
  const missing =
    available === null ? [] : value.filter((id) => available.every((g) => g.id !== id));

  return (
    <>
      <p className="muted" style={{ marginBlockStart: 0 }}>
        وقتی سرویس مشتری تمام می‌شود، اکانتش به این گروه‌ها منتقل می‌شود تا لینک اشتراکش همچنان
        جواب بدهد. خالی یعنی دست‌نخورده بماند — رفتار امروز.
      </p>

      {available === null ? (
        <div className="alert alert-warning">
          گروه‌ها از پنل خوانده نشد{reason ? ` — ${reason}` : ''}. انتخاب ذخیره‌شده دست‌نخورده
          می‌ماند.
          {value.length > 0 && (
            <div style={{ marginBlockStart: 6 }}>
              الان این گروه‌ها انتخاب شده‌اند:{' '}
              <b className="ltr">{value.map((id) => `#${id}`).join(' · ')}</b>
            </div>
          )}
        </div>
      ) : (
        <div className="pick-list">
          {available.length === 0 && missing.length === 0 && (
            <div className="empty">این پنل هیچ گروهی ندارد.</div>
          )}
          {available.map((g) => (
            <label key={g.id} className={`pick ${value.includes(g.id) ? 'pick--on' : ''}`}>
              <input
                type="checkbox"
                checked={value.includes(g.id)}
                onChange={() => toggle(g.id)}
                {...w}
              />
              <span>
                <b>{g.name}</b> <span className="ltr muted">#{g.id}</span>
                {typeof g.memberCount === 'number' && (
                  <span className="muted"> · {count(g.memberCount)} کاربر</span>
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
              </span>
            </label>
          ))}
        </div>
      )}

      <p className="muted" style={{ marginBlockStart: 8 }}>
        این انتخاب با دکمهٔ «ذخیره»ی پایینِ همین پنجره نوشته می‌شود.
      </p>
    </>
  );
}

/**
 * کاربرانی که این پنل را نمی‌بینند — legacy's `hide_user`, as a list.
 *
 * Mounted when the fold opens rather than with the modal: it is empty on all
 * five production panels, so asking for it on every edit is a query nobody
 * reads.
 *
 * The Telegram id is what the operator has in front of them — it is what they
 * were given by whoever asked for the block — so it is what the box takes and
 * what every row shows. Removing goes by OUR user id, which the list hands out.
 */
function PanelHiddenUsersSection({ panel }: { panel: PanelItem }) {
  const w = useAdminWriteProps();
  const [users, setUsers] = useState<PanelHiddenUser[] | null>(null);
  const [telegramId, setTelegramId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setUsers((await api.panelHiddenUsers(panel.id)).users);
    } catch (e) {
      setErr(message(e));
    }
  }

  useEffect(() => {
    void load();
  }, [panel.id]);

  async function add() {
    // Parsed here rather than sent as a string: the route requires a number, so
    // an empty or mistyped box would otherwise reach it as `NaN` and come back
    // as a validation message in English about a field nobody typed.
    const id = Number(telegramId.trim());
    if (!Number.isSafeInteger(id) || id <= 0) {
      setErr('آیدی عددی تلگرام را وارد کنید — فقط رقم.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.addPanelHiddenUser(panel.id, id);
      setTelegramId('');
      await load();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(userId: number) {
    setBusy(true);
    setErr(null);
    try {
      await api.removePanelHiddenUser(panel.id, userId);
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
        این افراد این پنل و سرویس‌هایش را در فروشگاه نمی‌بینند — نه در فهرست، نه با باز‌کردن لینک
        مستقیمش. برای بقیه هیچ چیز عوض نمی‌شود.
      </p>

      {err && <div className="alert alert-error">{err}</div>}

      {users === null ? (
        <div className="muted">در حال خواندن…</div>
      ) : users.length === 0 ? (
        <div className="empty">هیچ‌کس مستثنی نشده — همه این پنل را می‌بینند.</div>
      ) : (
        <div className="pick-list">
          {users.map((u) => (
            <div key={u.userId} className="pick">
              <span className="grow">
                <b className="ltr">{u.username === null ? u.telegramId : `@${u.username}`}</b>
                {u.username !== null && <span className="ltr muted"> {u.telegramId}</span>}
              </span>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={busy}
                onClick={() => void remove(u.userId)}
                {...w}
              >
                حذف
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="filters" style={{ marginBlockStart: 10 }}>
        <div className="grow">
          <label className="form-label" htmlFor="panel-hide-id">
            آیدی عددی تلگرام
          </label>
          <input
            id="panel-hide-id"
            className="form-control ltr"
            type="text"
            inputMode="numeric"
            placeholder="123456789"
            value={telegramId}
            onChange={(e) => setTelegramId(e.target.value)}
            {...w}
          />
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || telegramId.trim() === ''}
          onClick={() => void add()}
          {...w}
        >
          افزودن
        </button>
      </div>
      <p className="muted" style={{ marginBlockStart: 4 }}>
        فقط کسی که ربات را استارت کرده اضافه می‌شود. آیدیِ ناشناس رد می‌شود، چون یک اشتباه تایپی و
        یک بلاکِ کارکن باید از هم قابل تشخیص باشند.
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
  onOpen,
  children,
}: {
  title: string;
  open?: boolean;
  /**
   * Fired the first time the fold is opened, for a section whose contents cost
   * a request. Everything else in this modal loads with the modal, which is
   * right for a list an operator always wants and wrong for a deny list that is
   * empty on every panel the shop has.
   */
  onOpen?: () => void;
  children: ReactNode;
}) {
  return (
    <details
      open={open}
      onToggle={(e) => e.currentTarget.open && onOpen?.()}
      style={{ marginBlockStart: 14 }}
    >
      <summary
        style={{ cursor: 'pointer', fontWeight: 700, padding: '8px 0', color: 'var(--accent)' }}
      >
        {title}
      </summary>
      <div style={{ paddingBlockStart: 6 }}>{children}</div>
    </details>
  );
}

/** The three tier boxes as the operator types them. */
interface TierText {
  f: string;
  n: string;
  n2: string;
}

function tierText(p: PanelTierPrices | undefined): TierText {
  return { f: numText(p?.f), n: numText(p?.n), n2: numText(p?.n2) };
}

function numText(v: number | null | undefined): string {
  return v === null || v === undefined ? '' : String(v);
}

/**
 * A number an operator types, where empty and zero are NOT the same thing.
 *
 * Empty is null — «not set», «not for sale» — and null is the only way to say
 * it: the route refuses zero, because the bot already reads a zero price as
 * not-for-sale, so a stored zero would look set on this screen and be off in
 * the shop. Anything else unusable comes back as `'bad'` rather than as null,
 * so a mistyped price is an error instead of silently becoming «فروخته نمی‌شود».
 */
function positiveOrNull(raw: string): number | null | 'bad' {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : 'bad';
}

function positiveIntOrNull(raw: string): number | null | 'bad' {
  const v = positiveOrNull(raw);
  return typeof v === 'number' && !Number.isInteger(v) ? 'bad' : v;
}

/** All three tiers, or null if any box holds something unusable. */
function tierValues(t: TierText): PanelTierPrices | null {
  const f = positiveIntOrNull(t.f);
  const n = positiveIntOrNull(t.n);
  const n2 = positiveIntOrNull(t.n2);
  if (f === 'bad' || n === 'bad' || n2 === 'bad') return null;
  return { f, n, n2 };
}

function sameTiers(a: PanelTierPrices, b: PanelTierPrices): boolean {
  return a.f === b.f && a.n === b.n && a.n2 === b.n2;
}

function sameIds(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

const TIERS: ReadonlyArray<{ key: keyof TierText; label: string }> = [
  { key: 'f', label: 'مشتری عادی' },
  { key: 'n', label: 'نماینده' },
  { key: 'n2', label: 'نماینده سطح ۲' },
];

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
  /**
   * `panel` is the row as it came back. Creating hands it over so the caller
   * can turn this modal into the EDITOR for the panel just made — which is
   * what puts the groups section on screen without a second click, and is the
   * whole flow Sam asked for: add the panel, it tests itself, its groups
   * appear, tick them.
   */
  onSaved: (panel: PanelItem) => void;
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
  const [renewMode, setRenewMode] = useState<PanelItem['renewMode']>(panel?.renewMode ?? 'RESET');
  const [renewEnabled, setRenewEnabled] = useState(panel?.renewEnabled ?? true);
  const [capacity, setCapacity] = useState(
    panel?.capacity === null || panel?.capacity === undefined ? '' : String(panel.capacity),
  );
  const [sortOrder, setSortOrder] = useState(String(panel?.sortOrder ?? 0));
  const [usernameMode, setUsernameMode] = useState<PanelUsernameMode>(
    panel?.usernameMode ?? 'TELEGRAM_ID',
  );
  const [usernameText, setUsernameText] = useState(panel?.usernameText ?? '');
  const [trialEnabled, setTrialEnabled] = useState(panel?.trial.enabled ?? false);
  const [trialVolume, setTrialVolume] = useState(numText(panel?.trial.volumeGb));
  const [trialHours, setTrialHours] = useState(numText(panel?.trial.durationHours));
  const [extraVolume, setExtraVolume] = useState<TierText>(tierText(panel?.extraVolumeTomanPerGb));
  const [extraTime, setExtraTime] = useState<TierText>(tierText(panel?.extraTimeTomanPerDay));
  const [minVolume, setMinVolume] = useState(numText(panel?.extraVolumeMinGb));
  const [minTime, setMinTime] = useState(numText(panel?.extraTimeMinDays));
  const [newcomersOnly, setNewcomersOnly] = useState(panel?.newcomersOnly ?? false);
  /** The panel's login name, fetched once when the modal opens. Never a password. */
  const [storedUsername, setStoredUsername] = useState<string | null>(null);
  const [credentialSetBy, setCredentialSetBy] = useState<string | null>(null);
  const [downgradeGroupIds, setDowngradeGroupIds] = useState<number[]>(
    panel?.downgradeGroupIds ?? [],
  );
  /** The deny list costs a request, so it is not asked for until somebody looks. */
  const [hiddenOpened, setHiddenOpened] = useState(false);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const needsLogin = KINDS.find((k) => k.value === kind)?.login ?? true;
  // One fetch for both group folds — see `usePanelGroups`.
  const groups = usePanelGroups(panel !== null && needsLogin ? panel.id : null);

  /**
   * The panel's login name, asked for once when the modal opens.
   *
   * Its own request rather than a field on the panel list: this is half a
   * credential, and `GET /panels` is drawn on a screen an operator leaves open
   * with every panel on it. Failure is silent on purpose — an operator who
   * cannot be told which account a panel uses can still edit everything else,
   * and a red banner over a name is the wrong size of complaint.
   */
  useEffect(() => {
    if (panel === null || !panel.hasSecretRef) return;
    let live = true;
    void api
      .panelCredentialUsername(panel.id)
      .then((d) => {
        if (!live) return;
        setStoredUsername(d.username);
        setCredentialSetBy(d.setBy);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [panel]);

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
        onSaved(created.panel);
        return;
      }

      /**
       * The credential first, and a password ALONE is enough.
       *
       * First: if it went second, the auto-status probe below would answer
       * about the OLD password and switch a good panel off.
       *
       * Alone: no route hands a stored username back, so this box is empty on
       * a panel that already has one. Requiring both here is what made a typed
       * password vanish without a word under a label promising the opposite —
       * the server fills the username in from what is already sealed.
       */
      if (password !== '') {
        await api.setPanelCredential(panel.id, {
          ...(username.trim() === '' ? {} : { username: username.trim() }),
          password,
        });
      }

      const capacityValue = capacity.trim() === '' ? null : Number(capacity);
      if (capacityValue !== null && !Number.isInteger(capacityValue)) {
        setErr('محدودیت ساخت اکانت باید عدد باشد — خالی یعنی بی‌نهایت.');
        return;
      }
      const trialVolumeGb = positiveOrNull(trialVolume);
      const trialDurationHours = positiveIntOrNull(trialHours);
      if (trialVolumeGb === 'bad' || trialDurationHours === 'bad') {
        setErr('حجم و زمان سرویس تست باید عددی بزرگ‌تر از صفر باشند — خالی یعنی تنظیم‌نشده.');
        return;
      }
      const volumePrices = tierValues(extraVolume);
      const timePrices = tierValues(extraTime);
      if (volumePrices === null || timePrices === null) {
        setErr('قیمت‌ها باید عدد صحیح بزرگ‌تر از صفر باشند — خالی یعنی فروخته نمی‌شود.');
        return;
      }
      // Same rule as the prices beside them: empty is «no floor», a mistyped
      // number is neither and stops the save rather than quietly becoming null
      // — which the operator would read on screen as «حداقلی ندارد».
      const minVolumeValue = positiveIntOrNull(minVolume);
      const minTimeValue = positiveIntOrNull(minTime);
      if (minVolumeValue === 'bad' || minTimeValue === 'bad') {
        setErr('حداقل خرید باید عدد صحیح بزرگ‌تر از صفر باشد — خالی یعنی حداقلی ندارد.');
        return;
      }
      const panelText = usernameText.trim() === '' ? null : usernameText.trim();
      /*
       * The trial's three fields move together and the two price tables move
       * whole. That is the shape the route validates in: it checks the RESULT
       * of the merge, so sending only the switch leans on numbers already
       * stored and sending only a number leans on a switch already on — and the
       * `trial.enabled` this screen shows is DERIVED, false whenever a number is
       * missing. Sending the trio is what makes the switch on screen the answer.
       *
       * Everything else is sent only when it differs from the row that came
       * back, so an operator who opened the fold and closed it writes nothing.
       */
      const trialTouched =
        trialEnabled !== panel.trial.enabled ||
        trialVolumeGb !== panel.trial.volumeGb ||
        trialDurationHours !== panel.trial.durationHours;

      const updated = await api.updatePanel(panel.id, {
        name: name.trim(),
        baseUrl: baseUrl.trim() === '' ? null : baseUrl.trim(),
        capacity: capacityValue,
        sortOrder: Number(sortOrder) || 0,
        renewMode,
        renewEnabled,
        ...(autoStatus ? { autoStatus: true } : {}),
        ...(usernameMode === panel.usernameMode ? {} : { usernameMode }),
        ...(panelText === panel.usernameText ? {} : { usernameText: panelText }),
        ...(trialTouched ? { trialEnabled, trialVolumeGb, trialDurationHours } : {}),
        ...(sameTiers(volumePrices, panel.extraVolumeTomanPerGb)
          ? {}
          : { extraVolumeTomanPerGb: volumePrices }),
        ...(sameTiers(timePrices, panel.extraTimeTomanPerDay)
          ? {}
          : { extraTimeTomanPerDay: timePrices }),
        ...(sameIds(downgradeGroupIds, panel.downgradeGroupIds) ? {} : { downgradeGroupIds }),
        ...(minVolumeValue === panel.extraVolumeMinGb ? {} : { extraVolumeMinGb: minVolumeValue }),
        ...(minTimeValue === panel.extraTimeMinDays ? {} : { extraTimeMinDays: minTimeValue }),
        ...(newcomersOnly === panel.newcomersOnly ? {} : { newcomersOnly }),
      });
      setNote(statusNote(updated.panel, updated.probe));
      setPassword('');
      onSaved(updated.panel);
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
                  // The stored name as the placeholder rather than the value:
                  // typing must still mean «change it to this», and prefilling
                  // the value would send the same name back on every save.
                  placeholder={storedUsername ?? ''}
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
                {storedUsername === null
                  ? 'رمزی ذخیره شده است.'
                  : `این پنل با «${storedUsername}» وارد می‌شود.`}{' '}
                رمزش را هیچ‌جا پس نمی‌دهد — فقط سرویس‌هایی که تحویل می‌دهند می‌توانند بازش کنند.
                {credentialSetBy !== null && ` آخرین بار ${credentialSetBy} تنظیمش کرده.`}
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
                onChange={(e) => setRenewMode(e.target.value as PanelItem['renewMode'])}
                {...w}
              >
                <option value="RESET">ریست حجم و زمان</option>
                <option value="ADD">اضافه‌شدن حجم و زمان به قبلی</option>
                <option value="ADD_VOLUME_RESET_TIME">ریست زمان، اضافه‌شدن حجم</option>
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

          <label className="check" style={{ marginBlockStart: 12 }}>
            <input
              type="checkbox"
              checked={newcomersOnly}
              onChange={(e) => setNewcomersOnly(e.target.checked)}
              {...w}
            />{' '}
            فقط برای کسانی که هنوز خریدی نکرده‌اند
          </label>
          <p className="muted" style={{ marginBlockStart: 4 }}>
            پنلِ شروع: هر کس <b>یک سرویس داشته باشد</b> دیگر این پنل را نمی‌بیند. «خرید کرده» یعنی
            سرویسی در اختیار دارد، نه اینکه سفارشی ثبت کرده باشد.{' '}
            <b>
              تمدید هم از همین قاعده پیروی می‌کند — کسی که یک‌بار از این پنل خریده، دیگر نمی‌تواند
              روی همین پنل تمدید کند.
            </b>
          </p>
        </Fold>

        {/*
          Only for a saved panel, and each in its own fold. Sam asked for the
          groups view to show groups and nothing else.

          «هاست‌ها» used to be the last fold here and was removed on 2026-09-03:
          Sam said the shop does not need it, so host management goes back to
          the panel's own web UI. The «هیچ اینباندش هاست ندارد» warning in
          «گروه‌های پنل» survives — it is fed by `/inbounds`, not by that fold.

          The four folds added on 2026-09-02 are the panel settings the old bot
          had and this screen did not. Three of them are plain form state and go
          out with «ذخیره» below; the deny list has buttons of its own, because
          each row there is one audited write rather than a field of the panel.
        */}
        {editing && needsLogin && (
          <>
            <Fold title="💡 روش ساخت نام کاربری">
              <div className="filters">
                <div className="grow">
                  <label className="form-label" htmlFor="panel-username-mode">
                    روش ساخت
                  </label>
                  <select
                    id="panel-username-mode"
                    className="form-control"
                    value={usernameMode}
                    onChange={(e) => setUsernameMode(e.target.value as PanelUsernameMode)}
                    {...w}
                  >
                    <option value="TELEGRAM_ID">آیدی عددی کاربر</option>
                    <option value="PANEL_TEXT">متن دلخواه این پنل</option>
                    <option value="TELEGRAM_USERNAME">نام کاربری تلگرام</option>
                  </select>
                </div>
                {usernameMode === 'PANEL_TEXT' && (
                  <div className="grow">
                    <label className="form-label" htmlFor="panel-username-text">
                      متن دلخواه
                    </label>
                    <input
                      id="panel-username-text"
                      className="form-control ltr"
                      type="text"
                      maxLength={32}
                      placeholder="shikoo"
                      value={usernameText}
                      onChange={(e) => setUsernameText(e.target.value)}
                      {...w}
                    />
                  </div>
                )}
              </div>
              <p className="muted" style={{ marginBlockStart: 4 }}>
                نام اکانت روی پنل این شکلی می‌شود: <b>{'<پیشوند>_<شناسهٔ سفارش>'}</b>. پسوند همیشه
                شناسهٔ سفارش است تا اگر ساخت نیمه‌کاره ماند، تلاش دوم همان اکانت را پیدا کند و اکانت
                دوم نسازد.
                {usernameMode === 'TELEGRAM_USERNAME' && (
                  <> مشتری‌ای که نام کاربری تلگرام ندارد با آیدی عددی‌اش ساخته می‌شود.</>
                )}
              </p>
            </Fold>

            <Fold title="🎁 سرویس تست">
              <label className="pick">
                <input
                  type="checkbox"
                  checked={trialEnabled}
                  onChange={(e) => setTrialEnabled(e.target.checked)}
                  {...w}
                />
                <span>
                  <b>سرویس تست رایگان روی این پنل</b>
                  <div className="muted" style={{ fontSize: 12 }}>
                    بدون هر دو عددِ پایین روشن نمی‌شود. پنلی که روشن باشد و چیزی برای دادن نداشته
                    باشد، تپِ مشتری را با یک ساختِ ناموفق جواب می‌دهد.
                  </div>
                </span>
              </label>
              <div className="filters" style={{ marginBlockStart: 10 }}>
                <div className="grow">
                  <label className="form-label" htmlFor="panel-trial-volume">
                    حجم (گیگابایت)
                  </label>
                  <input
                    id="panel-trial-volume"
                    className="form-control ltr"
                    type="text"
                    inputMode="decimal"
                    value={trialVolume}
                    onChange={(e) => setTrialVolume(e.target.value)}
                    {...w}
                  />
                </div>
                <div className="grow">
                  <label className="form-label" htmlFor="panel-trial-hours">
                    مدت (ساعت)
                  </label>
                  <input
                    id="panel-trial-hours"
                    className="form-control ltr"
                    type="text"
                    inputMode="numeric"
                    value={trialHours}
                    onChange={(e) => setTrialHours(e.target.value)}
                    {...w}
                  />
                </div>
              </div>
              <p className="muted" style={{ marginBlockStart: 4 }}>
                مدت به <b>ساعت</b> است، نه روز. اینکه هر مشتری چند بار سرویس تست بگیرد این‌جا تعیین
                نمی‌شود — یک عدد برای کل فروشگاه است و در «تنظیمات» با کلید{' '}
                <span className="ltr">limit_usertest_all</span> نگه داشته می‌شود.
              </p>
            </Fold>

            <Fold title="➕ قیمت حجم و زمان اضافه">
              <div className="form-label">قیمت هر گیگابایت اضافه</div>
              <div className="filters">
                {TIERS.map((t) => (
                  <div className="grow" key={`vol-${t.key}`}>
                    <label className="form-label" htmlFor={`panel-extra-vol-${t.key}`}>
                      {t.label}
                    </label>
                    <input
                      id={`panel-extra-vol-${t.key}`}
                      className="form-control ltr"
                      type="text"
                      inputMode="numeric"
                      placeholder="فروخته نمی‌شود"
                      value={extraVolume[t.key]}
                      onChange={(e) => setExtraVolume({ ...extraVolume, [t.key]: e.target.value })}
                      {...w}
                    />
                  </div>
                ))}
              </div>

              <div className="form-label" style={{ marginBlockStart: 10 }}>
                قیمت هر روز اضافه
              </div>
              <div className="filters">
                {TIERS.map((t) => (
                  <div className="grow" key={`time-${t.key}`}>
                    <label className="form-label" htmlFor={`panel-extra-time-${t.key}`}>
                      {t.label}
                    </label>
                    <input
                      id={`panel-extra-time-${t.key}`}
                      className="form-control ltr"
                      type="text"
                      inputMode="numeric"
                      placeholder="فروخته نمی‌شود"
                      value={extraTime[t.key]}
                      onChange={(e) => setExtraTime({ ...extraTime, [t.key]: e.target.value })}
                      {...w}
                    />
                  </div>
                ))}
              </div>
              <p className="muted" style={{ marginBlockStart: 4 }}>
                قیمت‌ها به تومان‌اند. خالی یعنی روی این پنل فروخته نمی‌شود.
              </p>

              <div className="form-label" style={{ marginBlockStart: 12 }}>
                حداقل خرید
              </div>
              <div className="filters">
                <div className="grow">
                  <label className="form-label" htmlFor="panel-min-vol">
                    کمترین حجم (گیگابایت)
                  </label>
                  <input
                    id="panel-min-vol"
                    className="form-control ltr"
                    type="text"
                    inputMode="numeric"
                    placeholder="بدون حداقل"
                    value={minVolume}
                    onChange={(e) => setMinVolume(e.target.value)}
                    {...w}
                  />
                </div>
                <div className="grow">
                  <label className="form-label" htmlFor="panel-min-time">
                    کمترین زمان (روز)
                  </label>
                  <input
                    id="panel-min-time"
                    className="form-control ltr"
                    type="text"
                    inputMode="numeric"
                    placeholder="بدون حداقل"
                    value={minTime}
                    onChange={(e) => setMinTime(e.target.value)}
                    {...w}
                  />
                </div>
              </div>
              <p className="muted" style={{ marginBlockStart: 4 }}>
                یک حداقل برای همهٔ سطح‌ها، نه برای هر سطح جدا. خالی یعنی حداقلی ندارد و مشتری
                می‌تواند یک گیگابایت هم بخرد.
              </p>
            </Fold>

            <Fold title="گروه‌های پنل" open>
              <PanelGroupsSection panel={panel} groups={groups} />
            </Fold>
            <Fold title="⚙️ گروه اکانت غیرفعال">
              <PanelDowngradeGroups
                groups={groups}
                value={downgradeGroupIds}
                onChange={setDowngradeGroupIds}
              />
            </Fold>
          </>
        )}

        {editing && (
          <Fold title="😶 کاربرانی که این پنل را نمی‌بینند" onOpen={() => setHiddenOpened(true)}>
            {hiddenOpened && <PanelHiddenUsersSection panel={panel} />}
          </Fold>
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
  onShowProducts,
  busy,
}: {
  panel: PanelItem;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
  /** Open «محصولات» filtered to this panel — the shop this panel feeds. */
  onShowProducts: (panelId: number) => void;
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
            {/*
              «کلی پنل داریم که اصلا معلوم نیست کجا نمایش داده میشن» — the shop's
              owner, 2026-08-27. These three numbers have been here since the
              card was built and led nowhere; from a panel there was no way at
              all to reach the shop it feeds. The first one is now the way in.
            */}
            <button
              type="button"
              className="btn-link"
              onClick={() => onShowProducts(panel.id)}
              title={`محصول‌های «${panel.name}» در «محصولات»`}
            >
              {count(panel.planCount)} محصول
            </button>{' '}
            · {count(panel.productCount)} سرویس · {count(panel.liveSubscriptions)} اشتراک زنده
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

export function PanelsPage({ onGo }: { onGo: (id: 'products', search?: string) => void }) {
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
      (p.liveSubscriptions > 0 || p.planCount > 0) &&
      // Both halves of the consequence, and the second one is new: switching a
      // panel off takes every product on it out of the shop, and until now the
      // only number in this sentence was about subscriptions already sold. On
      // 2026-08-27 five panels were off and thirteen products had silently gone
      // with them.
      !window.confirm(
        `«${p.name}» را غیرفعال می‌کنید.

` +
          `• ${count(p.planCount)} محصول از فروشگاه برداشته می‌شوند و در ربات دیده نمی‌شوند.
` +
          (p.liveSubscriptions > 0
            ? `• ${count(p.liveSubscriptions)} اشتراک زنده دارد؛ فروخته‌شده‌ها پاک نمی‌شوند و تمدیدشان بسته می‌شود.
`
            : '') +
          `
ادامه؟`,
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
              onShowProducts={(id) => onGo('products', `?providerId=${id}`)}
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
          onSaved={(saved) => {
            // Creating leaves the modal OPEN, as the editor for the panel just
            // made. Closing it would be the wrong end of the flow: the groups
            // section only exists for a saved panel, so closing here would mean
            // adding a panel and then having to find it and re-open it before
            // it could be told what to sell. Walking this in the browser is how
            // that was noticed — the first version left the CREATE form open
            // and a second «ذخیره» answered 409 on its own code.
            setCreating(false);
            setEditing(saved);
            void load();
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
