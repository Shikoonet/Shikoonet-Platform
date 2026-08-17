/**
 * ارسال گروهی — the two actions that reach every customer at once.
 *
 * These were the last two of the bot admin panel's twelve permissions with no
 * equivalent here. Nothing about them is new: `bulkRoutes.ts` calls the same
 * `creditEveryone` and `queueBroadcast` the bot calls, so the idempotency key,
 * the recipient snapshot and the append-only wallet entry are one
 * implementation. What is new is being able to do it from a keyboard.
 *
 * ## Why the id is generated here
 *
 * `batchId` is minted when this page mounts and sent with the request, rather
 * than by the server on arrival. A server-minted id would be new on every
 * attempt, so a double-submitted form or a request whose response was lost
 * would credit eleven thousand wallets a second time — the idempotency key
 * would never collide. Minted here, a retry is free. It is re-minted only after
 * a *successful* submit, so the next thing the operator sends is a new batch.
 *
 * ## Two steps, and the total in the middle
 *
 * Neither action has an undo, so neither is one click. The confirmation shows
 * the amount multiplied by the reach, which is the number that catches a typed
 * extra zero: «۵۰٬۰۰۰ تومان» looks like «۵٬۰۰۰ تومان» at a glance, and
 * «۵۶۰٬۰۰۰٬۰۰۰ تومان در مجموع» does not look like «۵۶٬۰۰۰٬۰۰۰».
 */

import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';
import { count, toman } from '../format.js';

/** Telegram refuses a longer message outright rather than truncating it. */
const MAX_MESSAGE_LENGTH = 4096;

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'برای این کار دسترسی ادمین لازم است.';
    if (e.code === 'no_active_customers') return 'هیچ مشتری فعالی نیست.';
    if (e.code === 'invalid_body') return 'ورودی پذیرفته نشد.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

function newId(): string {
  return crypto.randomUUID();
}

export function BulkPage() {
  const [reach, setReach] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [amount, setAmount] = useState('');
  const [batchId, setBatchId] = useState(newId);
  const [confirmingCredit, setConfirmingCredit] = useState(false);

  const [body, setBody] = useState('');
  const [broadcastId, setBroadcastId] = useState(newId);
  const [confirmingMessage, setConfirmingMessage] = useState(false);

  const [busy, setBusy] = useState(false);

  async function loadReach() {
    try {
      setReach((await api.bulkReach()).reach);
    } catch (e) {
      setErr(message(e));
    }
  }

  useEffect(() => {
    void loadReach();
  }, []);

  // Toman in, Rial out, through the one conversion this panel has. Digits only:
  // a separator or a minus sign typed here is a mistake, not a number.
  const toman10 = /^[0-9]+$/.test(amount.trim()) ? Number(amount.trim()) : null;
  const amountIrr = toman10 === null || toman10 <= 0 ? null : toman10 * 10;
  const trimmed = body.trim();

  async function submitCredit() {
    if (amountIrr === null) return;
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      const r = await api.bulkCredit({ amountIrr, batchId });
      setDone(`کیف پول ${count(r.credited)} مشتری شارژ شد.`);
      setAmount('');
      // A fresh batch for whatever they send next; the one just used stays
      // spent, so a stale tab cannot replay it.
      setBatchId(newId());
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
      setConfirmingCredit(false);
    }
  }

  async function submitBroadcast() {
    if (trimmed === '') return;
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      const r = await api.broadcast({ body: trimmed, broadcastId });
      setDone(`پیام برای ${count(r.queued)} مشتری در صف قرار گرفت. ربات آن را می‌فرستد.`);
      setBody('');
      setBroadcastId(newId());
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
      setConfirmingMessage(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">ارسال گروهی</div>
          <div className="page-head__sub">
            {reach === null ? '…' : `${count(reach)} مشتری فعال`}
          </div>
        </div>
      </div>

      {err && <div className="alert alert-error">{err}</div>}
      {done && <div className="alert alert-info">{done}</div>}

      <div className="card">
        <h3>شارژ گروهی کیف پول</h3>
        <p className="muted">
          به کیف پول هر مشتری فعال یک مبلغ اضافه می‌شود. برگشت‌پذیر نیست. اگر همین درخواست دو بار
          برسد، هر کیف پول فقط یک بار شارژ می‌شود.
        </p>
        <div className="filters">
          <div>
            <label className="form-label" htmlFor="bulk-amount">
              مبلغ برای هر نفر (تومان)
            </label>
            <input
              id="bulk-amount"
              className="form-control ltr"
              inputMode="numeric"
              value={amount}
              disabled={busy}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || amountIrr === null || !reach}
            onClick={() => setConfirmingCredit(true)}
          >
            ادامه
          </button>
        </div>
      </div>

      {/* Directly under the card it confirms. Collected at the bottom of the
          page, both of these opened below the fold — the operator pressed
          «ادامه» and the screen appeared not to react. */}
      {confirmingCredit && amountIrr !== null && reach !== null && (
        <Confirm
          title="شارژ گروهی تایید شود؟"
          onCancel={() => setConfirmingCredit(false)}
          onConfirm={() => void submitCredit()}
          busy={busy}
        >
          <p>
            به کیف پول <strong>{count(reach)}</strong> مشتری، هر کدام{' '}
            <strong>{toman(amountIrr)}</strong> اضافه می‌شود.
          </p>
          {/* The number that actually catches a typed extra zero. */}
          <p>
            جمع کل: <strong>{toman(amountIrr * reach)}</strong>
          </p>
          <p className="muted">این کار برگشت‌پذیر نیست.</p>
        </Confirm>
      )}

      <div className="card" style={{ marginBlockStart: 16 }}>
        <h3>پیام همگانی</h3>
        <p className="muted">
          پیام برای هر مشتری فعال در صف می‌رود و ربات آن را می‌فرستد — نه از این صفحه. کسی که بعد از
          این لحظه /start بزند آن را نمی‌گیرد.
        </p>
        <div>
          <label className="form-label" htmlFor="bulk-body">
            متن پیام
          </label>
          <textarea
            id="bulk-body"
            className="form-control"
            rows={6}
            maxLength={MAX_MESSAGE_LENGTH}
            value={body}
            disabled={busy}
            onChange={(e) => setBody(e.target.value)}
          />
          <p className="muted">
            {count(trimmed.length)} از {count(MAX_MESSAGE_LENGTH)} نویسه
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || trimmed === '' || !reach}
          onClick={() => setConfirmingMessage(true)}
        >
          ادامه
        </button>
      </div>

      {confirmingMessage && reach !== null && (
        <Confirm
          title="پیام همگانی فرستاده شود؟"
          onCancel={() => setConfirmingMessage(false)}
          onConfirm={() => void submitBroadcast()}
          busy={busy}
        >
          <p>
            این پیام برای <strong>{count(reach)}</strong> مشتری در صف می‌رود.
          </p>
          <pre className="code-scrollable">{trimmed}</pre>
          <p className="muted">بعد از تایید، جلوی فرستادن را نمی‌شود گرفت.</p>
        </Confirm>
      )}
    </>
  );
}

/**
 * A card, not a modal.
 *
 * The first version of this used `.modal-backdrop` / `.modal-body`, which are
 * the *hub's* class names — scoped to `:where(.hub)` and defined nowhere else,
 * so on a panel screen the confirmation rendered as bare text floating at the
 * top of the page with no surface behind it. The panel has no modal layer at
 * all; every other screen confirms in an inline card. Found by looking at it.
 */
function Confirm({
  title,
  children,
  onCancel,
  onConfirm,
  busy,
}: {
  title: string;
  children: React.ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    <div className="card" style={{ marginBlockStart: 16 }} role="group" aria-label={title}>
      <div className="card__head">
        <span className="card__title">{title}</span>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={onCancel}>
          انصراف
        </button>
      </div>
      {children}
      <button type="button" className="btn btn-primary" disabled={busy} onClick={onConfirm}>
        {busy ? 'در حال ارسال…' : 'تایید'}
      </button>
    </div>
  );
}
