/**
 * Devices view — list, search, create, rotate, revoke, deactivate, reactivate.
 *
 * The Flow:
 *   1. User clicks "Add device" → form modal.
 *   2. Modal POSTs `/api/v1/devices`. On success, the modal switches
 *      to a one-time setup screen showing the plaintext token exactly
 *      once plus the SMS Relay configuration JSON.
 *   3. The user MUST copy the token (or close the modal knowing the
 *      token is lost). The modal is unmounted on close; we wipe
 *      every copy of the token from React state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Cache } from './query.js';
import { useMediaQuery } from './useMediaQuery.js';
import { forMutation, QK } from './queries.js';
import { count } from '../format.js';
import { useWriteProps } from '../role.js';
import { formatTime } from './format.js';
import { api, type DeviceListItem } from './api.js';
import { SortableHeader } from './SortableHeader.js';
import { useTableSortState } from './useTableSortState.js';
import { sortBy, type ColumnType } from './sort.js';
import { DeleteDeviceModal } from './DeleteDeviceModal.js';

interface DevicesViewProps {
  cache: Cache;
}

const DEVICE_COLUMNS = [
  { key: 'display_name', label: 'نام', type: 'text' as ColumnType },
  { key: 'device_code', label: 'کد', type: 'text' as ColumnType },
  { key: 'status', label: 'وضعیت', type: 'text' as ColumnType },
  { key: 'connection', label: 'اتصال', type: 'text' as ColumnType },
  { key: 'token', label: 'توکن', type: 'text' as ColumnType },
  { key: 'created_at', label: 'ساخته‌شده', type: 'date' as ColumnType },
  { key: 'last_seen_at', label: 'آخرین حضور', type: 'date' as ColumnType },
  { key: 'last_success_at', label: 'آخرین موفقیت', type: 'date' as ColumnType },
  { key: 'last_auth_failure_at', label: 'آخرین خطای احراز', type: 'date' as ColumnType },
];

function deviceAccessor(col: string) {
  return (d: DeviceListItem) => {
    switch (col) {
      case 'display_name':
        return d.display_name ?? '';
      case 'device_code':
        return d.device_code ?? '';
      case 'status':
        return d.active ? 'active' : 'inactive';
      case 'connection':
        return connectionStateLabel(d).label;
      case 'token':
        return d.credential?.token_prefix ?? '';
      case 'created_at':
        return d.created_at ?? null;
      case 'last_seen_at':
        return d.last_seen_at ?? null;
      case 'last_success_at':
        return d.last_success_at ?? null;
      case 'last_auth_failure_at':
        return d.last_auth_failure_at ?? null;
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

function connectionStateLabel(d: DeviceListItem): {
  label: string;
  tone: 'good' | 'warn' | 'idle' | 'bad' | 'muted';
} {
  if (!d.active) return { label: 'غیرفعال', tone: 'muted' };
  if (!d.credential) return { label: 'نیازمند توکن', tone: 'warn' };
  if (
    d.last_auth_failure_at &&
    (!d.last_success_at || d.last_auth_failure_at > d.last_success_at)
  ) {
    return { label: 'احراز هویت ناموفق', tone: 'bad' };
  }
  if (!d.last_seen_at) return { label: 'هرگز وصل نشده', tone: 'idle' };
  const now = Date.now();
  const age = now - d.last_seen_at;
  if (age < 60_000) return { label: 'متصل', tone: 'good' };
  if (age < 5 * 60_000) return { label: 'به‌تازگی فعال', tone: 'good' };
  if (d.last_success_at && now - d.last_success_at < 24 * 60 * 60 * 1000) {
    return { label: 'به‌تازگی فعال', tone: 'good' };
  }
  return { label: 'غیرفعال', tone: 'muted' };
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

  const isMobile = useMediaQuery('(max-width: 639px)');
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteFor, setDeleteFor] = useState<DeviceListItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  /** What the last press did. There was a channel for failure and none for success. */
  const [rowDone, setRowDone] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const items = data?.items ?? [];
  const [sort, setSort] = useTableSortState('devices', {
    column: 'display_name',
    direction: 'asc',
  });
  const sortedItems = useMemo(
    () =>
      sortBy(
        items,
        sort.column
          ? {
              column: sort.column,
              type: DEVICE_COLUMNS.find((c) => c.key === sort.column)?.type ?? 'text',
              accessor: deviceAccessor(sort.column),
            }
          : null,
        sort.direction,
      ),
    [items, sort.column, sort.direction],
  );

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
      setRowError(String(e));
    } finally {
      setBusyId(null);
    }
  }

  /**
   * The question asked before a press that stops a phone posting bank SMS.
   *
   * `POST /api/v1/sms` is the only public surface this platform has and the
   * whole payment chain runs through it: revoke a device's token and that
   * phone's messages stop arriving, claims stop matching, and customers who
   * paid sit unverified. Walking this screen on 2026-08-22, «ابطال توکن» did
   * exactly that on one click, with no question and no word afterwards — while
   * retiring a stock config, deleting an expense and blocking a customer all
   * ask first.
   *
   * Recovery is not a second press here either: the token is typed into the
   * Android app by hand, so whoever revokes it needs the phone.
   */
  function askAboutTheToken(name: string, what: 'rotate' | 'revoke'): boolean {
    return window.confirm(
      what === 'revoke'
        ? `توکن «${name}» باطل شود؟ این گوشی دیگر نمی‌تواند پیامک بانکی بفرستد و پرداخت‌هایی که از آن می‌آمدند تایید نمی‌شوند. برگرداندنش یعنی ساختن توکن تازه و واردکردن دستی‌اش روی همان گوشی.`
        : `توکن «${name}» عوض شود؟ تا وقتی توکن تازه را روی خود گوشی وارد نکنید، پیامک‌های آن نمی‌رسند.`,
    );
  }

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
      {rowError && <div className="error">{rowError}</div>}
      {rowDone && <div className="muted" role="status">{rowDone}</div>}
      {notice && (
        <div className="success-banner" role="status" aria-live="polite">
          {notice}
        </div>
      )}

      {createOpen && <CreateDeviceModal cache={cache} onClose={() => setCreateOpen(false)} />}
      {deleteFor && (
        <DeleteDeviceModal
          device={deleteFor}
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
      ) : isMobile ? (
        <>
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
          <ul className="card-list" aria-label="دستگاه‌ها">
            {sortedItems.map((d) => (
              <DeviceCard
                key={d.id}
                d={d}
                busy={busyId === d.id}
                onRotate={() =>
                  askAboutTheToken(d.display_name, 'rotate') &&
                  doAction(
                    d.id,
                    () => api.rotateDeviceCredential(d.id),
                    'deviceCredentialRotated',
                    `توکن «${d.display_name}» عوض شد — تا واردکردنش روی گوشی، پیامکی از آن نمی‌رسد.`,
                  )
                }
                onRevoke={() =>
                  askAboutTheToken(d.display_name, 'revoke') &&
                  doAction(
                    d.id,
                    () => api.revokeDeviceCredential(d.id),
                    'deviceCredentialRevoked',
                    `توکن «${d.display_name}» باطل شد — این گوشی دیگر پیامک نمی‌فرستد.`,
                  )
                }
                onDeactivate={() =>
                  doAction(d.id, () => api.deactivateDevice(d.id), 'deviceDeactivated')
                }
                onReactivate={() =>
                  doAction(d.id, () => api.reactivateDevice(d.id), 'deviceReactivated')
                }
                onGenerate={() =>
                  doAction(
                    d.id,
                    () => api.generateDeviceCredential(d.id),
                    'deviceCredentialCreated',
                  )
                }
                onDelete={() => setDeleteFor(d)}
              />
            ))}
          </ul>
        </>
      ) : (
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                {DEVICE_COLUMNS.map((c) => (
                  <SortableHeader
                    key={c.key}
                    column={c.key}
                    label={c.label}
                    state={sort}
                    onChange={setSort}
                  />
                ))}
                <th>عملیات</th>
              </tr>
            </thead>
            <tbody>
              {sortedItems.map((d) => {
                const cs = connectionStateLabel(d);
                return (
                  <tr key={d.id} className={d.active ? '' : 'dim'}>
                    <td>{d.display_name}</td>
                    <td>
                      <code>{d.device_code}</code>
                    </td>
                    <td>
                      <span className={`status-pill status-${d.active ? 'active' : 'inactive'}`}>
                        {d.active ? 'فعال' : 'غیرفعال'}
                      </span>
                    </td>
                    <td>
                      <span className={`status-pill status-${cs.tone}`}>{cs.label}</span>
                    </td>
                    <td>
                      {d.credential ? (
                        <code className="masked">{d.credential.token_prefix}…</code>
                      ) : (
                        <span className="muted">ندارد</span>
                      )}
                    </td>
                    <td>{formatTime(d.created_at)}</td>
                    <td>{d.last_seen_at ? formatTime(d.last_seen_at) : '—'}</td>
                    <td>{d.last_success_at ? formatTime(d.last_success_at) : '—'}</td>
                    <td>{d.last_auth_failure_at ? formatTime(d.last_auth_failure_at) : '—'}</td>
                    <td className="actions-cell">
                      <DeviceActions
                        d={d}
                        busy={busyId === d.id}
                        onRotate={() =>
                          askAboutTheToken(d.display_name, 'rotate') &&
                          doAction(
                            d.id,
                            () => api.rotateDeviceCredential(d.id),
                            'deviceCredentialRotated',
                            `توکن «${d.display_name}» عوض شد — تا واردکردنش روی گوشی، پیامکی از آن نمی‌رسد.`,
                          )
                        }
                        onRevoke={() =>
                          askAboutTheToken(d.display_name, 'revoke') &&
                          doAction(
                            d.id,
                            () => api.revokeDeviceCredential(d.id),
                            'deviceCredentialRevoked',
                            `توکن «${d.display_name}» باطل شد — این گوشی دیگر پیامک نمی‌فرستد.`,
                          )
                        }
                        onDeactivate={() =>
                          doAction(d.id, () => api.deactivateDevice(d.id), 'deviceDeactivated')
                        }
                        onReactivate={() =>
                          doAction(d.id, () => api.reactivateDevice(d.id), 'deviceReactivated')
                        }
                        onGenerate={() =>
                          doAction(
                            d.id,
                            () => api.generateDeviceCredential(d.id),
                            'deviceCredentialCreated',
                          )
                        }
                        onDelete={() => setDeleteFor(d)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
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
  return (
    <li className={`card device-card${d.active ? '' : ' dim'}`}>
      <div className="card-row card-row--top">
        <strong>{d.display_name}</strong>
        <span className={`status-pill status-${cs.tone}`}>{cs.label}</span>
      </div>
      <div className="card-row">
        <span className="label">کد</span>
        <code>{d.device_code}</code>
      </div>
      <div className="card-row">
        <span className="label">توکن</span>
        {d.credential ? (
          <code className="masked">{d.credential.token_prefix}…</code>
        ) : (
          <span className="muted">ندارد</span>
        )}
      </div>
      <div className="card-row">
        <span className="label">وضعیت</span>
        <span className={`status-pill status-${d.active ? 'active' : 'inactive'}`}>
          {d.active ? 'فعال' : 'غیرفعال'}
        </span>
      </div>
      <div className="card-row">
        <span className="label">آخرین حضور</span>
        <span>{d.last_seen_at ? formatTime(d.last_seen_at) : '—'}</span>
      </div>
      <div className="card-row">
        <span className="label">آخرین موفقیت</span>
        <span>{d.last_success_at ? formatTime(d.last_success_at) : '—'}</span>
      </div>
      <div className="card-row">
        <span className="label">خطای احراز</span>
        <span>{d.last_auth_failure_at ? formatTime(d.last_auth_failure_at) : '—'}</span>
      </div>
      <div className="card-actions">
        {d.active && d.credential && (
          <button type="button" disabled={busy} onClick={onRotate} {...w}>
            چرخش توکن
          </button>
        )}
        {d.active && d.credential && (
          <button type="button" className="danger" disabled={busy} onClick={onRevoke} {...w}>
            ابطال توکن
          </button>
        )}
        {d.active && !d.credential && (
          <button type="button" className="primary" disabled={busy} onClick={onGenerate} {...w}>
            ساخت توکن
          </button>
        )}
        {d.active ? (
          <button type="button" className="danger" disabled={busy} onClick={onDeactivate} {...w}>
            غیرفعال‌کردن
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={onReactivate} {...w}>
            فعال‌کردن دوباره
          </button>
        )}
        {!d.active && (
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={onDelete}
            data-testid="device-delete"
            {...w}
          >
            حذف همیشگی
          </button>
        )}
      </div>
    </li>
  );
}

function DeviceActions({
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
  if (!d.active) {
    return (
      <>
        <button type="button" disabled={busy} onClick={onReactivate} {...w}>
          فعال‌کردن دوباره
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={onDelete}
          data-testid="device-delete"
          {...w}
        >
          حذف همیشگی
        </button>
      </>
    );
  }
  return (
    <>
      {d.credential && (
        <button type="button" disabled={busy} onClick={onRotate} {...w}>
          چرخش توکن
        </button>
      )}
      {d.credential && (
        <button type="button" className="danger" disabled={busy} onClick={onRevoke} {...w}>
          ابطال توکن
        </button>
      )}
      {!d.credential && (
        <button type="button" className="primary" disabled={busy} onClick={onGenerate} {...w}>
          ساخت توکن
        </button>
      )}{' '}
      <button type="button" className="danger" disabled={busy} onClick={onDeactivate} {...w}>
        غیرفعال‌کردن
      </button>
    </>
  );
}

// ---------------------------------------------------------------------------
// CreateDeviceModal — explicit state machine:
//
//   kind='form'    → user is filling out the device name/code.
//   kind='setup'   → server returned the one-time API token + JSON config.
//
// Close paths go through requestClose() → optional confirmation →
// finalizeClose(). Done always finalizes directly. The plaintext token
// lives ONLY on this component while the modal is open; finalizeClose
// wipes it from React state and lets the parent unmount us.
// ---------------------------------------------------------------------------

interface SetupResponse {
  device: {
    id: string;
    deviceCode: string;
    displayName: string;
    description: string | null;
    active: boolean;
  };
  credential: {
    id: string;
    apiKey: string;
    tokenPrefix: string;
    status: 'ACTIVE';
    shownOnce: true;
  };
  configuration: {
    method: 'POST';
    url: string;
    contentType: 'application/json';
    jsonBody: {
      apiKey: string;
      deviceId: string;
      deviceName: string;
      message: string;
      sender: string;
      timestamp: string;
      checksum: string;
    };
  };
}

interface ModalState {
  kind: 'form' | 'setup';
  setup: SetupResponse | null;
  /** True after the user has copied or downloaded any secret-bearing payload. */
  hasSavedSetup: boolean;
  /** True while the discard-token confirmation dialog is mounted. */
  showCloseConfirmation: boolean;
}

const INITIAL_STATE: ModalState = {
  kind: 'form',
  setup: null,
  hasSavedSetup: false,
  showCloseConfirmation: false,
};

function CreateDeviceModal({ cache, onClose }: { cache: Cache; onClose: () => void }) {
  const [state, setState] = useState<ModalState>(INITIAL_STATE);
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
      // Parent unmounts us on close — restoring focus happens here.
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

  const finalizeClose = useCallback(() => {
    // Wipe the plaintext token from React state before unmounting.
    setState({ ...INITIAL_STATE });
    onClose();
  }, [onClose]);

  // One guarded close path for X / backdrop / Escape. Done bypasses this.
  const requestClose = useCallback(() => {
    setState((prev) => {
      if (prev.kind === 'form') {
        // The state update schedules a re-render, but finalizeClose also
        // lives in this render's closure; calling it here is safe — React
        // batches both state writes.
        queueMicrotask(finalizeClose);
        return prev;
      }
      // kind === 'setup'
      if (prev.showCloseConfirmation) {
        // Second invocation while the confirmation is up = confirm.
        return { ...prev, showCloseConfirmation: false, setup: null };
      }
      if (!prev.hasSavedSetup) {
        return { ...prev, showCloseConfirmation: true };
      }
      // Token already saved — close immediately.
      queueMicrotask(finalizeClose);
      return prev;
    });
  }, [finalizeClose]);

  const cancelConfirmation = useCallback(() => {
    setState((prev) => ({ ...prev, showCloseConfirmation: false }));
  }, []);

  const confirmDiscard = useCallback(() => {
    finalizeClose();
  }, [finalizeClose]);

  const markSetupSaved = useCallback(() => {
    setState((prev) => (prev.hasSavedSetup ? prev : { ...prev, hasSavedSetup: true }));
  }, []);

  // Escape: a single listener, routing through requestClose. With the
  // confirmation open, Escape is treated as "cancel" instead.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (state.showCloseConfirmation) {
        cancelConfirmation();
        return;
      }
      requestClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state.showCloseConfirmation, requestClose, cancelConfirmation]);

  // beforeunload should only fire while an unsaved one-time token is
  // visible. It MUST NOT block in-app close paths (Done / X / Esc / backdrop).
  const warnBeforeUnload = state.kind === 'setup' && !state.hasSavedSetup;
  useEffect(() => {
    if (!warnBeforeUnload) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [warnBeforeUnload]);

  async function submit() {
    if (!codeValid || !nameValid) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const body = {
        deviceCode: deviceCode.trim().toLowerCase(),
        displayName: displayName.trim(),
        description: description.trim() || null,
      };
      const r = await api.createDevice(body);
      setState({
        kind: 'setup',
        setup: r,
        hasSavedSetup: false,
        showCloseConfirmation: false,
      });
      cache.invalidate(...forMutation('deviceCreated'));
    } catch (e) {
      const msg = String(e);
      if (msg.includes('409') || msg.includes('duplicate_device_code')) {
        setSubmitError('این کد دستگاه قبلاً گرفته شده. یکی دیگر انتخاب کن.');
      } else {
        setSubmitError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    requestClose();
  };

  const isSetup = state.kind === 'setup' && state.setup !== null;
  const ariaLabel = isSetup ? 'راه‌اندازی دستگاه' : 'افزودن دستگاه';

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      onClick={handleBackdropClick}
    >
      <div className="modal-body">
        {!isSetup ? (
          <>
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
              یک گوشی اندروید تازه که SMS Relay رویش نصب است ثبت کن. بعد از ساخت دستگاه، یک توکن
              یک‌بارمصرف می‌گیری به‌علاوهٔ یک پیکربندی JSON قابل کپی که در اپ می‌چسبانی.
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
                {/* Latin, because this code goes into a URL and into the JSON
                    the Android app is configured with. A Persian device name is
                    fine and common, but it suggests no code — say so here rather
                    than leaving the operator with a disabled button and no
                    reason. */}
                <small className="muted">
                  حروف کوچک لاتین، رقم و خط تیره. ۳ تا ۶۴ نویسه. باید یکتا باشد. اگر نام دستگاه
                  فارسی است، کد را خودت بنویس.
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
          </>
        ) : (
          <OneTimeSetupScreen
            setup={state.setup!}
            showCloseConfirmation={state.showCloseConfirmation}
            onCopySaved={markSetupSaved}
            onRequestClose={requestClose}
            onCancelConfirmation={cancelConfirmation}
            onConfirmDiscard={confirmDiscard}
            onDone={finalizeClose}
          />
        )}
      </div>
    </div>
  );
}

function OneTimeSetupScreen({
  setup,
  showCloseConfirmation,
  onCopySaved,
  onRequestClose,
  onCancelConfirmation,
  onConfirmDiscard,
  onDone,
}: {
  setup: SetupResponse;
  showCloseConfirmation: boolean;
  onCopySaved: () => void;
  onRequestClose: () => void;
  onCancelConfirmation: () => void;
  onConfirmDiscard: () => void;
  onDone: () => void;
}) {
  const [tokenShown, setTokenShown] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const jsonBodyText = useMemo(
    () => JSON.stringify(setup.configuration.jsonBody, null, 2),
    [setup],
  );
  const jsonBodyOneLine = useMemo(() => JSON.stringify(setup.configuration.jsonBody), [setup]);
  const setupBlock = useMemo(
    () =>
      [
        `Remote Name: Payment Hub`,
        `Method: ${setup.configuration.method}`,
        `URL: ${setup.configuration.url}`,
        `Body Type: ${setup.configuration.contentType}`,
        `JSON Body:`,
        jsonBodyText,
      ].join('\n'),
    [setup, jsonBodyText],
  );

  // Mark a payload "secret" when it carries the apiKey or full JSON body —
  // copying either means the user has the token off the screen now.
  function containsToken(value: string): boolean {
    if (value.includes(setup.credential.apiKey)) return true;
    try {
      if (value.includes(JSON.stringify(setup.configuration.jsonBody))) return true;
    } catch {
      /* ignore */
    }
    return false;
  }

  async function copy(label: string, value: string, secret: boolean) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        // Fallback: textarea + execCommand.
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setToast(`${label} کپی شد`);
      setTimeout(() => setToast(null), 1500);
      if (secret) onCopySaved();
    } catch {
      setToast('کپی نشد — متن را انتخاب کن و Ctrl-C بزن');
      setTimeout(() => setToast(null), 2500);
    }
  }

  return (
    <>
      {showCloseConfirmation && (
        <div
          className="modal-backdrop modal-confirmation"
          data-testid="close-confirmation"
          role="alertdialog"
          aria-modal="true"
          aria-label="دور انداختن توکن؟"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="modal-body">
            <h3>بدون ذخیره بسته شود؟</h3>
            <p>
              توکن فقط یک بار نمایش داده می‌شود. اگر این پنجره را ببندی توکن از دست می‌رود — برای
              گرفتن یکی تازه باید توکن را بچرخانی.
            </p>
            <div className="row toolbar modal-actions">
              <button
                type="button"
                onClick={onCancelConfirmation}
                autoFocus
                data-testid="close-confirmation-cancel"
              >
                توکن روی صفحه بماند
              </button>
              <div className="spacer" />
              <button
                type="button"
                className="danger"
                onClick={onConfirmDiscard}
                data-testid="close-confirmation-confirm"
              >
                دور بینداز و ببند
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="row toolbar">
        <h3>دستگاه ساخته شد — توکن را ذخیره کن</h3>
        <div className="spacer" />
        <button type="button" onClick={onRequestClose} aria-label="بستن" data-testid="setup-close">
          ×
        </button>
      </div>
      <p>
        <strong>شناسهٔ دستگاه:</strong> <code>{setup.device.deviceCode}</code>
      </p>
      <p>
        <strong>نام دستگاه:</strong> {setup.device.displayName}
      </p>
      <p>
        <strong>روش:</strong> {setup.configuration.method}
      </p>
      <p>
        <strong>نشانی:</strong> <code>{setup.configuration.url}</code>
      </p>
      <p>
        <strong>نوع محتوا:</strong> <code>{setup.configuration.contentType}</code>
      </p>
      <div className="token-block">
        <strong>توکن API:</strong>
        <div className="row">
          <code aria-hidden={!tokenShown} className="token-text" data-testid="token-text">
            {tokenShown ? setup.credential.apiKey : '•'.repeat(setup.credential.apiKey.length)}
          </code>
        </div>
        <div className="row toolbar">
          <button type="button" onClick={() => setTokenShown((s) => !s)}>
            {tokenShown ? 'پنهان‌کردن' : 'نمایش'}
          </button>
          <button
            type="button"
            onClick={() => copy('توکن API', setup.credential.apiKey, true)}
            data-testid="copy-token"
          >
            کپی توکن API
          </button>
          <button type="button" onClick={() => copy('نشانی', setup.configuration.url, false)}>
            کپی نشانی
          </button>
        </div>
        <p className="warn small">
          این توکن فقط یک بار نمایش داده می‌شود. همین حالا ذخیره‌اش کن. دیگر نمی‌توانی ببینی‌اش.
        </p>
      </div>
      <details>
        <summary>بدنهٔ JSON</summary>
        <pre className="code-scrollable">{jsonBodyText}</pre>
        <div className="row toolbar">
          <button
            type="button"
            onClick={() => copy('بدنهٔ JSON', jsonBodyText, containsToken(jsonBodyText))}
          >
            کپی JSON (چندخطی)
          </button>
          <button
            type="button"
            onClick={() => copy('بدنهٔ JSON', jsonBodyOneLine, containsToken(jsonBodyOneLine))}
          >
            کپی JSON (یک‌خطی)
          </button>
          <button type="button" onClick={() => copy('پیکربندی', setupBlock, true)}>
            کپی کل پیکربندی
          </button>
          <button
            type="button"
            onClick={() => {
              const blob = new Blob([setupBlock], { type: 'text/plain' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `setup-${setup.device.deviceCode}.txt`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
              onCopySaved();
            }}
          >
            دانلود پیکربندی
          </button>
        </div>
      </details>
      <details>
        <summary>راهنمای راه‌اندازی گوشی</summary>
        {/* The app's own labels stay in English on purpose: SMS Relay is
            frozen and its screens say «Add Remote» and «Use JSON». Translating
            them would send the operator looking for buttons that do not exist. */}
        <ol className="instructions">
          <li>
            در SMS Relay برو به <code>Settings → Add Remote</code>
          </li>
          <li>
            <code>Remote Name</code> را بگذار <code>Payment Hub</code>
          </li>
          <li>
            <code>Method</code> را بگذار <code>POST</code>
          </li>
          <li>نشانی را بچسبان</li>
          <li>
            گزینهٔ <code>Use JSON</code> را انتخاب کن
          </li>
          <li>بدنهٔ JSON را بچسبان</li>
          <li>ذخیره کن</li>
          <li>دسترسی پیامک و اعلان را بده</li>
          <li>از یک گوشی دیگر یک پیامک آزمایشی بفرست</li>
        </ol>
      </details>
      {toast && (
        <div className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
      <div className="row toolbar modal-actions">
        <button type="button" className="primary" onClick={onDone} data-testid="setup-done">
          تمام
        </button>
      </div>
    </>
  );
}
