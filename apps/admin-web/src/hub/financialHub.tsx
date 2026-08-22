import { useEffect, useMemo, useState } from 'react';
import type { Cache } from './query.js';
import { count } from '../format.js';
import { useWriteProps } from '../role.js';
import { formatTomanFromIrr, formatTime } from './format.js';
import { IdentifierText } from './IdentifierText.js';
import { NewBadge } from './NewBadge.js';
import {
  bankName,
  formatToman,
  type AccountRefLike,
  type HistoryRange,
  HISTORY_RANGE_OPTIONS,
  type IncomeItem,
  type PaymentItem,
  type ResellerItem,
} from './paymentReview.js';
import type { AnalyticsResponse } from './analytics.js';
import { IconBalance, IconBotSales, IconResellerSales } from './paymentsIcons.js';

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

export function HistoryRangeSelect({
  value,
  onChange,
}: {
  value: HistoryRange;
  onChange: (v: HistoryRange) => void;
}) {
  return (
    <label className="history-range">
      <span>بازه</span>
      <select value={value} onChange={(e) => onChange(e.target.value as HistoryRange)}>
        {HISTORY_RANGE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SalesTrendChart({
  analytics,
  className,
}: {
  analytics: AnalyticsResponse | undefined;
  className?: string;
}) {
  if (!analytics?.trend.length) {
    return (
      <div className={`sales-trend${className ? ` ${className}` : ''}`} aria-label="روند فروش">
        <h3 className="sales-trend__title">روند فروش</h3>
        <p className="muted">در این بازه فروش تاییدشده‌ای نیست.</p>
      </div>
    );
  }
  const max = Math.max(...analytics.trend.map((b) => b.salesAmountIrr), 1);
  return (
    <div
      className={`sales-trend panel-subtle${className ? ` ${className}` : ''}`}
      aria-label="روند فروش"
    >
      <div className="sales-trend__header">
        <h3 className="sales-trend__title section-heading">روند فروش</h3>
        <p className="sales-trend__subtitle muted tabular-nums">
          {count(analytics.sales.count)} پرداخت · {formatTomanFromIrr(analytics.sales.amountIrr)}
        </p>
      </div>
      <div className="sales-trend__chart">
        {analytics.trend.map((b) => (
          <div key={b.bucketStart} className="sales-trend__bar-wrap">
            <div
              className="sales-trend__bar"
              style={{ height: `${Math.max(4, (b.salesAmountIrr / max) * 100)}%` }}
              title={`${b.label}\n${count(b.salesCount)} فروش\n${formatTomanFromIrr(b.salesAmountIrr)}`}
            />
            <span className="sales-trend__label">{b.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TopMetricsSummary({ analytics }: { analytics: AnalyticsResponse }) {
  return (
    <div className="metrics-strip" aria-label="شاخص‌های اصلی">
      <article className="metrics-strip__item">
        <span className="metrics-strip__icon" aria-hidden>
          <IconBalance />
        </span>
        <div className="metrics-strip__body">
          <span className="metrics-strip__label">موجودی کل</span>
          <span className="metrics-strip__value tabular-nums">
            {formatTomanFromIrr(analytics.balances.totalKnownIrr)}
          </span>
          <span className="metrics-strip__meta muted">
            {count(analytics.balances.knownAccounts)} حساب از{' '}
            {count(analytics.balances.totalActiveAccounts)}
          </span>
        </div>
      </article>
      <article className="metrics-strip__item metrics-strip__item--accent">
        <span className="metrics-strip__icon metrics-strip__icon--accent" aria-hidden>
          <IconBotSales />
        </span>
        <div className="metrics-strip__body">
          <span className="metrics-strip__label">فروش ربات</span>
          <span className="metrics-strip__value tabular-nums">
            {formatTomanFromIrr(analytics.botAutoVerified.amountIrr)}
          </span>
          <span className="metrics-strip__meta muted">
            {count(analytics.botAutoVerified.count)} پرداخت
          </span>
        </div>
      </article>
      <article className="metrics-strip__item">
        <span className="metrics-strip__icon" aria-hidden>
          <IconResellerSales />
        </span>
        <div className="metrics-strip__body">
          <span className="metrics-strip__label">فروش نمایندگی</span>
          <span className="metrics-strip__value tabular-nums">
            {formatTomanFromIrr(analytics.reseller.amountIrr)}
          </span>
          <span className="metrics-strip__meta muted">
            {count(analytics.reseller.count)} پرداخت
          </span>
        </div>
      </article>
    </div>
  );
}

export function IncomeTotalsBar({
  totals,
}: {
  totals: { count: number; amountIrr: number } | undefined;
}) {
  if (!totals) return null;
  return (
    <div className="hub-context-metrics" aria-label="جمع واریزی‌های تخصیص‌نیافته">
      <span>
        <strong>{totals.count}</strong> تخصیص‌نیافته
      </span>
      <span className="hub-context-metrics__sep" aria-hidden>
        ·
      </span>
      <span className="tabular-nums">
        <strong>{formatTomanFromIrr(totals.amountIrr)}</strong>
      </span>
    </div>
  );
}

function maskAccountHint(hint: string | null): string {
  if (!hint) return '****';
  return `****${hint.replace(/\s/g, '')}`;
}

export function IncomeRow({
  item,
  isNew,
  selected,
  onSelect,
  onOpen,
  onAssign,
  onMarkReseller,
  onDecline,
}: {
  item: IncomeItem;
  isNew?: boolean;
  selected?: boolean;
  onSelect?: (checked: boolean) => void;
  onOpen?: () => void;
  onAssign: () => void;
  onMarkReseller: () => void;
  onDecline: () => void;
}) {
  const masked = maskAccountHint(item.accountHint);
  const amountLabel =
    item.amountToman != null ? formatToman(item.amountToman) : formatTomanFromIrr(item.amountIrr);

  return (
    <li
      className={`hub-list-row hub-list-row--income${isNew ? ' hub-list-row--new' : ''}${selected ? ' hub-list-row--selected' : ''}`}
    >
      {onSelect && (
        <label className="hub-list-row__checkbox" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected ?? false}
            aria-label={`انتخاب واریزی ${item.id}`}
            onChange={(e) => onSelect(e.target.checked)}
          />
        </label>
      )}
      <button type="button" className="hub-list-row__button" onClick={onOpen}>
        <div className="hub-list-row__line1">
          <span className="hub-list-row__identity">
            <NewBadge isNew={isNew} />
            <AccountRef account={item} />
          </span>
          <span className="hub-list-row__amount tabular-nums">{amountLabel}</span>
        </div>
        <div className="hub-list-row__line2 muted">
          {item.bankTimestamp ? formatTime(item.bankTimestamp) : '—'} · {masked}
        </div>
      </button>
      <div className="hub-list-row__actions" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="ghost hub-list-row__action" onClick={onAssign}>
          تخصیص
        </button>
        <button type="button" className="ghost hub-list-row__action" onClick={onMarkReseller}>
          نمایندگی
        </button>
        <button type="button" className="ghost hub-list-row__action" onClick={onDecline}>
          رد
        </button>
      </div>
    </li>
  );
}

export function DeclinedTotalsBar({
  totals,
}: {
  totals: { count: number; amountIrr: number } | undefined;
}) {
  if (!totals) return null;
  return (
    <div
      className="hub-context-metrics hub-context-metrics--declined"
      aria-label="جمع واریزی‌های ردشده"
    >
      <span>
        <strong>{totals.count}</strong> ردشده
      </span>
      <span className="hub-context-metrics__sep" aria-hidden>
        ·
      </span>
      <span className="tabular-nums">
        <strong>{formatTomanFromIrr(totals.amountIrr)}</strong>
      </span>
    </div>
  );
}

export function DeclinedIncomeRow({
  item,
  selected,
  onSelect,
  onRestore,
}: {
  item: import('./paymentReview.js').DeclinedIncomeItem;
  selected?: boolean;
  onSelect?: (checked: boolean) => void;
  onRestore: () => void;
}) {
  return (
    <li
      className={`hub-list-row hub-list-row--declined${selected ? ' hub-list-row--selected' : ''}`}
    >
      {onSelect && (
        <label className="hub-list-row__checkbox" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected ?? false}
            aria-label={`Select declined income ${item.id}`}
            onChange={(e) => onSelect(e.target.checked)}
          />
        </label>
      )}
      <div className="hub-list-row__button hub-list-row__button--static">
        <div className="hub-list-row__line1">
          <span className="hub-list-row__identity">
            <AccountRef account={item} />
          </span>
          <span className="hub-list-row__amount tabular-nums">
            {formatTomanFromIrr(item.amountIrr)}
          </span>
        </div>
        <div className="hub-list-row__line2 muted">
          {item.bankTimestamp ? formatTime(item.bankTimestamp) : '—'}
          {item.reference && (
            <>
              {' '}
              · Ref: <IdentifierText value={item.reference} />
            </>
          )}
        </div>
        <div className="hub-list-row__line3 muted">
          Declined {formatTime(item.declinedAt)} · {item.declinedBy}
          {item.declineReason ? ` · ${item.declineReason}` : ''}
        </div>
      </div>
      <div className="hub-list-row__actions" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="primary hub-list-row__action" onClick={onRestore}>
          بازگردانی
        </button>
      </div>
    </li>
  );
}

export function ResellerStatsBar({
  stats,
}: {
  stats:
    | {
        payments: number;
        amountIrr: number;
        activeResellers: number;
        breakdown: Array<{ reseller_name: string; payments: number; amount_irr: number }>;
      }
    | undefined;
}) {
  if (!stats) return null;
  return (
    <div className="hub-context-metrics hub-context-metrics--reseller" aria-label="جمع نمایندگی">
      <span className="tabular-nums">
        <strong>{formatTomanFromIrr(stats.amountIrr)}</strong> فروش نمایندگی
      </span>
      <span className="hub-context-metrics__sep" aria-hidden>
        ·
      </span>
      <span>
        <strong>{stats.payments}</strong> پرداخت
      </span>
      <span className="hub-context-metrics__sep" aria-hidden>
        ·
      </span>
      <span>
        <strong>{stats.activeResellers}</strong> نمایندهٔ فعال
      </span>
      {stats.breakdown.length > 0 && (
        <ul className="hub-context-metrics__breakdown">
          {[...stats.breakdown]
            .sort((a, b) => b.amount_irr - a.amount_irr)
            .map((r) => (
              <li key={r.reseller_name} className="hub-context-metrics__breakdown-row">
                <span>{r.reseller_name}</span>
                <span className="tabular-nums">
                  {r.payments} · {formatTomanFromIrr(r.amount_irr)}
                </span>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

export function ResellerRow({
  item,
  isNew,
  onOpen,
}: {
  item: ResellerItem;
  isNew?: boolean;
  onOpen?: () => void;
}) {
  return (
    <li className={`hub-list-row hub-list-row--reseller${isNew ? ' hub-list-row--new' : ''}`}>
      <button
        type="button"
        className="hub-list-row__button"
        aria-label={`Reseller payment from ${item.resellerName}`}
        onClick={onOpen}
      >
        <div className="hub-list-row__line1">
          <span className="hub-list-row__identity">
            <NewBadge isNew={isNew} />
            <strong>{item.resellerName}</strong>
          </span>
          <span className="hub-list-row__amount tabular-nums">
            {formatTomanFromIrr(item.amountIrr)}
          </span>
        </div>
        <div className="hub-list-row__line2 muted">
          <AccountRef account={item} />
          {item.bankTimestamp && <> · {formatTime(item.bankTimestamp)}</>}
        </div>
        {(item.reference || item.note) && (
          <div className="hub-list-row__line3 muted">
            {item.reference && (
              <>
                Ref: <IdentifierText value={item.reference} />
              </>
            )}
            {item.reference && item.note && ' · '}
            {item.note}
          </div>
        )}
      </button>
    </li>
  );
}

export function MarkResellerModal({
  item,
  cache,
  onClose,
  onDone,
  onError,
}: {
  item: IncomeItem;
  cache: Cache;
  onClose: () => void;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const w = useWriteProps();
  const [resellers, setResellers] = useState<Array<{ id: string; name: string }>>([]);
  const [query, setQuery] = useState('');
  const [resellerId, setResellerId] = useState('');
  const [newName, setNewName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/resellers?q=${encodeURIComponent(query)}`)
      .then((r) => r.json())
      .then((j: { items: Array<{ id: string; name: string }> }) => {
        if (!cancelled) setResellers(j.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setResellers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  async function addReseller() {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const r = await fetch('/api/v1/resellers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const j = (await r.json()) as { ok: boolean; id?: string; error?: string };
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setResellerId(j.id!);
      setNewName('');
      setQuery('');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'create_failed');
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!resellerId) {
      onError('reseller_required');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/v1/transactions/${item.id}/classify-reseller`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resellerId, note: note.trim() || undefined }),
      });
      const j = (await r.json()) as { ok: boolean; error?: string };
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      cache.refetch();
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'classify_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-body">
        <h3>علامت‌زدن به‌عنوان نمایندگی</h3>
        <p>این تراکنش ورودی به‌عنوان پرداخت نمایندگی علامت زده شود؟</p>
        <p>
          +{formatTomanFromIrr(item.amountIrr)} · <AccountRef account={item} />
        </p>
        <p className="muted">ID {item.id}</p>
        <label>
          جست‌وجوی نماینده
          <input value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label>
          نمایندگی
          <select value={resellerId} onChange={(e) => setResellerId(e.target.value)}>
            <option value="">انتخاب…</option>
            {resellers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <div className="row toolbar">
          <input
            type="text"
            placeholder="نام نمایندهٔ جدید"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button type="button" disabled={busy} onClick={() => void addReseller()} {...w}>
            + افزودن نماینده
          </button>
        </div>
        <label>
          یادداشت (اختیاری)
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        </label>
        <div className="payment-review__actions">
          <button
            type="button"
            className="primary"
            disabled={busy || !resellerId}
            onClick={() => void submit()}
            {...w}
          >
            تایید
          </button>
          <button type="button" className="ghost" disabled={busy} onClick={onClose}>
            انصراف
          </button>
        </div>
      </div>
    </div>
  );
}

export function AssignToPaymentModal({
  transactionId,
  transactionAmountIrr,
  onClose,
  onError,
}: {
  transactionId: string;
  transactionAmountIrr: number | null;
  onClose: () => void;
  onError: (msg: string) => void;
}) {
  const w = useWriteProps();
  const [claims, setClaims] = useState<PaymentItem[]>([]);
  const [claimId, setClaimId] = useState('');
  const [search, setSearch] = useState('');
  const [reason, setReason] = useState('');
  const [verify, setVerify] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch('/api/v1/payments?tab=needs_review&range=all').then((r) => r.json()),
      fetch('/api/v1/payments?tab=suspected_fake&range=all').then((r) => r.json()),
      fetch('/api/v1/payments?tab=waiting&range=all').then((r) => r.json()),
    ])
      .then(([a, b, c]) => {
        const items = [
          ...((a as PaymentsResponseLite).items ?? []),
          ...((b as PaymentsResponseLite).items ?? []),
          ...((c as PaymentsResponseLite).items ?? []),
        ] as PaymentItem[];
        const byId = new Map<string, PaymentItem>();
        for (const item of items) byId.set(item.id, item);
        setClaims([...byId.values()]);
      })
      .catch(() => setClaims([]));
  }, []);

  const filteredClaims = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return claims;
    return claims.filter((c) => {
      const hay = [
        c.orderId,
        c.telegramUsername ?? '',
        c.telegramUserId ?? '',
        String(c.expectedAmountToman),
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [claims, search]);

  async function submit() {
    if (!claimId || !reason.trim()) {
      onError('claim_and_reason_required');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/v1/payment-claims/${claimId}/reassign-transaction`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          transactionId,
          reason: reason.trim(),
          verifyAfterAssign: verify,
        }),
      });
      const j = (await r.json()) as { ok: boolean; error?: string };
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'assign_failed');
    } finally {
      setBusy(false);
    }
  }

  const selected = useMemo(() => claims.find((c) => c.id === claimId), [claims, claimId]);
  const receivedToman = transactionAmountIrr != null ? Math.floor(transactionAmountIrr / 10) : null;
  const expectedToman = selected?.expectedAmountToman ?? null;
  const differenceToman =
    receivedToman != null && expectedToman != null ? receivedToman - expectedToman : null;
  const overpayment = differenceToman != null && differenceToman > 0;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-body">
        <h3>تخصیص به پرداخت</h3>
        <p className="muted">تراکنش {transactionId}</p>
        {receivedToman != null && (
          <p className="tabular-nums">دریافت‌شده: {formatToman(receivedToman)}</p>
        )}
        <label>
          جست‌وجوی پرداخت
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="نام کاربری، شناسهٔ کاربر، سفارش، مبلغ…"
          />
        </label>
        <label>
          ادعای پرداخت
          <select value={claimId} onChange={(e) => setClaimId(e.target.value)}>
            <option value="">پرداخت باز را انتخاب کن…</option>
            {filteredClaims.map((c) => (
              <option key={c.id} value={c.id}>
                {c.orderId} · {formatToman(c.expectedAmountToman)} · {c.reviewState}
                {c.telegramUsername ? ` · @${c.telegramUsername}` : ''}
              </option>
            ))}
          </select>
        </label>
        {selected && (
          <>
            <p className="muted">
              @{selected.telegramUsername ?? selected.telegramUserId} · سفارش {selected.orderId}
            </p>
            <dl className="payment-review__facts">
              <dt>مبلغ مورد انتظار</dt>
              <dd className="tabular-nums">{formatToman(expectedToman)}</dd>
              <dt>دریافت‌شده</dt>
              <dd className="tabular-nums">{formatToman(receivedToman)}</dd>
              {differenceToman != null && differenceToman !== 0 && (
                <>
                  <dt>اختلاف</dt>
                  <dd className={`tabular-nums${overpayment ? ' payment-warning' : ''}`}>
                    {differenceToman > 0 ? '+' : ''}
                    {formatToman(Math.abs(differenceToman))}
                  </dd>
                </>
              )}
            </dl>
            {overpayment && (
              <p className="payment-warning">مبلغ دریافتی از مبلغ مورد انتظار بیشتر است.</p>
            )}
          </>
        )}
        <label>
          دلیل (الزامی)
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} />
          تایید بعد از تخصیص
        </label>
        {overpayment && verify && (
          <p className="muted">
            تایید با مبلغ دقیق برای اضافه‌پرداخت شکست می‌خورد — بدون تایید تخصیص بده و بعد دستی
            تطبیق کن.
          </p>
        )}
        <div className="payment-review__actions">
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void submit()}
            {...w}
          >
            تخصیص
          </button>
          <button type="button" className="ghost" disabled={busy} onClick={onClose}>
            انصراف
          </button>
        </div>
      </div>
    </div>
  );
}

interface PaymentsResponseLite {
  items?: PaymentItem[];
}
