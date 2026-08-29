/**
 * The one-time token screen — the only moment a device's API key is legible.
 *
 * It used to live inside `CreateDeviceModal`, reachable only by creating a
 * device. That was wrong, and expensively so: `POST /devices/:id/credentials`
 * and `.../credentials/rotate` return the very same payload — `credential.apiKey`
 * plus the ready-to-paste `configuration` — and `DevicesView` awaited both and
 * threw the response away. Pressing «ساخت توکن» on an existing device minted a
 * real credential, wrote its hash to the database, and dropped the plaintext on
 * the floor. Nothing said so. The row simply grew a token prefix, and the key
 * that phone needed no longer existed anywhere.
 *
 * Recovery was not a second press either: rotating produced another key and
 * discarded that one too. On staging on 2026-08-29 all eight devices sat with
 * «نیازمند توکن» beside a button that could only make the problem worse.
 *
 * So the screen is a component, and every path that mints a key mounts it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface DeviceSetup {
  device: {
    id: string;
    deviceCode: string;
    displayName: string;
    description?: string | null;
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

/** Why this key exists — the sentence differs, the danger of losing it does not. */
export type SetupOrigin = 'created' | 'generated' | 'rotated';

const HEADING: Record<SetupOrigin, string> = {
  created: 'دستگاه ساخته شد — کلید را همین حالا بردار',
  generated: 'کلید ساخته شد — همین حالا بردار',
  rotated: 'کلید عوض شد — همین حالا بردار',
};

const LEDE: Record<SetupOrigin, string> = {
  created: 'این کلید و پیکربندی را به کسی بده که گوشی دستش است.',
  generated: 'این کلید و پیکربندی را به کسی بده که گوشی دستش است.',
  rotated:
    'کلید قبلی همین الان از کار افتاد. تا این یکی روی گوشی وارد نشود، پیامکی از آن دستگاه نمی‌رسد.',
};

export function DeviceSetupModal({
  setup,
  origin,
  onClose,
}: {
  setup: DeviceSetup;
  origin: SetupOrigin;
  onClose: () => void;
}) {
  /** True once the operator has copied or downloaded something carrying the key. */
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [shown, setShown] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Restore focus to whatever opened us.
  const triggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    triggerRef.current = (document.activeElement as HTMLElement | null) ?? null;
    return () => {
      const t = triggerRef.current;
      if (t && typeof t.focus === 'function') t.focus();
    };
  }, []);

  const markSaved = useCallback(() => setSaved(true), []);

  /** X / backdrop / Escape. «تمام» bypasses this deliberately. */
  const requestClose = useCallback(() => {
    if (saved) {
      onClose();
      return;
    }
    setConfirming(true);
  }, [saved, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (confirming) {
        setConfirming(false);
        return;
      }
      requestClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [confirming, requestClose]);

  // Only while an unsaved key is on screen, and never for the in-app close paths.
  useEffect(() => {
    if (saved) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [saved]);

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

  /** Copying either the key or the body means the secret is off this screen now. */
  function carriesTheKey(value: string): boolean {
    return value.includes(setup.credential.apiKey);
  }

  async function copy(label: string, value: string, secret: boolean) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
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
      if (secret) markSaved();
    } catch {
      setToast('کپی نشد — متن را انتخاب کن و Ctrl-C بزن');
      setTimeout(() => setToast(null), 2500);
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="راه‌اندازی دستگاه"
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div className="modal-body device-setup">
        {confirming && (
          <div
            className="modal-backdrop modal-confirmation"
            data-testid="close-confirmation"
            role="alertdialog"
            aria-modal="true"
            aria-label="دور انداختن کلید؟"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-body">
              <h3>بدون برداشتن کلید بسته شود؟</h3>
              <p>
                کلید فقط همین یک بار خوانده می‌شود. اگر ببندی، دیگر هیچ‌جا نیست — و برای گرفتن یکی
                تازه باید کلید را بچرخانی، که کلید فعلی را هم از کار می‌اندازد.
              </p>
              <div className="row toolbar modal-actions">
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  autoFocus
                  data-testid="close-confirmation-cancel"
                >
                  کلید روی صفحه بماند
                </button>
                <div className="spacer" />
                <button
                  type="button"
                  className="danger"
                  onClick={onClose}
                  data-testid="close-confirmation-confirm"
                >
                  دور بینداز و ببند
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="row toolbar">
          <h3>{HEADING[origin]}</h3>
          <div className="spacer" />
          <button
            type="button"
            onClick={requestClose}
            aria-label="بستن"
            data-testid="setup-close"
          >
            ×
          </button>
        </div>

        <p className="muted">{LEDE[origin]}</p>

        {/* The key first and alone. Everything the operator can look up later
            sits underneath it; the one thing they cannot is at the top. */}
        <div className="token-block device-setup__key">
          <div className="row toolbar">
            <strong>کلید API</strong>
            <div className="spacer" />
            <button type="button" onClick={() => setShown((s) => !s)}>
              {shown ? 'پنهان‌کردن' : 'نمایش'}
            </button>
          </div>
          <code aria-hidden={!shown} className="token-text" data-testid="token-text">
            {shown ? setup.credential.apiKey : '•'.repeat(setup.credential.apiKey.length)}
          </code>
          <div className="device-setup__key-actions">
            <button
              type="button"
              className="primary"
              onClick={() => copy('کلید API', setup.credential.apiKey, true)}
              data-testid="copy-token"
            >
              کپی کلید
            </button>
            <button
              type="button"
              onClick={() => copy('کل پیکربندی', setupBlock, true)}
              data-testid="copy-setup"
            >
              کپی کل پیکربندی
            </button>
            <button
              type="button"
              data-testid="download-setup"
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
                markSaved();
              }}
            >
              دانلود فایل
            </button>
          </div>
          <p className="warn small">
            این کلید فقط همین یک بار نمایش داده می‌شود. تا برنداری‌اش، این پنجره را نبند.
          </p>
        </div>

        <dl className="device-setup__facts">
          <dt>دستگاه</dt>
          <dd>{setup.device.displayName}</dd>
          <dt>شناسه</dt>
          <dd>
            <code>{setup.device.deviceCode}</code>
          </dd>
          <dt>روش</dt>
          <dd>
            <code>{setup.configuration.method}</code>
          </dd>
          <dt>نشانی</dt>
          <dd className="device-setup__url">
            <code>{setup.configuration.url}</code>
            <button type="button" onClick={() => copy('نشانی', setup.configuration.url, false)}>
              کپی
            </button>
          </dd>
        </dl>

        <details>
          <summary>بدنهٔ JSON</summary>
          <pre className="code-scrollable">{jsonBodyText}</pre>
          <div className="row toolbar">
            <button
              type="button"
              onClick={() => copy('بدنهٔ JSON', jsonBodyText, carriesTheKey(jsonBodyText))}
            >
              کپی JSON (چندخطی)
            </button>
            <button
              type="button"
              onClick={() => copy('بدنهٔ JSON', jsonBodyOneLine, carriesTheKey(jsonBodyOneLine))}
            >
              کپی JSON (یک‌خطی)
            </button>
          </div>
        </details>

        <details>
          <summary>راهنمای راه‌اندازی گوشی</summary>
          {/* The app's own labels stay in English on purpose: SMS Relay is
              frozen and its screens say «Add Remote» and «Use JSON».
              Translating them sends the operator looking for buttons that do
              not exist. */}
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
          {/* Said here because the app sends every SMS to every Remote it has,
              each with its own retry budget. Adding ours does not disturb one
              that is already working — the sentence that decides whether an
              admin dares touch a live phone. */}
          <p className="muted small">
            اگر روی گوشی از قبل یک Remote هست، دست به آن نزن. اپ هر پیامک را به همهٔ Remoteها
            می‌فرستد و هرکدام مستقل تلاش می‌کنند، پس افزودن این یکی چیزی را خراب نمی‌کند.
          </p>
        </details>

        {toast && (
          <div className="toast" role="status" aria-live="polite">
            {toast}
          </div>
        )}

        <div className="row toolbar modal-actions">
          <div className="spacer" />
          <button type="button" className="primary" onClick={onClose} data-testid="setup-done">
            برداشتم — ببند
          </button>
        </div>
      </div>
    </div>
  );
}
