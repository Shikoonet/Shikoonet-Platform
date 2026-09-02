/**
 * «تحویل بدون تایید بانکی» — the dialog in front of the one action in the panel
 * that hands over product against a payment nobody has evidence for.
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
      aria-label="تحویل بدون تایید بانکی"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-body">
        <h3>بدون تایید بانکی تحویل شود؟</h3>
        <p className="alert alert-warning">
          هیچ تراکنش بانکی‌ای پشت این پرداخت نیست. سفارش تحویل می‌شود و در صف «تحویل‌شده، در
          انتظار تطبیق» می‌ماند تا پیامک بانک برسد. این پرداخت <strong>در درآمد شمرده نمی‌شود</strong>{' '}
          تا تطبیق انجام شود.
        </p>
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
            {busy ? '…' : 'تحویل بده'}
          </button>
        </div>
      </div>
    </div>
  );
}
