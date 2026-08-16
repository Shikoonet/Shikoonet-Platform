/**
 * Payment review inbox for Mirzabot claims.
 *
 * Five operational buckets — what needs a human, what is still waiting, what
 * looks suspicious, what the engine handled, and the full history.
 */

import { useEffect, useState } from 'react';
import type { Cache } from './query.js';
import { QK } from './queries.js';
import { Drawer } from './Drawer.js';
import { formatTomanFromIrr, formatTimeSeconds } from './format.js';
import { IdentifierText } from './IdentifierText.js';
import { ClaimChangeAccount } from './ClaimChangeAccount.js';
import { TransactionReassignPicker } from './TransactionReassignPicker.js';
import {
  BotAutoVerifiedFilter,
  useBotAutoVerifiedFilter,
} from './BotAutoVerifiedFilter.js';
import {
  HeaderPrimaryOpsNav,
  ReviewSubNav,
  parsePaymentTabFromLocation,
  syncPaymentTabToLocation,
  level1GroupFromTab,
} from './paymentsNav.js';
import { HeaderSlot } from './shikoonetShell.js';
import {
  AssignToPaymentModal,
  DeclinedIncomeRow,
  DeclinedTotalsBar,
  IncomeRow,
  IncomeTotalsBar,
  MarkResellerModal,
  ResellerRow,
  ResellerStatsBar,
} from './financialHub.js';
import { BulkSelectionToolbar, HistoryDateNav } from './historyRangeNav.js';
import { NewBadge } from './NewBadge.js';
import {
  BotVerifiedMetrics,
  BotVerifiedTable,
  BotVerifiedTransactionRow,
  CompactEmptyState,
  PaymentTabReadAll,
  RecentActivity,
  StatsRail,
  StatusBadge,
} from './paymentsComponents.js';
import { useMediaQuery } from './useMediaQuery.js';
import { api } from './api.js';
import type { AnalyticsResponse } from './analytics.js';
import {
  ALL_TAB_STATES,
  bankName,
  defaultCandidateId,
  formatRelativeFuture,
  formatTimeAgo,
  formatToman,
  isReopenEligible,
  reasonText,
  reopenBlockedReason,
  stateLabel,
  type HistoryRangeState,
  appendHistoryRangeQuery,
  defaultHistoryRangeState,
  deviceInlineLabel,
  type DeclinedIncomeItem,
  type IncomeItem,
  type PaymentItem,
  type PaymentTab,
  type PaymentsResponse,
  type ResellerItem,
  type AccountRefLike,
} from './paymentReview.js';

/**
 * Bank names are Persian and identifiers are Latin digits; without isolation the
 * browser reorders them into an unreadable mix. `bdi` isolates the name and
 * IdentifierText pins the number to LTR.
 */
function AccountRef({ account }: { account: AccountRefLike }) {
  const bank = bankName(account);
  if (!bank && !account.accountHint) return <span className="muted">حساب نگاشت‌نشده</span>;
  return (
    <bdi className="account-ref">
      {bank && <span>{bank}</span>}
      {account.accountHint && <IdentifierText value={account.accountHint} tone="hint" />}
    </bdi>
  );
}

function PaymentIdentity({ item }: { item: PaymentItem }) {
  return (
    <div className="payment-identity">
      {item.telegramUsername && <strong>@{item.telegramUsername}</strong>}
      {item.telegramUserId && <span className="muted">User ID: {item.telegramUserId}</span>}
      <span className="muted">سفارش: {item.orderId}</span>
    </div>
  );
}

interface Filters {
  status: string;
  accountId: string;
  reason: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = { status: '', accountId: '', reason: '', from: '', to: '' };

function buildQuery(
  tab: PaymentTab,
  rangeState: HistoryRangeState,
  filters: Filters,
  botAutoFilterParams?: { purchaseType: string | null; range: string; day: string | null },
): string {
  const qs = new URLSearchParams({ tab });
  if (tab === 'bot_auto_verified' && botAutoFilterParams) {
    // Override the legacy date-range nav with the new segmented control.
    qs.set('range', botAutoFilterParams.range);
    if (botAutoFilterParams.day) qs.set('day', botAutoFilterParams.day);
    if (botAutoFilterParams.purchaseType) {
      qs.set('purchaseType', botAutoFilterParams.purchaseType);
    }
  } else {
    appendHistoryRangeQuery(qs, rangeState);
  }
  if (tab === 'all') {
    if (filters.status) qs.set('status', filters.status);
    if (filters.accountId) qs.set('accountId', filters.accountId);
    if (filters.reason) qs.set('reason', filters.reason);
    if (filters.from) qs.set('from', String(Date.parse(`${filters.from}T00:00:00`)));
    if (filters.to) qs.set('to', String(Date.parse(`${filters.to}T23:59:59`)));
  }
  return qs.toString();
}

function isPaymentItem(
  item: PaymentItem | IncomeItem | DeclinedIncomeItem | ResellerItem,
): item is PaymentItem {
  return 'reviewState' in item;
}

export function PaymentsView({ cache }: { cache: Cache }) {
  const [tab, setTab] = useState<PaymentTab>(() => parsePaymentTabFromLocation());
  const isWide = useMediaQuery('(min-width: 1200px)');
  const [rangeState, setRangeState] = useState<HistoryRangeState>(defaultHistoryRangeState());
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  // DEV-only: filters specific to the Bot Auto Verified tab.
  const botAutoFilter = useBotAutoVerifiedFilter();
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [incomeAction, setIncomeAction] = useState<IncomeItem | null>(null);
  const [assignIncome, setAssignIncome] = useState<IncomeItem | null>(null);
  const [declineTarget, setDeclineTarget] = useState<IncomeItem | null>(null);
  const [bulkDeclineOpen, setBulkDeclineOpen] = useState(false);
  const [selectedIncome, setSelectedIncome] = useState<Set<string>>(new Set());
  const [selectedDeclined, setSelectedDeclined] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [reopenTarget, setReopenTarget] = useState<PaymentItem | null>(null);
  const [locallyReadClaims, setLocallyReadClaims] = useState<Set<string>>(new Set());
  const [locallyReadIncome, setLocallyReadIncome] = useState<Set<string>>(new Set());
  const [markingReadAll, setMarkingReadAll] = useState(false);

  useEffect(() => {
    const onPop = () => setTab(parsePaymentTabFromLocation());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  function selectTab(next: PaymentTab) {
    setTab(next);
    syncPaymentTabToLocation(next);
  }

  const query = buildQuery(
    tab,
    rangeState,
    filters,
    tab === 'bot_auto_verified' ? botAutoFilter.toQueryParams() : undefined,
  );
  const queryKey = QK.payments(query);
  const analyticsQs = new URLSearchParams();
  appendHistoryRangeQuery(analyticsQs, rangeState);
  const analyticsKey = `analytics:${analyticsQs.toString()}`;
  const { data: analytics } = cache.useQuery<AnalyticsResponse>(analyticsKey, {
    fetcher: async (signal) => {
      const r = await fetch(`/api/v1/analytics?${analyticsQs}`, { signal });
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
  });
  const { data, status, refresh } = cache.useQuery<PaymentsResponse>(queryKey, {
    fetcher: async (signal) => {
      const r = await fetch(`/api/v1/payments?${query}`, { signal });
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
  });

  const claimItems = (data?.items ?? []).filter(isPaymentItem);
  const incomeItems = tab === 'income' ? ((data?.items ?? []) as IncomeItem[]) : [];
  const declinedItems =
    tab === 'declined_income' ? ((data?.items ?? []) as DeclinedIncomeItem[]) : [];
  const resellerItems = tab === 'reseller' ? ((data?.items ?? []) as ResellerItem[]) : [];
  const counts = data?.counts;
  const reviewing = claimItems.find((i) => i.id === reviewingId) ?? null;

  async function markClaimSeen(item: PaymentItem) {
    try {
      await api.markPaymentEventSeen(`claim:${item.id}`);
      cache.invalidate(QK.notificationCounts);
    } catch {
      /* best-effort */
    }
  }

  async function markIncomeSeen(item: IncomeItem) {
    try {
      await api.markPaymentEventSeen(`income:${item.id}`);
      cache.invalidate(QK.notificationCounts);
    } catch {
      /* best-effort */
    }
  }

  function openClaim(item: PaymentItem) {
    setLocallyReadClaims((prev) => new Set(prev).add(item.id));
    void markClaimSeen(item);
    setReviewingId(item.id);
  }

  function isClaimNew(item: PaymentItem): boolean {
    return Boolean(item.isNew && !locallyReadClaims.has(item.id));
  }

  function isIncomeNew(item: IncomeItem): boolean {
    return Boolean(item.isNew && !locallyReadIncome.has(item.id));
  }

  async function markResellerSeen(item: ResellerItem) {
    try {
      await api.markPaymentEventSeen(`reseller:${item.id}`);
      cache.invalidate(QK.notificationCounts);
    } catch {
      /* best-effort */
    }
  }

  async function readAllTab(
    t: 'needs_review' | 'suspected_fake' | 'bot_auto_verified' | 'reseller' | 'income',
  ) {
    setMarkingReadAll(true);
    setError(null);
    try {
      await api.markPaymentTabReadAll(t);
      if (t === 'income') {
        setLocallyReadIncome((prev) => {
          const next = new Set(prev);
          for (const row of incomeItems) next.add(row.id);
          return next;
        });
      } else {
        setLocallyReadClaims((prev) => {
          const next = new Set(prev);
          for (const row of claimItems) next.add(row.id);
          return next;
        });
      }
      cache.refetch(queryKey, QK.notificationCounts);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'read_all_failed');
    } finally {
      setMarkingReadAll(false);
    }
  }

  async function post(path: string, body: object) {
    setError(null);
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error ?? `${r.status}`);
    }
    setReviewingId(null);
    cache.refetch(queryKey, QK.suggested, QK.today);
  }

  return (
    <>
      <HeaderSlot slot="center">
        <HeaderPrimaryOpsNav tab={tab} counts={counts} onChange={selectTab} />
      </HeaderSlot>
      <HeaderSlot slot="dateNav">
        <HistoryDateNav value={rangeState} onChange={setRangeState} />
      </HeaderSlot>

      <section className="payments-shell">
        <div className="payments-shell__surface">
          <nav className="ops-nav ops-nav--subnav" aria-label="نماهای پرداخت">
            <ReviewSubNav
              activeGroup={level1GroupFromTab(tab)}
              tab={tab}
              counts={counts}
              onChange={selectTab}
            />
          </nav>

          <div className="payments-shell__content">
      {tab === 'income' && <IncomeTotalsBar totals={data?.incomeTotals} />}
      {tab === 'declined_income' && <DeclinedTotalsBar totals={data?.declinedTotals} />}
      {tab === 'reseller' && <ResellerStatsBar stats={data?.resellerStats} />}

      {tab === 'income' && (counts?.incomeUnread ?? 0) > 0 && incomeItems.length === 0 && (
        <div className="payment-table-header payment-table-header--end">
          <PaymentTabReadAll
            unread={counts?.incomeUnread ?? 0}
            busy={markingReadAll}
            onClick={() => void readAllTab('income')}
          />
        </div>
      )}
      {tab === 'needs_review' && (counts?.needsReviewUnread ?? 0) > 0 && (
        <div className="payment-table-header payment-table-header--end">
          <PaymentTabReadAll
            unread={counts?.needsReviewUnread ?? 0}
            busy={markingReadAll}
            onClick={() => void readAllTab('needs_review')}
          />
        </div>
      )}
      {tab === 'suspected_fake' && (counts?.suspectedFakeUnread ?? 0) > 0 && (
        <div className="payment-table-header payment-table-header--end">
          <PaymentTabReadAll
            unread={counts?.suspectedFakeUnread ?? 0}
            busy={markingReadAll}
            onClick={() => void readAllTab('suspected_fake')}
          />
        </div>
      )}
      {tab === 'bot_auto_verified' && (counts?.botAutoVerifiedUnread ?? 0) > 0 && (
        <div className="payment-table-header payment-table-header--end">
          <PaymentTabReadAll
            unread={counts?.botAutoVerifiedUnread ?? 0}
            busy={markingReadAll}
            onClick={() => void readAllTab('bot_auto_verified')}
          />
        </div>
      )}
      {tab === 'reseller' && (counts?.resellerUnread ?? 0) > 0 && (
        <div className="payment-table-header payment-table-header--end">
          <PaymentTabReadAll
            unread={counts?.resellerUnread ?? 0}
            busy={markingReadAll}
            onClick={() => void readAllTab('reseller')}
          />
        </div>
      )}

      {tab === 'all' && (
        <AllFilters
          cache={cache}
          filters={filters}
          onChange={setFilters}
          reasons={collectReasons(claimItems)}
        />
      )}

      {error && <p className="error">{error}</p>}
      {toast && <p className="toast toast--success">{toast}</p>}
      {!data && status === 'error' && (
        <p className="error">
          Could not load payments.{' '}
          <button type="button" className="ghost" onClick={refresh}>
            تلاش دوباره
          </button>
        </p>
      )}
      {!data && status !== 'error' && <p className="muted">در حال بارگذاری…</p>}
      {data &&
        ((tab === 'income' && incomeItems.length === 0) ||
          (tab === 'declined_income' && declinedItems.length === 0) ||
          (tab === 'reseller' && resellerItems.length === 0) ||
          (tab === 'manually_verified' && claimItems.length === 0) ||
          (tab !== 'income' &&
            tab !== 'declined_income' &&
            tab !== 'reseller' &&
            tab !== 'bot_auto_verified' &&
            tab !== 'manually_verified' &&
            claimItems.length === 0)) && (
          <CompactEmptyState>{emptyText(tab)}</CompactEmptyState>
        )}

      {tab === 'income' && incomeItems.length > 0 && (
        <div
          className={`payment-table-header${
            (counts?.incomeUnread ?? 0) > 0 ? ' payment-table-header--split' : ''
          }`}
        >
          <BulkSelectionToolbar
            itemIds={incomeItems.map((i) => i.id)}
            selectedIds={selectedIncome}
            onChangeSelected={setSelectedIncome}
            actions={
              selectedIncome.size > 0 ? (
                <button type="button" className="ghost payment-table-header__action" onClick={() => setBulkDeclineOpen(true)}>
                  رد انتخاب‌شده‌ها ({selectedIncome.size})
                </button>
              ) : null
            }
          />
          <PaymentTabReadAll
            unread={counts?.incomeUnread ?? 0}
            busy={markingReadAll}
            onClick={() => void readAllTab('income')}
          />
        </div>
      )}
      {tab === 'income' && incomeItems.length === 0 && (counts?.incomeUnread ?? 0) > 0 && (
        <div className="payment-table-header payment-table-header--end">
          <PaymentTabReadAll
            unread={counts?.incomeUnread ?? 0}
            busy={markingReadAll}
            onClick={() => void readAllTab('income')}
          />
        </div>
      )}

      {tab === 'declined_income' && declinedItems.length > 0 && (
        <BulkSelectionToolbar
          itemIds={declinedItems.map((i) => i.id)}
          selectedIds={selectedDeclined}
          onChangeSelected={setSelectedDeclined}
          actions={
            selectedDeclined.size > 0 ? (
              <button
                type="button"
                className="primary"
                onClick={async () => {
                  try {
                    await api.restoreIncomeBulk([...selectedDeclined]);
                    setSelectedDeclined(new Set());
                    cache.refetch(queryKey);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : 'restore_failed');
                  }
                }}
              >
                بازگردانی انتخاب‌شده‌ها ({selectedDeclined.size})
              </button>
            ) : null
          }
        />
      )}

      {tab === 'income' && (
        <ul className="hub-list hub-list--table">
          {incomeItems.map((item) => (
            <IncomeRow
              key={item.id}
              item={item}
              isNew={isIncomeNew(item)}
              selected={selectedIncome.has(item.id)}
              onSelect={(checked) => {
                setSelectedIncome((prev) => {
                  const next = new Set(prev);
                  if (checked) next.add(item.id);
                  else next.delete(item.id);
                  return next;
                });
              }}
              onOpen={() => {
                if (isIncomeNew(item)) {
                  setLocallyReadIncome((prev) => new Set(prev).add(item.id));
                  void markIncomeSeen(item);
                }
              }}
              onAssign={() => {
                if (isIncomeNew(item)) {
                  setLocallyReadIncome((prev) => new Set(prev).add(item.id));
                  void markIncomeSeen(item);
                }
                setAssignIncome(item);
              }}
              onMarkReseller={() => {
                if (isIncomeNew(item)) {
                  setLocallyReadIncome((prev) => new Set(prev).add(item.id));
                  void markIncomeSeen(item);
                }
                setIncomeAction(item);
              }}
              onDecline={() => setDeclineTarget(item)}
            />
          ))}
        </ul>
      )}

      {tab === 'declined_income' && (
        <ul className="hub-list">
          {declinedItems.map((item) => (
            <DeclinedIncomeRow
              key={item.id}
              item={item}
              selected={selectedDeclined.has(item.id)}
              onSelect={(checked) => {
                setSelectedDeclined((prev) => {
                  const next = new Set(prev);
                  if (checked) next.add(item.id);
                  else next.delete(item.id);
                  return next;
                });
              }}
              onRestore={async () => {
                try {
                  await api.restoreIncome(item.id);
                  cache.refetch(queryKey);
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'restore_failed');
                }
              }}
            />
          ))}
        </ul>
      )}

      {tab === 'reseller' && (
        <ul className="hub-list">
          {resellerItems.map((item) => (
            <ResellerRow
              key={item.id}
              item={item}
              {...(item.isNew ? { isNew: true as const } : {})}
              onOpen={() => {
                void markResellerSeen(item);
              }}
            />
          ))}
        </ul>
      )}

      {tab !== 'income' &&
        tab !== 'declined_income' &&
        tab !== 'reseller' &&
        tab !== 'bot_auto_verified' &&
        tab !== 'manually_verified' && (
        <ul className="hub-list hub-list--table">
          {claimItems.map((item) => {
            if (tab === 'needs_review') {
              return (
                <NeedsReviewRow
                  key={item.id}
                  item={item}
                  isNew={isClaimNew(item)}
                  onReview={() => openClaim(item)}
                />
              );
            }
            if (tab === 'waiting') {
              return (
                <WaitingRow key={item.id} item={item} onDetails={() => setReviewingId(item.id)} />
              );
            }
            if (tab === 'suspected_fake') {
              return (
                <SuspectedFakeRow
                  key={item.id}
                  item={item}
                  isNew={isClaimNew(item)}
                  onReview={() => openClaim(item)}
                  onRemove={() =>
                    post(`/api/v1/suspects/${item.id}/reject`, { reason: 'NO_BANK_TRANSACTION' })
                  }
                  onError={setError}
                />
              );
            }
            return (
              <AllRow key={item.id} item={item} onOpen={() => setReviewingId(item.id)} />
            );
          })}
        </ul>
      )}

      {tab === 'manually_verified' && (
        <ul className="hub-list hub-list--table">
          {claimItems.map((item) => (
            <ManuallyVerifiedRow
              key={item.id}
              item={item}
              onOpen={() => setReviewingId(item.id)}
              onReopen={() => setReopenTarget(item)}
            />
          ))}
        </ul>
      )}

      {tab === 'bot_auto_verified' && claimItems.length > 0 && (
        <div className={`bot-verified-layout${isWide ? ' bot-verified-layout--wide' : ''}`}>
          <div className="bot-verified-layout__main">
            <BotAutoVerifiedFilter
              value={botAutoFilter.value}
              onSegmentChange={botAutoFilter.setSegment}
              onDateChange={botAutoFilter.setDate}
            />
            <BotVerifiedMetrics analytics={analytics} items={claimItems} />
            <BotVerifiedTable>
              {claimItems.map((item) => (
                <BotVerifiedTransactionRow
                  key={item.id}
                  item={item}
                  isNew={isClaimNew(item)}
                  onOpen={() => openClaim(item)}
                />
              ))}
            </BotVerifiedTable>
          </div>
          {isWide && (
            <div className="bot-verified-layout__rail">
              <StatsRail analytics={analytics} cache={cache} rangeState={rangeState} />
              <RecentActivity
                items={claimItems}
                onOpen={(id) => {
                  const item = claimItems.find((i) => i.id === id);
                  if (item) openClaim(item);
                }}
              />
            </div>
          )}
        </div>
      )}

      {tab === 'bot_auto_verified' && claimItems.length === 0 && data && (
        <div className="bot-verified-empty">
          <BotAutoVerifiedFilter
            value={botAutoFilter.value}
            onSegmentChange={botAutoFilter.setSegment}
            onDateChange={botAutoFilter.setDate}
          />
          <CompactEmptyState>{emptyText(tab)}</CompactEmptyState>
        </div>
      )}

      {declineTarget && (
        <DeclineIncomeModal
          item={declineTarget}
          onClose={() => setDeclineTarget(null)}
          onDone={() => {
            setDeclineTarget(null);
            setSelectedIncome(new Set());
            cache.refetch(queryKey);
          }}
          onError={setError}
        />
      )}
      {bulkDeclineOpen && selectedIncome.size > 0 && (
        <BulkDeclineModal
          items={incomeItems.filter((i) => selectedIncome.has(i.id))}
          onClose={() => setBulkDeclineOpen(false)}
          onDone={() => {
            setBulkDeclineOpen(false);
            setSelectedIncome(new Set());
            cache.refetch(queryKey);
          }}
          onError={setError}
        />
      )}
      {incomeAction && (
        <MarkResellerModal
          item={incomeAction}
          cache={cache}
          onClose={() => setIncomeAction(null)}
          onDone={() => {
            setIncomeAction(null);
            cache.refetch(queryKey);
          }}
          onError={setError}
        />
      )}
      {assignIncome && (
        <AssignToPaymentModal
          transactionId={assignIncome.id}
          transactionAmountIrr={assignIncome.amountIrr}
          onClose={() => {
            setAssignIncome(null);
            cache.refetch(queryKey);
          }}
          onError={setError}
        />
      )}
      {reopenTarget && (
        <ReopenVerificationModal
          item={reopenTarget}
          onClose={() => setReopenTarget(null)}
          onDone={() => {
            setReopenTarget(null);
            setToast('تایید دوباره باز شد');
            setTimeout(() => setToast(null), 4000);
            cache.refetch(queryKey, QK.suggested, QK.today);
          }}
          onError={setError}
        />
      )}
      <Drawer
        open={reviewing != null}
        onClose={() => setReviewingId(null)}
        label="بررسی پرداخت"
        side="right"
      >
        {reviewing && (
          <ReviewPanel
            key={reviewing.id}
            item={reviewing}
            cache={cache}
            onRefresh={() => cache.refetch(queryKey, QK.suggested, QK.today)}
            onApprove={(transactionId) =>
              post(`/api/v1/suspects/${reviewing.id}/approve`, { transactionId })
            }
            onVerifyManual={(reason) =>
              post(`/api/v1/suspects/${reviewing.id}/verify-manual`, { reason })
            }
            onReassign={(body) =>
              post(`/api/v1/payment-claims/${reviewing.id}/reassign-transaction`, body)
            }
            onReject={(reason) => post(`/api/v1/suspects/${reviewing.id}/reject`, { reason })}
            onRemove={() =>
              post(`/api/v1/suspects/${reviewing.id}/reject`, { reason: 'NO_BANK_TRANSACTION' })
            }
            onMarkFake={() => post(`/api/v1/suspects/${reviewing.id}/mark-fake`, { confirmed: true })}
            onReopen={() => setReopenTarget(reviewing)}
            onError={setError}
          />
        )}
      </Drawer>
        </div>
        </div>
        <div className="payments-shell__decor" aria-hidden="true" />
      </section>
    </>
  );
}

function emptyText(tab: PaymentTab): string {
  if (tab === 'needs_review') return 'چیزی نیاز به بررسی ندارد.';
  if (tab === 'income') return 'در این بازه واریزی تخصیص‌نیافته‌ای نیست.';
  if (tab === 'declined_income') return 'در این بازه واریزی ردشده‌ای نیست.';
  if (tab === 'waiting') return 'پرداختی در انتظار نیست.';
  if (tab === 'suspected_fake') return 'رسید مشکوکی در انتظار بررسی نیست.';
  if (tab === 'bot_auto_verified') return 'در این بازه پرداختی با تایید خودکار ربات نیست.';
  if (tab === 'manually_verified') return 'در این بازه پرداختی با تایید دستی نیست.';
  if (tab === 'reseller') return 'در این بازه پرداخت نمایندگی نیست.';
  return 'پرداختی پیدا نشد.';
}

function collectReasons(items: PaymentItem[]): string[] {
  return [...new Set(items.map((i) => i.suspectReason).filter((r): r is string => r != null))];
}

function paymentIdentityLine(item: PaymentItem): string {
  const parts: string[] = [];
  if (item.telegramUsername) parts.push(`@${item.telegramUsername}`);
  if (item.telegramUserId) parts.push(item.telegramUserId);
  return parts.join(' · ');
}

function paymentDeviceLine(item: PaymentItem): string {
  return `دستگاه: ${deviceInlineLabel(item.device)}`;
}

function NeedsReviewRow({
  item,
  isNew,
  onReview,
}: {
  item: PaymentItem;
  isNew?: boolean;
  onReview: () => void;
}) {
  const identity = paymentIdentityLine(item);
  const masked = maskAccountHint(item.accountHint, item.cardMasked);

  return (
    <li className={`hub-list-row hub-list-row--review${isNew ? ' hub-list-row--new' : ''}`}>
      <button
        type="button"
        className="hub-list-row__button"
        aria-label={`Review payment from ${identity || item.orderId}`}
        onClick={onReview}
      >
        <div className="hub-list-row__line1">
          <span className="hub-list-row__identity">
            <NewBadge isNew={isNew} />
            {identity && <strong>{identity}</strong>}
          </span>
          <span className="hub-list-row__amount tabular-nums">{formatToman(item.expectedAmountToman)}</span>
        </div>
        <div className="hub-list-row__line2 muted">
          سفارش {item.orderId} · {masked} · {paymentDeviceLine(item)}
        </div>
        <div className="hub-list-row__line3 payment-reason">
          <StatusBadge tone="review">نیاز به بررسی</StatusBadge>
          <span className="payment-reason__text">{reasonText(item.suspectReason)}</span>
        </div>
      </button>
    </li>
  );
}

function WaitingRow({ item, onDetails }: { item: PaymentItem; onDetails: () => void }) {
  const identity = paymentIdentityLine(item);
  const masked = maskAccountHint(item.accountHint, item.cardMasked);
  const waitNote =
    item.waitingRemainingMs != null
      ? formatRelativeFuture(item.waitingRemainingMs)
      : 'در انتظار واریز بانکی';

  return (
    <li className="hub-list-row hub-list-row--waiting">
      <button type="button" className="hub-list-row__button" onClick={onDetails}>
        <div className="hub-list-row__line1">
          <span className="hub-list-row__identity">{identity && <strong>{identity}</strong>}</span>
          <span className="hub-list-row__amount tabular-nums">{formatToman(item.expectedAmountToman)}</span>
        </div>
        <div className="hub-list-row__line2 muted">
          سفارش {item.orderId} · {masked} · {paymentDeviceLine(item)}
        </div>
        <div className="hub-list-row__line3">
          <StatusBadge tone="waiting">{waitNote}</StatusBadge>
        </div>
      </button>
    </li>
  );
}

function SuspectedFakeRow({
  item,
  isNew,
  onReview,
  onRemove,
  onError,
}: {
  item: PaymentItem;
  isNew?: boolean;
  onReview: () => void;
  onRemove: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const identity = paymentIdentityLine(item);
  const masked = maskAccountHint(item.accountHint, item.cardMasked);

  async function runRemove() {
    setBusy(true);
    try {
      await onRemove();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'remove_failed');
    } finally {
      setBusy(false);
      setConfirmRemove(false);
    }
  }

  return (
    <li className={`hub-list-row hub-list-row--suspected${isNew ? ' hub-list-row--new' : ''}`}>
      <button
        type="button"
        className="hub-list-row__button"
        aria-label={`Review suspected fake from ${identity || item.orderId}`}
        onClick={onReview}
      >
        <div className="hub-list-row__line1">
          <span className="hub-list-row__identity">
            <NewBadge isNew={isNew} />
            {identity && <strong>{identity}</strong>}
          </span>
          <span className="hub-list-row__amount tabular-nums">{formatToman(item.expectedAmountToman)}</span>
        </div>
        <div className="hub-list-row__line2 muted">
          سفارش {item.orderId} · {masked} · {paymentDeviceLine(item)}
        </div>
        <div className="hub-list-row__line3 payment-reason">
          <StatusBadge tone="suspected">{reasonText(item.suspectReason)}</StatusBadge>
        </div>
      </button>
      <div className="hub-list-row__inline-actions">
        {!confirmRemove ? (
          <button type="button" className="ghost hub-list-row__action" disabled={busy} onClick={() => setConfirmRemove(true)}>
            حذف
          </button>
        ) : (
          <>
            <button type="button" className="danger hub-list-row__action" disabled={busy} onClick={() => void runRemove()}>
              تایید
            </button>
            <button type="button" className="ghost hub-list-row__action" disabled={busy} onClick={() => setConfirmRemove(false)}>
              انصراف
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function maskAccountHint(hint: string | null, cardMasked: string | null): string {
  if (hint) return `****${hint.replace(/\s/g, '')}`;
  if (cardMasked) {
    const digits = cardMasked.replace(/\D/g, '');
    if (digits.length >= 4) return `****${digits.slice(-4)}`;
  }
  return '****';
}

function ManuallyVerifiedRow({
  item,
  onOpen,
  onReopen,
}: {
  item: PaymentItem;
  onOpen: () => void;
  onReopen: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const identity = paymentIdentityLine(item);
  const masked = maskAccountHint(item.accountHint, item.cardMasked);
  const verifiedAt = item.matchedTransaction?.verifiedAt;
  const operator = item.matchedTransaction?.verifiedBy;
  const txLabel = item.matchedTransaction
    ? `+${formatTomanFromIrr(item.matchedTransaction.amountIrr)}`
    : 'هیچ‌کدام';
  const canReopen = isReopenEligible(item);
  const reopenBlocked = reopenBlockedReason(item);

  return (
    <li className="hub-list-row hub-list-row--manual">
      <button type="button" className="hub-list-row__button" onClick={onOpen}>
        <div className="hub-list-row__line1">
          <span className="hub-list-row__identity">
            {identity && <strong>{identity}</strong>}
            <span className="muted">سفارش {item.orderId}</span>
          </span>
          <span className="hub-list-row__amount tabular-nums">{formatToman(item.expectedAmountToman)}</span>
        </div>
        <div className="hub-list-row__line2 muted">
          {masked}
          {verifiedAt != null && <> · تایید {formatTimeAgo(verifiedAt)}</>}
          {operator && <> · توسط {operator}</>}
          <> · تراکنش {txLabel}</>
          <> · تحویل {item.fulfillmentState ?? 'نامشخص'}</>
        </div>
      </button>
      <div className="hub-list-row__menu">
        <button
          type="button"
          className="ghost hub-list-row__menu-trigger"
          aria-label="عملیات"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          ⋮
        </button>
        {menuOpen && (
          <div className="hub-list-row__menu-panel" role="menu">
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onOpen(); }}>
              جزئیات
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!canReopen}
              title={reopenBlocked ?? undefined}
              aria-disabled={!canReopen}
              onClick={() => {
                if (!canReopen) return;
                setMenuOpen(false);
                onReopen();
              }}
            >
              بازکردن دوبارهٔ تایید
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function ReopenVerificationModal({
  item,
  onClose,
  onDone,
  onError,
}: {
  item: PaymentItem;
  onClose: () => void;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const identity = paymentIdentityLine(item);
  const verifiedAt = item.matchedTransaction?.verifiedAt;
  const operator = item.matchedTransaction?.verifiedBy;

  async function submit() {
    if (!reason.trim()) {
      onError('reason_required');
      return;
    }
    setBusy(true);
    try {
      await api.reopenManualVerification(item.id, reason.trim());
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'reopen_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="بازکردن دوبارهٔ تایید دستی"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-body">
        <h3>تایید دستی دوباره باز شود؟</h3>
        <p>تصمیم تطبیق برای این مورد دوباره باز می‌شود:</p>
        <dl className="payment-review__facts">
          <dt>مشتری</dt>
          <dd>{identity || '—'}</dd>
          <dt>سفارش</dt>
          <dd>{item.orderId}</dd>
          <dt>مبلغ مورد انتظار</dt>
          <dd className="tabular-nums">{formatToman(item.expectedAmountToman)}</dd>
          {operator && (
            <>
              <dt>تاییدکننده</dt>
              <dd>{operator}</dd>
            </>
          )}
          {verifiedAt != null && (
            <>
              <dt>زمان تایید</dt>
              <dd>{formatTimeAgo(verifiedAt)}</dd>
            </>
          )}
        </dl>
        <p className="muted">
          تحویلی که انجام شده دوباره انجام نمی‌شود و خودکار هم برنمی‌گردد.
        </p>
        <label>
          دلیل (الزامی)
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={2000}
            rows={3}
          />
        </label>
        <div className="payment-review__actions">
          <button type="button" className="primary" disabled={busy || !reason.trim()} onClick={() => void submit()}>
            بازکردن دوبارهٔ تایید
          </button>
          <button type="button" className="ghost" disabled={busy} onClick={onClose}>
            انصراف
          </button>
        </div>
      </div>
    </div>
  );
}

function AllRow({
  item,
  onOpen,
}: {
  item: PaymentItem;
  onOpen: () => void;
}) {
  const identity = paymentIdentityLine(item);
  const masked = maskAccountHint(item.accountHint, item.cardMasked);

  return (
    <li className="hub-list-row">
      <button type="button" className="hub-list-row__button" onClick={onOpen}>
        <div className="hub-list-row__line1">
          <span className="hub-list-row__identity">
            {identity && <strong>{identity}</strong>}
            <span className={`status-pill status-pill--${item.reviewState.toLowerCase()}`}>
              {stateLabel(item.reviewState)}
            </span>
          </span>
          <span className="hub-list-row__amount tabular-nums">{formatToman(item.expectedAmountToman)}</span>
        </div>
        <div className="hub-list-row__line2 muted">
          سفارش {item.orderId} · {masked} · {paymentDeviceLine(item)}
        </div>
      </button>
    </li>
  );
}

function AllFilters({
  cache,
  filters,
  onChange,
  reasons,
}: {
  cache: Cache;
  filters: Filters;
  onChange: (f: Filters) => void;
  reasons: string[];
}) {
  const { data } = cache.useQuery<{
    items: Array<{ id: string; display_name: string; bank_name: string }>;
  }>(QK.accounts, {
    fetcher: async (signal) => {
      const r = await fetch('/api/v1/accounts', { signal });
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
  });
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  return (
    <div className="payments-filters">
      <label>
        وضعیت
        <select value={filters.status} onChange={(e) => set({ status: e.target.value })}>
          <option value="">Any</option>
          {ALL_TAB_STATES.map((s) => (
            <option key={s} value={s}>
              {stateLabel(s)}
            </option>
          ))}
        </select>
      </label>
      <label>
        حساب
        <select value={filters.accountId} onChange={(e) => set({ accountId: e.target.value })}>
          <option value="">Any</option>
          {(data?.items ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.display_name}
            </option>
          ))}
        </select>
      </label>
      <label>
        دلیل
        <select value={filters.reason} onChange={(e) => set({ reason: e.target.value })}>
          <option value="">Any</option>
          {reasons.map((r) => (
            <option key={r} value={r}>
              {reasonText(r)}
            </option>
          ))}
        </select>
      </label>
      <label>
        از
        <input type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} />
      </label>
      <label>
        To
        <input type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} />
      </label>
      <button type="button" className="ghost" onClick={() => onChange(EMPTY_FILTERS)}>
        پاک کردن
      </button>
    </div>
  );
}

const REJECT_REASONS = [
  { value: 'NO_BANK_TRANSACTION', label: 'هیچ واریزی نرسید' },
  { value: 'FAKE_RECEIPT', label: 'رسید جعلی' },
  { value: 'DUPLICATE', label: 'پرداخت تکراری' },
  { value: 'OTHER', label: 'سایر' },
] as const;

function ReviewPanel({
  item,
  cache,
  onRefresh,
  onApprove,
  onVerifyManual,
  onReassign,
  onReject,
  onRemove,
  onMarkFake,
  onReopen,
  onError,
}: {
  item: PaymentItem;
  cache: Cache;
  onRefresh: () => void;
  onApprove: (transactionId: string) => Promise<void>;
  onVerifyManual: (reason: string) => Promise<void>;
  onReassign: (body: {
    transactionId: string;
    reason: string;
    verifyAfterAssign: boolean;
  }) => Promise<void>;
  onReject: (reason: string) => Promise<void>;
  onRemove: () => Promise<void>;
  onMarkFake: () => Promise<void>;
  onReopen: () => void;
  onError: (message: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(() => defaultCandidateId(item));
  const [rejectReason, setRejectReason] = useState<string>('NO_BANK_TRANSACTION');
  const [confirmFake, setConfirmFake] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmManual, setConfirmManual] = useState(false);
  const [manualReason, setManualReason] = useState('');
  const [showReassign, setShowReassign] = useState(false);
  const [busy, setBusy] = useState(false);
  const actionable = item.reviewState === 'NEEDS_REVIEW' || item.reviewState === 'SUSPECTED_FAKE';
  const canMarkFake = item.reviewState === 'SUSPECTED_FAKE';
  const isManuallyVerified = item.reviewState === 'MANUALLY_VERIFIED';
  const canReopen = isReopenEligible(item);
  const reopenBlocked = reopenBlockedReason(item);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'action_failed');
    } finally {
      setBusy(false);
    }
  }

  if (showReassign) {
    return (
      <TransactionReassignPicker
        item={item}
        cache={cache}
        onClose={() => setShowReassign(false)}
        onError={onError}
        onReassign={async (body) => {
          await onReassign(body);
          setShowReassign(false);
        }}
      />
    );
  }

  return (
    <div className="payment-review">
      <h2 className="drawer-title">بررسی پرداخت</h2>

      <section className="drawer-section">
        <h3 className="drawer-section__heading">هویت</h3>
        <PaymentIdentity item={item} />
      </section>

      <section className="drawer-section">
        <h3 className="drawer-section__heading">پرداخت</h3>
        <dl className="payment-review__facts">
          <dt>مبلغ مورد انتظار</dt>
          <dd className="tabular-nums">
            {formatToman(item.expectedAmountToman)}
          </dd>
          <dt>کارت نمایش‌داده‌شده</dt>
          <dd>{item.cardMasked ?? '—'}</dd>
          <dt>وضعیت</dt>
          <dd>{stateLabel(item.reviewState)}</dd>
        </dl>
      </section>

      <section className="drawer-section">
        <h3 className="drawer-section__heading">دستگاه</h3>
        <p>{deviceInlineLabel(item.device)}</p>
      </section>

      <section className="drawer-section">
        <h3 className="drawer-section__heading">حساب</h3>
        <AccountRef account={item} />
        {actionable && (
          <ClaimChangeAccount
            item={item}
            cache={cache}
            onSaved={onRefresh}
            onError={onError}
          />
        )}
      </section>

      {(actionable || item.matchedTransaction) && (
        <section className="drawer-section">
          <h3 className="drawer-section__heading">تراکنش</h3>
          {item.matchedTransaction ? (
            <p className="tabular-nums">
              {item.matchedTransaction.bankTimestamp
                ? formatTimeSeconds(item.matchedTransaction.bankTimestamp)
                : '—'}{' '}
              · +{formatTomanFromIrr(item.matchedTransaction.amountIrr)}
              {item.matchedTransaction.timeDeltaSeconds != null &&
                ` · Δ ${item.matchedTransaction.timeDeltaSeconds} sec`}
            </p>
          ) : (
            <p className="muted">هنوز چیزی وصل نشده</p>
          )}
          {actionable && (
            <>
              {item.candidates.length === 0 ? (
                <p className="muted">هیچ تراکنش بانکی در فهرست نامزدهای نزدیک نیست.</p>
              ) : (
                <ul className="payment-candidates">
                  {item.candidates.map((c) => (
                    <li key={c.id}>
                      <label>
                        <input
                          type="radio"
                          name="candidate"
                          value={c.id}
                          checked={selected === c.id}
                          disabled={c.alreadyConsumed}
                          onChange={() => setSelected(c.id)}
                        />
                        <span>
                          <strong>
                            {c.bankTimestamp ? formatTimeSeconds(c.bankTimestamp) : '—'}
                          </strong>
                          <br />+{formatTomanFromIrr(c.amountIrr)}
                          <br />
                          <AccountRef account={c} />
                          {c.timeDeltaSeconds != null && <> · Δ {c.timeDeltaSeconds} sec</>}
                          {c.alreadyConsumed && (
                            <>
                              {' '}
                              · <span className="muted">already used</span>
                            </>
                          )}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      )}

      <section className="drawer-section">
        <h3 className="drawer-section__heading">تصمیم</h3>
        <p className="payment-reason">
          {actionable && item.reviewState === 'NEEDS_REVIEW' && (
            <span className="payment-reason__flag">نیاز به بررسی</span>
          )}{' '}
          {actionable && item.reviewState === 'SUSPECTED_FAKE' && (
            <span className="payment-reason__flag">مشکوک به جعل</span>
          )}{' '}
          {reasonText(item.suspectReason)}
        </p>

      {actionable && (
        <>
          <div className="payment-review__actions">
            <button
              type="button"
              className="primary"
              disabled={busy || selected == null}
              onClick={() => selected && run(() => onApprove(selected))}
            >
              تایید انتخاب‌شده‌ها
            </button>

            <div className="payment-review__reassign">
              <p className="muted">تراکنش درست را پیدا نمی‌کنی؟</p>
              <button type="button" className="ghost" disabled={busy} onClick={() => setShowReassign(true)}>
                یافتن یا تغییر تراکنش
              </button>
            </div>

            <div className="payment-review__manual-anyway">
              <p className="muted">اصلاً تراکنش بانکی وجود ندارد؟</p>
              {!confirmManual ? (
                <button type="button" className="ghost" disabled={busy} onClick={() => setConfirmManual(true)}>
                  با این حال دستی تایید کن
                </button>
              ) : (
                <>
                  <p className="muted">
                    بیرون از سامانه تایید شده و تراکنش بانکی قابل استفاده‌ای این‌جا نیست؟
                  </p>
                  <label>
                    دلیل (اختیاری)
                    <input
                      type="text"
                      value={manualReason}
                      maxLength={2000}
                      onChange={(e) => setManualReason(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => run(() => onVerifyManual(manualReason))}
                  >
                    تایید دستی پرداخت
                  </button>
                  <button type="button" className="ghost" disabled={busy} onClick={() => setConfirmManual(false)}>
                    انصراف
                  </button>
                </>
              )}
            </div>

            {canMarkFake && (
              <div className="payment-review__remove">
                {!confirmRemove ? (
                  <button type="button" className="ghost" disabled={busy} onClick={() => setConfirmRemove(true)}>
                    حذف
                  </button>
                ) : (
                  <>
                    <p className="muted">
                      Remove this payment from the queue? No bank transfer was found — this is not
                      a fraud classification.
                    </p>
                    <button type="button" className="danger" disabled={busy} onClick={() => run(onRemove)}>
                      تایید حذف
                    </button>
                    <button type="button" className="ghost" disabled={busy} onClick={() => setConfirmRemove(false)}>
                      انصراف
                    </button>
                  </>
                )}
              </div>
            )}
            {canMarkFake && (
              <div className="payment-review__mark-fake">
                {!confirmFake ? (
                  <button type="button" className="danger" disabled={busy} onClick={() => setConfirmFake(true)}>
                    علامت‌زدن به‌عنوان جعلی
                  </button>
                ) : (
                  <>
                    <p className="muted">
                      این پرداخت به‌عنوان رسید جعلی علامت زده شود؟ این یک تشخیص دستی تقلب است.
                    </p>
                    <button type="button" className="danger" disabled={busy} onClick={() => run(onMarkFake)}>
                      تایید جعلی‌بودن رسید
                    </button>
                    <button type="button" className="ghost" disabled={busy} onClick={() => setConfirmFake(false)}>
                      انصراف
                    </button>
                  </>
                )}
              </div>
            )}
            {item.reviewState === 'NEEDS_REVIEW' && (
              <div className="payment-review__reject">
                <select
                  aria-label="دلیل رد"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                >
                  {REJECT_REASONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => run(() => onReject(rejectReason))}
                >
                  رد پرداخت
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {!actionable && item.matchedTransaction && !isManuallyVerified && (
        <p className="muted">{stateLabel(item.reviewState)}</p>
      )}

      {isManuallyVerified && (
        <div className="payment-review__reopen">
          <p className="muted">
            {canReopen
              ? 'Send this payment back to the review queue. Existing fulfillment will not be reversed automatically.'
              : reopenBlocked}
          </p>
          <button
            type="button"
            className="ghost"
            disabled={busy || !canReopen}
            title={reopenBlocked ?? undefined}
            aria-disabled={!canReopen}
            onClick={() => {
              if (!canReopen) return;
              onReopen();
            }}
          >
            بازکردن دوبارهٔ تایید
          </button>
        </div>
      )}
      </section>
    </div>
  );
}

function DeclineIncomeModal({
  item,
  onClose,
  onDone,
  onError,
}: {
  item: IncomeItem;
  onClose: () => void;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.declineIncome(item.id, reason.trim() || undefined);
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'decline_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <h2>این واریزی رد شود؟</h2>
        <p>
          مبلغ: <strong>{formatTomanFromIrr(item.amountIrr)}</strong>
        </p>
        <p>
          حساب: <AccountRef account={item} />
        </p>
        <p className="muted">
          This will remove it from active Income. The original bank transaction will remain intact
          and can be restored later.
        </p>
        <label>
          دلیل
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <div className="modal__actions">
          <button type="button" className="ghost" disabled={busy} onClick={onClose}>
            انصراف
          </button>
          <button type="button" className="danger" disabled={busy} onClick={() => void submit()}>
            رد
          </button>
        </div>
      </div>
    </div>
  );
}

function BulkDeclineModal({
  items,
  onClose,
  onDone,
  onError,
}: {
  items: IncomeItem[];
  onClose: () => void;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const total = items.reduce((s, i) => s + (i.amountIrr ?? 0), 0);

  async function submit() {
    setBusy(true);
    try {
      await api.declineIncomeBulk(
        items.map((i) => i.id),
        reason.trim() || undefined,
      );
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'decline_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <h2>واریزی‌های انتخاب‌شده رد شوند؟</h2>
        <p>
          تراکنش‌ها: <strong>{items.length}</strong>
        </p>
        <p>
          مبلغ کل: <strong>{formatTomanFromIrr(total)}</strong>
        </p>
        <label>
          دلیل
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <div className="modal__actions">
          <button type="button" className="ghost" disabled={busy} onClick={onClose}>
            انصراف
          </button>
          <button type="button" className="danger" disabled={busy} onClick={() => void submit()}>
            رد انتخاب‌شده‌ها
          </button>
        </div>
      </div>
    </div>
  );
}
