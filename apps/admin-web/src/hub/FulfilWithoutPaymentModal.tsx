/**
 * «تأیید و تحویل دستی» — the dialog in front of the one action in the panel
 * that hands over product against a payment nobody has evidence for.
 *
 * Three things an operator has to be told before they press it, and they were
 * not all here: the delivery happens NOW, the money is still owed an
 * explanation afterwards, and this screen cannot take it back. The last one is
 * the one that was missing — `payment_claims` has one exit from
 * `FULFILLED_UNRECONCILED` and it is reconciliation, not a button.
 *
 * The reason field is required here and required again on the server. Two
 * guards for one rule, because `fulfilment_reason` is a nullable column — it has
 * to be, 350 rows predate it — so neither the schema nor this screen can be the
 * thing that refuses a fulfilment nobody explained.
 */

import { useState } from 'react';
import { api } from './api';
import { formatToman } from './format';

export function FulfilWithoutPaymentModal({
  claimId,
  orderId,
  customer,
  expectedAmountToman,
  onClose,
  onDone,
}: {
  claimId: string;
  orderId: string;
  customer: string;
  expectedAmountToman: number;
  onClose: () => void;
  onDone: (already: boolean) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = reason.trim().length >= 3;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="تأیید و تحویل دستی"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-body">
        <h3>همین سفارش دستی تحویل شود؟</h3>
        <div className="alert alert-warning">
          هیچ تراکنش بانکی‌ای پشت این پرداخت نیست.
          <ul>
            <li>
              سفارش <strong>همین حالا</strong> تحویل می‌شود.
            </li>
            <li>
              پرداخت و رسید <strong>هنوز تطبیق نشده‌اند</strong> و در صف «تحویل‌شده، در انتظار
              تطبیق» می‌مانند تا پیامک بانک برسد؛ تا آن موقع در درآمد شمرده نمی‌شود.
            </li>
            <li>
              اگر دوباره بزنی چیزی دو بار تحویل نمی‌شود، ولی{' '}
              <strong>از این صفحه برگشت‌پذیر نیست</strong>.
            </li>
          </ul>
        </div>
        <dl className="payment-review__facts">
          <dt>مشتری</dt>
          <dd>{customer || '—'}</dd>
          <dt>سفارش</dt>
          <dd>{orderId}</dd>
          <dt>مبلغ</dt>
          <dd className="tabular-nums">{formatToman(expectedAmountToman)}</dd>
        </dl>
        <label>
          چرا الان تحویل می‌دهید؟
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="مثلاً: مشتری رسید فرستاده و رله پیامک قطع است"
          />
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
                const out = await api.fulfilWithoutPayment(claimId, reason.trim());
                onDone(out.already);
              } catch (e) {
                setError(e instanceof Error ? e.message : 'fulfil_failed');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? '…' : 'تأیید و تحویل'}
          </button>
        </div>
      </div>
    </div>
  );
}
