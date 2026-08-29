/**
 * دستگاه‌ها — the phones that carry every bank SMS.
 *
 * This screen answers four questions and used to answer them in a nine-column
 * table: نام · کد · وضعیت · اتصال · توکن · ساخته‌شده · آخرین حضور · آخرین
 * موفقیت · آخرین خطای احراز · عملیات. At panel width that gives the name
 * column about fifty pixels, so «Staging Device» broke into «Stagi / ng /
 * Devic / e» and the two action buttons broke mid-word into «ساخ ت توکن» and
 * «غیرفعا لکردن» — a screen whose own words could not be read, with four date
 * columns that were «—» on nearly every row.
 *
 * A device is not a row of nine equal facts. It is one phone with a state, and
 * the operator wants: which phone, is it being heard from, does it have a key,
 * and what can I do about it. So it is a card, at every width — the same card
 * the narrow layout already used — and a timestamp appears only when there is
 * one. Devices that have been switched off go into a collapsed section rather
 * than filling the screen alongside the live ones.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Cache } from './query.js';
import { forMutation, QK } from './queries.js';
import { count } from '../format.js';
import { useWriteProps } from '../role.js';
import { formatTime } from './format.js';
import { api, type DeviceListItem } from './api.js';
import { sortBy, type ColumnType } from './sort.js';
import { useTableSortState } from './useTableSortState.js';
import { DeleteDeviceModal } from './DeleteDeviceModal.js';
import { DeviceSetupModal, type DeviceSetup, type SetupOrigin } from './DeviceSetupModal.js';

interface DevicesViewProps {
  cache: Cache;
}

const SORT_COLUMNS: Record<string, ColumnType> = {
  display_name: 'text',
  last_seen_at: 'date',
  created_at: 'date',
};

function deviceAccessor(col: string) {
  return (d: DeviceListItem) => {
    switch (col) {
      case 'display_name':
        return d.display_name ?? '';
      case 'last_seen_at':
        return d.last_seen_at ?? null;
      case 'created_at':
        return d.created_at ?? null;
      default:
        return null;
    }
  };
}

function suggestDeviceCode(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Whether this phone is being heard from — which is NOT whether it is switched
 * on in the panel.
 *
 * «وضعیت» is `d.active`: an operator flipped a switch. This is what the
 * timestamps say. They are independent, and a device that is enabled but
 * silent is the single most important card on this screen — a phone that
 * should be relaying bank SMS and is not, which means payments stop verifying
 * themselves and nobody is told.
 *
 * Both used to answer «غیرفعال». One word, two meanings, on the same row: the
 * screen showed «وضعیت: فعال» beside «اتصال: غیرفعال» and read as a
 * contradiction rather than as the warning it was. The data was right the whole
 * time; only the word was wrong.
 *
 * So the administrative sense keeps «خاموش» and the liveness sense says what it
 * actually knows — how long the silence has been. Nothing here shares a string
 * with `d.active` any more.
 */
export function connectionStateLabel(d: DeviceListItem): {
  label: string;
  tone: 'good' | 'warn' | 'idle' | 'bad' | 'muted';
} {
  if (!d.active) return { label: 'خاموش شده', tone: 'muted' };
  if (!d.credential) return { label: 'نیازمند توکن', tone: 'warn' };
  if (d.last_auth_failure_at && (!d.last_success_at || d.last_auth_failure_at > d.last_success_at)) {
    return { label: 'احراز هویت ناموفق', tone: 'bad' };
  }
  if (!d.last_seen_at) return { label: 'هرگز وصل نشده', tone: 'idle' };
  const now = Date.now();
  const age = now - d.last_seen_at;
  if (age < 60_000) return { label: 'متصل', tone: 'good' };
  if (age < 5 * 60_000) return { label: 'چند دقیقه پیش', tone: 'good' };
  if (d.last_success_at && now - d.last_success_at < 24 * 60 * 60 * 1000) {
    return { label: 'امروز فعال بوده', tone: 'good' };
  }
  // Enabled, credentialled, and nothing for a day. Said out loud, because
  // «غیرفعال» here used to make it look like somebody had turned it off on
  // purpose — the one reading that stops an operator investigating.
  //
  // `warn`, not `bad`: an unheard-from phone may be switched off on a shelf,
  // and `bad` is reserved for a device that ANSWERED and was refused. Worth
  // looking at is not the same as known broken, and a screen that paints both
  // the same colour teaches the operator to ignore the colour.
  return { label: 'بیش از ۲۴ ساعت بی‌خبر', tone: 'warn' };
}

/**
 * The one line on the card that says what to do next.
 *
 * Sam's complaint about this panel was «معلوم نیست دکمه‌ها چیکار می‌کنن». A
 * button label names an action; it cannot say why this particular phone needs
 * it. This can, and it is the difference between a screen an operator reads and
 * one they guess at.
 */
export function nextStepFor(d: DeviceListItem): string | null {
  if (!d.active) return null;
  if (!d.credential) {
    return 'هنوز کلیدی ندارد. «ساخت کلید» را بزن تا کلید و پیکربندی آماده را بگیری و روی گوشی بگذاری.';
  }
  if (d.last_auth_failure_at && (!d.last_success_at || d.last_auth_failure_at > d.last_success_at)) {
    return 'آخرین تلاش این گوشی رد شد — کلیدی که رویش هست با کلید اینجا یکی نیست. «چرخش کلید» و واردکردن دوباره روی گوشی درستش می‌کند.';
  }
  if (!d.last_seen_at) {
    return 'کلید دارد ولی هنوز هیچ‌وقت وصل نشده. یک پیامک آزمایشی به آن گوشی بفرست.';
  }
  return null;
}

/**
 * The one server refusal on this screen that an operator can do nothing about,
 * said in a sentence instead of a code.
 *
 * `INGEST_URL` is the address printed into a phone's SMS-relay configuration.
 * Without it `POST /devices` and both credential routes answer 503 before they
 * read the request body — so no device can be registered and no key can be
 * issued at all. On 2026-08-29 the staging dashboard had never been given one:
 * it deployed green, every check passed, and the first screen of the whole
 * bank-SMS chain was dead. What reached the screen was
 * `Error: 503: ingest_url_not_configured`, which names the fault and not one
 * thing to do about it.
 */
export function explainDeviceError(e: unknown): string {
  const msg = String(e);
  if (msg.includes('ingest_url_not_configured')) {
    return 'این داشبورد نشانی سرویس دریافت پیامک را ندارد، پس نمی‌تواند پیکربندی گوشی را بسازد. تا وقتی متغیر INGEST_URL روی همین اپ تنظیم نشود، نه دستگاهی ساخته می‌شود و نه کلیدی صادر. این تنظیم سمت دیپلوی است، نه چیزی که از این صفحه درست شود.';
  }
  return msg;
}

export function DevicesView({ cache }: DevicesViewProps) {
  const w = useWriteProps();
  const { data, status, error } = cache.useQuery<{ ok: boolean; items: DeviceListItem[] }>(
    QK.devices,
    {
      fetcher: async (signal) => {
        const r = await fetch('/api/v1/devices', { signal });
        if (!r.ok) {
          if (r.status === 401 || r.status === 403) throw new Error('session_expired');
          throw new Error(`${r.status}`);
        }
        return r.json();
      },
    },
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [deleteFor, setDeleteFor] = useState<DeviceListItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  /** What the last press did. There was a channel for failure and none for success. */
  const [rowDone, setRowDone] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * The one-time key, whichever of the three paths minted it. Held here rather
   * than inside the create modal because generate and rotate return the same
   * payload and used to discard it.
   */
  const [setup, setSetup] = useState<{ payload: DeviceSetup; origin: SetupOrigin } | null>(null);

  const items = data?.items ?? [];
  const [sort, setSort] = useTableSortState('devices', {
    column: 'display_name',
    direction: 'asc',
  });
  const sortedItems = useMemo(
    () =>
      sortBy(
        items,
        sort.column && SORT_COLUMNS[sort.column]
          ? {
              column: sort.column,
              type: SORT_COLUMNS[sort.column]!,
              accessor: deviceAccessor(sort.column),
            }
          : null,
        sort.direction,
      ),
    [items, sort.column, sort.direction],
  );

  const live = sortedItems.filter((d) => d.active);
  const retired = sortedItems.filter((d) => !d.active);

  async function doAction(
    idOrCode: string,
    fn: () => Promise<unknown>,
    mutation: keyof typeof import('./queries.js').FOR_MUTATION,
    /** Said afterwards, because a row that quietly changes says nothing. */
    said?: string,
  ) {
    setBusyId(idOrCode);
    setRowError(null);
    setRowDone(null);
    try {
      await fn();
      cache.invalidate(...forMutation(mutation));
      if (said) setRowDone(said);
    } catch (e) {
      setRowError(explainDeviceError(e));
    } finally {
      setBusyId(null);
    }
  }

  /**
   * A key-minting press: the response IS the deliverable, so it is shown rather
   * than awaited and dropped. See the header of `DeviceSetupModal`.
   */
  async function mintKey(
    d: DeviceListItem,
    fn: () => Promise<unknown>,
    mutation: keyof typeof import('./queries.js').FOR_MUTATION,
    origin: SetupOrigin,
  ) {
    setBusyId(d.id);
    setRowError(null);
    setRowDone(null);
    try {
      const r = (await fn()) as DeviceSetup;
      cache.invalidate(...forMutation(mutation));
      setSetup({ payload: r, origin });
    } catch (e) {
      setRowError(explainDeviceError(e));
    } finally {
      setBusyId(null);
    }
  }

  /**
   * The question asked before a press that stops a phone posting bank SMS.
   *
   * `POST /api/v1/sms` is the only public surface this platform has and the
   * whole payment chain runs through it: revoke a device's key and that phone's
   * messages stop arriving, claims stop matching, and customers who paid sit
   * unverified. Walking this screen on 2026-08-22, «ابطال توکن» did exactly
   * that on one click, with no question and no word afterwards — while retiring
   * a stock config, deleting an expense and blocking a customer all ask first.
   *
   * Recovery is not a second press here either: the key is typed into the
   * Android app by hand, so whoever revokes it needs the phone.
   */
  function askAboutTheToken(name: string, what: 'rotate' | 'revoke'): boolean {
    return window.confirm(
      what === 'revoke'
        ? `کلید «${name}» باطل شود؟ این گوشی دیگر نمی‌تواند پیامک بانکی بفرستد و پرداخت‌هایی که از آن می‌آمدند تایید نمی‌شوند. برگرداندنش یعنی ساختن کلید تازه و واردکردن دستی‌اش روی همان گوشی.`
        : `کلید «${name}» عوض شود؟ کلید فعلی همان لحظه از کار می‌افتد و تا واردکردن کلید تازه روی خود گوشی، پیامک‌های آن نمی‌رسند.`,
    );
  }

  const handlers = (d: DeviceListItem) => ({
    onRotate: () => {
      if (!askAboutTheToken(d.display_name, 'rotate')) return;
      void mintKey(d, () => api.rotateDeviceCredential(d.id), 'deviceCredentialRotated', 'rotated');
    },
    onRevoke: () => {
      if (!askAboutTheToken(d.display_name, 'revoke')) return;
      void doAction(
        d.id,
        () => api.revokeDeviceCredential(d.id),
        'deviceCredentialRevoked',
        `کلید «${d.display_name}» باطل شد — این گوشی دیگر پیامک نمی‌فرستد.`,
      );
    },
    onGenerate: () => {
      void mintKey(
        d,
        () => api.generateDeviceCredential(d.id),
        'deviceCredentialCreated',
        'generated',
      );
    },
    onDeactivate: () => {
      void doAction(
        d.id,
        () => api.deactivateDevice(d.id),
        'deviceDeactivated',
        `«${d.display_name}» خاموش شد — پیامک‌هایش دیگر پذیرفته نمی‌شوند.`,
      );
    },
    onReactivate: () => {
      void doAction(
        d.id,
        () => api.reactivateDevice(d.id),
        'deviceReactivated',
        `«${d.display_name}» دوباره روشن شد.`,
      );
    },
    onDelete: () => setDeleteFor(d),
  });

  if (status === 'loading' && !data) return <p className="muted">در حال بارگذاری…</p>;
  if (error && !data) {
    return (
      <p className="error">
        بارگذاری دستگاه‌ها ناموفق بود.{' '}
        <button type="button" onClick={() => cache.refetch(QK.devices)}>
          تلاش دوباره
        </button>
      </p>
    );
  }

  return (
    <div className="devices">
      <div className="row toolbar">
        <h2>دستگاه‌ها ({count(items.length)})</h2>
        <div className="spacer" />
        <button
          type="button"
          className="primary"
          onClick={() => setCreateOpen(true)}
          data-testid="open-add-device"
          {...w}
        >
          + افزودن دستگاه
        </button>
      </div>
      <p className="muted devices__lede">
        هر دستگاه یک گوشی اندروید است که SMS Relay رویش نصب شده و پیامک‌های بانکی را برای ما
        می‌فرستد. تا وقتی یک گوشی کلید نداشته باشد، هیچ پیامکی از آن پذیرفته نمی‌شود.
      </p>

      {rowError && <div className="error">{rowError}</div>}
      {rowDone && (
        <div className="muted" role="status">
          {rowDone}
        </div>
      )}
      {notice && (
        <div className="success-banner" role="status" aria-live="polite">
          {notice}
        </div>
      )}

      {createOpen && (
        <CreateDeviceModal
          cache={cache}
          onClose={() => setCreateOpen(false)}
          onCreated={(payload) => {
            setCreateOpen(false);
            setSetup({ payload, origin: 'created' });
          }}
        />
      )}
      {setup && (
        <DeviceSetupModal
          setup={setup.payload}
          origin={setup.origin}
          onClose={() => setSetup(null)}
        />
      )}
      {deleteFor && (
        <DeleteDeviceModal
          device={deleteFor}
          // So the modal has somewhere to send the history. Without a target
          // there is nothing to pick, and a device that ever carried one SMS
          // stays undeletable forever.
          devices={items}
          onClose={() => setDeleteFor(null)}
          onDeleted={() => {
            setDeleteFor(null);
            setNotice(`دستگاه ${deleteFor.display_name} حذف شد.`);
            cache.invalidate(...forMutation('deviceDeleted'));
          }}
        />
      )}

      {items.length === 0 ? (
        <p className="empty">
          هیچ دستگاهی ثبت نشده. برای ساختن یکی روی <strong>+ افزودن دستگاه</strong> بزن.
        </p>
      ) : (
        <>
          {items.length > 1 && (
            <div className="row toolbar sort-dropdown">
              <label htmlFor="sort-devices">مرتب‌سازی:</label>
              <select
                id="sort-devices"
                value={sort.column ? `${sort.column}-${sort.direction}` : ''}
                onChange={(e) => {
                  const [col, dir] = e.target.value.split('-');
                  setSort({ column: col ?? '', direction: (dir as 'asc' | 'desc') ?? 'asc' });
                }}
              >
                <option value="display_name-asc">نام: صعودی</option>
                <option value="display_name-desc">نام: نزولی</option>
                <option value="last_seen_at-desc">آخرین حضور: تازه‌ترین</option>
                <option value="last_seen_at-asc">آخرین حضور: قدیمی‌ترین</option>
                <option value="created_at-desc">ساخت: تازه‌ترین</option>
                <option value="created_at-asc">ساخت: قدیمی‌ترین</option>
              </select>
            </div>
          )}

          {live.length === 0 ? (
            <p className="empty">هیچ دستگاه روشنی نیست — همه خاموش‌اند.</p>
          ) : (
            <ul className="card-list device-grid" aria-label="دستگاه‌های روشن">
              {live.map((d) => (
                <DeviceCard key={d.id} d={d} busy={busyId === d.id} {...handlers(d)} />
              ))}
            </ul>
          )}

          {/* Switched-off devices are history, not work. They stay reachable —
              reactivating and permanent delete both live in here — but they no
              longer sit between the operator and the phones that matter. */}
          {retired.length > 0 && (
            <details className="devices__retired" data-testid="retired-devices">
              <summary>دستگاه‌های خاموش ({count(retired.length)})</summary>
              <ul className="card-list device-grid" aria-label="دستگاه‌های خاموش">
                {retired.map((d) => (
                  <DeviceCard key={d.id} d={d} busy={busyId === d.id} {...handlers(d)} />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

/** A timestamp row, present only when there is a timestamp. */
function When({ label, at }: { label: string; at: number | null | undefined }) {
  if (!at) return null;
  return (
    <div className="card-row">
      <span className="label">{label}</span>
      <span>{formatTime(at)}</span>
    </div>
  );
}

function DeviceCard({
  d,
  busy,
  onRotate,
  onRevoke,
  onDeactivate,
  onReactivate,
  onGenerate,
  onDelete,
}: {
  d: DeviceListItem;
  busy: boolean;
  onRotate: () => void;
  onRevoke: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
  onGenerate: () => void;
  onDelete: () => void;
}) {
  const w = useWriteProps();
  const cs = connectionStateLabel(d);
  const next = nextStepFor(d);
  return (
    <li className={`hub-card device-card status-${cs.tone}${d.active ? '' : ' dim'}`}>
      <div className="card-row card-row--top device-card__head">
        <strong>{d.display_name}</strong>
        <span className={`status-pill status-${cs.tone}`}>{cs.label}</span>
      </div>
      <code className="device-card__code">{d.device_code}</code>

      <div className="card-row">
        <span className="label">کلید</span>
        {d.credential ? (
          <code className="masked">{d.credential.token_prefix}…</code>
        ) : (
          <span className="muted">ندارد</span>
        )}
      </div>
      <When label="آخرین حضور" at={d.last_seen_at} />
      <When label="آخرین پیامک پذیرفته‌شده" at={d.last_success_at} />
      <When label="آخرین خطای احراز" at={d.last_auth_failure_at} />

      {next && <p className="device-card__next">{next}</p>}

      <div className="card-actions device-card__actions">
        {d.active && !d.credential && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={onGenerate}
            title="یک کلید تازه می‌سازد و پیکربندی آمادهٔ گوشی را نشان می‌دهد"
            {...w}
          >
            ساخت کلید
          </button>
        )}
        {d.active && d.credential && (
          <button
            type="button"
            disabled={busy}
            onClick={onRotate}
            title="کلید فعلی را باطل می‌کند و یک کلید تازه می‌دهد — باید روی گوشی وارد شود"
            {...w}
          >
            چرخش کلید
          </button>
        )}
        {d.active && d.credential && (
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={onRevoke}
            title="کلید را باطل می‌کند بدون اینکه کلید تازه‌ای بدهد"
            {...w}
          >
            ابطال کلید
          </button>
        )}
        {d.active ? (
          <button
            type="button"
            disabled={busy}
            onClick={onDeactivate}
            title="دستگاه را خاموش می‌کند — پیامک‌هایش پذیرفته نمی‌شوند، ولی چیزی حذف نمی‌شود"
            {...w}
          >
            خاموش‌کردن
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={onReactivate} {...w}>
            روشن‌کردن دوباره
          </button>
        )}
        {!d.active && (
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={onDelete}
            data-testid="device-delete"
            title="ردیف دستگاه را برای همیشه حذف می‌کند — فقط وقتی هیچ پیامک و حسابی به آن وصل نباشد"
            {...w}
          >
            حذف همیشگی
          </button>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// CreateDeviceModal — the form, and only the form.
//
// It used to also own the one-time key screen, which is why generate and
// rotate had nowhere to show theirs. On success it hands the payload up and
// the parent mounts `DeviceSetupModal`, the same one all three paths use.
// ---------------------------------------------------------------------------

function CreateDeviceModal({
  cache,
  onClose,
  onCreated,
}: {
  cache: Cache;
  onClose: () => void;
  onCreated: (setup: DeviceSetup) => void;
}) {
  const [deviceCode, setDeviceCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Remember the element that opened us so we can restore focus on close.
  const triggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    triggerRef.current = (document.activeElement as HTMLElement | null) ?? null;
    return () => {
      const t = triggerRef.current;
      if (t && typeof t.focus === 'function') t.focus();
    };
  }, []);

  const suggestedCode = useMemo(() => suggestDeviceCode(displayName), [displayName]);
  const codeValid = useMemo(() => {
    const v = deviceCode.trim().toLowerCase();
    return v.length >= 3 && v.length <= 64 && /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(v);
  }, [deviceCode]);
  const nameValid = displayName.trim().length > 0;

  const requestClose = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      requestClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [requestClose]);

  async function submit() {
    if (!codeValid || !nameValid) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const r = await api.createDevice({
        deviceCode: deviceCode.trim().toLowerCase(),
        displayName: displayName.trim(),
        description: description.trim() || null,
      });
      cache.invalidate(...forMutation('deviceCreated'));
      onCreated(r as DeviceSetup);
    } catch (e) {
      const msg = String(e);
      if (msg.includes('409') || msg.includes('duplicate_device_code')) {
        setSubmitError('این کد دستگاه قبلاً گرفته شده. یکی دیگر انتخاب کن.');
      } else {
        setSubmitError(explainDeviceError(e));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="افزودن دستگاه"
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div className="modal-body">
        <div className="row toolbar">
          <h3>افزودن دستگاه</h3>
          <div className="spacer" />
          <button
            type="button"
            onClick={requestClose}
            aria-label="بستن"
            data-testid="device-modal-close"
          >
            ×
          </button>
        </div>
        <p className="muted">
          یک گوشی اندروید تازه که SMS Relay رویش نصب است ثبت کن. بعد از ساخت، یک کلید یک‌بارمصرف
          می‌گیری به‌علاوهٔ پیکربندی آماده‌ای که در اپ می‌چسبانی.
        </p>
        <div className="form">
          <label>
            <span>نام دستگاه</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => {
                const v = e.target.value;
                setDisplayName(v);
                if (!deviceCode || deviceCode === suggestDeviceCode(displayName)) {
                  setDeviceCode(suggestDeviceCode(v));
                }
              }}
              placeholder="گوشی اندروید پویان ۲"
              autoFocus
            />
          </label>
          <label>
            <span>شناسه / کد دستگاه</span>
            <input
              type="text"
              value={deviceCode}
              onChange={(e) => setDeviceCode(e.target.value.trim().toLowerCase())}
              placeholder={suggestedCode || 'phone-poyan-02'}
            />
            {/* Latin, because this code goes into a URL and into the JSON the
                Android app is configured with. A Persian device name is fine
                and common, but it suggests no code — say so here rather than
                leaving the operator with a disabled button and no reason. */}
            <small className="muted">
              حروف کوچک لاتین، رقم و خط تیره. ۳ تا ۶۴ نویسه. باید یکتا باشد. اگر نام دستگاه فارسی
              است، کد را خودت بنویس.
              {suggestedCode && deviceCode !== suggestedCode ? (
                <>
                  {' '}
                  پیشنهاد از روی نام: <code>{suggestedCode}</code>
                </>
              ) : null}
            </small>
          </label>
          <label>
            <span>توضیح (اختیاری)</span>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="گوشی یدک، سیم‌کارت پشتیبان و مانند آن"
            />
          </label>
        </div>
        {submitError && <div className="error">{submitError}</div>}
        <div className="row toolbar modal-actions">
          <button type="button" onClick={requestClose}>
            انصراف
          </button>
          <div className="spacer" />
          <button
            type="button"
            className="primary"
            disabled={submitting || !codeValid || !nameValid}
            onClick={submit}
          >
            ساخت دستگاه
          </button>
        </div>
      </div>
    </div>
  );
}
