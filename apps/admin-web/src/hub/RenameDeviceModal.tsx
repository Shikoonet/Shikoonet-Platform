/**
 * Rename a device — the label, and nothing else.
 *
 * A device's name is the only thing on this panel an operator can get wrong at
 * no cost: «Staging Device» on the phone that actually sits in the shop, a
 * typo, a phone that moved desks. Everything else here is a key or a switch,
 * so until now the only way to fix a name was to delete the device and make a
 * new one — which mints a new key, needs the handset in hand, and is refused
 * outright once that device has carried a single bank SMS.
 *
 * So this dialog writes `display_name` and cannot write anything else: the
 * request body is `{ displayName }` and the server's schema is `.strict()`.
 * The key, the code, the switch, the history and the ownership are all
 * somewhere else on purpose.
 *
 * The Save button is gated by `validateDeviceDisplayName` — the same function
 * the server decides with, imported rather than re-typed, so the button and the
 * answer cannot drift apart. It is a convenience, not the boundary; the
 * boundary is `PATCH /api/v1/devices/:idOrCode`.
 */
import { useEffect, useState } from 'react';
import { validateDeviceDisplayName, type DeviceNameError } from '@shikoo/contracts';
import { api, type DeviceListItem } from './api.js';

/** One sentence per refusal, whether it came from this file or from the server. */
const NAME_ERROR_TEXT: Record<DeviceNameError, string> = {
  required: 'نام دستگاه نمی‌تواند خالی باشد.',
  length: 'نام دستگاه از ۲۰۰ نویسه بیشتر است.',
  control_characters: 'نام دستگاه نویسهٔ کنترلی دارد. آن را بدون خط جدید و کاراکتر مخفی بنویس.',
};

function isNameError(v: unknown): v is DeviceNameError {
  return v === 'required' || v === 'length' || v === 'control_characters';
}

/**
 * The server's refusal, said in a sentence. `req()` puts the parsed body on the
 * error, so a rule the client did not check (or checked differently) still
 * arrives as words rather than as `400: invalid_display_name`.
 */
function explain(e: unknown): string {
  const body = (e as { body?: { error?: unknown; reason?: unknown } } | null)?.body;
  if (body?.error === 'invalid_display_name' && isNameError(body.reason)) {
    return NAME_ERROR_TEXT[body.reason];
  }
  if (body?.error === 'device_not_found') {
    return 'این دستگاه دیگر وجود ندارد. صفحه را تازه کن.';
  }
  if (body?.error === 'forbidden') {
    return 'نقش شما اجازهٔ تغییر نام دستگاه را ندارد.';
  }
  return `ذخیرهٔ نام تازه ناموفق بود: ${String(e)}`;
}

export interface RenameDeviceModalProps {
  device: DeviceListItem;
  onClose: () => void;
  onRenamed: (displayName: string) => void;
}

export function RenameDeviceModal({ device, onClose, onRenamed }: RenameDeviceModalProps) {
  const [name, setName] = useState(device.display_name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const check = validateDeviceDisplayName(name);
  // Only once the operator has actually broken the rule — an empty field on
  // open is not yet a mistake, and a dialog that opens shouting is one an
  // operator learns to ignore.
  const localError = !check.ok && name !== device.display_name ? NAME_ERROR_TEXT[check.error] : null;

  async function save() {
    if (!check.ok) return;
    // Nothing to write. Closing is the honest answer and it costs the server
    // nothing; the endpoint answers the same way if it is asked anyway.
    if (check.name === device.display_name) {
      onClose();
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await api.renameDevice(device.id, check.name);
      onRenamed(r.device.displayName);
    } catch (e) {
      // The old name is still on screen behind this dialog and still in the
      // field: nothing was written, so nothing is pretended.
      setErr(explain(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="ویرایش نام دستگاه"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-body">
        <div className="row toolbar">
          <h3>ویرایش نام دستگاه</h3>
          <div className="spacer" />
          <button type="button" onClick={onClose} aria-label="بستن">
            ×
          </button>
        </div>
        <p className="muted small">
          فقط نامی که در پنل دیده می‌شود عوض می‌شود. کلید، کد دستگاه (<code>{device.device_code}</code>
          )، سابقهٔ پیامک‌ها و حساب‌های وصل‌شده دست‌نخورده می‌مانند و گوشی همان‌طور که هست به کارش
          ادامه می‌دهد.
        </p>
        <div className="form">
          <label>
            <span>نام فعلی</span>
            <output data-testid="rename-device-current">{device.display_name}</output>
          </label>
          <label>
            <span>نام تازه</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="rename-device-input"
              disabled={busy}
              autoFocus
            />
          </label>
        </div>
        {localError && <div className="error">{localError}</div>}
        {err && <div className="error">{err}</div>}
        <div className="row toolbar modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            انصراف
          </button>
          <div className="spacer" />
          <button
            type="button"
            className="primary"
            disabled={busy || !check.ok}
            onClick={save}
            data-testid="rename-device-save"
          >
            {busy ? 'در حال ذخیره…' : 'ذخیره'}
          </button>
        </div>
      </div>
    </div>
  );
}
