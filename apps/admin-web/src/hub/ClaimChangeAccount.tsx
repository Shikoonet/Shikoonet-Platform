/**
 * Claim-specific bank/account override inside Payment Review.
 */

import { useEffect, useMemo, useState } from 'react';
import type { Cache } from './query.js';
import { QK } from './queries.js';
import { api } from './api.js';
import type { PaymentItem } from './paymentReview.js';

export function ClaimChangeAccount({
  item,
  cache,
  onSaved,
  onError,
}: {
  item: PaymentItem;
  cache: Cache;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState(item.accountId ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const { data: accounts } = cache.useQuery<{
    items: Array<{ id: string; display_name: string; bank_name: string; active: number }>;
  }>(QK.accounts, {
    fetcher: async (signal) => {
      const r = await fetch('/api/v1/accounts', { signal });
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
  });

  const filtered = useMemo(
    () => (accounts?.items ?? []).filter((a) => a.active === 1),
    [accounts?.items],
  );

  useEffect(() => {
    setAccountId(item.accountId ?? '');
  }, [item.accountId, item.id]);

  async function submit() {
    setBusy(true);
    try {
      await api.changePaymentClaimAccount(item.id, {
        accountId: accountId || null,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      setOpen(false);
      onSaved();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="ghost" onClick={() => setOpen(true)}>
        Change bank/account
      </button>
    );
  }

  return (
    <div className="claim-change-account">
      <label>
        Effective bank/account
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">— Unmapped —</option>
          {filtered.map((a) => (
            <option key={a.id} value={a.id}>
              {a.display_name} ({a.bank_name})
            </option>
          ))}
        </select>
      </label>
      <label>
        Reason (optional)
        <input type="text" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="payment-review__actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void submit()}>
          Save account
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
