import { useEffect, useMemo } from 'react';
import type { Cache } from './query.js';
import { useSeenTracker } from './query.js';
import { useSeenCache } from './useSeenCache.js';
import { QK } from './queries.js';
import {
  formatTomanFromIrr,
  formatTime,
  formatTimeSeconds,
  directionLabel,
  statusLabel,
} from './format.js';
import { count } from '../format.js';
import { IdentifierText } from './IdentifierText.js';
import { DeviceName } from './DeviceName.js';
import { AccountCell } from './AccountCell.js';
import { SortableHeader } from './SortableHeader.js';
import { useTableSortState } from './useTableSortState.js';
import { sortBy, type ColumnType } from './sort.js';
import { useMediaQuery } from './useMediaQuery.js';
import { NewBadge } from './NewBadge.js';
import type { TodayItem } from './api.js';

interface TodayViewProps {
  cache: Cache;
}

const COLUMNS = [
  { key: 'direction', label: 'نوع', type: 'text' as ColumnType },
  { key: 'amount_irr', label: 'مبلغ (تومان)', type: 'numeric' as ColumnType },
  { key: 'balance_irr', label: 'موجودی', type: 'numeric' as ColumnType },
  { key: 'account_display', label: 'حساب', type: 'text' as ColumnType },
  { key: 'account_hint', label: 'نشانهٔ حساب', type: 'identifier' as ColumnType },
  { key: 'device', label: 'دستگاه', type: 'text' as ColumnType },
  { key: 'sms_timestamp', label: 'زمان پیامک', type: 'date' as ColumnType },
  { key: 'received_at', label: 'دریافت سرور', type: 'date' as ColumnType },
  { key: 'parser_id', label: 'تحلیل‌گر', type: 'text' as ColumnType },
  { key: 'status', label: 'وضعیت', type: 'text' as ColumnType },
];

// Compact-desktop (1200–1439px) drops the standalone Device column and
// folds display_name + device_code into the Account cell.
const COMPACT_COLUMNS = [
  { key: 'direction', label: 'نوع', type: 'text' as ColumnType },
  { key: 'amount_irr', label: 'مبلغ', type: 'numeric' as ColumnType },
  { key: 'balance_irr', label: 'موجودی', type: 'numeric' as ColumnType },
  { key: 'account_display', label: 'حساب', type: 'text' as ColumnType },
  { key: 'sms_timestamp', label: 'زمان پیامک', type: 'date' as ColumnType },
  { key: 'received_at', label: 'دریافت سرور', type: 'date' as ColumnType },
  { key: 'status', label: 'وضعیت', type: 'text' as ColumnType },
];

// Sort accessor for the Device column: primary = display_name, fallback =
// device_code. Null when neither exists. Locale-aware text sort.
const deviceSortAccessor = (t: TodayItem): string | null =>
  t.device_display_name?.trim() || t.device_code?.trim() || null;

// Server says "new" AND the optimistic seen-cache hasn't dismissed it.
// The server is authoritative on every poll; the cache only shortens the
// wait between an action and the next refetch.
function isNewForToday(t: TodayItem, seenIds: Set<string>): boolean {
  if (seenIds.has(t.id)) return false;
  return t.is_new === true;
}

export function TodayView({ cache }: TodayViewProps) {
  const { data, status, error } = cache.useQuery<{
    ok: boolean;
    count: number;
    items: TodayItem[];
  }>(QK.today, {
    fetcher: async (signal) => {
      const r = await fetch('/api/v1/today', { signal });
      if (!r.ok) {
        if (r.status === 401 || r.status === 403) throw new Error('session_expired');
        throw new Error(`${r.status}`);
      }
      return r.json();
    },
  });

  const isMobile = useMediaQuery('(max-width: 639px)');
  const isCompact = useMediaQuery('(min-width: 1200px) and (max-width: 1439px)');
  const isWideDesktop = useMediaQuery('(min-width: 1440px)');
  const [sort, setSort] = useTableSortState('today', {
    column: 'received_at',
    direction: 'desc',
  });
  const items = data?.items ?? [];

  // Sort the polled list (poll data is the source of truth).
  const sortedItems = useMemo(() => {
    if (!sort.column) return items;
    const colDef = COLUMNS.find((c) => c.key === sort.column);
    const descriptor: { column: string; type: ColumnType; accessor?: (t: TodayItem) => unknown } = {
      column: sort.column,
      type: colDef?.type ?? 'text',
    };
    if (sort.column === 'device') descriptor.accessor = deviceSortAccessor;
    return sortBy(items, descriptor, sort.direction);
  }, [items, sort.column, sort.direction]);

  const ids = data?.items.map((i) => i.id);
  const { newIds, markSeen } = useSeenTracker('seen:today', ids);
  const seenCache = useSeenCache(cache);

  useEffect(() => {
    if (!newIds.length) return;
    const t = setTimeout(() => markSeen(), 4000);
    return () => clearTimeout(t);
  }, [newIds, markSeen]);

  if (status === 'loading' && !data) return <div className="muted">در حال بارگذاری…</div>;
  if (error && status === 'error' && !data) {
    return (
      <div className="error">
        بارگذاری تراکنش‌های امروز ناموفق بود.{' '}
        {'message' in (error as Error) ? (error as Error).message : ''}{' '}
        <button type="button" onClick={() => cache.refetch(QK.today)}>
          تلاش دوباره
        </button>
      </div>
    );
  }
  if (!data) return <div className="muted">هنوز داده‌ای نیست.</div>;

  return (
    <div className="today">
      <h2>
        تراکنش‌های امروز ({count(data.count)})
        {newIds.length > 0 && (
          <span className="new-banner" aria-live="polite">
            <strong>{count(newIds.length)}</strong> تراکنش تازه رسید
            <button type="button" onClick={() => markSeen()}>
              خواندم
            </button>
          </span>
        )}
      </h2>
      {items.length === 0 ? (
        <p className="empty">امروز تراکنشی نبوده.</p>
      ) : isMobile ? (
        <>
          <MobileSortControl
            tableKey="today"
            currentColumn={sort.column}
            currentDirection={sort.direction}
            options={[
              {
                value: 'received_at-desc',
                column: 'received_at',
                direction: 'desc',
                label: 'دریافت سرور: تازه‌ترین',
              },
              {
                value: 'received_at-asc',
                column: 'received_at',
                direction: 'asc',
                label: 'دریافت سرور: قدیمی‌ترین',
              },
              {
                value: 'sms_timestamp-desc',
                column: 'sms_timestamp',
                direction: 'desc',
                label: 'زمان پیامک: تازه‌ترین',
              },
              {
                value: 'sms_timestamp-asc',
                column: 'sms_timestamp',
                direction: 'asc',
                label: 'زمان پیامک: قدیمی‌ترین',
              },
              {
                value: 'amount_irr-desc',
                column: 'amount_irr',
                direction: 'desc',
                label: 'مبلغ: زیاد به کم',
              },
              {
                value: 'amount_irr-asc',
                column: 'amount_irr',
                direction: 'asc',
                label: 'مبلغ: کم به زیاد',
              },
              {
                value: 'device-asc',
                column: 'device',
                direction: 'asc',
                label: 'نام دستگاه: صعودی',
              },
              {
                value: 'device-desc',
                column: 'device',
                direction: 'desc',
                label: 'نام دستگاه: نزولی',
              },
              {
                value: 'account_display-asc',
                column: 'account_display',
                direction: 'asc',
                label: 'حساب: صعودی',
              },
            ]}
            onChange={(col, dir) => setSort({ column: col, direction: dir })}
          />
          <ul className="card-list" aria-label="تراکنش‌های امروز">
            {sortedItems.map((t) => (
              <TodayTxCard
                key={t.id}
                t={t}
                isNew={isNewForToday(t, seenCache.seenIds)}
                onSeen={seenCache.markSeen}
              />
            ))}
          </ul>
        </>
      ) : isCompact && !isWideDesktop ? (
        // Compact desktop (1200–1439px): 7-column table. Device is folded
        // into the Account cell so the row stays inside the viewport and
        // the user never has to open View Details to see the device.
        <div className="data-table-wrapper">
          <table className="data-table today-table--compact">
            <colgroup>
              <col style={{ width: '90px' }} />
              <col style={{ width: '120px' }} />
              <col style={{ width: '110px' }} />
              <col style={{ width: 'auto' }} />
              <col style={{ width: '150px' }} />
              <col style={{ width: '150px' }} />
              <col style={{ width: '110px' }} />
            </colgroup>
            <thead>
              <tr>
                {COMPACT_COLUMNS.map((c) => (
                  <SortableHeader
                    key={c.key}
                    column={c.key}
                    label={c.label}
                    state={sort}
                    onChange={setSort}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedItems.map((t) => {
                const isNew = isNewForToday(t, seenCache.seenIds);
                return (
                  <tr
                    key={t.id}
                    className={isNew ? 'transaction-row--new' : undefined}
                    onClick={() => {
                      if (isNew) seenCache.markSeen(t.id);
                    }}
                  >
                    <td>
                      {directionLabel(t.direction)} <NewBadge isNew={isNew} />
                    </td>
                    <td>{formatTomanFromIrr(t.amount_irr)}</td>
                    <td>{formatTomanFromIrr(t.balance_irr)}</td>
                    <td>
                      <AccountCell
                        accountDisplay={t.account_display}
                        deviceDisplayName={t.device_display_name}
                        deviceCode={t.device_code}
                      />
                    </td>
                    <td>
                      <span
                        className="table-ellipsis"
                        style={{ maxWidth: '150px' }}
                        title={t.sms_timestamp ? formatTime(t.sms_timestamp) : ''}
                      >
                        {t.sms_timestamp ? formatTimeSeconds(t.sms_timestamp) : '—'}
                      </span>
                    </td>
                    <td>
                      <span
                        className="table-ellipsis"
                        style={{ maxWidth: '150px' }}
                        title={t.received_at ? formatTime(t.received_at) : ''}
                      >
                        {t.received_at ? formatTimeSeconds(t.received_at) : '—'}
                      </span>
                    </td>
                    <td>{statusLabel(t.status)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <SortableHeader
                    key={c.key}
                    column={c.key}
                    label={c.label}
                    state={sort}
                    onChange={setSort}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedItems.map((t) => {
                const isNew = isNewForToday(t, seenCache.seenIds);
                return (
                  <tr
                    key={t.id}
                    className={isNew ? 'transaction-row--new' : undefined}
                    onClick={() => {
                      if (isNew) seenCache.markSeen(t.id);
                    }}
                  >
                    <td>{directionLabel(t.direction)}</td>
                    <td>
                      {formatTomanFromIrr(t.amount_irr)} <NewBadge isNew={isNew} />
                    </td>
                    <td>{formatTomanFromIrr(t.balance_irr)}</td>
                    <td>
                      {t.account_display ?? (
                        <span className="muted">{t.account_hint ? 'نگاشت‌نشده' : '—'}</span>
                      )}
                    </td>
                    <td>
                      <IdentifierText value={t.account_hint} />
                    </td>
                    <td>
                      <DeviceName displayName={t.device_display_name} deviceCode={t.device_code} />
                    </td>
                    <td>
                      <span
                        className="table-ellipsis"
                        style={{ maxWidth: '150px' }}
                        title={t.sms_timestamp ? formatTime(t.sms_timestamp) : ''}
                      >
                        {t.sms_timestamp ? formatTimeSeconds(t.sms_timestamp) : '—'}
                      </span>
                    </td>
                    <td>
                      <span
                        className="table-ellipsis"
                        style={{ maxWidth: '150px' }}
                        title={t.received_at ? formatTime(t.received_at) : ''}
                      >
                        {t.received_at ? formatTimeSeconds(t.received_at) : '—'}
                      </span>
                    </td>
                    <td>
                      <code className="parser-id">{t.parser_id ?? '—'}</code>
                    </td>
                    <td>{statusLabel(t.status)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TodayTxCard({
  t,
  isNew,
  onSeen,
}: {
  t: TodayItem;
  isNew: boolean;
  onSeen: (id: string) => void;
}) {
  return (
    <li
      key={t.id}
      className={`card tx-card${isNew ? ' transaction-row--new' : ''}`}
      onClick={() => {
        if (isNew) onSeen(t.id);
      }}
    >
      <div className="card-row card-row--top">
        <span className="amount">
          {directionLabel(t.direction)} {formatTomanFromIrr(t.amount_irr)}
        </span>
        <span className="card-row--top-right">
          <NewBadge isNew={isNew} />
          <span className="status-pill">{statusLabel(t.status)}</span>
        </span>
      </div>
      <div className="card-row">
        <span className="label">حساب</span>
        <span>
          {t.account_display ?? (
            <span className="muted">{t.account_hint ? 'نگاشت‌نشده' : 'اختصاص نیافته'}</span>
          )}
        </span>
      </div>
      {t.account_hint && !t.account_display && (
        <div className="card-row">
          <span className="label">شناسایی‌شده</span>
          <IdentifierText value={t.account_hint} />
        </div>
      )}
      <div className="card-row">
        <span className="label">بانک</span>
        <span>
          {t.account_bank ?? '—'} <code className="parser-id">{t.parser_id ?? '—'}</code>
        </span>
      </div>
      <div className="card-row">
        <span className="label">دریافت پیامک روی گوشی</span>
        <span>{t.sms_timestamp ? formatTimeSeconds(t.sms_timestamp) : '—'}</span>
      </div>
      <div className="card-row">
        <span className="label">دریافت توسط سرور</span>
        <span>{t.received_at ? formatTimeSeconds(t.received_at) : '—'}</span>
      </div>
      {t.bank_timestamp && (
        <div className="card-row">
          <span className="label">زمان تراکنش بانکی</span>
          <span>{formatTime(t.bank_timestamp)}</span>
        </div>
      )}
      <div className="card-row">
        <span className="label">دستگاه</span>
        <span>
          <DeviceName displayName={t.device_display_name} deviceCode={t.device_code} />
        </span>
      </div>
    </li>
  );
}

interface MobileSortOption {
  value: string;
  column: string;
  direction: 'asc' | 'desc';
  label: string;
}

function MobileSortControl({
  tableKey,
  currentColumn,
  currentDirection,
  options,
  onChange,
}: {
  tableKey: string;
  currentColumn: string | null;
  currentDirection: 'asc' | 'desc';
  options: MobileSortOption[];
  onChange: (column: string, direction: 'asc' | 'desc') => void;
}) {
  const value = currentColumn ? `${currentColumn}-${currentDirection}` : '';
  return (
    <div className="row toolbar sort-dropdown">
      <label htmlFor={`sort-${tableKey}`}>مرتب‌سازی:</label>
      <select
        id={`sort-${tableKey}`}
        value={value}
        onChange={(e) => {
          const opt = options.find((o) => o.value === e.target.value);
          if (opt) onChange(opt.column, opt.direction);
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
