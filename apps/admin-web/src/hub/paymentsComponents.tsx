import type { ReactNode } from 'react';
import type { PaymentItem } from './paymentReview.js';
import { formatTomanFromIrr } from './format.js';
import { IdentifierText } from './IdentifierText.js';
import { NewBadge } from './NewBadge.js';
import { bankName, formatToman, deviceInlineLabel, type AccountRefLike } from './paymentReview.js';
import { formatTimeAgo } from './paymentReview.js';
import { formatExactDateTime } from './paymentReview.js';
import type { AnalyticsResponse } from './analytics.js';
import { formatPercentChange } from './analytics.js';
import type { Cache } from './query.js';
import type { HistoryRangeState } from './paymentReview.js';
import { IconBotVerified, IconReview } from './paymentsIcons.js';

/* ── Status badges ── */

export type StatusBadgeTone = 'review' | 'waiting' | 'suspected' | 'verified' | 'neutral' | 'bot' | 'match';

export function StatusBadge({ tone, children }: { tone: StatusBadgeTone; children: ReactNode }) {
  return <span className={`status-badge status-badge--${tone}`}>{children}</span>;
}

/** @deprecated Use StatusBadge */
export const StatusChip = StatusBadge;
export type StatusChipTone = StatusBadgeTone;

/* ── Empty state ── */

export function CompactEmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="compact-empty" role="status">
      <span className="compact-empty__mark" aria-hidden>
        ✓
      </span>
      {children}
    </p>
  );
}

/** @deprecated Use CompactEmptyState */
export const EmptyState = CompactEmptyState;

/* ── Metric cards ── */

export function MetricCard({
  label,
  value,
  meta,
  accent,
  icon,
}: {
  label: string;
  value: ReactNode;
  meta?: ReactNode;
  accent?: boolean;
  icon?: ReactNode;
}) {
  return (
    <article className={`metric-card${accent ? ' metric-card--accent' : ''}`}>
      {icon && <span className="metric-card__icon">{icon}</span>}
      <div className="metric-card__body">
        <span className="metric-card__label">{label}</span>
        <span className="metric-card__value tabular-nums">{value}</span>
        {meta != null && <span className="metric-card__meta muted">{meta}</span>}
      </div>
    </article>
  );
}

function formatDurationSeconds(total: number): string {
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function BotVerifiedMetrics({
  analytics,
  items,
}: {
  analytics: AnalyticsResponse | undefined;
  items: PaymentItem[];
}) {
  if (!analytics && items.length === 0) return null;

  const botCount = analytics?.botAutoVerified?.count ?? items.length;
  const manualCount = analytics?.manualVerified?.count ?? 0;
  const totalVerified = botCount + manualCount;
  const rate =
    totalVerified > 0 ? `${((botCount / totalVerified) * 100).toFixed(1)}%` : '—';

  const deltas = items
    .map((i) => i.matchedTransaction?.timeDeltaSeconds)
    .filter((d): d is number => d != null);
  const avgSeconds =
    deltas.length > 0 ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length) : null;
  const avgTime = avgSeconds != null ? formatDurationSeconds(avgSeconds) : '—';

  const uniqueCustomers = new Set(
    items.map((i) => i.telegramUserId ?? i.telegramUsername).filter(Boolean),
  ).size;

  const countMeta =
    analytics?.botAutoVerified?.amountIrr != null
      ? formatTomanFromIrr(analytics.botAutoVerified.amountIrr)
      : 'verified today';

  return (
    <div className="bot-metrics" aria-label="خلاصهٔ تایید خودکار ربات">
      <MetricCard
        label="کل تاییدشده‌های امروز"
        value={botCount}
        meta={countMeta}
        accent
        icon={<IconBotVerified />}
      />
      <MetricCard
        label="نرخ تایید"
        value={rate}
        meta="automation rate"
        icon={<IconReview />}
      />
      <MetricCard label="میانگین زمان تایید" value={avgTime} meta="claim to bank tx" />
      <MetricCard
        label="مشتریان یکتا"
        value={uniqueCustomers > 0 ? uniqueCustomers : '—'}
        meta="in current range"
      />
    </div>
  );
}

/* ── Transaction table ── */

function AccountRefCell({ account }: { account: AccountRefLike }) {
  const bank = bankName(account);
  if (!bank && !account.accountHint) return <span className="muted">نگاشت‌نشده</span>;
  return (
    <bdi className="account-ref">
      {bank && <span>{bank}</span>}
      {account.accountHint && <IdentifierText value={account.accountHint} tone="hint" />}
    </bdi>
  );
}

function maskCardHint(item: PaymentItem): string {
  if (item.cardMasked) {
    const digits = item.cardMasked.replace(/\D/g, '');
    if (digits.length >= 4) return `**** ${digits.slice(-4)}`;
  }
  if (item.accountHint) return `**** ${item.accountHint.replace(/\s/g, '')}`;
  return '—';
}

function customerCell(item: PaymentItem) {
  return (
    <div className="txn-row__customer">
      {item.telegramUsername && <strong>@{item.telegramUsername}</strong>}
      {item.telegramUserId && !item.telegramUsername && (
        <span>{item.telegramUserId}</span>
      )}
      {!item.telegramUsername && !item.telegramUserId && <span className="muted">—</span>}
    </div>
  );
}

function verifiedAtLabel(item: PaymentItem): string {
  const ts =
    item.matchedTransaction?.verifiedAt ?? item.matchedTransaction?.bankTimestamp ?? item.effectiveTs;
  if (ts == null) return '—';
  return formatTimeAgo(ts);
}

/** Exact YYYY-MM-DD HH:mm:ss in the user's local timezone (no relative time). */
function verifiedAtExactLabel(item: PaymentItem): string {
  const ts =
    item.matchedTransaction?.verifiedAt ?? item.matchedTransaction?.bankTimestamp ?? item.effectiveTs;
  return formatExactDateTime(ts);
}

function matchLabel(item: PaymentItem): ReactNode {
  if (item.matchedTransaction) {
    return <StatusBadge tone="match">تطبیق یکتا</StatusBadge>;
  }
  return '—';
}

export function TransactionTable({ children }: { children: ReactNode }) {
  return (
    <div className="txn-table-wrap">
      <table className="txn-table">
        <thead>
          <tr>
            <th scope="col">وضعیت</th>
            <th scope="col">تاییدشده</th>
            <th scope="col">مشتری</th>
            <th scope="col">شناسهٔ سفارش</th>
            <th scope="col">مبلغ</th>
            <th scope="col">حساب / کارت</th>
            <th scope="col">مرجع</th>
            <th scope="col">تطبیق</th>
            <th scope="col">زمان تایید</th>
            <th scope="col">
              <span className="sr-only">عملیات</span>
            </th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function BotVerifiedTransactionRow({
  item,
  isNew,
  onOpen,
}: {
  item: PaymentItem;
  isNew?: boolean;
  onOpen: () => void;
}) {
  const ref = item.matchedTransaction?.id ?? null;
  // Telegram ID is shown as a separate column immediately after Customer,
  // per task spec. Selectable text — no truncation, no tooltip masking.
  const telegramId = item.telegramUserId ?? null;

  return (
    <tr className={`txn-row${isNew ? ' txn-row--new' : ''}`}>
      <td>
        <StatusBadge tone="bot">BOT VERIFIED</StatusBadge>
      </td>
      <td>
        <span className="txn-row__verified-mark" aria-hidden>
          ✓
        </span>
        <NewBadge isNew={isNew} />
      </td>
      <td>{customerCell(item)}</td>
      <td className="txn-row__telegram-id">
        {telegramId ? (
          <span className="telegram-id-cell">{telegramId}</span>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>
        <IdentifierText value={item.orderId} />
      </td>
      <td className="tabular-nums txn-row__amount">{formatToman(item.expectedAmountToman)}</td>
      <td>
        <div className="txn-row__account-card">
          <AccountRefCell
            account={{
              accountBank: item.accountBank,
              accountHint: item.accountHint,
              accountDisplay: item.accountDisplay,
            }}
          />
          <span className="txn-row__card-hint muted">{maskCardHint(item)}</span>
          <span className="txn-row__device-hint muted">دستگاه: {deviceInlineLabel(item.device)}</span>
        </div>
      </td>
      <td>{ref ? <IdentifierText value={ref} tone="hint" /> : <span className="muted">—</span>}</td>
      <td>{matchLabel(item)}</td>
      <td className="tabular-nums muted txn-row__verified-at">
        <time dateTime={new Date(item.matchedTransaction?.verifiedAt ?? 0).toISOString()}>
          {verifiedAtExactLabel(item)}
        </time>
      </td>
      <td>
        <button
          type="button"
          className="ghost txn-row__menu"
          aria-label={`Actions for order ${item.orderId}`}
          onClick={onOpen}
        >
          ⋮
        </button>
      </td>
    </tr>
  );
}

/**
 * DEV-only table header for the Bot Auto Verified view.
 * Adds "شناسهٔ تلگرام" immediately after "مشتری".
 */
export function BotVerifiedTableHeader() {
  return (
    <thead>
      <tr>
        <th scope="col">وضعیت</th>
        <th scope="col">تاییدشده</th>
        <th scope="col">مشتری</th>
        <th scope="col">شناسهٔ تلگرام</th>
        <th scope="col">شناسهٔ سفارش</th>
        <th scope="col">مبلغ</th>
        <th scope="col">حساب / کارت</th>
        <th scope="col">مرجع</th>
        <th scope="col">تطبیق</th>
        <th scope="col">زمان تایید</th>
        <th scope="col">
          <span className="sr-only">عملیات</span>
        </th>
      </tr>
    </thead>
  );
}

export function BotVerifiedTable({ children }: { children: ReactNode }) {
  return (
    <div className="txn-table-wrap">
      <table className="txn-table txn-table--bot-auto-verified">
        <BotVerifiedTableHeader />
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/* ── Sidebar rails ── */

export function StatsRail({
  analytics,
}: {
  analytics: AnalyticsResponse | undefined;
  cache?: Cache;
  rangeState?: HistoryRangeState;
}) {
  if (!analytics) return null;

  const botCount = analytics.botAutoVerified.count;
  const manualCount = analytics.manualVerified.count;
  const totalVerified = botCount + manualCount;
  const autoRate = totalVerified > 0 ? `${((botCount / totalVerified) * 100).toFixed(1)}%` : '—';

  return (
    <aside className="stats-rail" aria-label="آمار زندهٔ تایید خودکار ربات">
      <section className="stats-rail__block stats-rail__block--live">
        <div className="stats-rail__heading">
          <h3 className="stats-rail__title">آمار زندهٔ تایید خودکار ربات</h3>
          <span className="stats-rail__live">
            <span className="stats-rail__live-dot" aria-hidden />
            زنده
          </span>
        </div>
        <dl className="stats-rail__grid">
          <div className="stats-rail__grid-row">
            <dt>تایید ربات</dt>
            <dd className="tabular-nums">
              {botCount}
              <span className="muted stats-rail__sub">{formatTomanFromIrr(analytics.botAutoVerified.amountIrr)}</span>
            </dd>
          </div>
          <div className="stats-rail__grid-row">
            <dt>تایید دستی</dt>
            <dd className="tabular-nums">
              {manualCount}
              <span className="muted stats-rail__sub">{formatTomanFromIrr(analytics.manualVerified.amountIrr)}</span>
            </dd>
          </div>
          <div className="stats-rail__grid-row">
            <dt>نرخ خودکارسازی</dt>
            <dd className="tabular-nums">{autoRate}</dd>
          </div>
          <div className="stats-rail__grid-row">
            <dt>فروش</dt>
            <dd className="tabular-nums">
              {formatTomanFromIrr(analytics.sales.amountIrr)}
              <span className="muted stats-rail__sub">
                {analytics.sales.count} · {formatPercentChange(analytics.sales.amountChange)}
              </span>
            </dd>
          </div>
          <div className="stats-rail__grid-row">
            <dt>ورودی بانکی</dt>
            <dd className="tabular-nums">{formatTomanFromIrr(analytics.bankInflowIrr)}</dd>
          </div>
          <div className="stats-rail__grid-row">
            <dt>موجودی معلوم</dt>
            <dd className="tabular-nums">
              {formatTomanFromIrr(analytics.balances.totalKnownIrr)}
              <span className="muted stats-rail__sub">
                {analytics.balances.knownAccounts}/{analytics.balances.totalActiveAccounts} accounts
              </span>
            </dd>
          </div>
        </dl>
      </section>
    </aside>
  );
}

function customerLabel(item: PaymentItem): string {
  if (item.telegramUsername) return `@${item.telegramUsername}`;
  if (item.telegramUserId) return item.telegramUserId;
  return '—';
}

export function RecentActivity({ items, onOpen }: { items: PaymentItem[]; onOpen: (id: string) => void }) {
  const recent = items.slice(0, 8);
  if (recent.length === 0) return null;

  return (
    <aside className="recent-activity" aria-label="فعالیت اخیر">
      <h3 className="recent-activity__title">فعالیت اخیر</h3>
      <ul className="recent-activity__list">
        {recent.map((item) => (
          <li key={item.id}>
            <button type="button" className="recent-activity__item" onClick={() => onOpen(item.id)}>
              <span className="recent-activity__check" aria-hidden>
                ✓
              </span>
              <span className="recent-activity__amount tabular-nums">
                {formatToman(item.expectedAmountToman)}
              </span>
              <span className="recent-activity__time muted">{verifiedAtLabel(item)}</span>
              <span className="recent-activity__customer">{customerLabel(item)}</span>
            </button>
          </li>
        ))}
      </ul>
      {items.length > recent.length && (
        <button type="button" className="ghost recent-activity__more">
          همهٔ فعالیت‌ها ←
        </button>
      )}
    </aside>
  );
}

export function PaymentTabReadAll({
  unread,
  busy,
  onClick,
}: {
  unread: number;
  busy?: boolean;
  onClick: () => void;
}) {
  if (unread <= 0) return null;
  return (
    <button
      type="button"
      className="ghost payment-table-header__action payment-tab-read-all"
      aria-label={`علامت‌زدن ${unread} مورد خوانده‌نشده به‌عنوان خوانده‌شده`}
      disabled={busy}
      onClick={onClick}
    >
      {busy ? 'Marking…' : 'خواندن همه'}
    </button>
  );
}

/** @deprecated Header moved to ShikoonetHeader shell */
export function PaymentsHeader(_props: { actions?: ReactNode }) {
  return null;
}
