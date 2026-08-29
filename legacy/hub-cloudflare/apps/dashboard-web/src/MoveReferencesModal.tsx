/**
 * MoveReferencesModal — moves all transactions, claims, and identifiers
 * from a source account to a target account. Optionally deletes the
 * source.
 *
 * Two-step:
 *   1. Pick the target account (dropdown filtered to active accounts
 *      excluding the source). Hit "Preview" → server returns counts.
 *   2. Toggle the three options (reassignTransactions / reassignClaims /
 *      moveIdentifiers / deleteSource), reason, then "Confirm".
 *
 * Outcome:
 *   - On success: calls `onMoved` so the parent can invalidate the
 *     affected queries (accounts, today, matches, etc.).
 *   - On failure: surfaces the server error verbatim.
 *
 * Why a separate modal:
 *   - Clearer mental model than a checkbox in the DeleteAccountModal.
 *   - User can pick a specific target (not just "merge into any").
 *   - The four options are wired to the new /api/v1/accounts/:id/move-references
 *     endpoint.
 */

import { useEffect, useMemo, useState } from 'react';
import type { AccountListItem } from './api.js';
import { api } from './api.js';

export interface MoveReferencesModalProps {
  source: AccountListItem;
  accounts: AccountListItem[];
  onClose: () => void;
  onMoved: (deletedSource: boolean) => void;
}

export function MoveReferencesModal({
  source,
  accounts,
  onClose,
  onMoved,
}: MoveReferencesModalProps) {
  const eligible = useMemo(
    () => accounts.filter((a) => a.active === 1 && a.id !== source.id),
    [accounts, source.id],
  );
  const [targetId, setTargetId] = useState<string>(eligible[0]?.id ?? '');
  const [options, setOptions] = useState({
    reassignTransactions: true,
    reassignClaims: true,
    moveIdentifiers: true,
    deleteSource: false,
  });
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<{
    counts: { transactions: number; paymentClaims: number; identifiers: number };
    identifiers: Array<{ id: string; kind: string; value: string; label: string | null }>;
  } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Recompute preview when target or options change.
  useEffect(() => {
    if (!targetId) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewBusy(true);
    api
      .moveReferencesPreview(source.id, { targetAccountId: targetId })
      .then((r) => {
        if (!cancelled) setPreview({ counts: r.counts, identifiers: r.identifiers });
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e));
      })
      .finally(() => {
        if (!cancelled) setPreviewBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source.id, targetId]);

  async function submit() {
    if (!targetId) return;
    setBusy(true);
    setErr(null);
    try {
      await api.moveReferences(source.id, {
        targetAccountId: targetId,
        options,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      onMoved(options.deleteSource);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  const noop =
    !preview || (preview.counts.transactions === 0 && preview.counts.paymentClaims === 0);

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Move references"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-body">
        <div className="row toolbar">
          <h3>Move references — {source.display_name}</h3>
          <div className="spacer" />
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p>
          Move everything attached to <strong>{source.display_name}</strong> ({source.bank_name}) to
          a different account. The move is atomic — if any step fails, nothing changes.
        </p>
        {eligible.length === 0 ? (
          <div className="warn-banner">
            No active target accounts available. Create another account first.
          </div>
        ) : (
          <div className="form">
            <label>
              <span>Target account</span>
              <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                {eligible.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.display_name} ({a.bank_name}
                    {a.account_hint ? ` • ${a.account_hint}` : ''})
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Reason (audit log)</span>
              <input
                type="text"
                value={reason}
                maxLength={500}
                placeholder="e.g. duplicate account created in error"
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <fieldset className="form-options">
              <legend>Move options</legend>
              <label className="row checkbox-row">
                <input
                  type="checkbox"
                  checked={options.reassignTransactions}
                  onChange={(e) =>
                    setOptions((o) => ({ ...o, reassignTransactions: e.target.checked }))
                  }
                />
                <span>Reassign transactions</span>
              </label>
              <label className="row checkbox-row">
                <input
                  type="checkbox"
                  checked={options.reassignClaims}
                  onChange={(e) => setOptions((o) => ({ ...o, reassignClaims: e.target.checked }))}
                />
                <span>Reassign payment claims</span>
              </label>
              <label className="row checkbox-row">
                <input
                  type="checkbox"
                  checked={options.moveIdentifiers}
                  onChange={(e) => setOptions((o) => ({ ...o, moveIdentifiers: e.target.checked }))}
                />
                <span>Move identifiers</span>
              </label>
              <label className="row checkbox-row">
                <input
                  type="checkbox"
                  checked={options.deleteSource}
                  onChange={(e) => setOptions((o) => ({ ...o, deleteSource: e.target.checked }))}
                />
                <span>Delete source account after move</span>
              </label>
            </fieldset>
          </div>
        )}
        {preview && (
          <div className="preview-box">
            <h4>Preview</h4>
            <p>
              Will move <strong>{preview.counts.transactions}</strong> transaction(s),{' '}
              <strong>{preview.counts.paymentClaims}</strong> payment claim(s), and{' '}
              <strong>{preview.counts.identifiers}</strong> identifier(s) to the target.
            </p>
            {preview.identifiers.length > 0 && (
              <ul className="ref-list">
                {preview.identifiers.map((i) => (
                  <li key={i.id}>
                    <span className="ref-claim-id">{i.kind}</span>
                    <span className="ref-amount">{i.value}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {previewBusy && <p className="muted">Loading preview…</p>}
        {err && <div className="error">{err}</div>}
        <div className="row toolbar modal-actions">
          <div className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !targetId || noop}
            onClick={submit}
          >
            {busy ? 'Moving…' : 'Confirm move'}
          </button>
        </div>
      </div>
    </div>
  );
}
