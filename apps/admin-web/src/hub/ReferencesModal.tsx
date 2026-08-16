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
import { count } from '../format.js';
import { directionLabel, formatTime, formatTomanFromIrr, statusLabel } from './format.js';

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
          <h3>ارجاع‌ها — {account.display_name}</h3>
          <div className="spacer" />
          <button type="button" onClick={onClose} aria-label="بستن">
            ×
          </button>
        </div>
        <p>
          {/* The stray `v` in front of the state was a leftover; there is no
              version here, only whether the account is switched on. */}
          <strong>{account.bank_name}</strong> · {account.active ? 'فعال' : 'غیرفعال'}
        </p>
        {err && <div className="error">{err}</div>}
        {preview && (
          <>
            <dl className="ref-counts">
              <dt>تراکنش‌ها</dt>
              <dd>{count(total?.transactions ?? 0)}</dd>
              <dt>ادعاهای پرداخت</dt>
              <dd>{count(total?.paymentClaims ?? 0)}</dd>
              <dt>شناسه‌ها</dt>
              <dd>{count(total?.identifiers ?? 0)}</dd>
            </dl>
            <h4>تراکنش‌ها (۵۰ مورد آخر)</h4>
            {preview.references.transactions.length === 0 ? (
              <p className="muted">هیچ‌کدام.</p>
            ) : (
              <ul className="ref-list">
                {preview.references.transactions.map((t) => (
                  <li key={t.id}>
                    <span className="ref-dir">
                      {directionLabel(t.direction as 'CREDIT' | 'DEBIT' | 'UNKNOWN')}
                    </span>
                    <span className="ref-amount">{formatTomanFromIrr(t.amount_irr)}</span>
                    <span className="ref-status">{statusLabel(t.status)}</span>
                    {/* Tehran and Jalali, like every other timestamp in the
                        panel — this was the browser's own zone and calendar. */}
                    <span className="ref-when">
                      {t.bank_timestamp ? formatTime(t.bank_timestamp) : '—'}
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
                    <span className="ref-amount">{formatTomanFromIrr(c.expected_amount_irr)}</span>
                    <span className="ref-status">{statusLabel(c.status)}</span>
                    <span className="ref-when">{formatTime(c.submitted_at)}</span>
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
