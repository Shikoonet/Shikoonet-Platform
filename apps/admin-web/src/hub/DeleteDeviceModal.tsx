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
import { count } from '../format.js';
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
    device_must_be_inactive: 'دستگاه هنوز فعال است — اول غیرفعالش کن.',
    device_in_use:
      'این دستگاه سابقهٔ پیامک، حساب مالی یا تراکنش دارد. این‌ها هیچ‌وقت آبشاری حذف نمی‌شوند.',
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
      aria-label="حذف همیشگی دستگاه"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-body modal-body--danger">
        <div className="row toolbar">
          <h3>حذف همیشگی دستگاه</h3>
          <div className="spacer" />
          <button type="button" onClick={onClose} aria-label="بستن">
            ×
          </button>
        </div>
        <p>
          این کار <strong>{device.display_name}</strong> (<code>{device.device_code}</code>) را از
          دیتابیس حذف می‌کند. <strong>برگشت‌پذیر نیست.</strong>
        </p>
        <p className="muted small">
          سابقهٔ پیامک، حساب‌های مالی و تراکنش‌ها هیچ‌وقت آبشاری حذف نمی‌شوند. فقط ردیف دستگاه و
          توکن‌های مربوط به آن برداشته می‌شوند.
        </p>
        {loadError && <div className="error">{loadError}</div>}
        {preview && (
          <>
            <h4>ارجاع‌های مرتبط</h4>
            <dl className="ref-counts">
              <dt>رویدادهای خام پیامک</dt>
              <dd>{count(refs?.rawSmsEvents ?? 0)}</dd>
              <dt>حساب‌های مالی</dt>
              <dd>{count(refs?.financialAccounts ?? 0)}</dd>
              <dt>توکن‌ها</dt>
              <dd>{count(refs?.credentials ?? 0)}</dd>
              <dt>تراکنش‌ها</dt>
              <dd>{count(refs?.transactions ?? 0)}</dd>
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
                برای تایید <code>{preview.device.displayName}</code> یا{' '}
                <code>{preview.device.deviceCode}</code> را بنویس:
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
            انصراف
          </button>
          <div className="spacer" />
          <button
            type="button"
            className="danger"
            disabled={!canSubmit}
            onClick={confirm}
            title={
              blocked
                ? 'دستگاه در وضعیت فعلی‌اش حذف‌شدنی نیست.'
                : !matchesTyped
                  ? 'برای تایید، نام یا کد دستگاه را دقیقاً بنویس.'
                  : 'این دستگاه برای همیشه حذف شود'
            }
          >
            {busy ? 'در حال حذف…' : 'حذف همیشگی'}
          </button>
        </div>
      </div>
    </div>
  );
}
