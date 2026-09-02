/**
 * The strip that says the shop is currently selling without proof of payment.
 *
 * It is loud on purpose and it is not dismissible. The mode exists for an
 * incident, and the failure it can cause — orders delivered against payments
 * nobody has evidence for — is invisible from every other screen: the review
 * queue looks normal, the revenue figure looks normal, and the only sign is
 * this. An operator who forgets the mode is on is exactly the person this is
 * for, so a banner they can close is a banner that does not work.
 *
 * Every role sees it. Only ADMIN sees the button, because only ADMIN may
 * change it — and a REVIEWER still needs to know why the queue is behaving
 * differently from yesterday.
 */

import { useEffect, useState } from 'react';
import { api } from './api';
import { useRole } from '../role.js';

interface State {
  mode: 'NORMAL' | 'CONTINUITY';
  expiresAt: number | null;
  activatedBy: string | null;
  reason: string | null;
}

/** Longest one activation may run, mirroring `CONTINUITY_MAX_DURATION_MS`. */
const DURATIONS = [
  { label: '۳۰ دقیقه', ms: 30 * 60 * 1000 },
  { label: '۱ ساعت', ms: 60 * 60 * 1000 },
  { label: '۳ ساعت', ms: 3 * 60 * 60 * 1000 },
  { label: '۶ ساعت', ms: 6 * 60 * 60 * 1000 },
];

function remaining(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return '';
  const left = expiresAt - now;
  if (left <= 0) return 'در حال پایان';
  const mins = Math.ceil(left / 60000);
  return mins >= 60 ? `${Math.floor(mins / 60)} ساعت و ${mins % 60} دقیقه` : `${mins} دقیقه`;
}

export function ContinuityBanner() {
  // Read from the context App already provides rather than threaded as a prop:
  // the banner sits in the header, five components away from where the role is
  // known, and a prop chain that long is how a screen ends up trusting a
  // default.
  const isAdmin = useRole() === 'ADMIN';
  const [state, setState] = useState<State | null>(null);
  const [dialog, setDialog] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  async function refresh() {
    try {
      const s = await api.continuityMode();
      setState({
        mode: s.mode,
        expiresAt: s.expiresAt,
        activatedBy: s.activatedBy,
        reason: s.reason,
      });
    } catch {
      /* the banner is a warning, not a gate; a failed read hides it */
    }
  }

  useEffect(() => {
    void refresh();
    // The expiry is enforced server-side at read time, so this poll is only
    // about the banner telling the truth — it is not what turns the mode off.
    const t = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 30_000);
    return () => clearInterval(t);
  }, []);

  if (!state) return null;

  if (state.mode !== 'CONTINUITY') {
    return isAdmin ? (
      <>
        <button type="button" className="btn btn-ghost continuity-open" onClick={() => setDialog(true)}>
          حالت تداوم
        </button>
        {dialog && <ActivateDialog onClose={() => setDialog(false)} onDone={() => { setDialog(false); void refresh(); }} />}
      </>
    ) : null;
  }

  return (
    <div className="continuity-banner" role="status" aria-live="polite">
      <strong>حالت تداوم فعال است</strong>
      <span>
        سفارش‌های تازه بدون تایید بانکی تحویل می‌شوند و در صف تطبیق می‌مانند
        {state.expiresAt !== null && ` — ${remaining(state.expiresAt, now)} باقی مانده`}
      </span>
      {state.activatedBy && <span className="continuity-banner__by">{state.activatedBy}</span>}
      {state.reason && <span className="continuity-banner__reason">«{state.reason}»</span>}
      {isAdmin && (
        <button
          type="button"
          className="btn btn-danger"
          onClick={async () => {
            await api.setContinuityMode({ active: false });
            await refresh();
          }}
        >
          خاموش کن
        </button>
      )}
    </div>
  );
}

function ActivateDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [durationMs, setDurationMs] = useState(DURATIONS[1]!.ms);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = reason.trim().length >= 3;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="فعال‌کردن حالت تداوم"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-body">
        <h3>حالت تداوم فعال شود؟</h3>
        {/*
          Said before the button, not after. This is the one screen in the panel
          where pressing the obvious button starts giving product away against
          payments nobody has checked.
        */}
        <p className="alert alert-warning">
          تا پایان این مدت، هر سفارش تازه <strong>بدون تایید بانکی</strong> تحویل می‌شود و در صف
          «تحویل‌شده، در انتظار تطبیق» می‌ماند. سفارش‌های موجود دست نمی‌خورند.
        </p>
        <label>
          چرا؟
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="مثلاً: رله پیامک از ساعت ۹ قطع است"
          />
        </label>
        <label>
          برای چه مدت؟
          <select value={durationMs} onChange={(e) => setDurationMs(Number(e.target.value))}>
            {DURATIONS.map((d) => (
              <option key={d.ms} value={d.ms}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            انصراف
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={!ready || busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.setContinuityMode({ active: true, reason: reason.trim(), durationMs });
                onDone();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'failed');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? '…' : 'فعال کن'}
          </button>
        </div>
      </div>
    </div>
  );
}
