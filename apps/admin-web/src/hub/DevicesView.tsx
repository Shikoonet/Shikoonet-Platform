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
  { key: 'display_name', label: 'Name', type: 'text' as ColumnType },
  { key: 'device_code', label: 'Code', type: 'text' as ColumnType },
  { key: 'status', label: 'Status', type: 'text' as ColumnType },
  { key: 'connection', label: 'Connection', type: 'text' as ColumnType },
  { key: 'token', label: 'Token', type: 'text' as ColumnType },
  { key: 'created_at', label: 'Created', type: 'date' as ColumnType },
  { key: 'last_seen_at', label: 'Last seen', type: 'date' as ColumnType },
  { key: 'last_success_at', label: 'Last success', type: 'date' as ColumnType },
  { key: 'last_auth_failure_at', label: 'Last auth failure', type: 'date' as ColumnType },
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
  if (!d.active) return { label: 'Inactive', tone: 'muted' };
  if (!d.credential) return { label: 'Token required', tone: 'warn' };
  if (
    d.last_auth_failure_at &&
    (!d.last_success_at || d.last_auth_failure_at > d.last_success_at)
  ) {
    return { label: 'Authentication failing', tone: 'bad' };
  }
  if (!d.last_seen_at) return { label: 'Never connected', tone: 'idle' };
  const now = Date.now();
  const age = now - d.last_seen_at;
  if (age < 60_000) return { label: 'Connected', tone: 'good' };
  if (age < 5 * 60_000) return { label: 'Recently active', tone: 'good' };
  if (d.last_success_at && now - d.last_success_at < 24 * 60 * 60 * 1000) {
    return { label: 'Recently active', tone: 'good' };
  }
  return { label: 'Inactive', tone: 'muted' };
}

export function DevicesView({ cache }: DevicesViewProps) {
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
  ) {
    setBusyId(idOrCode);
    setRowError(null);
    try {
      await fn();
      cache.invalidate(...forMutation(mutation));
    } catch (e) {
      setRowError(String(e));
    } finally {
      setBusyId(null);
    }
  }

  if (status === 'loading' && !data) return <p className="muted">Loading…</p>;
  if (error && !data) {
    return (
      <p className="error">
        Failed to load devices.{' '}
        <button type="button" onClick={() => cache.refetch(QK.devices)}>
          Retry
        </button>
      </p>
    );
  }

  return (
    <div className="devices">
      <div className="row toolbar">
        <h2>Devices ({items.length})</h2>
        <div className="spacer" />
        <button
          type="button"
          className="primary"
          onClick={() => setCreateOpen(true)}
          data-testid="open-add-device"
        >
          + Add device
        </button>
      </div>
      {rowError && <div className="error">{rowError}</div>}
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
            setNotice(`Device ${deleteFor.display_name} deleted.`);
            cache.invalidate(...forMutation('deviceDeleted'));
          }}
        />
      )}

      {items.length === 0 ? (
        <p className="empty">
          No devices registered. Click <strong>+ Add device</strong> to create one.
        </p>
      ) : isMobile ? (
        <>
          <div className="row toolbar sort-dropdown">
            <label htmlFor="sort-devices">Sort by:</label>
            <select
              id="sort-devices"
              value={sort.column ? `${sort.column}-${sort.direction}` : ''}
              onChange={(e) => {
                const [col, dir] = e.target.value.split('-');
                setSort({ column: col ?? '', direction: (dir as 'asc' | 'desc') ?? 'asc' });
              }}
            >
              <option value="display_name-asc">Name (A → Z)</option>
              <option value="display_name-desc">Name (Z → A)</option>
              <option value="last_seen_at-desc">Most recent</option>
              <option value="last_seen_at-asc">Oldest activity</option>
              <option value="created_at-desc">Newest</option>
              <option value="created_at-asc">Oldest</option>
            </select>
          </div>
          <ul className="card-list" aria-label="Devices">
            {sortedItems.map((d) => (
              <DeviceCard
                key={d.id}
                d={d}
                busy={busyId === d.id}
                onRotate={() =>
                  doAction(d.id, () => api.rotateDeviceCredential(d.id), 'deviceCredentialRotated')
                }
                onRevoke={() =>
                  doAction(d.id, () => api.revokeDeviceCredential(d.id), 'deviceCredentialRevoked')
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
                <th>Actions</th>
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
                        {d.active ? 'active' : 'inactive'}
                      </span>
                    </td>
                    <td>
                      <span className={`status-pill status-${cs.tone}`}>{cs.label}</span>
                    </td>
                    <td>
                      {d.credential ? (
                        <code className="masked">{d.credential.token_prefix}…</code>
                      ) : (
                        <span className="muted">none</span>
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
                          doAction(
                            d.id,
                            () => api.rotateDeviceCredential(d.id),
                            'deviceCredentialRotated',
                          )
                        }
                        onRevoke={() =>
                          doAction(
                            d.id,
                            () => api.revokeDeviceCredential(d.id),
                            'deviceCredentialRevoked',
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
  const cs = connectionStateLabel(d);
  return (
    <li className={`card device-card${d.active ? '' : ' dim'}`}>
      <div className="card-row card-row--top">
        <strong>{d.display_name}</strong>
        <span className={`status-pill status-${cs.tone}`}>{cs.label}</span>
      </div>
      <div className="card-row">
        <span className="label">Code</span>
        <code>{d.device_code}</code>
      </div>
      <div className="card-row">
        <span className="label">Token</span>
        {d.credential ? (
          <code className="masked">{d.credential.token_prefix}…</code>
        ) : (
          <span className="muted">none</span>
        )}
      </div>
      <div className="card-row">
        <span className="label">Status</span>
        <span className={`status-pill status-${d.active ? 'active' : 'inactive'}`}>
          {d.active ? 'active' : 'inactive'}
        </span>
      </div>
      <div className="card-row">
        <span className="label">Last seen</span>
        <span>{d.last_seen_at ? formatTime(d.last_seen_at) : '—'}</span>
      </div>
      <div className="card-row">
        <span className="label">Last success</span>
        <span>{d.last_success_at ? formatTime(d.last_success_at) : '—'}</span>
      </div>
      <div className="card-row">
        <span className="label">Auth failure</span>
        <span>{d.last_auth_failure_at ? formatTime(d.last_auth_failure_at) : '—'}</span>
      </div>
      <div className="card-actions">
        {d.active && d.credential && (
          <button type="button" disabled={busy} onClick={onRotate}>
            Rotate
          </button>
        )}
        {d.active && d.credential && (
          <button type="button" className="danger" disabled={busy} onClick={onRevoke}>
            Revoke
          </button>
        )}
        {d.active && !d.credential && (
          <button type="button" className="primary" disabled={busy} onClick={onGenerate}>
            Generate token
          </button>
        )}
        {d.active ? (
          <button type="button" className="danger" disabled={busy} onClick={onDeactivate}>
            Deactivate
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={onReactivate}>
            Reactivate
          </button>
        )}
        {!d.active && (
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={onDelete}
            data-testid="device-delete"
          >
            Delete permanently
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
  if (!d.active) {
    return (
      <>
        <button type="button" disabled={busy} onClick={onReactivate}>
          Reactivate
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={onDelete}
          data-testid="device-delete"
        >
          Delete permanently
        </button>
      </>
    );
  }
  return (
    <>
      {d.credential && (
        <button type="button" disabled={busy} onClick={onRotate}>
          Rotate
        </button>
      )}
      {d.credential && (
        <button type="button" className="danger" disabled={busy} onClick={onRevoke}>
          Revoke
        </button>
      )}
      {!d.credential && (
        <button type="button" className="primary" disabled={busy} onClick={onGenerate}>
          Generate token
        </button>
      )}{' '}
      <button type="button" className="danger" disabled={busy} onClick={onDeactivate}>
        Deactivate
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
        setSubmitError('That device code is already taken. Pick a different one.');
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
  const ariaLabel = isSetup ? 'Device setup' : 'Add device';

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
              <h3>Add device</h3>
              <div className="spacer" />
              <button
                type="button"
                onClick={requestClose}
                aria-label="Close"
                data-testid="device-modal-close"
              >
                ×
              </button>
            </div>
            <p className="muted">
              Register a new Android phone running SMS Relay. After creating the device, you'll get
              a one-time API token plus a copyable JSON configuration to paste into the app.
            </p>
            <div className="form">
              <label>
                <span>Device name</span>
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
                  placeholder="Poyan Android Phone 2"
                  autoFocus
                />
              </label>
              <label>
                <span>Device ID / code</span>
                <input
                  type="text"
                  value={deviceCode}
                  onChange={(e) => setDeviceCode(e.target.value.trim().toLowerCase())}
                  placeholder={suggestedCode || 'phone-poyan-02'}
                />
                <small className="muted">
                  Lowercase letters, digits, hyphens. 3–64 chars. Must be unique.
                  {suggestedCode && deviceCode !== suggestedCode ? (
                    <>
                      {' '}
                      Suggested from name: <code>{suggestedCode}</code>
                    </>
                  ) : null}
                </small>
              </label>
              <label>
                <span>Description (optional)</span>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Spare phone, backup SIM, etc."
                />
              </label>
            </div>
            {submitError && <div className="error">{submitError}</div>}
            <div className="row toolbar modal-actions">
              <button type="button" onClick={requestClose}>
                Cancel
              </button>
              <div className="spacer" />
              <button
                type="button"
                className="primary"
                disabled={submitting || !codeValid || !nameValid}
                onClick={submit}
              >
                Create device
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
      setToast(`${label} copied`);
      setTimeout(() => setToast(null), 1500);
      if (secret) onCopySaved();
    } catch {
      setToast('Copy failed — select the text and press Cmd/Ctrl-C');
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
          aria-label="Discard API token?"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="modal-body">
            <h3>Close without saving?</h3>
            <p>
              The API token is shown only once. If you discard this dialog the token will be lost —
              you'll need to rotate to get a new one.
            </p>
            <div className="row toolbar modal-actions">
              <button
                type="button"
                onClick={onCancelConfirmation}
                autoFocus
                data-testid="close-confirmation-cancel"
              >
                Keep token on screen
              </button>
              <div className="spacer" />
              <button
                type="button"
                className="danger"
                onClick={onConfirmDiscard}
                data-testid="close-confirmation-confirm"
              >
                Discard and close
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="row toolbar">
        <h3>Device created — save your API token</h3>
        <div className="spacer" />
        <button type="button" onClick={onRequestClose} aria-label="Close" data-testid="setup-close">
          ×
        </button>
      </div>
      <p>
        <strong>Device ID:</strong> <code>{setup.device.deviceCode}</code>
      </p>
      <p>
        <strong>Device name:</strong> {setup.device.displayName}
      </p>
      <p>
        <strong>Method:</strong> {setup.configuration.method}
      </p>
      <p>
        <strong>URL:</strong> <code>{setup.configuration.url}</code>
      </p>
      <p>
        <strong>Content type:</strong> <code>{setup.configuration.contentType}</code>
      </p>
      <div className="token-block">
        <strong>API token:</strong>
        <div className="row">
          <code aria-hidden={!tokenShown} className="token-text" data-testid="token-text">
            {tokenShown ? setup.credential.apiKey : '•'.repeat(setup.credential.apiKey.length)}
          </code>
        </div>
        <div className="row toolbar">
          <button type="button" onClick={() => setTokenShown((s) => !s)}>
            {tokenShown ? 'Hide' : 'Show'}
          </button>
          <button
            type="button"
            onClick={() => copy('API token', setup.credential.apiKey, true)}
            data-testid="copy-token"
          >
            Copy API token
          </button>
          <button type="button" onClick={() => copy('URL', setup.configuration.url, false)}>
            Copy URL
          </button>
        </div>
        <p className="warn small">
          This token is shown only once. Save it now. You cannot view it again.
        </p>
      </div>
      <details>
        <summary>JSON body</summary>
        <pre className="code-scrollable">{jsonBodyText}</pre>
        <div className="row toolbar">
          <button
            type="button"
            onClick={() => copy('JSON body', jsonBodyText, containsToken(jsonBodyText))}
          >
            Copy JSON (pretty)
          </button>
          <button
            type="button"
            onClick={() => copy('JSON body', jsonBodyOneLine, containsToken(jsonBodyOneLine))}
          >
            Copy JSON (one line)
          </button>
          <button type="button" onClick={() => copy('Setup', setupBlock, true)}>
            Copy complete setup
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
            Download setup
          </button>
        </div>
      </details>
      <details>
        <summary>Phone setup instructions</summary>
        <ol className="instructions">
          <li>SMS Relay → Settings → Add Remote</li>
          <li>Remote Name: Payment Hub</li>
          <li>Method: POST</li>
          <li>Paste URL</li>
          <li>Select Use JSON</li>
          <li>Paste JSON body</li>
          <li>Save</li>
          <li>Allow SMS and notification permissions</li>
          <li>Send a test SMS from another phone</li>
        </ol>
      </details>
      {toast && (
        <div className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
      <div className="row toolbar modal-actions">
        <button type="button" className="primary" onClick={onDone} data-testid="setup-done">
          Done
        </button>
      </div>
    </>
  );
}
