/**
 * Permanent-delete confirmation for an inactive financial account.
 *
 * Two-step gate:
 *   1. Fetch the delete-preview; show reference counts + blocking reasons.
 *   2. User must type «Delete» (`confirmWord.ts`) to enable the destructive
 *      Confirm button.
 *
 * And a third door, since 2026-09-19, for an account that is blocked only by
 * its own transactions: «حذف کامل با تراکنش‌ها». Sam: «ازم سوال کنه: میخوای
 * کامل حذف کنی؟ بگم بله، بعد بگه X تراکنش و Y مبلغ از سیستم حسابداری و
 * دیتابیس حذف می‌شه، بعد که تایید کردم کامل حذف کنه.» Saying yes turns the
 * modal into that sentence — the count and the sum in Toman — and the typed
 * name is the confirmation. The offer is not made while any transaction is
 * pinned to the books; the server refuses that too.
 *
 * On success, the parent (AccountsView) clears state, invalidates affected
 * query keys, and shows a success notification.
 */
import { useEffect, useState } from 'react';
import { count, toman } from '../format.js';
import type { AccountListItem } from './api.js';
import { api } from './api.js';
import { DELETE_WORD, typedDeleteWord } from './confirmWord.js';

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
  purge: { transactions: number; amountIrr: number; pinnedTransactions: number; canPurge: boolean };
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
  /** The operator said yes to «حذف کامل»; the modal now names the price. */
  const [purging, setPurging] = useState(false);

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
  const matchesTyped = typedDeleteWord(typed);
  const canSubmit = !!preview && (preview.canDelete || purging) && matchesTyped && !busy;
  const purge = preview?.purge;
  // Only the account's own transactions stand in the way — a claim aimed at
  // it is somebody's payment in flight and is never purged.
  const purgeOffered =
    !!preview &&
    !preview.canDelete &&
    !!purge &&
    purge.canPurge &&
    purge.transactions > 0 &&
    (refs?.paymentClaims ?? 0) === 0;

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setErr(null);
    try {
      await api.deleteAccount(account.id, purging ? { purgeTransactions: true } : undefined);
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
            {purging && purge && (
              <div className="warn-banner">
                <p>
                  با پاک‌کردن کامل، <strong>{count(purge.transactions)} تراکنش</strong> به مبلغ{' '}
                  <strong>{toman(purge.amountIrr)}</strong> از حسابداری و دیتابیس حذف می‌شود، همراه
                  با خودِ حساب و شناسه‌هایش. پیامک‌های خام بانک می‌مانند.{' '}
                  <strong>برگشت‌پذیر نیست.</strong>
                </p>
              </div>
            )}
            {!purging && preview.blockingReasons.length > 0 && (
              <div className="warn-banner">
                {preview.blockingReasons.map((r) => (
                  <div key={r}>{reasonText[r] ?? r}</div>
                ))}
                {refs && (refs.transactions > 0 || refs.paymentClaims > 0) && (
                  <p>قبل از حذف، تراکنش‌ها و ادعاهای پرداختش را به حساب دیگری بده یا ادغام کن.</p>
                )}
                {purge && purge.pinnedTransactions > 0 && (
                  <p>
                    {count(purge.pinnedTransactions)} تراکنش این حساب در دفتر حساب شده (به یک پرداخت
                    یا نماینده وصل است) و پاک‌شدنی نیست.
                  </p>
                )}
                {purgeOffered && (
                  <button
                    type="button"
                    className="danger"
                    style={{ marginTop: '0.75rem' }}
                    onClick={() => setPurging(true)}
                  >
                    حذف کامل با تراکنش‌ها…
                  </button>
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
        {preview && (preview.canDelete || purging) && (
          <div className="form">
            <label>
              <span>
                برای تایید <code>{DELETE_WORD}</code> را بنویس:
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
              blocked && !purging
                ? 'حساب در وضعیت فعلی‌اش حذف‌شدنی نیست.'
                : !matchesTyped
                  ? `برای تایید، ${DELETE_WORD} را بنویس.`
                  : purging
                    ? 'حساب و همهٔ تراکنش‌هایش برای همیشه حذف شوند'
                    : 'این حساب برای همیشه حذف شود'
            }
          >
            {busy ? 'در حال حذف…' : purging ? 'بله، همه‌چیز را پاک کن' : 'حذف همیشگی'}
          </button>
        </div>
      </div>
    </div>
  );
}
