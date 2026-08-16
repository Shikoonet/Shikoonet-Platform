/**
 * ReferencesModal — drill-down view of all transactions / payment claims
 * attached to an account. Used both standalone and as the source of the
 * MoveReferencesModal flow.
 *
 * - Shows totals + the first 50 of each.
 * - "انتقال ارجاع‌ها به…" button opens the MoveReferencesModal.
 *
 * No state beyond the fetched preview.
 */

import { useEffect, useState } from 'react';
import type { AccountListItem } from './api.js';
import { api } from './api.js';
import { formatTomanFromIrr } from './format.js';

interface ReferencesResponse {
  ok: boolean;
  account: { id: string; displayName: string; bank: string; active: boolean };
  references: {
    totals: { transactions: number; paymentClaims: number; identifiers: number };
    transactions: Array<{
      id: string;
      direction: string;
      amount_irr: number | null;
      balance_irr: number | null;
      bank_timestamp: number | null;
      status: string;
    }>;
    paymentClaims: Array<{
      id: string;
      external_order_id: string;
      expected_amount_irr: number;
      submitted_at: number;
      status: string;
    }>;
  };
}

export interface ReferencesModalProps {
  account: AccountListItem;
  onClose: () => void;
  onMove?: (accountId: string) => void;
}

export function ReferencesModal({ account, onClose, onMove }: ReferencesModalProps) {
  const [preview, setPreview] = useState<ReferencesResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .accountReferences(account.id)
      .then((r) => {
        if (!cancelled) setPreview(r);
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [account.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const total = preview?.references.totals;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="ارجاع‌های حساب"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-body">
        <div className="row toolbar">
          <h3>References — {account.display_name}</h3>
          <div className="spacer" />
          <button type="button" onClick={onClose} aria-label="بستن">
            ×
          </button>
        </div>
        <p>
          <strong>{account.bank_name}</strong> · v{account.active ? 'active' : 'inactive'}
        </p>
        {err && <div className="error">{err}</div>}
        {preview && (
          <>
            <dl className="ref-counts">
              <dt>تراکنش‌ها</dt>
              <dd>{total?.transactions ?? 0}</dd>
              <dt>ادعاهای پرداخت</dt>
              <dd>{total?.paymentClaims ?? 0}</dd>
              <dt>شناسه‌ها</dt>
              <dd>{total?.identifiers ?? 0}</dd>
            </dl>
            <h4>تراکنش‌ها (۵۰ مورد آخر)</h4>
            {preview.references.transactions.length === 0 ? (
              <p className="muted">هیچ‌کدام.</p>
            ) : (
              <ul className="ref-list">
                {preview.references.transactions.map((t) => (
                  <li key={t.id}>
                    <span className="ref-dir">{t.direction}</span>
                    <span className="ref-amount">
                      {formatTomanFromIrr(t.amount_irr)}
                    </span>
                    <span className="ref-status">{t.status}</span>
                    <span className="ref-when">
                      {t.bank_timestamp ? new Date(t.bank_timestamp).toLocaleString('en-US') : '—'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <h4>ادعاهای پرداخت (۵۰ مورد آخر)</h4>
            {preview.references.paymentClaims.length === 0 ? (
              <p className="muted">هیچ‌کدام.</p>
            ) : (
              <ul className="ref-list">
                {preview.references.paymentClaims.map((c) => (
                  <li key={c.id}>
                    <span className="ref-claim-id">{c.external_order_id}</span>
                    <span className="ref-amount">
                      {formatTomanFromIrr(c.expected_amount_irr)}
                    </span>
                    <span className="ref-status">{c.status}</span>
                    <span className="ref-when">
                      {new Date(c.submitted_at).toLocaleString('en-US')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <div className="row toolbar modal-actions">
          <div className="spacer" />
          <button type="button" onClick={onClose}>
            بستن
          </button>
          {onMove && (
            <button
              type="button"
              className="primary"
              onClick={() => onMove(account.id)}
              disabled={!preview || (total?.transactions === 0 && total?.paymentClaims === 0)}
            >
              انتقال ارجاع‌ها به…
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
