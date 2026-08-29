/**
 * Permanent-delete confirmation for an inactive device.
 *
 * Two-step gate:
 *   1. Fetch the delete-preview; show reference counts + blocking reasons.
 *   2. User must type the device display name OR code exactly to enable
 *      the destructive Confirm button.
 *
 * On success, the parent (DevicesView) clears state, invalidates affected
 * query keys, and shows a success notification.
 *
 * ADMIN-only endpoint; a non-admin caller sees a 403 here.
 */
import { useEffect, useState } from 'react';
import type { DeviceListItem } from './api.js';
import { api } from './api.js';

interface PreviewResponse {
  ok: boolean;
  device: { id: string; deviceCode: string; displayName: string; active: boolean };
  references: {
    rawSmsEvents: number;
    financialAccounts: number;
    credentials: number;
    transactions: number;
  };
  canDelete: boolean;
  blockingReasons: string[];
}

export interface DeleteDeviceModalProps {
  device: DeviceListItem;
  onClose: () => void;
  onDeleted: (deletedId: string) => void;
}

export function DeleteDeviceModal({ device, onClose, onDeleted }: DeleteDeviceModalProps) {
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .deleteDevicePreview(device.id)
      .then((r) => {
        if (!cancelled) setPreview(r);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [device.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const refs = preview?.references;
  const blocked = !preview || !preview.canDelete;
  const reasonText: Record<string, string> = {
    device_must_be_inactive: 'Device is still active — deactivate it first.',
    device_in_use:
      'Device has SMS history, financial accounts, or transactions. These are never cascade-deleted.',
  };
  // Accept either display name OR device code so the user has a short,
  // easy-to-type confirmation phrase for a phone with a long display name.
  const matchesTyped =
    typed.trim() === preview?.device.displayName.trim() ||
    typed.trim() === preview?.device.deviceCode;
  const canSubmit = !!preview && preview.canDelete && matchesTyped && !busy;

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setErr(null);
    try {
      await api.deleteDevice(device.id);
      onDeleted(device.id);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Delete device permanently"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-body modal-body--danger">
        <div className="row toolbar">
          <h3>Delete device permanently</h3>
          <div className="spacer" />
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p>
          This deletes <strong>{device.display_name}</strong> (<code>{device.device_code}</code>)
          from the database. <strong>This cannot be undone.</strong>
        </p>
        <p className="muted small">
          SMS history, financial accounts, and transactions are NEVER cascade-deleted. Only the
          device row and any associated credentials are removed.
        </p>
        {loadError && <div className="error">{loadError}</div>}
        {preview && (
          <>
            <h4>Linked references</h4>
            <dl className="ref-counts">
              <dt>Raw SMS events</dt>
              <dd>{refs?.rawSmsEvents ?? 0}</dd>
              <dt>Financial accounts</dt>
              <dd>{refs?.financialAccounts ?? 0}</dd>
              <dt>Credentials</dt>
              <dd>{refs?.credentials ?? 0}</dd>
              <dt>Transactions</dt>
              <dd>{refs?.transactions ?? 0}</dd>
            </dl>
            {preview.blockingReasons.length > 0 && (
              <div className="warn-banner">
                {preview.blockingReasons.map((r) => (
                  <div key={r}>{reasonText[r] ?? r}</div>
                ))}
              </div>
            )}
          </>
        )}
        {preview?.canDelete && (
          <div className="form">
            <label>
              <span>
                Type <code>{preview.device.displayName}</code> or{' '}
                <code>{preview.device.deviceCode}</code> to confirm:
              </span>
              <input
                type="text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoFocus
                spellCheck={false}
              />
            </label>
          </div>
        )}
        {err && <div className="error">{err}</div>}
        <div className="row toolbar modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <div className="spacer" />
          <button
            type="button"
            className="danger"
            disabled={!canSubmit}
            onClick={confirm}
            title={
              blocked
                ? 'Device cannot be deleted in its current state.'
                : !matchesTyped
                  ? 'Type the device display name or code exactly to confirm.'
                  : 'Delete this device forever'
            }
          >
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}
