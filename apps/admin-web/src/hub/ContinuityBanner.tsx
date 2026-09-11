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
 *
 * ## Why this is three exports and not one component
 *
 * The two halves belong in two different places in the header. The BUTTON is a
 * control and sits with the other controls; the STRIP is a full-width warning
 * and sits on its own row. One component cannot render into two DOM positions,
 * and putting the strip where the button goes is what made the header collapse
 * — it was a flex item in the `auto` track of a two-column grid, so its
 * paragraph of Persian ate the track holding the payment tabs.
 *
 * The state stays in ONE place — `useContinuityMode`, called once by
 * `ShikoonetHeader` and passed down — because two instances would mean two
 * timers polling the same endpoint to answer the same question.
 */

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
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

export interface ContinuityView {
  /** Null until the first read answers — neither half draws anything yet. */
  state: State | null;
  refresh: () => Promise<void>;
}

/**
 * The mode, polled. Called ONCE by the header and handed to both halves.
 *
 * The expiry is enforced server-side at read time, so this poll is only about
 * the screen telling the truth — it is not what turns the mode off.
 */
export function useContinuityMode(): ContinuityView {
  const [state, setState] = useState<State | null>(null);

  const refresh = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  return { state, refresh };
}

/**
 * «حالت تداوم» — the way in, shown only while the shop is NORMAL.
 *
 * Stays among the header controls, because that is what it is. Only ADMIN, for
 * the same reason the server refuses anyone else.
 */
export function ContinuityButton({ state, onChanged }: { state: State | null; onChanged: () => Promise<void> }) {
  // Read from the context App already provides rather than threaded as a prop:
  // the header is five components away from where the role is known, and a prop
  // chain that long is how a screen ends up trusting a default.
  const isAdmin = useRole() === 'ADMIN';
  const [dialog, setDialog] = useState(false);

  if (!state || state.mode === 'CONTINUITY' || !isAdmin) return null;

  return (
    <>
      <button type="button" className="btn btn-ghost continuity-open" onClick={() => setDialog(true)}>
        حالت تداوم
      </button>
      {dialog && (
        <ActivateDialog
          onClose={() => setDialog(false)}
          onDone={() => {
            setDialog(false);
            void onChanged();
          }}
        />
      )}
    </>
  );
}

/**
 * The strip itself. Renders nothing at all unless the mode is on, so the header
 * gains no empty row in the ordinary case.
 */
export function ContinuityBanner({ state, onChanged }: { state: State | null; onChanged: () => Promise<void> }) {
  const isAdmin = useRole() === 'ADMIN';
  const [now, setNow] = useState(() => Date.now());

  // Only the countdown needs a clock, and only while it is on screen. It used
  // to be re-read inside the poll that fetches the mode, which tied how often
  // «۵۹ دقیقه» ticks to how often the server is asked.
  const live = state?.mode === 'CONTINUITY';
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [live]);

  if (!state || state.mode !== 'CONTINUITY') return null;

  return (
    <div className="continuity-banner" role="status" aria-live="polite">
      <strong>حالت تداوم فعال است</strong>
      <span>
        سفارش‌های تازه بدون تایید بانکی تحویل می‌شوند و در صف تطبیق می‌مانند
        {state.expiresAt !== null && ` — ${remaining(state.expiresAt, now)} باقی مانده`}
      </span>
      {/* `dir="auto"`: both of these are values a person typed or an address,
          and a latin one dropped into the RTL flow was drawn in a different
          order from the one it reads in. The quotes stay outside so the
          isolation wraps the reason, not the punctuation around it. */}
      {state.activatedBy && (
        <span dir="auto" className="continuity-banner__by">
          {state.activatedBy}
        </span>
      )}
      {state.reason && (
        <span className="continuity-banner__reason">
          «<span dir="auto">{state.reason}</span>»
        </span>
      )}
      {isAdmin && (
        <button
          type="button"
          className="btn btn-danger continuity-banner__off"
          onClick={async () => {
            await api.setContinuityMode({ active: false });
            await onChanged();
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

  /*
   * Portalled to `document.body`, and that is the fix, not a style.
   *
   * The button lives in `.app-header`, which is `position: fixed` with a
   * `backdrop-filter` — and a backdrop-filter makes its element the containing
   * block for every fixed-position descendant. Rendered in place, this
   * backdrop's `inset: 0` filled the HEADER: on staging the dialog measured
   * 1703×63, a strip along the top with the form cut off underneath. Moving the
   * subtree out of the header is the only thing that resolves `inset: 0`
   * against the viewport again.
   */
  return createPortal(
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="فعال‌کردن حالت تداوم"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-body modal-body--danger">
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
        <label className="form-label" htmlFor="continuity-reason">
          چرا؟
        </label>
        <input
          id="continuity-reason"
          className="form-control"
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="مثلاً: رله پیامک از ساعت ۹ قطع است"
          autoFocus
        />
        <label className="form-label" htmlFor="continuity-duration" style={{ marginBlockStart: 10 }}>
          برای چه مدت؟
        </label>
        <select
          id="continuity-duration"
          className="form-control"
          value={durationMs}
          onChange={(e) => setDurationMs(Number(e.target.value))}
        >
          {DURATIONS.map((d) => (
            <option key={d.ms} value={d.ms}>
              {d.label}
            </option>
          ))}
        </select>
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
    </div>,
    document.body,
  );
}
