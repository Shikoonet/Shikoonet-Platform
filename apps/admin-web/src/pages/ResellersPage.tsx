/**
 * «نمایندگان» — the franchises, what they bought, and what the meter says.
 *
 * ## What this screen deliberately does not have
 *
 * A list of anybody's customers. A reseller runs their own installation and
 * their customers never reach this database — Sam's own line was that we need
 * to know how much they used, not who used it. So there is no drill-down into
 * their shop, and `latestTotalUsers` is a COUNT shown as context, never a door.
 *
 * ## The one number that could be quietly wrong
 *
 * «مصرف کل» is `max(lifetime_used_bytes)` over the append-only ledger, not the
 * newest reading and not a sum. Two readings of the same hour must not double
 * an invoice, and a panel whose counter was reset must not make a bill shrink.
 * The API decides that; this file only has to keep them apart on screen, which
 * is why «این دوره» is drawn beside it rather than instead of it.
 *
 * And «هنوز خوانده نشده» is drawn for `null` rather than «۰ گیگ». On a screen
 * about money those are the same glyph and opposite facts.
 *
 * ## «پنل نمایندگی» (#474)
 *
 * A row is either linked to an admin that already exists on the panel
 * (`ACTIVE`) or left for the bot to create on the reseller's first paid
 * purchase (`PENDING`). Volume is never typed here: the bot seeds it from the
 * panel, and after that only a paid order moves it.
 */

import { useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type CustomerListItem,
  type PanelItem,
  type ResellerReading,
  type ResellerRow,
} from '../api.js';
import { count, dateOnly, dateTime, endOfTehranDay, gigabytes } from '../format.js';
import { useAdminWriteProps } from '../role.js';

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'در انتظار ساخت',
  ACTIVE: 'فعال',
  SUSPENDED: 'معلق',
  CLOSED: 'بسته',
};

type Target = 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

/**
 * The only moves the server accepts from each status — anything else is a
 * 409 `transition_refused`, so it is not drawn. CLOSED has no way out.
 * Removing a deadline does not reactivate a suspended row; «فعال‌سازی» does.
 */
const MOVES: Record<string, ReadonlyArray<{ to: Target; label: string }>> = {
  PENDING: [{ to: 'CLOSED', label: 'بستن' }],
  ACTIVE: [
    { to: 'SUSPENDED', label: 'تعلیق' },
    { to: 'CLOSED', label: 'بستن' },
  ],
  SUSPENDED: [
    { to: 'ACTIVE', label: 'فعال‌سازی' },
    { to: 'CLOSED', label: 'بستن' },
  ],
};

/** A name the bot may create on PasarGuard. The server checks the same pattern. */
const NEW_ADMIN_NAME = /^[A-Za-z0-9_.-]{3,34}$/;

/** The server's refusals, in the operator's words. */
function reason(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  if (e.code === 'that panel admin is already taken') {
    return 'این ادمین پنل قبلاً به نمایندهٔ دیگری وصل شده است.';
  }
  if (e.code === 'transition_refused') {
    return 'این تغییر وضعیت پذیرفته نشد — وضعیت همین حالا عوض شده؛ صفحه را تازه کنید.';
  }
  if (e.code === 'volume_moved') return 'حجم همین حالا عوض شد؛ صفحه را تازه کنید.';
  if (e.code === 'bad request') return 'ورودی پذیرفته نشد — فیلدها را دوباره ببینید.';
  if (e.code === 'forbidden') return 'این کار فقط با نقش «مدیر» ممکن است.';
  return e.message;
}

/** «@username · 123456», or the telegram id alone — how every screen names a customer. */
function customerLabel(c: { telegramId: number; username: string | null }): string {
  return c.username ? `@${c.username} · ${c.telegramId}` : String(c.telegramId);
}

/** `YYYY-MM-DD` from a date input → the first instant after that Tehran day. */
function deadlineMs(day: string): number {
  return Date.parse(endOfTehranDay(day));
}

/**
 * What the meter says about capacity, as one sentence.
 *
 * Written here rather than as three columns because the operator's question is
 * "is this one about to run out", and three numbers they have to divide in
 * their head is how that gets missed.
 */
function capacityLine(row: ResellerRow): string {
  if (row.status === 'PENDING') return 'هنوز ساخته نشده';
  if (row.dataLimitBytes === null) return 'نامحدود';
  const used = row.billableBytes;
  // A cap of ZERO is a real state and not the same as no cap — the whole
  // reason the adapter refuses to collapse `null` into `0`. It is what the
  // panel reports for an admin who may use nothing at all, and dividing by it
  // would put «NaN٪» or «Infinity٪» on a screen about money. Said in words
  // instead.
  if (row.dataLimitBytes === 0) {
    return used === null || used === 0 ? 'سقف صفر' : `${gigabytes(used)} با سقف صفر`;
  }
  if (used === null) return `${gigabytes(row.dataLimitBytes)} خریده`;
  const pct = Math.round((used / row.dataLimitBytes) * 100);
  return `${gigabytes(used)} از ${gigabytes(row.dataLimitBytes)} (${count(pct)}٪)`;
}

/**
 * «ثبت نماینده». Two ways in, and the difference is who makes the panel admin.
 *
 * `?user=<id>` pre-fills the user: «لیست درخواست‌ها» links here from an
 * approved request, so the operator does not copy a number across screens.
 * Otherwise the user is FOUND, by telegram id or @username, through the same
 * search «کاربران» uses — nobody knows our internal `users.id` by heart.
 */
function NewResellerForm({
  initialUserId,
  onCreated,
  onCancel,
}: {
  initialUserId: string;
  onCreated: (name: string) => void;
  onCancel: () => void;
}) {
  const w = useAdminWriteProps();
  const [mode, setMode] = useState<'ACTIVE' | 'PENDING'>('ACTIVE');
  const prefillId = Number(initialUserId);
  const [picked, setPicked] = useState<{ id: number; label: string } | null>(
    Number.isInteger(prefillId) && prefillId > 0
      ? { id: prefillId, label: `کاربر #${count(prefillId)}` }
      : null,
  );
  const [q, setQ] = useState('');
  /** `null` = not searched yet; `[]` = searched and nobody matched. */
  const [matches, setMatches] = useState<CustomerListItem[] | null>(null);
  const [panels, setPanels] = useState<PanelItem[] | null>(null);
  const [providerId, setProviderId] = useState('');
  const [adminName, setAdminName] = useState('');
  const [name, setName] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .panels()
      .then((r) => live && setPanels(r.items))
      .catch(() => live && setErr('فهرست پنل‌ها خوانده نشد'));
    return () => {
      live = false;
    };
  }, []);

  // The prefilled id already IS the answer; this only puts a face on it. A
  // failure leaves «کاربر #id», which is still the right user.
  useEffect(() => {
    if (!(Number.isInteger(prefillId) && prefillId > 0)) return;
    let live = true;
    api
      .customer(prefillId)
      .then((r) => live && setPicked({ id: prefillId, label: customerLabel(r.customer) }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [prefillId]);

  async function search() {
    const term = q.trim();
    if (term === '') return;
    setErr(null);
    try {
      const r = await api.customers({ q: term, page: 1, pageSize: 10 });
      setMatches(r.items);
    } catch (e) {
      setErr(reason(e, 'جست‌وجوی کاربر انجام نشد'));
    }
  }

  // The bot can create an admin only on PasarGuard today (#474); linking an
  // existing admin is whatever panel the meter can read.
  const offered = (panels ?? []).filter((p) => mode === 'ACTIVE' || p.kind === 'pasarguard');
  const panel = offered.find((p) => String(p.id) === providerId) ?? null;
  const uid = picked?.id ?? 0;
  const admin = adminName.trim();
  const adminOk =
    mode === 'PENDING' ? NEW_ADMIN_NAME.test(admin) : admin.length >= 1 && admin.length <= 34;
  const ready =
    Number.isInteger(uid) && uid > 0 && panel !== null && adminOk && name.trim() !== '';

  async function submit() {
    if (!ready || panel === null) return;
    setBusy(true);
    setErr(null);
    try {
      await api.createReseller({
        userId: uid,
        providerId: panel.id,
        panelAdminUsername: admin,
        name: name.trim(),
        // Never typed here: the bot reads it from the panel once, then only a
        // paid order moves it. For PENDING the server refuses anything else.
        dataLimitBytes: null,
        expiresAtMs: expiresOn === '' ? null : deadlineMs(expiresOn),
        installationUrl: null,
        note: null,
        status: mode,
      });
      onCreated(name.trim());
    } catch (e) {
      setErr(reason(e, 'نماینده ثبت نشد'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBlockEnd: 16 }}>
      <h2>ثبت نمایندهٔ تازه</h2>
      {err !== null && (
        <div className="alert alert-error" role="alert">
          {err}
        </div>
      )}

      <fieldset className="filters" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="form-label">ادمین پنل</legend>
        <label className="form-label">
          <input
            type="radio"
            name="reseller-mode"
            checked={mode === 'ACTIVE'}
            onChange={() => setMode('ACTIVE')}
          />{' '}
          ادمین موجود روی پنل
        </label>
        <label className="form-label">
          <input
            type="radio"
            name="reseller-mode"
            checked={mode === 'PENDING'}
            onChange={() => setMode('PENDING')}
          />{' '}
          پنل جدید بسازد
        </label>
      </fieldset>
      <p className="muted">
        {mode === 'ACTIVE'
          ? 'ادمین از قبل روی پنل هست. تا نقشش روی پنل «نماینده» و آیدی تلگرامش آیدی همین ' +
            'کاربر نشود، ربات هیچ خریدی را روی آن نمی‌پذیرد.'
          : 'ربات ادمین را با همین یوزرنیم روی پنل می‌سازد — در اولین خرید پرداخت‌شدهٔ ' +
            'نماینده. تا آن موقع ردیف «در انتظار ساخت» است.'}
      </p>

      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="reseller-user-q">
            کاربر — آیدی عددی تلگرام یا @یوزرنیم
          </label>
          <div className="filters">
            <input
              id="reseller-user-q"
              className="form-control ltr grow"
              type="search"
              autoComplete="off"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void search();
                }
              }}
              {...w}
            />
            <button
              type="button"
              className="btn btn-sm"
              disabled={q.trim() === ''}
              onClick={() => void search()}
              {...w}
            >
              جست‌وجو
            </button>
          </div>
          <p className="muted" aria-live="polite" data-testid="reseller-picked">
            {/* `<bdi dir="ltr">` so «@name · 123» is not reordered by the RTL line. */}
            {picked === null ? (
              'هنوز کاربری انتخاب نشده.'
            ) : (
              <>
                انتخاب‌شده: <bdi dir="ltr">{picked.label}</bdi>
              </>
            )}
          </p>
          {matches !== null && matches.length === 0 && (
            <div className="alert alert-warning">
              این کاربر هنوز ربات را استارت نکرده — اول باید یک بار /start بزند.
            </div>
          )}
          {matches !== null && matches.length > 0 && (
            <div className="filters" role="group" aria-label="کاربرهای پیدا شده">
              {matches.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={picked?.id === c.id ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
                  aria-pressed={picked?.id === c.id}
                  dir="ltr"
                  onClick={() => setPicked({ id: c.id, label: customerLabel(c) })}
                  {...w}
                >
                  {customerLabel(c)}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="grow">
          <label className="form-label" htmlFor="reseller-panel">
            پنل
          </label>
          <select
            id="reseller-panel"
            className="form-control"
            value={panel === null ? '' : String(panel.id)}
            onChange={(e) => setProviderId(e.target.value)}
            {...w}
          >
            <option value="">{panels === null ? 'در حال خواندن…' : 'انتخاب کنید'}</option>
            {offered.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {mode === 'PENDING' && panel !== null && (panel.resellerSale ?? null) === null && (
        <div className="alert alert-warning">
          «فروش به نماینده» روی این پنل تنظیم نشده؛ تا تنظیم نشود ربات خرید را نمی‌پذیرد.
        </div>
      )}

      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="reseller-admin">
            {mode === 'PENDING' ? 'یوزرنیم ادمین جدید' : 'یوزرنیم ادمین روی پنل'}
          </label>
          <input
            id="reseller-admin"
            className="form-control ltr"
            type="text"
            autoComplete="off"
            maxLength={34}
            aria-invalid={admin !== '' && !adminOk}
            aria-describedby="reseller-admin-hint"
            value={adminName}
            onChange={(e) => setAdminName(e.target.value)}
            {...w}
          />
          <p
            id="reseller-admin-hint"
            className={admin !== '' && !adminOk ? 'alert alert-error' : 'muted'}
          >
            {mode === 'PENDING'
              ? 'فقط حروف انگلیسی، عدد، نقطه، خط تیره و زیرخط؛ ۳ تا ۳۴ کاراکتر'
              : 'دقیقاً همان‌طور که روی پنل نوشته شده — بزرگی و کوچکی حروف فرق دارد؛ ' +
                'حداکثر ۳۴ کاراکتر'}
          </p>
        </div>
        <div className="grow">
          <label className="form-label" htmlFor="reseller-name">
            نام نماینده
          </label>
          <input
            id="reseller-name"
            className="form-control"
            type="text"
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            {...w}
          />
        </div>
        <div className="grow">
          <label className="form-label" htmlFor="reseller-expires">
            مهلت <span className="muted">(خالی = بی‌مهلت)</span>
          </label>
          <input
            id="reseller-expires"
            className="form-control ltr"
            type="date"
            value={expiresOn}
            onChange={(e) => setExpiresOn(e.target.value)}
            {...w}
          />
        </div>
      </div>

      <div className="modal-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !ready}
          onClick={() => void submit()}
          {...w}
        >
          {busy ? 'در حال ثبت…' : 'ثبت نماینده'}
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          انصراف
        </button>
      </div>
    </div>
  );
}

/**
 * Name, note and deadline — the PATCH is partial, so only what changed goes.
 *
 * No volume box: the bot writes it on every paid order, and an edit here would
 * race that. The server guards it (`volume_moved`) for whoever does add one.
 */
function EditReseller({
  row,
  onSaved,
  onCancel,
}: {
  row: ResellerRow;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const w = useAdminWriteProps();
  const [name, setName] = useState(row.name);
  const [note, setNote] = useState(row.note ?? '');
  const [expiresOn, setExpiresOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send(patch: Parameters<typeof api.updateReseller>[1]) {
    setBusy(true);
    setErr(null);
    try {
      await api.updateReseller(row.id, patch);
      onSaved();
    } catch (e) {
      setErr(reason(e, 'تغییر ذخیره نشد'));
    } finally {
      setBusy(false);
    }
  }

  const noteValue = note.trim() === '' ? null : note.trim();
  const patch = {
    ...(name.trim() !== row.name ? { name: name.trim() } : {}),
    ...(noteValue !== row.note ? { note: noteValue } : {}),
    ...(expiresOn !== '' ? { expiresAtMs: deadlineMs(expiresOn) } : {}),
  };

  return (
    <div className="card" style={{ marginBlockStart: 16 }}>
      <h2>ویرایش «{row.name}»</h2>
      {err !== null && (
        <div className="alert alert-error" role="alert">
          {err}
        </div>
      )}
      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="reseller-edit-name">
            نام نماینده
          </label>
          <input
            id="reseller-edit-name"
            className="form-control"
            type="text"
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            {...w}
          />
        </div>
        <div className="grow">
          <label className="form-label" htmlFor="reseller-edit-expires">
            مهلت تازه{' '}
            <span className="muted">
              (الان: {row.expiresAt === null ? 'بدون سررسید' : dateOnly(row.expiresAt)})
            </span>
          </label>
          <input
            id="reseller-edit-expires"
            className="form-control ltr"
            type="date"
            value={expiresOn}
            onChange={(e) => setExpiresOn(e.target.value)}
            {...w}
          />
        </div>
      </div>
      <label className="form-label" htmlFor="reseller-edit-note">
        یادداشت
      </label>
      <textarea
        id="reseller-edit-note"
        className="form-control"
        rows={2}
        maxLength={500}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        {...w}
      />
      <p className="muted">
        برداشتن مهلت نمایندهٔ معلق را فعال نمی‌کند — برای آن «فعال‌سازی» را در ردیفش بزنید.
      </p>
      <div className="modal-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || Object.keys(patch).length === 0 || name.trim() === ''}
          onClick={() => void send(patch)}
          {...w}
        >
          ذخیره
        </button>
        {row.expiresAt !== null && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => void send({ expiresAtMs: null })}
            {...w}
          >
            برداشتن مهلت
          </button>
        )}
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          انصراف
        </button>
      </div>
    </div>
  );
}

export function ResellersPage() {
  const w = useAdminWriteProps();
  const [rows, setRows] = useState<ResellerRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [readings, setReadings] = useState<ResellerReading[]>([]);
  // `?user=` from «لیست درخواست‌ها» opens the form on that user.
  const [prefillUser] = useState(
    () => new URLSearchParams(window.location.search).get('user') ?? '',
  );
  const [creating, setCreating] = useState(prefillUser !== '');
  const [editing, setEditing] = useState<number | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // What is selected RIGHT NOW, readable from inside a promise that started
  // earlier. `open` in a closure is the value it had when the request began.
  const idRef = useRef<number | null>(null);
  idRef.current = open;

  async function load() {
    try {
      const res = await api.resellers();
      setRows(res.items);
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'فهرست نمایندگان خوانده نشد');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function showReadings(id: number) {
    if (open === id) {
      setOpen(null);
      return;
    }
    // Opened optimistically so a slow answer cannot land under the wrong row.
    // Open A, then B: if A's request finishes last, writing its rows without
    // this check would show A's ledger beneath B's name — a reseller looking
    // at somebody else's usage, which on this screen is the one mistake worth
    // ruling out.
    setOpen(id);
    setReadings([]);
    try {
      const res = await api.resellerReadings(id);
      setReadings((prev) => (idRef.current === id ? res.items : prev));
    } catch (e) {
      if (idRef.current === id) {
        setErr(e instanceof ApiError ? e.message : 'خوانش‌ها خوانده نشد');
      }
    }
  }

  async function setStatus(r: ResellerRow, status: Target) {
    // Closing has no way back, and takes «پنل نمایندگی» out of their menu.
    // The admin on the panel is not touched — that is done on the panel.
    if (
      status === 'CLOSED' &&
      !window.confirm(
        `«${r.name}» بسته شود؟ ردیف بسته دوباره باز نمی‌شود و «پنل نمایندگی» از منوی ربات ` +
          `او برداشته می‌شود. ادمینش روی پنل دست نمی‌خورد.`,
      )
    ) {
      return;
    }
    setBusy(r.id);
    setErr(null);
    try {
      await api.setResellerStatus(r.id, status);
      await load();
    } catch (e) {
      setErr(reason(e, 'وضعیت عوض نشد'));
    } finally {
      setBusy(null);
    }
  }

  const active = rows.filter((r) => r.status === 'ACTIVE').length;
  const editRow = rows.find((r) => r.id === editing) ?? null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2 className="page-head__title">نمایندگان</h2>
          {/* Both numbers, always — the same rule «محصولات» learned: a total on
              its own says nothing about whether anything is running.

              Inside the wrapper `div`, and in `page-head__sub` rather than
              `muted`: `.page-head` is `justify-content: space-between`, so a
              count that is a direct child is not a subtitle under the title —
              it is a second column, and it was drawn hard against the far edge
              of the screen with the title alone on the other side. */}
          <div className="page-head__sub">
            {count(rows.length)} نماینده · {count(active)} فعال
          </div>
        </div>
        {!creating && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setCreating(true)}
            {...w}
          >
            ثبت نماینده
          </button>
        )}
      </div>

      {creating && (
        <NewResellerForm
          initialUserId={prefillUser}
          onCancel={() => setCreating(false)}
          onCreated={(name) => {
            setCreating(false);
            setDone(`«${name}» ثبت شد.`);
            void load();
          }}
        />
      )}
      {done !== null && <div className="alert alert-ok">{done}</div>}

      <p className="muted" style={{ maxWidth: '60ch' }}>
        هر نماینده یک نصب کامل و جدا دارد — ربات، دیتابیس و پنل مدیریتی خودش — و فقط به
        پنل‌های VPN ما وصل است. مشتری‌های او هیچ‌وقت وارد دیتابیس ما نمی‌شوند؛ آنچه
        این‌جا می‌بینید کنتور خودِ پنل است، نه چیزی که او گزارش کرده.
      </p>

      {err !== null && (
        <div className="alert alert-error" role="alert">
          {err}
        </div>
      )}

      {rows.length === 0 && err === null && (
        <div className="empty">
          هنوز نماینده‌ای ثبت نشده. نماینده یک ردیف در همین صفحه است که به یک اکانت ادمین
          روی یکی از پنل‌های ما وصل می‌شود؛ مصرفش از همان‌جا خوانده می‌شود.
        </div>
      )}

      {rows.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>نماینده</th>
              <th>پنل</th>
              <th>ظرفیت و مصرف کل</th>
              <th>این دوره</th>
              <th>کاربرها</th>
              <th>سررسید</th>
              <th>آخرین خوانش</th>
              <th>وضعیت</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <div>{r.name}</div>
                  <div className="muted small">{r.panelAdminUsername}</div>
                </td>
                <td>{r.providerName}</td>
                <td>
                  {capacityLine(r)}
                  {/* The panel reached the cap by itself and, with
                      `disconnect_users_when_limited`, has already stopped that
                      franchise's customers. Worth its own badge: it is the one
                      state where nothing of ours acted and everything stopped. */}
                  {r.latestPanelIsLimited === true && (
                    <div className="badge badge-block">به سقف رسیده</div>
                  )}
                </td>
                <td>{r.latestUsedBytes === null ? '—' : gigabytes(r.latestUsedBytes)}</td>
                <td>{r.latestTotalUsers === null ? '—' : count(r.latestTotalUsers)}</td>
                <td>{r.expiresAt === null ? 'بدون سررسید' : dateOnly(r.expiresAt)}</td>
                <td>
                  {/* «هنوز خوانده نشده» rather than a zero. See the header. */}
                  {r.lastReadAt === null ? (
                    <span className="muted">هنوز خوانده نشده</span>
                  ) : (
                    dateTime(r.lastReadAt)
                  )}
                </td>
                <td>{STATUS_LABEL[r.status] ?? r.status}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void showReadings(r.id)}
                  >
                    {open === r.id ? 'بستن خوانش‌ها' : 'خوانش‌ها'}
                  </button>
                  {r.status !== 'CLOSED' && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-label={`ویرایش ${r.name}`}
                      onClick={() => setEditing(editing === r.id ? null : r.id)}
                      {...w}
                    >
                      ویرایش
                    </button>
                  )}
                  {(MOVES[r.status] ?? []).map((m) => (
                    <button
                      key={m.to}
                      type="button"
                      className={m.to === 'CLOSED' ? 'btn btn-sm btn-danger' : 'btn btn-sm'}
                      aria-label={`${m.label} ${r.name}`}
                      disabled={busy === r.id}
                      onClick={() => void setStatus(r, m.to)}
                      {...w}
                    >
                      {m.label}
                    </button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editRow !== null && (
        <EditReseller
          key={editRow.id}
          row={editRow}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setDone(`«${editRow.name}» ذخیره شد.`);
            void load();
          }}
        />
      )}

      {open !== null && (
        <div className="card">
          <h2>خوانش‌های کنتور</h2>
          <p className="muted">
            دفتر فقط‌افزودنی است — هیچ خوانشی ویرایش یا حذف نمی‌شود. صورت‌حساب از بیشینهٔ
            «مصرف کل» ساخته می‌شود، نه از جمع این ردیف‌ها؛ برای همین خواندن دوبارهٔ کنتور
            چیزی را دو برابر نمی‌کند.
          </p>
          {readings.length === 0 ? (
            <div className="empty">هنوز خوانشی ثبت نشده.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>زمان</th>
                  <th>این دوره</th>
                  <th>مصرف کل</th>
                  <th>سقف در آن لحظه</th>
                  <th>کاربرها</th>
                  <th>وضعیت پنل</th>
                </tr>
              </thead>
              <tbody>
                {readings.map((s) => (
                  <tr key={s.takenAt}>
                    <td>{dateTime(s.takenAt)}</td>
                    <td>{gigabytes(s.usedBytes)}</td>
                    <td>{gigabytes(s.lifetimeUsedBytes)}</td>
                    {/* The cap AS IT WAS when this was read. A cap raised
                        mid-period would otherwise make every earlier row look
                        wrong. */}
                    <td>{s.dataLimitBytes === null ? 'نامحدود' : gigabytes(s.dataLimitBytes)}</td>
                    <td>{count(s.totalUsers)}</td>
                    <td>{s.panelIsLimited === true ? 'به سقف رسیده' : (s.panelStatus ?? '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
