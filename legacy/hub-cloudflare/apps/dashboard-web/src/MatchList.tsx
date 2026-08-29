import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type AccountListItem,
  type MatchListPayload,
  type ReviewedTransactionItem,
  type UnmatchedItem,
} from './api.js';
import type { Cache } from './query.js';
import { useSeenTracker } from './query.js';
import { useSeenCache } from './useSeenCache.js';
import { useMediaQuery } from './useMediaQuery.js';
import { forMutation, QK } from './queries.js';
import {
  formatTomanFromIrr,
  formatTime,
  formatTimeSeconds,
  directionLabel,
  statusLabel,
} from './format.js';
import { DetectedIdentifierList, IdentifierText } from './IdentifierText.js';
import { DeviceName } from './DeviceName.js';
import { AccountCell } from './AccountCell.js';
import { SortableHeader } from './SortableHeader.js';
import { useTableSortState } from './useTableSortState.js';
import { sortBy, type ColumnType } from './sort.js';
import { NewBadge } from './NewBadge.js';
import { MoreMenu } from './MoreMenu.js';

type Tab = 'suggested' | 'unmatched' | 'reviewed';

const SUGGESTED_COLUMNS = [
  { key: 'transaction.direction', label: 'Direction', type: 'text' as ColumnType },
  { key: 'transaction.amount_irr', label: 'Amount', type: 'numeric' as ColumnType },
  { key: 'account_display', label: 'Account', type: 'text' as ColumnType },
  { key: 'device', label: 'Device', type: 'text' as ColumnType },
  { key: 'transaction.sms_timestamp', label: 'SMS time', type: 'date' as ColumnType },
  { key: 'transaction.received_at', label: 'Server received', type: 'date' as ColumnType },
  { key: 'match.score', label: 'Score', type: 'numeric' as ColumnType },
  { key: 'match.status', label: 'Status', type: 'text' as ColumnType },
];
function suggestedAccessor(col: string) {
  return (r: MatchListPayload['items'][number]) => {
    switch (col) {
      case 'transaction.direction':
        return r.transaction.direction;
      case 'transaction.amount_irr':
        return r.transaction.amount_irr ?? null;
      case 'account_display':
        return r.account_display ?? '';
      case 'device':
        return r.device_display_name?.trim() || r.device_code?.trim() || null;
      case 'transaction.sms_timestamp':
        return r.transaction.sms_timestamp ?? null;
      case 'transaction.received_at':
        return r.transaction.received_at ?? null;
      case 'match.score':
        return r.match.score;
      case 'match.status':
        return r.match.status;
      default:
        return null;
    }
  };
}

const UNMATCHED_COMPACT_COLUMNS: { key: string; label: string; type: ColumnType }[] = [
  { key: 'sort_amount', label: 'Amount', type: 'numeric' },
  { key: 'account_display', label: 'Account', type: 'text' },
  { key: 'detected', label: 'Detected', type: 'identifier' },
  { key: 'sms_timestamp', label: 'SMS time', type: 'date' },
  { key: 'status', label: 'Status', type: 'text' },
];
const UNMATCHED_WIDE_COLUMNS = [
  { key: 'direction', label: 'Direction', type: 'text' as ColumnType },
  { key: 'amount_irr', label: 'Amount', type: 'numeric' as ColumnType },
  { key: 'balance_irr', label: 'Balance', type: 'numeric' as ColumnType },
  { key: 'account_display', label: 'Account', type: 'text' as ColumnType },
  { key: 'detected', label: 'Detected', type: 'identifier' as ColumnType },
  { key: 'device', label: 'Device', type: 'text' as ColumnType },
  { key: 'sms_timestamp', label: 'SMS time', type: 'date' as ColumnType },
  { key: 'received_at', label: 'Server received', type: 'date' as ColumnType },
  { key: 'parser_id', label: 'Parser', type: 'text' as ColumnType },
  { key: 'status', label: 'Status', type: 'text' as ColumnType },
];
function unmatchedAccessor(col: string) {
  return (t: UnmatchedItem) => {
    switch (col) {
      case 'sort_amount':
      case 'amount_irr':
        return t.amount_irr ?? null;
      case 'balance_irr':
        return t.balance_irr ?? null;
      case 'account_display':
        return t.account_display ?? '';
      case 'detected':
        return t.detected_identifiers?.[0]?.normalized_value ?? '';
      case 'time':
      case 'sms_timestamp':
        return t.sms_timestamp ?? null;
      case 'received_at':
        return t.received_at ?? null;
      case 'bank_timestamp':
        return t.bank_timestamp ?? null;
      case 'direction':
        return t.direction;
      case 'device':
        return t.device_display_name?.trim() || t.device_code?.trim() || null;
      case 'parser_id':
        return t.parser_id ?? '';
      case 'status':
        return t.status;
      default:
        return null;
    }
  };
}

const REVIEWED_MATCH_COLUMNS = [
  { key: 'transaction.direction', label: 'Direction', type: 'text' as ColumnType },
  { key: 'transaction.amount_irr', label: 'Amount', type: 'numeric' as ColumnType },
  { key: 'account_display', label: 'Account', type: 'text' as ColumnType },
  { key: 'device', label: 'Device', type: 'text' as ColumnType },
  { key: 'transaction.sms_timestamp', label: 'SMS time', type: 'date' as ColumnType },
  { key: 'transaction.received_at', label: 'Server received', type: 'date' as ColumnType },
  { key: 'match.reviewed_at', label: 'Reviewed', type: 'date' as ColumnType },
  { key: 'match.status', label: 'Status', type: 'text' as ColumnType },
  { key: 'match.score', label: 'Score', type: 'numeric' as ColumnType },
];

const REVIEWED_TX_COLUMNS = [
  { key: 'decision', label: 'Decision', type: 'text' as ColumnType },
  { key: 'amount_irr', label: 'Amount', type: 'numeric' as ColumnType },
  { key: 'account_display', label: 'Account', type: 'text' as ColumnType },
  { key: 'device', label: 'Device', type: 'text' as ColumnType },
  { key: 'review.reason', label: 'Reason', type: 'text' as ColumnType },
  { key: 'review.reviewed_by', label: 'Reviewed by', type: 'text' as ColumnType },
  { key: 'sms_timestamp', label: 'SMS time', type: 'date' as ColumnType },
  { key: 'received_at', label: 'Server received', type: 'date' as ColumnType },
  { key: 'review.reviewed_at', label: 'Reviewed at', type: 'date' as ColumnType },
];

function reviewedMatchAccessor(col: string) {
  return (r: MatchListPayload['items'][number]) => {
    switch (col) {
      case 'transaction.direction':
        return r.transaction.direction;
      case 'transaction.amount_irr':
        return r.transaction.amount_irr ?? null;
      case 'account_display':
        return r.account_display ?? '';
      case 'device':
        return r.device_display_name?.trim() || r.device_code?.trim() || null;
      case 'transaction.sms_timestamp':
        return r.transaction.sms_timestamp ?? null;
      case 'transaction.received_at':
        return r.transaction.received_at ?? null;
      case 'match.reviewed_at':
        return r.match.reviewed_at ?? null;
      case 'match.status':
        return r.match.status;
      case 'match.score':
        return r.match.score;
      default:
        return null;
    }
  };
}

function reviewedTxAccessor(col: string) {
  return (r: ReviewedTransactionItem) => {
    switch (col) {
      case 'decision':
        return r.review.decision;
      case 'amount_irr':
        return r.amount_irr ?? null;
      case 'account_display':
        return r.account_display ?? '';
      case 'device':
        return r.device_display_name?.trim() || r.device_code?.trim() || null;
      case 'review.reason':
        return r.review.reason ?? r.review.comment ?? '';
      case 'review.reviewed_by':
        return r.review.reviewed_by;
      case 'sms_timestamp':
        return r.sms_timestamp ?? null;
      case 'received_at':
        return r.received_at ?? null;
      case 'review.reviewed_at':
        return r.review.reviewed_at;
      default:
        return null;
    }
  };
}

const REJECT_REASONS = [
  'FAKE_RECEIPT',
  'NO_BANK_TRANSACTION',
  'DUPLICATE',
  'WRONG_AMOUNT',
  'WRONG_ACCOUNT',
  'EXPIRED',
  'REFUNDED',
  'TEST_PAYMENT',
  'OTHER',
];

const TX_REJECT_REASONS = ['false_parse', 'duplicate', 'irrelevant', 'wrong_amount', 'other'];

interface Props {
  cache: Cache;
  selected: string | null;
  onSelect: (id: string | null) => void;
}

export function MatchesView({ cache, selected, onSelect }: Props) {
  // Tab is local to the view so resizing doesn't blow away the user's place.
  const [tab, setTab] = useState<Tab>('unmatched');

  const suggestedQ = cache.useQuery<MatchListPayload>(QK.suggested, {
    fetcher: async (signal) => {
      const r = await fetch('/api/v1/matches/suggested', { signal });
      if (!r.ok) {
        if (r.status === 401 || r.status === 403) throw new Error('session_expired');
        throw new Error(`${r.status}`);
      }
      return r.json();
    },
  });

  const unmatchedQ = cache.useQuery<{ ok: boolean; items: UnmatchedItem[] }>(QK.unmatched, {
    fetcher: async (signal) => {
      const r = await fetch('/api/v1/matches/unmatched', { signal });
      if (!r.ok) {
        if (r.status === 401 || r.status === 403) throw new Error('session_expired');
        throw new Error(`${r.status}`);
      }
      return r.json();
    },
  });

  const reviewedMatchesQ = cache.useQuery<MatchListPayload>(QK.reviewedMatches, {
    fetcher: async (signal) => {
      const r = await fetch('/api/v1/matches/reviewed', { signal });
      if (!r.ok) {
        if (r.status === 401 || r.status === 403) throw new Error('session_expired');
        throw new Error(`${r.status}`);
      }
      return r.json();
    },
  });

  const reviewedTxQ = cache.useQuery<{ ok: boolean; items: ReviewedTransactionItem[] }>(
    QK.reviewedTransactions,
    {
      fetcher: async (signal) => {
        const r = await fetch('/api/v1/matches/reviewed/transactions', { signal });
        if (!r.ok) {
          if (r.status === 401 || r.status === 403) throw new Error('session_expired');
          throw new Error(`${r.status}`);
        }
        return r.json();
      },
    },
  );

  const tabItems: { value: Tab; label: string; count: number }[] = [
    { value: 'suggested', label: 'Suggested', count: suggestedQ.data?.items.length ?? 0 },
    { value: 'unmatched', label: 'Unmatched', count: unmatchedQ.data?.items.length ?? 0 },
    {
      value: 'reviewed',
      label: 'Reviewed',
      count: (reviewedMatchesQ.data?.items.length ?? 0) + (reviewedTxQ.data?.items.length ?? 0),
    },
  ];

  const scrollRef = useRef<HTMLDivElement>(null);
  const lastScrollTop = useRef(0);
  // Save scroll position on every refetch; restore after the new render.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      lastScrollTop.current = el.scrollTop;
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [tab]);
  // After each cache tick, re-apply the saved scroll position so the
  // user doesn't get yanked back to the top after a refetch.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el && lastScrollTop.current > 0) el.scrollTop = lastScrollTop.current;
    });
    return () => cancelAnimationFrame(id);
  }, [suggestedQ.data, unmatchedQ.data, reviewedMatchesQ.data, reviewedTxQ.data]);

  const sessionExpired = [suggestedQ, unmatchedQ, reviewedMatchesQ, reviewedTxQ].some(
    (q) => q.error instanceof Error && q.error.message === 'session_expired',
  );

  return (
    <section className="matches-section">
      <div className="tabs-scroll" role="tablist" aria-label="Match tabs">
        <div className="tabs tabs--scroll">
          {tabItems.map((it) => (
            <button
              key={it.value}
              type="button"
              role="tab"
              aria-selected={tab === it.value}
              className={tab === it.value ? 'tab active' : 'tab'}
              onClick={() => setTab(it.value)}
            >
              {it.label} ({it.count})
            </button>
          ))}
        </div>
      </div>

      {sessionExpired && (
        <div className="error">
          Session expired.{' '}
          <a href="https://samsalpak.cloudflareaccess.com" rel="noreferrer">
            Sign in again
          </a>
        </div>
      )}

      <div ref={scrollRef} className="match-list-scroll">
        {tab === 'suggested' && (
          <SuggestedList
            items={suggestedQ.data?.items ?? []}
            loading={suggestedQ.status === 'loading' && !suggestedQ.data}
            cache={cache}
            selected={selected}
            onSelect={onSelect}
          />
        )}
        {tab === 'unmatched' && (
          <UnmatchedList
            items={unmatchedQ.data?.items ?? []}
            loading={unmatchedQ.status === 'loading' && !unmatchedQ.data}
            cache={cache}
          />
        )}
        {tab === 'reviewed' && (
          <ReviewedList
            items={reviewedMatchesQ.data?.items ?? []}
            reviewedTransactions={reviewedTxQ.data?.items ?? []}
            reviewedMatchesLoading={reviewedMatchesQ.status === 'loading' && !reviewedMatchesQ.data}
            reviewedTxLoading={reviewedTxQ.status === 'loading' && !reviewedTxQ.data}
            cache={cache}
          />
        )}
      </div>
    </section>
  );
}

function SuggestedList({
  items,
  loading,
  cache,
  selected,
  onSelect,
}: {
  items: MatchListPayload['items'];
  loading: boolean;
  cache: Cache;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const isMobile = useMediaQuery('(max-width: 639px)');
  const isCompact = useMediaQuery('(min-width: 1200px) and (max-width: 1439px)');
  const isWideDesktop = useMediaQuery('(min-width: 1440px)');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useTableSortState('matches.suggested', {
    column: 'match.score',
    direction: 'desc',
  });
  const seenCache = useSeenCache(cache);
  const sortedItems = useMemo(
    () =>
      sortBy(
        items,
        sort.column
          ? {
              column: sort.column,
              type: SUGGESTED_COLUMNS.find((c) => c.key === sort.column)?.type ?? 'text',
              accessor: suggestedAccessor(sort.column),
            }
          : null,
        sort.direction,
      ),
    [items, sort.column, sort.direction],
  );

  function reportError(e: unknown) {
    setError(String(e));
  }

  async function approve(matchId: string, transactionCandidateId: string) {
    setBusy(matchId);
    setError(null);
    try {
      await api.approve(transactionCandidateId, matchId);
      cache.invalidate(...forMutation('approveMatch'));
      void seenCache.markSeen(transactionCandidateId);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(null);
    }
  }

  async function reject(matchId: string, transactionCandidateId: string) {
    const reason = window.prompt(`Reject reason (one of: ${REJECT_REASONS.join(', ')})`);
    if (!reason || !REJECT_REASONS.includes(reason)) return;
    setBusy(matchId);
    setError(null);
    try {
      await api.reject(matchId, reason);
      cache.invalidate(...forMutation('rejectMatch'));
      void seenCache.markSeen(transactionCandidateId);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <p className="muted">Loading…</p>;
  if (items.length === 0)
    return (
      <p className="empty">No suggestions. Add a payment claim or wait for a new transaction.</p>
    );
  if (isMobile) {
    return (
      <>
        {error && <div className="error-inline">{error}</div>}
        <MobileSortControl
          tableKey="matches.suggested"
          currentColumn={sort.column}
          currentDirection={sort.direction}
          options={[
            {
              value: 'match.score-desc',
              column: 'match.score',
              direction: 'desc',
              label: 'Best score',
            },
            {
              value: 'transaction.amount_irr-desc',
              column: 'transaction.amount_irr',
              direction: 'desc',
              label: 'Amount: high to low',
            },
            {
              value: 'transaction.amount_irr-asc',
              column: 'transaction.amount_irr',
              direction: 'asc',
              label: 'Amount: low to high',
            },
            {
              value: 'transaction.sms_timestamp-desc',
              column: 'transaction.sms_timestamp',
              direction: 'desc',
              label: 'SMS time: newest',
            },
            {
              value: 'transaction.sms_timestamp-asc',
              column: 'transaction.sms_timestamp',
              direction: 'asc',
              label: 'SMS time: oldest',
            },
            {
              value: 'transaction.received_at-desc',
              column: 'transaction.received_at',
              direction: 'desc',
              label: 'Server received: newest',
            },
            {
              value: 'transaction.received_at-asc',
              column: 'transaction.received_at',
              direction: 'asc',
              label: 'Server received: oldest',
            },
            {
              value: 'account_display-asc',
              column: 'account_display',
              direction: 'asc',
              label: 'Account (A→Z)',
            },
            {
              value: 'device-asc',
              column: 'device',
              direction: 'asc',
              label: 'Device name: A–Z',
            },
            {
              value: 'device-desc',
              column: 'device',
              direction: 'desc',
              label: 'Device name: Z–A',
            },
            {
              value: 'match.status-asc',
              column: 'match.status',
              direction: 'asc',
              label: 'Status',
            },
          ]}
          onChange={(col, dir) => setSort({ column: col, direction: dir })}
        />
        <ul className="card-list" aria-label="Suggested matches">
          {sortedItems.map((row) => {
            const isNew =
              row.transaction.is_new === true && !seenCache.seenIds.has(row.transaction.id);
            return (
              <li
                key={row.match.id}
                className={[
                  'card',
                  'match-card',
                  isNew ? 'transaction-row--new' : null,
                  selected === row.match.id ? 'selected' : null,
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => {
                  if (isNew) void seenCache.markSeen(row.transaction.id);
                  onSelect(row.match.id);
                }}
              >
                <div className="card-row card-row--top">
                  <span className="amount">
                    {directionLabel(row.transaction.direction)}{' '}
                    {formatTomanFromIrr(row.transaction.amount_irr)}
                  </span>
                  <span className="card-row--top-right">
                    <NewBadge isNew={isNew} />
                    <span className="status-pill">{statusLabel(row.match.status)}</span>
                  </span>
                </div>
                <div className="card-row">
                  <span className="label">Account</span>
                  <span>{row.account_display ?? '—'}</span>
                </div>
                <div className="card-row">
                  <span className="label">Score</span>
                  <span>{row.match.score.toFixed(2)}</span>
                </div>
                <div className="card-row">
                  <span className="label">SMS received on phone</span>
                  <span>
                    {row.transaction.sms_timestamp
                      ? formatTimeSeconds(row.transaction.sms_timestamp)
                      : '—'}
                  </span>
                </div>
                <div className="card-row">
                  <span className="label">Received by server</span>
                  <span>
                    {row.transaction.received_at
                      ? formatTimeSeconds(row.transaction.received_at)
                      : '—'}
                  </span>
                </div>
                {row.transaction.bank_timestamp && (
                  <div className="card-row">
                    <span className="label">Bank transaction time</span>
                    <span>{formatTime(row.transaction.bank_timestamp)}</span>
                  </div>
                )}
                <div className="card-row">
                  <span className="label">Received by device</span>
                  <span>
                    <DeviceName
                      displayName={row.device_display_name}
                      deviceCode={row.device_code}
                    />
                  </span>
                </div>
                <div className="card-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy === row.match.id || row.match.status !== 'SUGGESTED'}
                    onClick={() => approve(row.match.id, row.transaction.id)}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy === row.match.id || row.match.status === 'CONFIRMED'}
                    onClick={() => reject(row.match.id, row.transaction.id)}
                  >
                    Reject
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </>
    );
  }
  if (isCompact && !isWideDesktop) {
    // Compact desktop (1200–1439px): 8-column table. Device is folded into
    // the Account cell so the device stays visible inline without forcing
    // the user to open View Details.
    return (
      <>
        {error && <div className="error-inline">{error}</div>}
        <div className="data-table-wrapper">
          <table className="data-table suggested-table--compact">
            <colgroup>
              <col style={{ width: '90px' }} />
              <col style={{ width: '120px' }} />
              <col style={{ width: '220px' }} />
              <col style={{ width: '150px' }} />
              <col style={{ width: '150px' }} />
              <col style={{ width: '80px' }} />
              <col style={{ width: '90px' }} />
              <col style={{ width: '220px' }} />
            </colgroup>
            <thead>
              <tr>
                <th>Direction</th>
                <th>Amount</th>
                <th>Account</th>
                <th>SMS time</th>
                <th>Server received</th>
                <th>Score</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedItems.map((row) => {
                const isNew =
                  row.transaction.is_new === true && !seenCache.seenIds.has(row.transaction.id);
                return (
                  <tr
                    key={row.match.id}
                    className={[
                      'match-row',
                      isNew ? 'transaction-row--new' : null,
                      selected === row.match.id ? 'selected' : null,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => {
                      if (isNew) void seenCache.markSeen(row.transaction.id);
                      onSelect(row.match.id);
                    }}
                  >
                    <td>
                      {directionLabel(row.transaction.direction)} <NewBadge isNew={isNew} />
                    </td>
                    <td>
                      <strong>{formatTomanFromIrr(row.transaction.amount_irr)}</strong>
                    </td>
                    <td>
                      <AccountCell
                        accountDisplay={row.account_display}
                        deviceDisplayName={row.device_display_name}
                        deviceCode={row.device_code}
                      />
                    </td>
                    <td>
                      <span
                        className="table-ellipsis"
                        style={{ maxWidth: '150px' }}
                        title={
                          row.transaction.sms_timestamp
                            ? formatTime(row.transaction.sms_timestamp)
                            : ''
                        }
                      >
                        {row.transaction.sms_timestamp
                          ? formatTimeSeconds(row.transaction.sms_timestamp)
                          : '—'}
                      </span>
                    </td>
                    <td>
                      <span
                        className="table-ellipsis"
                        style={{ maxWidth: '150px' }}
                        title={
                          row.transaction.received_at ? formatTime(row.transaction.received_at) : ''
                        }
                      >
                        {row.transaction.received_at
                          ? formatTimeSeconds(row.transaction.received_at)
                          : '—'}
                      </span>
                    </td>
                    <td>{row.match.score.toFixed(2)}</td>
                    <td>{statusLabel(row.match.status)}</td>
                    <td className="actions-cell" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className="primary"
                        disabled={busy === row.match.id || row.match.status !== 'SUGGESTED'}
                        onClick={() => approve(row.match.id, row.transaction.id)}
                      >
                        Approve
                      </button>
                      <MoreMenu
                        ariaLabel={`More actions for transaction ${row.transaction.id}`}
                        actions={[
                          {
                            key: 'reject',
                            label: 'Reject',
                            danger: true,
                            disabled: busy === row.match.id || row.match.status === 'CONFIRMED',
                            onSelect: () => reject(row.match.id, row.transaction.id),
                          },
                        ]}
                        onOpen={() => {
                          if (
                            row.transaction.is_new &&
                            !seenCache.seenIds.has(row.transaction.id)
                          ) {
                            void seenCache.markSeen(row.transaction.id);
                          }
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </>
    );
  }
  return (
    <>
      {error && <div className="error-inline">{error}</div>}
      <div className="data-table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              {SUGGESTED_COLUMNS.map((c) => (
                <SortableHeader
                  key={c.key}
                  column={c.key}
                  label={c.label}
                  state={sort}
                  onChange={setSort}
                />
              ))}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedItems.map((row) => {
              const isNew =
                row.transaction.is_new === true && !seenCache.seenIds.has(row.transaction.id);
              return (
                <tr
                  key={row.match.id}
                  className={[
                    'match-row',
                    isNew ? 'transaction-row--new' : null,
                    selected === row.match.id ? 'selected' : null,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => {
                    if (isNew) void seenCache.markSeen(row.transaction.id);
                    onSelect(row.match.id);
                  }}
                >
                  <td>
                    {directionLabel(row.transaction.direction)} <NewBadge isNew={isNew} />
                  </td>
                  <td>
                    <strong>{formatTomanFromIrr(row.transaction.amount_irr)}</strong>
                  </td>
                  <td>{row.account_display ?? '—'}</td>
                  <td>
                    <DeviceName
                      displayName={row.device_display_name}
                      deviceCode={row.device_code}
                    />
                  </td>
                  <td>
                    <span
                      className="table-ellipsis"
                      style={{ maxWidth: '150px' }}
                      title={
                        row.transaction.sms_timestamp
                          ? formatTime(row.transaction.sms_timestamp)
                          : ''
                      }
                    >
                      {row.transaction.sms_timestamp
                        ? formatTimeSeconds(row.transaction.sms_timestamp)
                        : '—'}
                    </span>
                  </td>
                  <td>
                    <span
                      className="table-ellipsis"
                      style={{ maxWidth: '150px' }}
                      title={
                        row.transaction.received_at ? formatTime(row.transaction.received_at) : ''
                      }
                    >
                      {row.transaction.received_at
                        ? formatTimeSeconds(row.transaction.received_at)
                        : '—'}
                    </span>
                  </td>
                  <td>{row.match.score.toFixed(2)}</td>
                  <td>{statusLabel(row.match.status)}</td>
                  <td className="actions-cell" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="primary"
                      disabled={busy === row.match.id || row.match.status !== 'SUGGESTED'}
                      onClick={() => approve(row.match.id, row.transaction.id)}
                    >
                      Approve
                    </button>
                    <MoreMenu
                      ariaLabel={`More actions for transaction ${row.transaction.id}`}
                      actions={[
                        {
                          key: 'reject',
                          label: 'Reject',
                          danger: true,
                          disabled: busy === row.match.id || row.match.status === 'CONFIRMED',
                          onSelect: () => reject(row.match.id, row.transaction.id),
                        },
                      ]}
                      onOpen={() => {
                        if (row.transaction.is_new && !seenCache.seenIds.has(row.transaction.id)) {
                          void seenCache.markSeen(row.transaction.id);
                        }
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
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
  options: { value: string; column: string; direction: 'asc' | 'desc'; label: string }[];
  onChange: (column: string, direction: 'asc' | 'desc') => void;
}) {
  const value = currentColumn ? `${currentColumn}-${currentDirection}` : '';
  return (
    <div className="row toolbar sort-dropdown">
      <label htmlFor={`sort-${tableKey}`}>Sort by:</label>
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

function UnmatchedList({
  items,
  loading,
  cache,
}: {
  items: UnmatchedItem[];
  loading: boolean;
  cache: Cache;
}) {
  const isMobile = useMediaQuery('(max-width: 639px)');
  // Compact-desktop shows a 6-column table; wide-desktop shows the full
  // 11-column table. Both share the same JSX shape but the compact path
  // hides the secondary fields (balance, device, parser, reasons) and
  // exposes them through a View-details modal.
  const isCompact = useMediaQuery('(min-width: 1200px) and (max-width: 1439px)');
  const isWideDesktop = useMediaQuery('(min-width: 1440px)');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorByTx, setErrorByTx] = useState<Record<string, string>>({});
  const [assignFor, setAssignFor] = useState<UnmatchedItem | null>(null);
  const [createFor, setCreateFor] = useState<UnmatchedItem | null>(null);
  const [detailsFor, setDetailsFor] = useState<UnmatchedItem | null>(null);
  const [sort, setSort] = useTableSortState('matches.unmatched', {
    column: 'sms_timestamp',
    direction: 'desc',
  });
  const sortedItems = useMemo(
    () =>
      sortBy(
        items,
        sort.column
          ? {
              column: sort.column,
              type:
                UNMATCHED_WIDE_COLUMNS.find((c) => c.key === sort.column)?.type ??
                UNMATCHED_COMPACT_COLUMNS.find((c) => c.key === sort.column)?.type ??
                'text',
              accessor: unmatchedAccessor(sort.column),
            }
          : null,
        sort.direction,
      ),
    [items, sort.column, sort.direction],
  );

  const accountsQ = cache.useQuery<{ ok: boolean; items: AccountListItem[] }>(QK.accounts, {
    fetcher: async (signal) => {
      const r = await fetch('/api/v1/accounts', { signal });
      if (!r.ok) {
        if (r.status === 401 || r.status === 403) throw new Error('session_expired');
        throw new Error(`${r.status}`);
      }
      return r.json();
    },
  });

  const ids = items.map((i) => i.id);
  const { newIds, markSeen } = useSeenTracker('seen:unmatched', ids);
  const seenCache = useSeenCache(cache);
  useEffect(() => {
    if (!newIds.length) return;
    const t = setTimeout(markSeen, 4000);
    return () => clearTimeout(t);
  }, [newIds, markSeen]);

  const accounts = useMemo(
    () => (accountsQ.data?.items ?? []).filter((a) => a.active === 1),
    [accountsQ.data],
  );

  function reportError(txId: string, e: unknown) {
    const msg = String(e);
    setErrorByTx((m) => ({ ...m, [txId]: msg }));
  }

  async function accept(t: UnmatchedItem) {
    setBusyId(t.id);
    try {
      await api.acceptTransaction(t.id);
      cache.invalidate(...forMutation('accept'));
      void seenCache.markSeen(t.id);
    } catch (e) {
      reportError(t.id, e);
    } finally {
      setBusyId(null);
    }
  }

  async function reject(t: UnmatchedItem) {
    const reason = window.prompt(`Reject reason (one of: ${TX_REJECT_REASONS.join(', ')})`) ?? '';
    if (!TX_REJECT_REASONS.includes(reason)) return;
    const comment = window.prompt('Optional comment') ?? undefined;
    setBusyId(t.id);
    try {
      const body: { reason: string; comment?: string } = { reason };
      if (comment) body.comment = comment;
      await api.rejectTransaction(t.id, body);
      cache.invalidate(...forMutation('reject'));
      void seenCache.markSeen(t.id);
    } catch (e) {
      reportError(t.id, e);
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <p className="muted">Loading…</p>;
  if (items.length === 0)
    return (
      <p className="empty">
        No unmatched incoming transactions. Every transaction has at least one match candidate or
        been reviewed.
      </p>
    );

  return (
    <>
      {newIds.length > 0 && (
        <div className="new-banner" aria-live="polite">
          <strong>{newIds.length}</strong> new transaction{newIds.length > 1 ? 's' : ''} received{' '}
          since you opened this page.{' '}
          <button type="button" onClick={() => markSeen()}>
            Mark seen
          </button>
        </div>
      )}
      {isMobile || (!isCompact && !isWideDesktop) ? (
        // Mobile + tablet (640–1199px): card list.
        <>
          <MobileSortControl
            tableKey="matches.unmatched"
            currentColumn={sort.column}
            currentDirection={sort.direction}
            options={[
              {
                value: 'sms_timestamp-desc',
                column: 'sms_timestamp',
                direction: 'desc',
                label: 'SMS time: newest',
              },
              {
                value: 'sms_timestamp-asc',
                column: 'sms_timestamp',
                direction: 'asc',
                label: 'SMS time: oldest',
              },
              {
                value: 'received_at-desc',
                column: 'received_at',
                direction: 'desc',
                label: 'Server received: newest',
              },
              {
                value: 'received_at-asc',
                column: 'received_at',
                direction: 'asc',
                label: 'Server received: oldest',
              },
              {
                value: 'amount_irr-asc',
                column: 'amount_irr',
                direction: 'asc',
                label: 'Amount: low to high',
              },
              {
                value: 'amount_irr-desc',
                column: 'amount_irr',
                direction: 'desc',
                label: 'Amount: high to low',
              },
              {
                value: 'account_display-asc',
                column: 'account_display',
                direction: 'asc',
                label: 'Account (A→Z)',
              },
              {
                value: 'device-asc',
                column: 'device',
                direction: 'asc',
                label: 'Device name: A–Z',
              },
              {
                value: 'device-desc',
                column: 'device',
                direction: 'desc',
                label: 'Device name: Z–A',
              },
              { value: 'status-asc', column: 'status', direction: 'asc', label: 'Status' },
            ]}
            onChange={(col, dir) => setSort({ column: col, direction: dir })}
          />
          <ul className="card-list" aria-label="Unmatched incoming transactions">
            {sortedItems.map((t) => {
              const detected = t.detected_identifiers ?? [];
              const hasAccount = !!t.financial_account_id;
              const isNew = t.is_new === true && !seenCache.seenIds.has(t.id);
              return (
                <li
                  key={t.id}
                  className={`card tx-card${isNew ? ' transaction-row--new' : ''}`}
                  onClick={() => {
                    if (isNew) void seenCache.markSeen(t.id);
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
                    <span className="label">Account</span>
                    <span>{t.account_display ?? <span className="muted">Not assigned</span>}</span>
                  </div>
                  <div className="card-row">
                    <span className="label">Detected account</span>
                    <span>
                      {detected.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        <span className="detected-stack">
                          <IdentifierText
                            value={detected[0]!.normalized_value}
                            label={detected[0]!.type}
                          />
                          {detected.length > 1 && (
                            <small className="muted"> +{detected.length - 1} more</small>
                          )}
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="card-row">
                    <span className="label">Bank</span>
                    <span>
                      {t.account_bank ?? '—'}{' '}
                      <code className="parser-id">{t.parser_id ?? '—'}</code>
                    </span>
                  </div>
                  <div className="card-row">
                    <span className="label">SMS received on phone</span>
                    <span>{t.sms_timestamp ? formatTimeSeconds(t.sms_timestamp) : '—'}</span>
                  </div>
                  <div className="card-row">
                    <span className="label">Received by server</span>
                    <span>{t.received_at ? formatTimeSeconds(t.received_at) : '—'}</span>
                  </div>
                  {t.bank_timestamp && (
                    <div className="card-row">
                      <span className="label">Bank transaction time</span>
                      <span>{formatTime(t.bank_timestamp)}</span>
                    </div>
                  )}
                  <div className="card-row">
                    <span className="label">Received by device</span>
                    <span>
                      <DeviceName displayName={t.device_display_name} deviceCode={t.device_code} />
                    </span>
                  </div>
                  {t.reason_no_match.length > 0 && (
                    <div className="card-row">
                      <span className="label">Why</span>
                      <span className="muted">{t.reason_no_match.join(', ')}</span>
                    </div>
                  )}
                  {errorByTx[t.id] && <div className="error-inline">{errorByTx[t.id]}</div>}
                  <div className="card-actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={busyId === t.id}
                      onClick={() => setAssignFor(t)}
                    >
                      Assign
                    </button>
                    <button
                      type="button"
                      disabled={busyId === t.id}
                      onClick={() => setCreateFor(t)}
                    >
                      Create
                    </button>
                    <button
                      type="button"
                      disabled={busyId === t.id || !hasAccount}
                      title={
                        hasAccount
                          ? 'Accept as a valid bank record'
                          : 'Assign an account before accepting this transaction.'
                      }
                      onClick={() => accept(t)}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={busyId === t.id}
                      onClick={() => reject(t)}
                    >
                      Reject
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      ) : isCompact ? (
        // Compact desktop (1200–1439px): 6-column table with a More menu for
        // secondary actions. The "View details" button opens a modal that
        // exposes the dropped fields (balance, device, parser, warnings,
        // reason_no_match, full IDs, UUID, effective_ts).
        <UnmatchedTable
          items={sortedItems}
          compact
          sort={sort}
          onSortChange={setSort}
          busyId={busyId}
          errorByTx={errorByTx}
          onAssign={(t) => {
            void seenCache.markSeen(t.id);
            setAssignFor(t);
          }}
          onCreate={(t) => {
            void seenCache.markSeen(t.id);
            setCreateFor(t);
          }}
          onAccept={accept}
          onReject={reject}
          onDetails={(t) => {
            void seenCache.markSeen(t.id);
            setDetailsFor(t);
          }}
          seenCache={seenCache}
        />
      ) : (
        // Wide desktop (>=1440px): full 11-column table with the same
        // compact-action More menu. Same actions, more columns.
        <UnmatchedTable
          items={sortedItems}
          compact={false}
          sort={sort}
          onSortChange={setSort}
          busyId={busyId}
          errorByTx={errorByTx}
          onAssign={(t) => {
            void seenCache.markSeen(t.id);
            setAssignFor(t);
          }}
          onCreate={(t) => {
            void seenCache.markSeen(t.id);
            setCreateFor(t);
          }}
          onAccept={accept}
          onReject={reject}
          onDetails={(t) => {
            void seenCache.markSeen(t.id);
            setDetailsFor(t);
          }}
          seenCache={seenCache}
        />
      )}
      {assignFor && (
        <AssignAccountModal
          tx={assignFor}
          accounts={accounts}
          onClose={() => setAssignFor(null)}
          onSaved={() => {
            setAssignFor(null);
            cache.invalidate(...forMutation('assignAccount'));
          }}
        />
      )}
      {createFor && (
        <CreateAccountModal
          tx={createFor}
          onClose={() => setCreateFor(null)}
          onSaved={() => {
            setCreateFor(null);
            cache.invalidate(...forMutation('createAccountAndAssign'));
          }}
        />
      )}
      {detailsFor && (
        <TransactionDetailsModal tx={detailsFor} onClose={() => setDetailsFor(null)} />
      )}
    </>
  );
}

/** Shared desktop table for Unmatched incoming. `compact=true` renders
 *  only the 6 most important columns and exposes the rest via the
 *  View-details modal; `compact=false` renders the full 11-column set. */
function UnmatchedTable({
  items,
  compact,
  sort,
  onSortChange,
  busyId,
  errorByTx,
  onAssign,
  onCreate,
  onAccept,
  onReject,
  onDetails,
  seenCache,
}: {
  items: UnmatchedItem[];
  compact: boolean;
  sort: { column: string | null; direction: 'asc' | 'desc' };
  onSortChange: (next: { column: string | null; direction: 'asc' | 'desc' }) => void;
  busyId: string | null;
  errorByTx: Record<string, string>;
  onAssign: (t: UnmatchedItem) => void;
  onCreate: (t: UnmatchedItem) => void;
  onAccept: (t: UnmatchedItem) => void | Promise<void>;
  onReject: (t: UnmatchedItem) => void | Promise<void>;
  onDetails: (t: UnmatchedItem) => void;
  seenCache: { seenIds: Set<string>; markSeen: (id: string) => Promise<void> };
}) {
  const tableClass = compact ? 'data-table unmatched-table--compact' : 'data-table';
  return (
    <div className="data-table-wrapper">
      <table className={tableClass}>
        <colgroup>
          {compact ? (
            <>
              <col style={{ width: '160px' }} />
              <col style={{ width: '220px' }} />
              <col style={{ width: '160px' }} />
              <col style={{ width: '150px' }} />
              <col style={{ width: '110px' }} />
              <col style={{ width: '200px' }} />
            </>
          ) : (
            <>
              <col style={{ width: '90px' }} />
              <col style={{ width: '120px' }} />
              <col style={{ width: '110px' }} />
              <col style={{ width: '160px' }} />
              <col style={{ width: '200px' }} />
              <col style={{ width: '160px' }} />
              <col style={{ width: '150px' }} />
              <col style={{ width: '150px' }} />
              <col style={{ width: '100px' }} />
              <col style={{ width: '100px' }} />
              <col style={{ width: '220px' }} />
            </>
          )}
        </colgroup>
        <thead>
          <tr>
            {compact ? (
              <>
                <SortableHeader
                  column="sort_amount"
                  label="Amount"
                  state={sort}
                  onChange={onSortChange}
                />
                <SortableHeader
                  column="account_display"
                  label="Account"
                  state={sort}
                  onChange={onSortChange}
                />
                <SortableHeader
                  column="detected"
                  label="Detected"
                  state={sort}
                  onChange={onSortChange}
                />
                <SortableHeader
                  column="sms_timestamp"
                  label="SMS time"
                  state={sort}
                  onChange={onSortChange}
                />
                <SortableHeader
                  column="status"
                  label="Status"
                  state={sort}
                  onChange={onSortChange}
                />
                <th>Actions</th>
              </>
            ) : (
              UNMATCHED_WIDE_COLUMNS.map((c) => (
                <SortableHeader
                  key={c.key}
                  column={c.key}
                  label={c.label}
                  state={sort}
                  onChange={onSortChange}
                />
              )).concat([<th key="actions">Actions</th>])
            )}
          </tr>
        </thead>
        <tbody>
          {items.map((t) => {
            const detected = t.detected_identifiers ?? [];
            const hasAccount = !!t.financial_account_id;
            const warningsCount = t.warnings.length;
            const reasonsCount = t.reason_no_match.length;
            const isNew = t.is_new === true && !seenCache.seenIds.has(t.id);
            return (
              <tr
                key={t.id}
                className={isNew ? 'transaction-row--new' : undefined}
                onClick={() => {
                  if (isNew) void seenCache.markSeen(t.id);
                }}
              >
                {compact ? (
                  <>
                    <td>
                      <strong>{formatTomanFromIrr(t.amount_irr)}</strong> <NewBadge isNew={isNew} />
                      <br />
                      <small className="muted">{directionLabel(t.direction)}</small>
                    </td>
                    <td>
                      <AccountCell
                        accountDisplay={t.account_display}
                        deviceDisplayName={t.device_display_name}
                        deviceCode={t.device_code}
                      />
                    </td>
                    <td>
                      {detected.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        <div className="detected-stack">
                          <IdentifierText
                            value={detected[0]!.normalized_value}
                            label={detected[0]!.type}
                          />
                          {detected.length > 1 && (
                            <small className="muted"> +{detected.length - 1} more</small>
                          )}
                        </div>
                      )}
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
                      <span className="status-pill">{statusLabel(t.status)}</span>
                      {(warningsCount > 0 || reasonsCount > 0) && (
                        <small className="muted">
                          {reasonsCount > 0 &&
                            `${reasonsCount} reason${reasonsCount > 1 ? 's' : ''}`}
                          {warningsCount > 0 &&
                            `${reasonsCount > 0 ? ' · ' : ''}${warningsCount} warning${
                              warningsCount > 1 ? 's' : ''
                            }`}
                        </small>
                      )}
                    </td>
                    <td className="actions-cell">
                      {errorByTx[t.id] && <div className="error-inline">{errorByTx[t.id]}</div>}
                      <button
                        type="button"
                        className="primary"
                        disabled={busyId === t.id}
                        onClick={() => onAssign(t)}
                      >
                        Assign
                      </button>
                      <button
                        type="button"
                        disabled={busyId === t.id || !hasAccount}
                        title={
                          hasAccount
                            ? 'Accept as a valid bank record'
                            : 'Assign an account before accepting this transaction.'
                        }
                        onClick={() => onAccept(t)}
                      >
                        Accept
                      </button>
                      <MoreMenu
                        ariaLabel={`More actions for transaction ${t.id}`}
                        actions={[
                          {
                            key: 'create',
                            label: 'Create account',
                            disabled: busyId === t.id,
                            onSelect: () => onCreate(t),
                          },
                          {
                            key: 'details',
                            label: 'View details',
                            disabled: busyId === t.id,
                            onSelect: () => onDetails(t),
                          },
                          {
                            key: 'reject',
                            label: 'Reject',
                            danger: true,
                            disabled: busyId === t.id,
                            onSelect: () => onReject(t),
                          },
                        ]}
                        onOpen={() => {
                          if (t.is_new && !seenCache.seenIds.has(t.id)) {
                            void seenCache.markSeen(t.id);
                          }
                        }}
                      />
                    </td>
                  </>
                ) : (
                  <>
                    <td>
                      {directionLabel(t.direction)} <NewBadge isNew={isNew} />
                    </td>
                    <td>{formatTomanFromIrr(t.amount_irr)}</td>
                    <td>{formatTomanFromIrr(t.balance_irr)}</td>
                    <td>
                      {t.account_display ? (
                        t.account_display
                      ) : (
                        <span className="muted">Not assigned</span>
                      )}
                    </td>
                    <td>
                      {detected.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        <div className="detected-stack detected-stack--rows">
                          {detected.map((d) => (
                            <div key={`${d.type}-${d.normalized_value}`} className="identifier">
                              <IdentifierText value={d.normalized_value} label={d.type} />
                            </div>
                          ))}
                        </div>
                      )}
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
                    <td>
                      {t.reason_no_match.map((r) => (
                        <div key={r} className="reason">
                          {r}
                        </div>
                      ))}
                    </td>
                    <td className="actions-cell">
                      {errorByTx[t.id] && <div className="error-inline">{errorByTx[t.id]}</div>}
                      <button
                        type="button"
                        className="primary"
                        disabled={busyId === t.id}
                        onClick={() => onAssign(t)}
                      >
                        Assign
                      </button>
                      <button
                        type="button"
                        disabled={busyId === t.id || !hasAccount}
                        title={
                          hasAccount
                            ? 'Accept this transaction as a valid bank record'
                            : 'Assign an account before accepting this transaction.'
                        }
                        onClick={() => onAccept(t)}
                      >
                        Accept
                      </button>
                      <MoreMenu
                        ariaLabel={`More actions for transaction ${t.id}`}
                        actions={[
                          {
                            key: 'create',
                            label: 'Create account',
                            disabled: busyId === t.id,
                            onSelect: () => onCreate(t),
                          },
                          {
                            key: 'details',
                            label: 'View details',
                            disabled: busyId === t.id,
                            onSelect: () => onDetails(t),
                          },
                          {
                            key: 'reject',
                            label: 'Reject',
                            danger: true,
                            disabled: busyId === t.id,
                            onSelect: () => onReject(t),
                          },
                        ]}
                        onOpen={() => {
                          if (t.is_new && !seenCache.seenIds.has(t.id)) {
                            void seenCache.markSeen(t.id);
                          }
                        }}
                      />
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Read-only modal showing the secondary fields hidden from the compact
 *  6-column table: balance, device, parser, warnings, reason_no_match,
 *  full detected identifiers, transaction UUID, effective timestamp. */
function TransactionDetailsModal({ tx, onClose }: { tx: UnmatchedItem; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const detected = tx.detected_identifiers ?? [];
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Transaction details"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-body">
        <div className="row toolbar">
          <h3>Transaction details</h3>
          <div className="spacer" />
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <dl>
          <dt>Direction</dt>
          <dd>{directionLabel(tx.direction)}</dd>
          <dt>Amount</dt>
          <dd>{formatTomanFromIrr(tx.amount_irr)}</dd>
          <dt>Balance</dt>
          <dd>{formatTomanFromIrr(tx.balance_irr)}</dd>
          <dt>Status</dt>
          <dd>{statusLabel(tx.status)}</dd>
          <dt>Account</dt>
          <dd>{tx.account_display ?? <span className="muted">Not assigned</span>}</dd>
          <dt>Account hint</dt>
          <dd>
            <code className="hint">{tx.account_hint ?? '—'}</code>
          </dd>
          <dt>Bank</dt>
          <dd>{tx.account_bank ?? '—'}</dd>
          <dt>Device name</dt>
          <dd>
            <DeviceName displayName={tx.device_display_name} deviceCode={tx.device_code} />
          </dd>
          <dt>Device code</dt>
          <dd>
            <code className="hint">{tx.device_code ?? '—'}</code>
          </dd>
          <dt>Parser</dt>
          <dd>
            <code className="parser-id">{tx.parser_id ?? '—'}</code>
          </dd>
          <dt>SMS received on phone</dt>
          <dd>{tx.sms_timestamp ? formatTimeSeconds(tx.sms_timestamp) : '—'}</dd>
          <dt>Received by server</dt>
          <dd>{tx.received_at ? formatTimeSeconds(tx.received_at) : '—'}</dd>
          <dt>Bank transaction time</dt>
          <dd>{tx.bank_timestamp ? formatTime(tx.bank_timestamp) : '—'}</dd>
          <dt>Effective at</dt>
          <dd>{formatTime(tx.effective_ts)}</dd>
          <dt>Transaction id</dt>
          <dd>
            <code className="hint">{tx.id}</code>
          </dd>
        </dl>
        {(tx.device_id || tx.id) && (
          <details className="debug-subsection">
            <summary>Technical details</summary>
            {tx.device_id && (
              <p>
                <strong>Device internal id:</strong> <code className="hint">{tx.device_id}</code>
              </p>
            )}
          </details>
        )}
        {detected.length > 0 && (
          <>
            <h4>Detected identifiers</h4>
            <DetectedIdentifierList detected={detected} />
          </>
        )}
        {tx.reason_no_match.length > 0 && (
          <>
            <h4>Reason no match</h4>
            <ul className="list-plain">
              {tx.reason_no_match.map((r) => (
                <li key={r} className="reason">
                  {r}
                </li>
              ))}
            </ul>
          </>
        )}
        {tx.warnings.length > 0 && (
          <>
            <h4>Warnings</h4>
            <ul className="list-plain">
              {tx.warnings.map((w) => (
                <li key={w} className="reason">
                  {w}
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="row toolbar modal-actions">
          <div className="spacer" />
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function AssignAccountModal({
  tx,
  accounts,
  onClose,
  onSaved,
}: {
  tx: UnmatchedItem;
  accounts: AccountListItem[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const detected = tx.detected_identifiers ?? [];
  const [accountId, setAccountId] = useState<string>('');
  const [identifierType, setIdentifierType] = useState<string>(
    detected[0]?.type ?? 'ACCOUNT_NUMBER',
  );
  const [identifierValue, setIdentifierValue] = useState<string>(
    detected[0]?.normalized_value ?? '',
  );
  const [saveIdentifier, setSaveIdentifier] = useState(true);
  const [backfill, setBackfill] = useState(true);
  const [preview, setPreview] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Structured conflict surface — the modal stays open so the user can
  // resolve the conflict (pick a different account, disable Save, etc).
  const [conflict, setConflict] = useState<{
    code:
      | 'identifier_conflict'
      | 'account_identifier_ambiguous'
      | 'already_assigned_to_other_account'
      | 'account_inactive';
    existingAccountId?: string | undefined;
    existingAccountDisplayName?: string | undefined;
  } | null>(null);
  const filtered = useMemo(() => accounts.filter((a) => a.bank_name && a.active === 1), [accounts]);
  useEffect(() => {
    if (!accountId || !saveIdentifier || !identifierValue) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    api
      .backfillAccountPreview(accountId, {
        identifierType: identifierType as
          | 'ACCOUNT_NUMBER'
          | 'CARD_LAST_FOUR'
          | 'IBAN'
          | 'ACCOUNT_HINT',
        normalizedValue: identifierValue,
      })
      .then((r) => {
        if (!cancelled) setPreview(r.matchingUnassignedCount);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, identifierType, identifierValue, saveIdentifier]);

  async function submit() {
    if (!accountId) {
      setError('Pick an account first.');
      return;
    }
    setBusy(true);
    setError(null);
    setConflict(null);
    try {
      const body: {
        accountId: string;
        identifier?: {
          type: 'ACCOUNT_NUMBER' | 'CARD_LAST_FOUR' | 'IBAN' | 'ACCOUNT_HINT';
          normalizedValue: string;
          maskedValue?: string;
        };
        saveIdentifierToAccount?: boolean;
        backfillHistorical?: boolean;
      } = { accountId };
      if (identifierValue && identifierType) {
        body.identifier = {
          type: identifierType as 'ACCOUNT_NUMBER' | 'CARD_LAST_FOUR' | 'IBAN' | 'ACCOUNT_HINT',
          normalizedValue: identifierValue,
        };
      }
      if (saveIdentifier) body.saveIdentifierToAccount = true;
      if (backfill) body.backfillHistorical = true;
      await api.assignTransactionAccount(tx.id, body);
      onSaved();
    } catch (e: unknown) {
      // api.assignTransactionAccount wraps the response body on a non-2xx
      // status; structured conflicts carry `error: 'identifier_conflict'`
      // etc. Render a clear message and keep the modal open.
      const maybeErr = e as {
        body?: { error?: string; existingAccountDisplayName?: string; existingAccountId?: string };
        message?: string;
      };
      const code = maybeErr.body?.error;
      if (
        code === 'identifier_conflict' ||
        code === 'account_identifier_ambiguous' ||
        code === 'already_assigned_to_other_account' ||
        code === 'account_inactive'
      ) {
        setConflict({
          code,
          existingAccountId: maybeErr.body?.existingAccountId,
          existingAccountDisplayName: maybeErr.body?.existingAccountDisplayName,
        });
      } else {
        setError(maybeErr.message ?? 'Assign failed. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  // Keep the modal body inside its scroll viewport — close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Assign account"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-body">
        <div className="row toolbar">
          <h3>Assign account</h3>
          <div className="spacer" />
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p>
          <strong>Detected identifier:</strong>{' '}
          {detected.length === 0 ? (
            <span className="muted">none</span>
          ) : (
            <IdentifierText value={detected[0]!.normalized_value} label={detected[0]!.type} />
          )}
        </p>
        <p>
          <strong>Current account:</strong>{' '}
          {tx.account_display ?? <span className="muted">Not assigned</span>}
        </p>
        <div className="form">
          <label>
            <span>Account</span>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">— Select an account —</option>
              {filtered.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.display_name} ({a.bank_name}
                  {a.account_hint ? ` • ${a.account_hint}` : ''})
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Identifier type</span>
            <select value={identifierType} onChange={(e) => setIdentifierType(e.target.value)}>
              <option value="ACCOUNT_NUMBER">ACCOUNT_NUMBER</option>
              <option value="CARD_LAST_FOUR">CARD_LAST_FOUR</option>
              <option value="IBAN">IBAN</option>
              <option value="ACCOUNT_HINT">ACCOUNT_HINT</option>
            </select>
          </label>
          <label>
            <span>Identifier value (normalized)</span>
            <input
              type="text"
              value={identifierValue}
              onChange={(e) => setIdentifierValue(e.target.value)}
            />
          </label>
          <label className="row checkbox-row">
            <input
              type="checkbox"
              checked={saveIdentifier}
              onChange={(e) => setSaveIdentifier(e.target.checked)}
            />
            <span>Save identifier to account</span>
          </label>
          <label className="row checkbox-row">
            <input
              type="checkbox"
              checked={backfill}
              onChange={(e) => setBackfill(e.target.checked)}
            />
            <span>Assign matching historical transactions</span>
          </label>
        </div>
        {saveIdentifier && preview !== null && (
          <p className="muted">{preview} historical transaction(s) will be assigned.</p>
        )}
        {conflict && (
          <div className="error" role="alert" data-testid="assign-conflict">
            {conflict.code === 'identifier_conflict' && (
              <>
                This identifier is already owned by{' '}
                <strong>{conflict.existingAccountDisplayName ?? 'another active account'}</strong>
                {conflict.existingAccountId ? ` (${conflict.existingAccountId.slice(0, 8)})` : ''}.
                Pick a different account, or uncheck "Save identifier to account" to proceed.
              </>
            )}
            {conflict.code === 'account_identifier_ambiguous' && (
              <>This identifier resolves to multiple accounts. Resolve manually before saving.</>
            )}
            {conflict.code === 'already_assigned_to_other_account' && (
              <>This transaction is already assigned to a different account.</>
            )}
            {conflict.code === 'account_inactive' && (
              <>The selected account is inactive. Pick an active account.</>
            )}
          </div>
        )}
        {error && !conflict && <div className="error">{error}</div>}
        <div className="row toolbar modal-actions">
          <div className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={busy || !accountId} onClick={submit}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateAccountModal({
  tx,
  onClose,
  onSaved,
}: {
  tx: UnmatchedItem;
  onClose: () => void;
  onSaved: () => void;
}) {
  const detected = tx.detected_identifiers ?? [];
  const seedDisplay = tx.account_bank ?? tx.parser_id ?? 'Bank account';
  const [bankName, setBankName] = useState(tx.account_bank ?? 'UNKNOWN');
  const [displayName, setDisplayName] = useState(
    `${seedDisplay} ${detected[0]?.normalized_value ?? ''}`.trim(),
  );
  const [ownerLabel, setOwnerLabel] = useState('');
  const [accountType, setAccountType] = useState<'CARD' | 'ACCOUNT' | 'IBAN' | 'OTHER'>('ACCOUNT');
  const [backfill, setBackfill] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body: {
        bank_name: string;
        display_name: string;
        owner_label: string | null;
        account_type: 'CARD' | 'ACCOUNT' | 'IBAN' | 'OTHER';
        identifier?: {
          type: 'ACCOUNT_NUMBER' | 'CARD_LAST_FOUR' | 'IBAN' | 'ACCOUNT_HINT';
          normalizedValue: string;
          maskedValue?: string;
        };
        backfillHistorical?: boolean;
      } = {
        bank_name: bankName,
        display_name: displayName,
        owner_label: ownerLabel || null,
        account_type: accountType,
      };
      if (detected[0]) {
        body.identifier = {
          type: detected[0].type,
          normalizedValue: detected[0].normalized_value,
          maskedValue: detected[0].masked_value,
        };
      }
      if (backfill) body.backfillHistorical = true;
      await api.createAccountFromTransaction(tx.id, body);
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Create account"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-body">
        <div className="row toolbar">
          <h3>Create account</h3>
          <div className="spacer" />
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {detected[0] && (
          <p>
            <strong>Detected:</strong>{' '}
            <IdentifierText value={detected[0].normalized_value} label={detected[0].type} />
          </p>
        )}
        <div className="form">
          <label>
            <span>Display name</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>
          <label>
            <span>Bank name</span>
            <input type="text" value={bankName} onChange={(e) => setBankName(e.target.value)} />
          </label>
          <label>
            <span>Owner label</span>
            <input type="text" value={ownerLabel} onChange={(e) => setOwnerLabel(e.target.value)} />
          </label>
          <label>
            <span>Account type</span>
            <select
              value={accountType}
              onChange={(e) =>
                setAccountType(e.target.value as 'CARD' | 'ACCOUNT' | 'IBAN' | 'OTHER')
              }
            >
              <option value="ACCOUNT">ACCOUNT</option>
              <option value="CARD">CARD</option>
              <option value="IBAN">IBAN</option>
              <option value="OTHER">OTHER</option>
            </select>
          </label>
        </div>
        {detected[0] && (
          <p className="muted">
            Will stamp <IdentifierText value={detected[0].normalized_value} /> on the new account
            and assign this transaction.
          </p>
        )}
        <label className="row checkbox-row">
          <input
            type="checkbox"
            checked={backfill}
            onChange={(e) => setBackfill(e.target.checked)}
          />
          <span>Assign matching historical transactions</span>
        </label>
        {error && <div className="error">{error}</div>}
        <div className="row toolbar modal-actions">
          <div className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !displayName}
            onClick={submit}
          >
            Create + assign
          </button>
        </div>
      </div>
    </div>
  );
}

function ReviewedList({
  items,
  reviewedTransactions,
  reviewedMatchesLoading,
  reviewedTxLoading,
  cache,
}: {
  items: MatchListPayload['items'];
  reviewedTransactions: ReviewedTransactionItem[];
  reviewedMatchesLoading: boolean;
  reviewedTxLoading: boolean;
  cache: Cache;
}) {
  const isMobile = useMediaQuery('(max-width: 639px)');
  const isCompact = useMediaQuery('(min-width: 1200px) and (max-width: 1439px)');
  const isWideDesktop = useMediaQuery('(min-width: 1440px)');
  const seenCache = useSeenCache(cache);
  const [matchSort, setMatchSort] = useTableSortState('matches.reviewed.matches', {
    column: 'reviewed_at',
    direction: 'desc',
  });
  const [txSort, setTxSort] = useTableSortState('matches.reviewed.tx', {
    column: 'reviewed_at',
    direction: 'desc',
  });
  const sortedMatches = useMemo(() => {
    return sortBy(
      items,
      matchSort.column
        ? {
            column: matchSort.column,
            type: REVIEWED_MATCH_COLUMNS.find((c) => c.key === matchSort.column)?.type ?? 'date',
            accessor: reviewedMatchAccessor(matchSort.column),
          }
        : null,
      matchSort.direction,
    );
  }, [items, matchSort.column, matchSort.direction]);
  const sortedTx = useMemo(() => {
    return sortBy(
      reviewedTransactions,
      txSort.column
        ? {
            column: txSort.column,
            type: REVIEWED_TX_COLUMNS.find((c) => c.key === txSort.column)?.type ?? 'date',
            accessor: reviewedTxAccessor(txSort.column),
          }
        : null,
      txSort.direction,
    );
  }, [reviewedTransactions, txSort.column, txSort.direction]);
  if (
    items.length === 0 &&
    reviewedTransactions.length === 0 &&
    !reviewedMatchesLoading &&
    !reviewedTxLoading
  )
    return <p className="empty">No reviewed matches yet.</p>;
  return (
    <>
      {items.length > 0 && (
        <>
          <h4>Reviewed matches</h4>
          {isMobile ? (
            <ul className="card-list" aria-label="Reviewed matches">
              {sortedMatches.map((row) => (
                <li key={row.match.id} className="card">
                  <div className="card-row card-row--top">
                    <span className="amount">
                      {directionLabel(row.transaction.direction)}{' '}
                      {formatTomanFromIrr(row.transaction.amount_irr)}
                    </span>
                    <span className="status-pill">{statusLabel(row.match.status)}</span>
                  </div>
                  <div className="card-row">
                    <span className="label">Account</span>
                    <span>{row.account_display ?? '—'}</span>
                  </div>
                  <div className="card-row">
                    <span className="label">SMS received on phone</span>
                    <span>
                      {row.transaction.sms_timestamp
                        ? formatTimeSeconds(row.transaction.sms_timestamp)
                        : '—'}
                    </span>
                  </div>
                  <div className="card-row">
                    <span className="label">Received by server</span>
                    <span>
                      {row.transaction.received_at
                        ? formatTimeSeconds(row.transaction.received_at)
                        : '—'}
                    </span>
                  </div>
                  {row.transaction.bank_timestamp && (
                    <div className="card-row">
                      <span className="label">Bank transaction time</span>
                      <span>{formatTime(row.transaction.bank_timestamp)}</span>
                    </div>
                  )}
                  <div className="card-row">
                    <span className="label">Score</span>
                    <span>{row.match.score.toFixed(2)}</span>
                  </div>
                  <div className="card-row">
                    <span className="label">Reviewed</span>
                    <span className="muted">
                      {row.match.reviewed_at
                        ? `${formatTime(row.match.reviewed_at)} • ${row.match.reviewed_by ?? ''}`
                        : '—'}
                    </span>
                  </div>
                  <div className="card-row">
                    <span className="label">Received by device</span>
                    <span>
                      <DeviceName
                        displayName={row.device_display_name}
                        deviceCode={row.device_code}
                      />
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : isCompact && !isWideDesktop ? (
            // Compact desktop (1200–1439px): 7-column table with the device
            // folded into the Account cell.
            <div className="data-table-wrapper">
              <table className="data-table reviewed-table--compact">
                <colgroup>
                  <col style={{ width: '90px' }} />
                  <col style={{ width: '120px' }} />
                  <col style={{ width: '220px' }} />
                  <col style={{ width: '150px' }} />
                  <col style={{ width: '200px' }} />
                  <col style={{ width: '90px' }} />
                  <col style={{ width: '80px' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Direction</th>
                    <th>Amount</th>
                    <th>Account</th>
                    <th>SMS time</th>
                    <th>Reviewed</th>
                    <th>Status</th>
                    <th>Score</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedMatches.map((row) => (
                    <tr key={row.match.id}>
                      <td>{directionLabel(row.transaction.direction)}</td>
                      <td>{formatTomanFromIrr(row.transaction.amount_irr)}</td>
                      <td>
                        <AccountCell
                          accountDisplay={row.account_display}
                          deviceDisplayName={row.device_display_name}
                          deviceCode={row.device_code}
                        />
                      </td>
                      <td>
                        <span
                          className="table-ellipsis"
                          style={{ maxWidth: '150px' }}
                          title={
                            row.transaction.sms_timestamp
                              ? formatTime(row.transaction.sms_timestamp)
                              : ''
                          }
                        >
                          {row.transaction.sms_timestamp
                            ? formatTimeSeconds(row.transaction.sms_timestamp)
                            : '—'}
                        </span>
                      </td>
                      <td>
                        {row.match.reviewed_at
                          ? `${formatTime(row.match.reviewed_at)} • ${row.match.reviewed_by ?? ''}`
                          : '—'}
                      </td>
                      <td>{statusLabel(row.match.status)}</td>
                      <td>{row.match.score.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="data-table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    {REVIEWED_MATCH_COLUMNS.map((c) => (
                      <SortableHeader
                        key={c.key}
                        column={c.key}
                        label={c.label}
                        state={matchSort}
                        onChange={setMatchSort}
                      />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedMatches.map((row) => (
                    <tr key={row.match.id}>
                      <td>{directionLabel(row.transaction.direction)}</td>
                      <td>{formatTomanFromIrr(row.transaction.amount_irr)}</td>
                      <td>{row.account_display ?? '—'}</td>
                      <td>
                        <DeviceName
                          displayName={row.device_display_name}
                          deviceCode={row.device_code}
                        />
                      </td>
                      <td>
                        <span
                          className="table-ellipsis"
                          style={{ maxWidth: '150px' }}
                          title={
                            row.transaction.sms_timestamp
                              ? formatTime(row.transaction.sms_timestamp)
                              : ''
                          }
                        >
                          {row.transaction.sms_timestamp
                            ? formatTimeSeconds(row.transaction.sms_timestamp)
                            : '—'}
                        </span>
                      </td>
                      <td>
                        <span
                          className="table-ellipsis"
                          style={{ maxWidth: '150px' }}
                          title={
                            row.transaction.received_at
                              ? formatTime(row.transaction.received_at)
                              : ''
                          }
                        >
                          {row.transaction.received_at
                            ? formatTimeSeconds(row.transaction.received_at)
                            : '—'}
                        </span>
                      </td>
                      <td>
                        {row.match.reviewed_at
                          ? `${formatTime(row.match.reviewed_at)} • ${row.match.reviewed_by ?? ''}`
                          : '—'}
                      </td>
                      <td>{statusLabel(row.match.status)}</td>
                      <td>{row.match.score.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {reviewedTransactions.length > 0 && (
        <>
          <h4>Reviewed transactions</h4>
          {isMobile ? (
            <ul className="card-list" aria-label="Reviewed transactions">
              {sortedTx.map((r) => {
                const isNew = r.is_new === true && !seenCache.seenIds.has(r.id);
                return (
                  <li
                    key={r.id}
                    className={`card${isNew ? ' transaction-row--new' : ''}`}
                    onClick={() => {
                      if (isNew) void seenCache.markSeen(r.id);
                    }}
                  >
                    <div className="card-row card-row--top">
                      <span className="amount">{formatTomanFromIrr(r.amount_irr)}</span>
                      <span className="card-row--top-right">
                        <NewBadge isNew={isNew} />
                        <span className={`status-pill status-${r.review.decision.toLowerCase()}`}>
                          {r.review.decision}
                        </span>
                      </span>
                    </div>
                    <div className="card-row">
                      <span className="label">Account</span>
                      <span>{r.account_display ?? '—'}</span>
                    </div>
                    <div className="card-row">
                      <span className="label">Reason</span>
                      <span className="muted">{r.review.reason ?? r.review.comment ?? '—'}</span>
                    </div>
                    <div className="card-row">
                      <span className="label">By</span>
                      <span className="muted">{r.review.reviewed_by}</span>
                    </div>
                    <div className="card-row">
                      <span className="label">SMS received on phone</span>
                      <span className="muted">
                        {r.sms_timestamp ? formatTimeSeconds(r.sms_timestamp) : '—'}
                      </span>
                    </div>
                    <div className="card-row">
                      <span className="label">Received by server</span>
                      <span className="muted">
                        {r.received_at ? formatTimeSeconds(r.received_at) : '—'}
                      </span>
                    </div>
                    <div className="card-row">
                      <span className="label">Reviewed at</span>
                      <span className="muted">{formatTime(r.review.reviewed_at)}</span>
                    </div>
                    <div className="card-row">
                      <span className="label">Received by device</span>
                      <span>
                        <DeviceName
                          displayName={r.device_display_name}
                          deviceCode={r.device_code}
                        />
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : isCompact && !isWideDesktop ? (
            // Compact desktop (1200–1439px): 7-column table with the device
            // folded into the Account cell.
            <div className="data-table-wrapper">
              <table className="data-table reviewed-table--compact">
                <colgroup>
                  <col style={{ width: '90px' }} />
                  <col style={{ width: '120px' }} />
                  <col style={{ width: '220px' }} />
                  <col style={{ width: 'auto' }} />
                  <col style={{ width: '120px' }} />
                  <col style={{ width: '150px' }} />
                  <col style={{ width: '150px' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Decision</th>
                    <th>Amount</th>
                    <th>Account</th>
                    <th>Reason</th>
                    <th>Reviewed by</th>
                    <th>SMS time</th>
                    <th>Reviewed at</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedTx.map((r) => {
                    const isNew = r.is_new === true && !seenCache.seenIds.has(r.id);
                    return (
                      <tr
                        key={r.id}
                        className={isNew ? 'transaction-row--new' : undefined}
                        onClick={() => {
                          if (isNew) void seenCache.markSeen(r.id);
                        }}
                      >
                        <td>{r.review.decision}</td>
                        <td>
                          {formatTomanFromIrr(r.amount_irr)} <NewBadge isNew={isNew} />
                        </td>
                        <td>
                          <AccountCell
                            accountDisplay={r.account_display}
                            deviceDisplayName={r.device_display_name}
                            deviceCode={r.device_code}
                          />
                        </td>
                        <td>{r.review.reason ?? r.review.comment ?? '—'}</td>
                        <td>{r.review.reviewed_by}</td>
                        <td>
                          <span
                            className="table-ellipsis"
                            style={{ maxWidth: '150px' }}
                            title={r.sms_timestamp ? formatTime(r.sms_timestamp) : ''}
                          >
                            {r.sms_timestamp ? formatTimeSeconds(r.sms_timestamp) : '—'}
                          </span>
                        </td>
                        <td>{formatTime(r.review.reviewed_at)}</td>
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
                    {REVIEWED_TX_COLUMNS.map((c) => (
                      <SortableHeader
                        key={c.key}
                        column={c.key}
                        label={c.label}
                        state={txSort}
                        onChange={setTxSort}
                      />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedTx.map((r) => {
                    const isNew = r.is_new === true && !seenCache.seenIds.has(r.id);
                    return (
                      <tr
                        key={r.id}
                        className={isNew ? 'transaction-row--new' : undefined}
                        onClick={() => {
                          if (isNew) void seenCache.markSeen(r.id);
                        }}
                      >
                        <td>
                          {r.review.decision} <NewBadge isNew={isNew} />
                        </td>
                        <td>{formatTomanFromIrr(r.amount_irr)}</td>
                        <td>{r.account_display ?? '—'}</td>
                        <td>
                          <DeviceName
                            displayName={r.device_display_name}
                            deviceCode={r.device_code}
                          />
                        </td>
                        <td>{r.review.reason ?? r.review.comment ?? '—'}</td>
                        <td>{r.review.reviewed_by}</td>
                        <td>
                          <span
                            className="table-ellipsis"
                            style={{ maxWidth: '150px' }}
                            title={r.sms_timestamp ? formatTime(r.sms_timestamp) : ''}
                          >
                            {r.sms_timestamp ? formatTimeSeconds(r.sms_timestamp) : '—'}
                          </span>
                        </td>
                        <td>
                          <span
                            className="table-ellipsis"
                            style={{ maxWidth: '150px' }}
                            title={r.received_at ? formatTime(r.received_at) : ''}
                          >
                            {r.received_at ? formatTimeSeconds(r.received_at) : '—'}
                          </span>
                        </td>
                        <td>{formatTime(r.review.reviewed_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
