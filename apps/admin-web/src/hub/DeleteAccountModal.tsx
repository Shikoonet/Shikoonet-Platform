/**
 * Permanent-delete confirmation for an inactive financial account.
 *
 * Two-step gate:
 *   1. Fetch the delete-preview; show reference counts + blocking reasons.
 *   2. User must type the account display name exactly to enable the
 *      destructive Confirm button.
 *
 * On success, the parent (AccountsView) clears state, invalidates affected
 * query keys, and shows a success notification.
 */
import { useEffect, useState } from 'react';
import { count } from '../format.js';
import type { AccountListItem } from './api.js';
import { api } from './api.js';

interface PreviewResponse {
  ok: boolean;
  account: { id: string; displayName: string; bank: string; active: boolean };
  references: {
    transactions: number;
    paymentClaims: number;
    matches: number;
    identifiers: number;
  };
  canDelete: boolean;
  blockingReasons: string[];
}

export interface DeleteAccountModalProps {
  account: AccountListItem;
  onClose: () => void;
  onDeleted: (deletedId: string) => void;
  onMoveReferences?: () => void;
}

export function DeleteAccountModal({
  account,
  onClose,
  onDeleted,
  onMoveReferences,
}: DeleteAccountModalProps) {
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .deleteAccountPreview(account.id)
      .then((r) => {
        if (!cancelled) setPreview(r);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e));
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

  const refs = preview?.references;
  const blocked = !preview || !preview.canDelete;
  const reasonText: Record<string, string> = {
    account_must_be_inactive: 'حساب هنوز فعال است — اول غیرفعالش کن.',
    account_in_use: 'این حساب تراکنش یا ادعای پرداخت مرتبط دارد.',
  };
  const matchesTyped = typed.trim() === preview?.account.displayName.trim();
  const canSubmit = !!preview && preview.canDelete && matchesTyped && !busy;

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setErr(null);
    try {
      await api.deleteAccount(account.id);
      onDeleted(account.id);
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
      aria-label="حذف همیشگی حساب"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-body modal-body--danger">
        <div className="row toolbar">
          <h3>حذف همیشگی حساب</h3>
          <div className="spacer" />
          <button type="button" onClick={onClose} aria-label="بستن">
            ×
          </button>
        </div>
        <p>
          این کار <strong>{account.display_name}</strong> ({account.bank_name}) را از دیتابیس حذف
          می‌کند. <strong>برگشت‌پذیر نیست.</strong>
        </p>
        {loadError && <div className="error">{loadError}</div>}
        {preview && (
          <>
            <h4>ارجاع‌های مرتبط</h4>
            <dl className="ref-counts">
              <dt>تراکنش‌ها</dt>
              <dd>{count(refs?.transactions ?? 0)}</dd>
              <dt>ادعاهای پرداخت</dt>
              <dd>{count(refs?.paymentClaims ?? 0)}</dd>
              <dt>شناسه‌های اضافی</dt>
              <dd>{count(refs?.identifiers ?? 0)}</dd>
            </dl>
            {preview.blockingReasons.length > 0 && (
              <div className="warn-banner">
                {preview.blockingReasons.map((r) => (
                  <div key={r}>{reasonText[r] ?? r}</div>
                ))}
                {refs && (refs.transactions > 0 || refs.paymentClaims > 0) && (
                  <p>
                    قبل از حذف، تراکنش‌ها و ادعاهای پرداختش را به حساب دیگری بده یا ادغام کن.
                  </p>
                )}
                {onMoveReferences && refs && (refs.transactions > 0 || refs.paymentClaims > 0) && (
                  <button
                    type="button"
                    className="primary"
                    style={{ marginTop: '0.75rem' }}
                    onClick={onMoveReferences}
                  >
                    انتقال ارجاع‌ها به حساب دیگر…
                  </button>
                )}
              </div>
            )}
          </>
        )}
        {preview?.canDelete && (
          <div className="form">
            <label>
              <span>
                برای تایید <code>{preview.account.displayName}</code> را بنویس:
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
              blocked
                ? 'حساب در وضعیت فعلی‌اش حذف‌شدنی نیست.'
                : !matchesTyped
                  ? 'برای تایید، نام نمایشی حساب را دقیقاً بنویس.'
                  : 'این حساب برای همیشه حذف شود'
            }
          >
            {busy ? 'در حال حذف…' : 'حذف همیشگی'}
          </button>
        </div>
      </div>
    </div>
  );
}
