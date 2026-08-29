/**
 * Permanent-delete for a switched-off device — including the ones that used to
 * be undeletable.
 *
 * The server refuses to delete a device that still owns bank SMS, financial
 * accounts or transactions, and that refusal is right: `raw_sms_events` is
 * `ON DELETE RESTRICT` and the transaction candidates built from those events
 * cascade off them. Deleting would destroy money evidence to tidy a screen.
 *
 * But this modal used to say only «این دستگاه سابقه دارد» and stop, which meant
 * a device that had ever relayed one SMS could never be removed. On staging on
 * 2026-08-29 that was seven of eight rows, holding six hundred synthetic
 * messages between them, permanently.
 *
 * So the dead end has a door now: pick another device, move the history onto
 * it, and delete. `POST /devices/:id/move-references` does both in one
 * transaction. The only thing that can stop it is the ingest's own per-device
 * de-duplication index — a message the target already holds byte for byte
 * cannot land there twice — and that is counted and named rather than resolved
 * by quietly dropping a row.
 *
 * Two-step gate throughout: the preview says what will happen, and the
 * destructive button stays disabled until the operator types the device's name
 * or code exactly.
 *
 * ADMIN-only endpoints; a non-admin caller sees a 403 here.
 */
import { useEffect, useMemo, useState } from 'react';
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

interface MovePreview {
  moves: { rawSmsEvents: number; financialAccounts: number; transactions: number };
  duplicateSmsOnTarget: number;
  canMove: boolean;
  canDeleteSourceAfterwards: boolean;
}

export interface DeleteDeviceModalProps {
  device: DeviceListItem;
  /** Every device, so the history has somewhere to go. */
  devices?: DeviceListItem[];
  onClose: () => void;
  onDeleted: (deletedId: string) => void;
}

export function DeleteDeviceModal({
  device,
  devices = [],
  onClose,
  onDeleted,
}: DeleteDeviceModalProps) {
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [targetId, setTargetId] = useState('');
  const [movePreview, setMovePreview] = useState<MovePreview | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

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
  const inUse = preview?.blockingReasons.includes('device_in_use') ?? false;
  const mustBeInactive = preview?.blockingReasons.includes('device_must_be_inactive') ?? false;

  /** Anything but this device. A switched-off target is fine — it still holds rows. */
  const targets = useMemo(() => devices.filter((d) => d.id !== device.id), [devices, device.id]);

  // The move preview follows the picker, so the counts on screen always belong
  // to the target actually selected.
  useEffect(() => {
    if (!targetId) {
      setMovePreview(null);
      setMoveError(null);
      return;
    }
    let cancelled = false;
    setMoveError(null);
    api
      .moveDevicePreview(device.id, targetId)
      .then((r) => {
        if (!cancelled) setMovePreview(r);
      })
      .catch((e) => {
        if (!cancelled) {
          setMovePreview(null);
          setMoveError(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [device.id, targetId]);

  const reasonText: Record<string, string> = {
    device_must_be_inactive: 'دستگاه هنوز روشن است — اول خاموشش کن.',
    device_in_use:
      'این دستگاه سابقهٔ پیامک، حساب مالی یا تراکنش دارد. این‌ها هیچ‌وقت حذف نمی‌شوند — برای برداشتن دستگاه باید اول سابقه‌اش به یک دستگاه دیگر منتقل شود.',
  };

  // Either the name or the code, so a phone with a long Persian display name
  // still has a short thing to type.
  const matchesTyped =
    typed.trim() === preview?.device.displayName.trim() ||
    typed.trim() === preview?.device.deviceCode;

  // Two routes to the same end, and each has its own precondition.
  const plainDeleteReady = !!preview && preview.canDelete;
  const moveDeleteReady =
    !!preview && inUse && !mustBeInactive && !!movePreview && movePreview.canMove;
  const canSubmit = (plainDeleteReady || moveDeleteReady) && matchesTyped && !busy;

  async function confirm() {
    if (!preview || !canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      if (plainDeleteReady) {
        await api.deleteDevice(device.id);
      } else {
        await api.moveDeviceReferences(device.id, { targetDeviceId: targetId, deleteSource: true });
      }
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
          سابقهٔ پیامک، حساب‌های مالی و تراکنش‌ها هیچ‌وقت حذف نمی‌شوند — یا سرِ جایشان می‌مانند یا
          به دستگاه دیگری منتقل می‌شوند. فقط ردیف دستگاه و کلیدهای مربوط به آن برداشته می‌شوند.
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
              <dt>کلیدها</dt>
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

        {/* The way through. Offered only when history is the thing in the way —
            a device that is merely still switched on needs the switch, not a
            merge, and showing both at once would suggest the merge fixes it. */}
        {inUse && !mustBeInactive && (
          <div className="form device-move" data-testid="device-move">
            <h4>انتقال سابقه، بعد حذف</h4>
            <label>
              <span>سابقه به کدام دستگاه منتقل شود؟</span>
              <select
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                data-testid="device-move-target"
              >
                <option value="">— انتخاب کن —</option>
                {targets.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.display_name} ({d.device_code}){d.active ? '' : ' — خاموش'}
                  </option>
                ))}
              </select>
            </label>
            {targets.length === 0 && (
              <p className="muted small">
                دستگاه دیگری وجود ندارد که سابقه به آن منتقل شود. اول یک دستگاه بساز.
              </p>
            )}
            {moveError && <div className="error">{moveError}</div>}
            {movePreview && (
              <>
                <p className="muted small" data-testid="device-move-summary">
                  {count(movePreview.moves.rawSmsEvents)} پیامک،{' '}
                  {count(movePreview.moves.financialAccounts)} حساب مالی و{' '}
                  {count(movePreview.moves.transactions)} تراکنش منتقل می‌شوند، بعد این دستگاه حذف
                  می‌شود.
                </p>
                {!movePreview.canMove && (
                  <div className="warn-banner" data-testid="device-move-conflict">
                    {count(movePreview.duplicateSmsOnTarget)} پیامک از این دستگاه، عیناً روی دستگاه
                    مقصد هم هست. ورودی پیامک برای هر دستگاه تکراری‌ها را رد می‌کند، پس این‌ها
                    نمی‌توانند آن‌جا بنشینند و انتقال انجام نمی‌شود. یک مقصد دیگر انتخاب کن.
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {(plainDeleteReady || moveDeleteReady) && (
          <div className="form">
            <label>
              <span>
                برای تایید <code>{preview!.device.displayName}</code> یا{' '}
                <code>{preview!.device.deviceCode}</code> را بنویس:
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
              mustBeInactive
                ? 'اول دستگاه را خاموش کن.'
                : inUse && !moveDeleteReady
                  ? 'یک دستگاه مقصد برای انتقال سابقه انتخاب کن.'
                  : !matchesTyped
                    ? 'برای تایید، نام یا کد دستگاه را دقیقاً بنویس.'
                    : 'این دستگاه برای همیشه حذف شود'
            }
          >
            {busy ? 'در حال حذف…' : moveDeleteReady ? 'انتقال سابقه و حذف همیشگی' : 'حذف همیشگی'}
          </button>
        </div>
      </div>
    </div>
  );
}
