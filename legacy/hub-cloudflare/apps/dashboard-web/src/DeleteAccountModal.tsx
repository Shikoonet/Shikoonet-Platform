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
    account_must_be_inactive: 'Account is still active — deactivate it first.',
    account_in_use: 'Account has linked transactions or payment claims.',
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
      aria-label="Delete account permanently"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-body modal-body--danger">
        <div className="row toolbar">
          <h3>Delete account permanently</h3>
          <div className="spacer" />
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p>
          This deletes <strong>{account.display_name}</strong> ({account.bank_name}) from the
          database. <strong>This cannot be undone.</strong>
        </p>
        {loadError && <div className="error">{loadError}</div>}
        {preview && (
          <>
            <h4>Linked references</h4>
            <dl className="ref-counts">
              <dt>Transactions</dt>
              <dd>{refs?.transactions ?? 0}</dd>
              <dt>Payment claims</dt>
              <dd>{refs?.paymentClaims ?? 0}</dd>
              <dt>Additional identifiers</dt>
              <dd>{refs?.identifiers ?? 0}</dd>
            </dl>
            {preview.blockingReasons.length > 0 && (
              <div className="warn-banner">
                {preview.blockingReasons.map((r) => (
                  <div key={r}>{reasonText[r] ?? r}</div>
                ))}
                {refs && (refs.transactions > 0 || refs.paymentClaims > 0) && (
                  <p>
                    Reassign or merge its transactions and payment claims before deleting. Use the
                    account detail view to migrate references.
                  </p>
                )}
                {onMoveReferences && refs && (refs.transactions > 0 || refs.paymentClaims > 0) && (
                  <button
                    type="button"
                    className="primary"
                    style={{ marginTop: '0.75rem' }}
                    onClick={onMoveReferences}
                  >
                    Move references to another account…
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
                Type <code>{preview.account.displayName}</code> to confirm:
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
            Cancel
          </button>
          <div className="spacer" />
          <button
            type="button"
            className="danger"
            disabled={!canSubmit}
            onClick={confirm}
            title={
              blocked
                ? 'Account cannot be deleted in its current state.'
                : !matchesTyped
                  ? 'Type the account display name exactly to confirm.'
                  : 'Delete this account forever'
            }
          >
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}
