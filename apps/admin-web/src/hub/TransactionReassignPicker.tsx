/**
 * Searchable bank-transaction picker for reassignment inside Payment Review.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Cache } from './query.js';
import { QK } from './queries.js';
import { formatTomanFromIrr, formatTimeSeconds } from './format.js';
import { type AccountRefLike, bankName, type PaymentItem } from './paymentReview.js';
import { IdentifierText } from './IdentifierText.js';

export type SearchTransaction = {
  id: string;
  amountIrr: number | null;
  bankTimestamp: number | null;
  accountId: string | null;
  accountDisplay: string | null;
  accountBank: string | null;
  accountHint: string | null;
  matchStatus: string | null;
  consumed: boolean;
  linkedClaim: {
    claimId: string;
    orderId: string;
    telegramUserId: string | null;
    telegramUsername: string | null;
    claimStatus: string | null;
  } | null;
};

function AccountRef({ account }: { account: AccountRefLike }) {
  const bank = bankName(account);
  if (!bank && !account.accountHint) return <span className="muted">تخصیص‌نیافته</span>;
  return (
    <bdi className="account-ref">
      {bank && <span>{bank}</span>}
      {account.accountHint && <IdentifierText value={account.accountHint} tone="hint" />}
    </bdi>
  );
}

function linkedLabel(link: SearchTransaction['linkedClaim']): string | null {
  if (!link) return null;
  if (link.telegramUsername) return `@${link.telegramUsername}`;
  if (link.telegramUserId) return `user ${link.telegramUserId}`;
  return null;
}

export function TransactionReassignPicker({
  item,
  cache,
  onClose,
  onReassign,
  onError,
}: {
  item: PaymentItem;
  cache: Cache;
  onClose: () => void;
  onReassign: (args: { transactionId: string; reason: string; verifyAfterAssign: boolean }) => Promise<void>;
  onError: (message: string) => void;
}) {
  const anchor = item.paidClickedAt ?? item.receiptSubmittedAt ?? item.createdAt;
  const defaultFrom = anchor != null ? anchor - 30 * 60_000 : null;
  const defaultTo = anchor != null ? anchor + 30 * 60_000 : null;

  const [amount, setAmount] = useState(
    String(item.expectedAmountToman ?? Math.floor(item.expectedAmountIrr / 10)),
  );
  const [accountId, setAccountId] = useState(item.accountId ?? '');
  const [from, setFrom] = useState(defaultFrom != null ? String(defaultFrom) : '');
  const [to, setTo] = useState(defaultTo != null ? String(defaultTo) : '');
  const [transactionId, setTransactionId] = useState('');
  const [reference, setReference] = useState('');
  const [results, setResults] = useState<SearchTransaction[]>([]);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<SearchTransaction | null>(null);
  const [reason, setReason] = useState('');
  const [verifyAfter, setVerifyAfter] = useState(true);
  const [confirmStep, setConfirmStep] = useState(false);

  const { data: accounts } = cache.useQuery<{
    items: Array<{ id: string; display_name: string; bank_name: string }>;
  }>(QK.accounts, {
    fetcher: async (signal) => {
      const r = await fetch('/api/v1/accounts', { signal });
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
  });

  const query = useMemo(() => {
    const qs = new URLSearchParams();
    const amt = Number(amount);
    if (Number.isFinite(amt) && amt > 0) qs.set('amount', String(Math.round(amt * 10)));
    if (accountId) qs.set('accountId', accountId);
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    if (transactionId.trim()) qs.set('transactionId', transactionId.trim());
    if (reference.trim()) qs.set('reference', reference.trim());
    qs.set('limit', '50');
    return qs.toString();
  }, [amount, accountId, from, to, transactionId, reference]);

  const search = useCallback(async () => {
    setSearching(true);
    setPicked(null);
    setConfirmStep(false);
    try {
      const r = await fetch(`/api/v1/transactions/search?${query}`);
      if (!r.ok) throw new Error(`${r.status}`);
      const j = (await r.json()) as { items: SearchTransaction[] };
      setResults(j.items ?? []);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'search_failed');
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [query, onError]);

  useEffect(() => {
    void search();
  }, [search]);

  async function submit() {
    if (!picked || !reason.trim()) return;
    setBusy(true);
    try {
      await onReassign({
        transactionId: picked.id,
        reason: reason.trim(),
        verifyAfterAssign: verifyAfter,
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : 'reassign_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="transaction-reassign">
      <div className="row toolbar">
        <h3>یافتن یا تغییر تراکنش</h3>
        <div className="spacer" />
        <button type="button" className="ghost" onClick={onClose}>
          بازگشت
        </button>
      </div>

      <div className="transaction-reassign__filters">
        <label>
          مبلغ (تومان)
          <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label>
          حساب
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">همه</option>
            {(accounts?.items ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.display_name}
              </option>
            ))}
          </select>
        </label>
        <label>
          از (میلی‌ثانیه)
          <input type="text" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To (ms)
          <input type="text" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          شناسهٔ تراکنش
          <input type="text" value={transactionId} onChange={(e) => setTransactionId(e.target.value)} />
        </label>
        <label>
          مرجع
          <input type="text" value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
        <button type="button" className="ghost" onClick={() => void search()} disabled={searching}>
          {searching ? 'در حال جست‌وجو…' : 'جست‌وجو'}
        </button>
      </div>

      {searching && <p className="muted">در حال جست‌وجو…</p>}
      {!searching && results.length === 0 && <p className="muted">هیچ تراکنشی با این فیلترها نمی‌خواند.</p>}

      <ul className="transaction-reassign__results">
        {results.map((tx) => (
          <li key={tx.id} className={picked?.id === tx.id ? 'picked' : undefined}>
            <div className="transaction-reassign__row">
              <div>
                <strong>{tx.bankTimestamp ? formatTimeSeconds(tx.bankTimestamp) : '—'}</strong>
                <br />
                +{tx.amountIrr != null ? formatTomanFromIrr(tx.amountIrr) : '—'}
                <br />
                <AccountRef account={tx} />
                <br />
                <span className="muted">ID {tx.id}</span>
              </div>
              <div>
                {tx.consumed ? (
                  <>
                    <p className="payment-reason__flag">قبلاً استفاده شده</p>
                    {tx.linkedClaim && (
                      <p>
                        Linked: {linkedLabel(tx.linkedClaim) ?? 'کاربر نامشخص'}
                        <br />
                        User ID: {tx.linkedClaim.telegramUserId ?? '—'}
                        <br />
                        Order: {tx.linkedClaim.orderId}
                      </p>
                    )}
                    <button type="button" disabled>
                      تغییر تخصیص مسدود است
                    </button>
                  </>
                ) : tx.linkedClaim && tx.matchStatus === 'SUGGESTED' ? (
                  <>
                    <p className="muted">الان پیشنهاد شده برای:</p>
                    <p>
                      {linkedLabel(tx.linkedClaim) ?? 'کاربر نامشخص'}
                      <br />
                      User ID: {tx.linkedClaim.telegramUserId ?? '—'}
                      <br />
                      Order: {tx.linkedClaim.orderId}
                    </p>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => {
                        setPicked(tx);
                        setConfirmStep(true);
                      }}
                    >
                      انتخاب
                    </button>
                  </>
                ) : (
                  <>
                    <p className="muted">
                      {tx.linkedClaim ? `Status: ${tx.matchStatus ?? 'linked'}` : 'تخصیص‌نیافته'}
                    </p>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => {
                        setPicked(tx);
                        setConfirmStep(true);
                      }}
                    >
                      انتخاب
                    </button>
                  </>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>

      {confirmStep && picked && !picked.consumed && (
        <div className="transaction-reassign__confirm">
          <h4>تایید تغییر تخصیص</h4>
          {picked.linkedClaim && picked.matchStatus === 'SUGGESTED' && (
            <div className="transaction-reassign__sides">
              <div>
                <strong>فعلی</strong>
                <p>
                  {linkedLabel(picked.linkedClaim) ?? 'کاربر نامشخص'}
                  <br />
                  User ID: {picked.linkedClaim.telegramUserId ?? '—'}
                  <br />
                  Order: {picked.linkedClaim.orderId}
                </p>
              </div>
              <div>
                <strong>New</strong>
                <p>
                  {item.telegramUsername ? `@${item.telegramUsername}` : userFallback(item)}
                  <br />
                  User ID: {item.telegramUserId ?? '—'}
                  <br />
                  Order: {item.orderId}
                </p>
              </div>
            </div>
          )}
          {!picked.linkedClaim && <p>Assign this bank transaction to Order {item.orderId}?</p>}
          <label>
            دلیل (الزامی)
            <input
              type="text"
              value={reason}
              maxLength={2000}
              placeholder="e.g. Transaction was attached to the user's previous payment attempt."
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={verifyAfter}
              onChange={(e) => setVerifyAfter(e.target.checked)}
            />
            تایید بعد از تخصیص (تایید دستی)
          </label>
          <div className="payment-review__actions">
            <button
              type="button"
              className="primary"
              disabled={busy || !reason.trim()}
              onClick={() => void submit()}
            >
              {verifyAfter ? 'تغییر تخصیص و تایید' : 'فقط تغییر تخصیص'}
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setConfirmStep(false)}>
              انصراف
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function userFallback(item: PaymentItem): string {
  if (item.telegramUserId) return `user ${item.telegramUserId}`;
  return 'کاربر نامشخص';
}
