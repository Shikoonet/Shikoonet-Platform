/**
 * ChangeAccountModal — modal that lets a user re-assign a transaction
 * (or payment claim) to a different account. Replaces the legacy
 * AssignAccountModal for the dashboard's Today / Suggested / Unmatched /
 * Reviewed flows.
 *
 * Differences vs the legacy AssignAccountModal:
 *   - Always references the new /api/v1/transactions/:id/change-account
 *     endpoint that writes a MANUAL assignment row. Auto-assignment is
 *     never overwritten by AUTO_IDENTIFIER.
 *   - Shows the current assignment source (AUTO_IDENTIFIER vs MANUAL) so
 *     the user knows whether their manual change is "promoting" an
 *     auto-assigned row or replacing an existing manual one.
 *   - Optional "Show history" toggle surfaces the per-transaction
 *     assignment chain.
 *   - Allows clearing the assignment (accountId = null) — the row
 *     returns to NEEDS_REVIEW.
 *
 * No props for tabs, no prop spreading. Caller passes the bare row +
 * account list and an onSaved callback.
 */

import { useEffect, useMemo, useState } from 'react';
import { api, type AccountListItem, type TodayItem } from './api.js';
import { formatTomanFromIrr } from './format.js';

export interface ChangeAccountModalProps {
  /** The transaction we are re-assigning. */
  tx: TodayItem;
  accounts: AccountListItem[];
  /** Optional: the current assignment source, if known. */
  currentSource?: 'AUTO_IDENTIFIER' | 'MANUAL' | 'HISTORICAL_BACKFILL' | 'ACCOUNT_MERGE' | null;
  onClose: () => void;
  onSaved: () => void;
}

export function ChangeAccountModal({
  tx,
  accounts,
  currentSource,
  onClose,
  onSaved,
}: ChangeAccountModalProps) {
  const [accountId, setAccountId] = useState<string>(tx.financial_account_id ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<
    Array<{
      id: string;
      accountId: string | null;
      source: string;
      assignedBy: string;
      assignedAt: number;
      active: boolean;
    }>
  >([]);
  const [historyBusy, setHistoryBusy] = useState(false);

  const filtered = useMemo(() => accounts.filter((a) => a.active === 1), [accounts]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Lazy-load history.
  useEffect(() => {
    if (!showHistory) return;
    let cancelled = false;
    setHistoryBusy(true);
    api
      .transactionAssignmentHistory(tx.id)
      .then((r) => {
        if (!cancelled) setHistory(r.items);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      })
      .finally(() => {
        if (!cancelled) setHistoryBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showHistory, tx.id]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.changeTransactionAccount(tx.id, {
        accountId: accountId === '' ? null : accountId,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const sourceBadge = currentSource
    ? sourceLabel(currentSource)
    : tx.financial_account_id
      ? 'Currently assigned'
      : 'Unassigned';

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Change account"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-body">
        <div className="row toolbar">
          <h3>Change account</h3>
          <div className="spacer" />
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p>
          <strong>Transaction:</strong> {tx.direction} ·{' '}
          {formatTomanFromIrr(tx.amount_irr)}
        </p>
        <p>
          <strong>Current account:</strong>{' '}
          {tx.account_display ?? <span className="muted">Not assigned</span>}{' '}
          <span className="source-badge">{sourceBadge}</span>
        </p>
        <div className="form">
          <label>
            <span>New account</span>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">— Unassigned —</option>
              {filtered.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.display_name} ({a.bank_name}
                  {a.account_hint ? ` • ${a.account_hint}` : ''})
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Reason (optional, audit log)</span>
            <input
              type="text"
              value={reason}
              maxLength={500}
              placeholder="e.g. wrong account, customer requested"
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        </div>
        <div className="row toolbar">
          <button type="button" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? 'Hide history' : 'Show history'}
          </button>
        </div>
        {showHistory && (
          <div className="history-list">
            {historyBusy ? (
              <p className="muted">Loading…</p>
            ) : history.length === 0 ? (
              <p className="muted">No assignment history.</p>
            ) : (
              <ul>
                {history.map((h) => (
                  <li
                    key={h.id}
                    className={h.active ? 'history-item history-item--active' : 'history-item'}
                  >
                    <span className="history-source">{h.source}</span>
                    <span className="history-assignee">{h.assignedBy}</span>
                    <span className="history-when">
                      {new Date(h.assignedAt).toLocaleString('en-US')}
                    </span>
                    {h.active && <span className="history-active-tag">active</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {error && <div className="error">{error}</div>}
        <div className="row toolbar modal-actions">
          <div className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={busy} onClick={submit}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

function sourceLabel(s: string): string {
  switch (s) {
    case 'AUTO_IDENTIFIER':
      return 'auto-assigned';
    case 'MANUAL':
      return 'manual';
    case 'HISTORICAL_BACKFILL':
      return 'backfill';
    case 'ACCOUNT_MERGE':
      return 'moved';
    default:
      return s;
  }
}
