/**
 * Payment review inbox for Mirzabot claims.
 *
 * Five operational buckets — what needs a human, what is still waiting, what
 * looks suspicious, what the engine handled, and the full history.
 */

import { useEffect, useState } from 'react';
import type { Cache } from './query.js';
import { QK } from './queries.js';
import { formatTomanFromIrr, formatTimeSeconds } from './format.js';
import { count } from '../format.js';
import { IdentifierText } from './IdentifierText.js';
import { ClaimChangeAccount } from './ClaimChangeAccount.js';
import { TransactionReassignPicker } from './TransactionReassignPicker.js';
import { BotAutoVerifiedFilter, useBotAutoVerifiedFilter } from './BotAutoVerifiedFilter.js';
import {
  HeaderPrimaryOpsNav,
  ReviewSubNav,
  parsePaymentTabFromLocation,
  parseReviewIdFromLocation,
  syncPaymentTabToLocation,
  syncReviewToLocation,
  level1GroupFromTab,
} from './paymentsNav.js';
import { HeaderSlot } from './shikoonetShell.js';
import { useWriteProps } from '../role.js';
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
import { FulfilWithoutPaymentModal } from './FulfilWithoutPaymentModal.js';

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
  /** Full digits of one of the shop's cards — «چقدر به این کارت ریخته شد». */
  cardDigits: string;
  /** A Telegram id — «این آی‌دی چند بار و به کدام کارت‌ها واریز داشته». */
  telegramId: string;
}

const EMPTY_FILTERS: Filters = {
  status: '',
  accountId: '',
  reason: '',
  from: '',
  to: '',
  cardDigits: '',
  telegramId: '',
};

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
    // The DAY, not an instant. `Date.parse('2026-08-23T00:00:00')` has no zone,
    // so it meant midnight wherever the operator was sitting — up to three and
    // a half hours of claims off either edge of a money filter. The server
    // resolves the Tehran day, which is the only place that is already right.
    if (filters.from) qs.set('fromDay', filters.from);
    if (filters.to) qs.set('toDay', filters.to);
    if (filters.cardDigits) qs.set('cardDigits', filters.cardDigits);
    if (filters.telegramId) qs.set('telegramId', filters.telegramId);
  }
  return qs.toString();
}

function isPaymentItem(
  item: PaymentItem | IncomeItem | DeclinedIncomeItem | ResellerItem,
): item is PaymentItem {
  return 'reviewState' in item;
}

export function PaymentsView({ cache }: { cache: Cache }) {
  const w = useWriteProps();
  const [tab, setTab] = useState<PaymentTab>(() => parsePaymentTabFromLocation());
  const isWide = useMediaQuery('(min-width: 1200px)');
  const [rangeState, setRangeState] = useState<HistoryRangeState>(defaultHistoryRangeState());
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  // DEV-only: filters specific to the Bot Auto Verified tab.
  const botAutoFilter = useBotAutoVerifiedFilter();
  const [reviewingId, setReviewingId] = useState<string | null>(() => parseReviewIdFromLocation());
  const [incomeAction, setIncomeAction] = useState<IncomeItem | null>(null);
  const [assignIncome, setAssignIncome] = useState<IncomeItem | null>(null);
  const [declineTarget, setDeclineTarget] = useState<IncomeItem | null>(null);
  const [bulkDeclineOpen, setBulkDeclineOpen] = useState(false);
  const [selectedIncome, setSelectedIncome] = useState<Set<string>>(new Set());
  const [selectedDeclined, setSelectedDeclined] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [reopenTarget, setReopenTarget] = useState<PaymentItem | null>(null);
  const [fulfilTarget, setFulfilTarget] = useState<PaymentItem | null>(null);
  const [locallyReadClaims, setLocallyReadClaims] = useState<Set<string>>(new Set());
  const [locallyReadIncome, setLocallyReadIncome] = useState<Set<string>>(new Set());
  const [markingReadAll, setMarkingReadAll] = useState(false);

  useEffect(() => {
    const onPop = () => {
      setTab(parsePaymentTabFromLocation());
      // Back out of a review and you land on the queue you came from, with its
      // tab and filters intact — which is what `pushState` in `openReview` is
      // for. Without this line the address changed and the screen did not.
      setReviewingId(parseReviewIdFromLocation());
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  function selectTab(next: PaymentTab) {
    setTab(next);
    syncPaymentTabToLocation(next);
  }

  const baseQuery = buildQuery(
    tab,
    rangeState,
    filters,
    tab === 'bot_auto_verified' ? botAutoFilter.toQueryParams() : undefined,
  );
  /*
   * Page 1 whenever anything else about the question changes.
   *
   * Keyed on the query string rather than reset inside each setter: the tab,
   * the range, six filters and the bot-auto segmented control all change what
   * is being asked, and a reset that has to be remembered in nine places is a
   * reset that will be forgotten in one -- leaving an operator on «page 4» of
   * a filter that now matches two rows, looking at an empty list.
   */
  useEffect(() => {
    setPage(1);
  }, [baseQuery]);
  const query = page > 1 ? `${baseQuery}&page=${page}` : baseQuery;
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
  const inLoadedPage = claimItems.find((i) => i.id === reviewingId) ?? null;

  /**
   * The claim a `?claim=` link points at, when it is not on the page in hand.
   *
   * `claimItems` is one `LIMIT 200` slice of one tab, and the review page used
   * to resolve the link by searching it and nothing else. So the link worked
   * for a claim near the top of the queue you happened to be on, and for
   * every other claim it rendered «این پرداخت در فهرست باز نیست» — which reads
   * as "somebody already decided this" and was not what happened. Found in the
   * browser on 2026-08-25, on a queue of 505, using a link I had handed Sam an
   * hour earlier.
   *
   * The key is the id, so opening the same payment twice costs one request,
   * and it is only ever asked for when the list did not already answer.
   */
  const needsFetch = reviewingId !== null && inLoadedPage === null;
  // A constant key when there is nothing to fetch, rather than a conditional
  // hook: the comment on the early return below is a promise that every hook
  // in this component runs unconditionally, and it is worth keeping.
  const { data: fetchedClaim } = cache.useQuery<PaymentsResponse>(
    needsFetch ? QK.payments(`claim=${reviewingId}`) : QK.payments('claim=idle'),
    {
      fetcher: async (signal) => {
        if (!needsFetch) return { items: [] };
        const r = await fetch(`/api/v1/payments?claim=${encodeURIComponent(reviewingId)}`, {
          signal,
        });
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      },
    },
  );
  const reviewing =
    inLoadedPage ?? (needsFetch ? ((fetchedClaim?.items ?? []).filter(isPaymentItem)[0] ?? null) : null);

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

  /**
   * Open a payment for review — and say so in the address bar.
   *
   * Every row goes through here now. Three of them used to call
   * `setReviewingId` directly, which opened the same panel at the same size
   * with no address and no way back, so whether the review had a URL depended
   * on which row you clicked.
   */
  function openReview(item: PaymentItem) {
    setReviewingId(item.id);
    syncReviewToLocation(item.id);
  }

  function openClaim(item: PaymentItem) {
    setLocallyReadClaims((prev) => new Set(prev).add(item.id));
    void markClaimSeen(item);
    openReview(item);
  }

  function closeReview() {
    setReviewingId(null);
    syncReviewToLocation(null);
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
    closeReview();
    cache.refetch(queryKey, QK.suggested, QK.today);
  }

  /*
   * The review, when there is one — and it takes the whole screen.
   *
   * It used to live in `<Drawer side="right">`, which is
   * `width: min(360px, 90vw)`: four hundred and ninety-three lines about a
   * real payment, in a column narrower than the phone in your pocket, over a
   * list you could still half-see. Sam's words for the result were «نمیدونم چی
   * به چیه».
   *
   * An early return rather than a branch inside the tree below, because the
   * queue is not behind this page — it is replaced by it. Rendering both and
   * hiding one would keep the list's fetches, its keyboard focus and its
   * scroll position alive underneath, which is most of what made the drawer
   * feel like a lid rather than a screen.
   *
   * Every hook this component has runs above; nothing below is conditional.
   */
  if (reviewingId !== null) {
    return (
      <>
        <HeaderSlot slot="center">
          <HeaderPrimaryOpsNav tab={tab} counts={counts} onChange={selectTab} />
        </HeaderSlot>

        <section className="payments-shell">
          <div className="payments-shell__surface">
            <div className="review-page" data-testid="review-page">
              <div className="review-page__bar">
                <button type="button" className="btn btn-ghost" onClick={closeReview}>
                  → بازگشت به صف
                </button>
                <h2 className="review-page__title">بررسی پرداخت</h2>
                {/*
                  The fulfil action used to live here, in the page bar, and that
                  is half of why «هیچ کاری نمی‌شود کرد» was the report. It moved
                  into «تصمیم» — see `canFulfil` in `ReviewPanel` — because that
                  section is where every other decision about a claim is taken,
                  and for a `WAITING` claim it held one sentence and no control
                  at all. A button in the title bar of a page whose body says
                  «در انتظار واریز بانکی» is not an action an operator finds.
                */}
              </div>

              {error && <div className="alert alert-error">{error}</div>}

              {reviewing === null ? (
                /*
                 * An address that names a payment this list does not hold —
                 * a link opened after the payment was decided, or with another
                 * tab selected. Said out loud rather than silently falling back
                 * to the queue, because a link that quietly shows you something
                 * else is worse than one that does not work.
                 */
                <div className="empty">
                  {status === 'loading'
                    ? 'در حال خواندن…'
                    : 'این پرداخت در فهرست باز نیست — شاید تصمیمش گرفته شده یا در تب دیگری است.'}
                </div>
              ) : (
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
                    post(`/api/v1/suspects/${reviewing.id}/reject`, {
                      reason: 'NO_BANK_TRANSACTION',
                    })
                  }
                  onMarkFake={() =>
                    post(`/api/v1/suspects/${reviewing.id}/mark-fake`, { confirmed: true })
                  }
                  onReopen={() => setReopenTarget(reviewing)}
                  onFulfil={() => setFulfilTarget(reviewing)}
                  onError={setError}
                />
              )}
            </div>
          </div>
        </section>

        {fulfilTarget && (
          <FulfilWithoutPaymentModal
            claimId={fulfilTarget.id}
            orderId={fulfilTarget.orderId}
            customer={paymentIdentityLine(fulfilTarget)}
            expectedAmountToman={fulfilTarget.expectedAmountToman}
            onClose={() => setFulfilTarget(null)}
            onDone={(already) => {
              setFulfilTarget(null);
              setToast(
                already
                  ? 'این سفارش قبلاً تحویل شده بود — همچنان در انتظار تطبیق'
                  : 'تحویل شد — پرداخت هنوز در انتظار تطبیق است',
              );
              setTimeout(() => setToast(null), 6000);
              // The `?claim=` key too, and that is not belt-and-braces. A review
              // opened from a link resolves through `needsFetch`, which is a
              // DIFFERENT cache key from the queue's — so refetching the queue
              // alone left the screen showing «در انتظار» after a delivery that
              // had already happened, with the button still offering to do it
              // again. See `reviewing` above.
              cache.refetch(
                queryKey,
                QK.payments(`claim=${fulfilTarget.id}`),
                QK.suggested,
                QK.today,
              );
            }}
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
        {toast && <div className="toast">{toast}</div>}
      </>
    );
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
                      <button
                        type="button"
                        className="ghost payment-table-header__action"
                        onClick={() => setBulkDeclineOpen(true)}
                      >
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
                      {...w}
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
                    /*
                     * On «در انتظار بررسی» the row is chosen by what the CLAIM
                     * is, not by which tab is open.
                     *
                     * This matters more than it looks. The three queues that
                     * this one replaced each had their own row with its own
                     * actions — «واریزی پیدا نشد» (then called «مشکوک به
                     * جعل») carried a «حذف» that rejects with
                     * NO_BANK_TRANSACTION, «نیاز به بررسی» a review button. Merging the tabs and rendering `AllRow` for
                     * everything would have quietly taken those away: the
                     * screen would look tidier and do less, which is the worst
                     * kind of simplification and exactly what the merge was
                     * NOT for.
                     *
                     * So the state did not disappear when the tabs did — it
                     * moved into the row, where it belongs. What kind of
                     * attention a payment needs is a property of the payment,
                     * never an address you have to navigate to first.
                     */
                    const kind = tab === 'open' ? item.reviewState : tab;

                    if (kind === 'needs_review' || kind === 'NEEDS_REVIEW') {
                      return (
                        <NeedsReviewRow
                          key={item.id}
                          item={item}
                          isNew={isClaimNew(item)}
                          onReview={() => openClaim(item)}
                        />
                      );
                    }
                    if (kind === 'waiting' || kind === 'WAITING') {
                      return (
                        <WaitingRow
                          key={item.id}
                          item={item}
                          onDetails={() => openReview(item)}
                        />
                      );
                    }
                    if (kind === 'suspected_fake' || kind === 'NO_TRANSFER_FOUND') {
                      return (
                        <NoTransferRow
                          key={item.id}
                          item={item}
                          isNew={isClaimNew(item)}
                          onReview={() => openClaim(item)}
                          onRemove={() =>
                            post(`/api/v1/suspects/${item.id}/reject`, {
                              reason: 'NO_BANK_TRANSACTION',
                            })
                          }
                          onError={setError}
                        />
                      );
                    }
                    return (
                      <AllRow key={item.id} item={item} onOpen={() => openReview(item)} />
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
                    onOpen={() => openReview(item)}
                    onReopen={() => setReopenTarget(item)}
                  />
                ))}
              </ul>
            )}

            <ClaimPager
              page={data?.page ?? 1}
              pageSize={data?.pageSize}
              total={data?.total}
              onPage={setPage}
            />

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
          </div>
        </div>
        <div className="payments-shell__decor" aria-hidden="true" />
      </section>
    </>
  );
}

function emptyText(tab: PaymentTab): string {
  // The only empty state on this screen that is unambiguously good news, and it
  // is worth saying so plainly. Under the old three tabs an operator had to
  // check all three to learn this, and even then the answer could be wrong: a
  // pending claim that matched none of their predicates left every one of them
  // looking empty while the money sat undecided.
  if (tab === 'open') return 'هیچ پرداختی منتظر تصمیم نیست.';
  if (tab === 'needs_review') return 'چیزی نیاز به بررسی ندارد.';
  if (tab === 'income') return 'در این بازه واریزی تخصیص‌نیافته‌ای نیست.';
  if (tab === 'declined_income') return 'در این بازه واریزی ردشده‌ای نیست.';
  if (tab === 'waiting') return 'پرداختی در انتظار نیست.';
  if (tab === 'suspected_fake') return 'پرداختی بدون واریزی منطبق نمانده است.';
  if (tab === 'bot_auto_verified') return 'در این بازه پرداختی با تایید خودکار ربات نیست.';
  if (tab === 'manually_verified') return 'در این بازه پرداختی با تایید دستی نیست.';
  if (tab === 'reseller') return 'در این بازه پرداخت نمایندگی نیست.';
  return 'پرداختی پیدا نشد.';
}

/**
 * The customer's own evidence, on the screen where their money is decided.
 *
 * The bot has stored these since it was written and nothing showed them:
 * `receiptFor()` had zero callers and the column was not in the list query, so
 * a customer sent a picture of their transfer, the bot said «رسید شما دریافت
 * شد», and no operator could ever look at it. Sam asked where the admin sees
 * the receipt and the honest answer was: nowhere.
 *
 * Rendered as an ordinary `<img>` pointed at the route, so the browser does the
 * fetching and the bytes never pass through React state. The handle is not
 * here and never will be — the client is told only `hasReceipt`, and the
 * server reads the file_id.
 *
 * The absent case is written out rather than left blank, because on this screen
 * "no receipt" is a fact an operator is entitled to act on: a claim in
 * «واریزی پیدا نشد» with no document behind it means the customer pressed a
 * button and sent nothing, which is a different conversation from a disputed
 * image.
 */
/**
 * Why the receipt did not draw, in the operator's own words.
 *
 * The comment above promised the screen would say «whether the receipt is gone
 * or the panel is misconfigured» and the screen said neither — one sentence for
 * every cause. So the operator who hit `bot_token_unreadable` on staging read
 * «الان قابل نمایش نیست», opened the URL in a new tab to find out more, and got
 * raw JSON. The server now answers with a class; this turns the class into a
 * sentence. Unknown codes keep the old wording rather than printing a code.
 */
const RECEIPT_ERROR_TEXT: Record<string, string> = {
  no_bot_token: 'هیچ رباتی وصل نیست، پس رسید خوانده نمی‌شود — از «ربات تلگرام» یکی وصل کن.',
  secret_key_missing: 'این سرویس کلید باز کردن توکن ربات را ندارد — پیکربندی سرور ناقص است.',
  bot_token_unreadable: 'توکن ذخیره‌شدهٔ ربات با کلید این سرویس باز نمی‌شود — کلید عوض شده است.',
  telegram_unauthorized: 'تلگرام توکن ربات را نپذیرفت — ربات وصل‌شده عوض شده است.',
  receipt_unavailable: 'این رسید دیگر در دسترس ربات نیست.',
  receipt_unreachable: 'تلگرام جواب نداد. چند لحظه بعد دوباره امتحان کن.',
  unsupported_type: 'نوع این فایل قابل نمایش نیست.',
  bad_handle: 'شناسهٔ رسید معتبر نیست.',
};

function ReceiptSection({ item }: { item: PaymentItem }) {
  const [failed, setFailed] = useState(false);
  const [why, setWhy] = useState<string | null>(null);

  /**
   * One extra request, and only after the image has already failed.
   *
   * `<img>` reports that it broke and nothing about why — the body is not
   * reachable from an `onError`. Asking again costs a request on a path that
   * has already gone wrong, which is the cheapest place to spend one.
   */
  async function explain() {
    setFailed(true);
    try {
      const r = await fetch(`/api/v1/payment-claims/${item.id}/receipt`);
      const body = (await r.json()) as { error?: string };
      setWhy(body.error ? (RECEIPT_ERROR_TEXT[body.error] ?? null) : null);
    } catch {
      // The explanation is a nicety; failing to fetch it must not replace the
      // message that is already on the screen.
    }
  }

  return (
    <section className="drawer-section">
      <h3 className="drawer-section__heading">رسید</h3>
      {item.hasReceipt !== true ? (
        <p className="muted">مشتری رسیدی نفرستاده است.</p>
      ) : failed ? (
        // Telegram refused, or the worker has no bot token. Said plainly: an
        // operator looking at a broken image should not have to guess whether
        // the receipt is gone or the panel is misconfigured.
        <p className="muted">
          {why ?? 'رسید ثبت شده، ولی الان قابل نمایش نیست.'}{' '}
          <a href={`/api/v1/payment-claims/${item.id}/receipt`} target="_blank" rel="noreferrer">
            تلاش دوباره
          </a>
        </p>
      ) : (
        <a
          href={`/api/v1/payment-claims/${item.id}/receipt`}
          target="_blank"
          rel="noreferrer"
          className="payment-receipt"
        >
          <img
            src={`/api/v1/payment-claims/${item.id}/receipt`}
            alt="رسید پرداخت مشتری"
            loading="lazy"
            onError={() => void explain()}
          />
        </a>
      )}
    </section>
  );
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
          <span className="hub-list-row__amount tabular-nums">
            {formatToman(item.expectedAmountToman)}
          </span>
        </div>
        <div className="hub-list-row__line2 muted">
          سفارش {item.orderId} · {masked} · {paymentDeviceLine(item)}
        </div>
        <div className="hub-list-row__line3 payment-reason">
          <StatusBadge tone="review">نیاز به بررسی</StatusBadge>
          <span className="payment-reason__text">{reasonText(item.suspectReason)}</span>
          <ReceiptMark item={item} />
        </div>
      </button>
    </li>
  );
}

/**
 * Whether this claim has a receipt behind it — on the row, before anyone opens
 * anything.
 *
 * The list has carried `hasReceipt` since the viewer was built and no row ever
 * showed it, so the one fact that decides whether an operator has evidence to
 * look at was only discoverable by opening each claim in turn. Sam sent a
 * receipt through the bot on 2026-08-25, looked at this queue, and could not
 * tell his claim from the three beside it that have nothing.
 *
 * Silent when there is no receipt. An absent receipt is the ordinary case — the
 * customer pressed the button and sent nothing — and a row that announced it
 * would put a warning on most of the queue for no decision.
 */
function ReceiptMark({ item }: { item: PaymentItem }) {
  if (item.hasReceipt !== true) return null;
  return (
    <span className="payment-reason__receipt" title="مشتری رسید فرستاده است">
      📸 رسید دارد
    </span>
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
          <span className="hub-list-row__amount tabular-nums">
            {formatToman(item.expectedAmountToman)}
          </span>
        </div>
        <div className="hub-list-row__line2 muted">
          سفارش {item.orderId} · {masked} · {paymentDeviceLine(item)}
        </div>
        <div className="hub-list-row__line3 payment-reason">
          <StatusBadge tone="waiting">{waitNote}</StatusBadge>
          <ReceiptMark item={item} />
        </div>
      </button>
    </li>
  );
}

function NoTransferRow({
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
    <li className={`hub-list-row${isNew ? ' hub-list-row--new' : ''}`}>
      <button
        type="button"
        className="hub-list-row__button"
        aria-label={`Review payment with no bank transfer from ${identity || item.orderId}`}
        onClick={onReview}
      >
        <div className="hub-list-row__line1">
          <span className="hub-list-row__identity">
            <NewBadge isNew={isNew} />
            {identity && <strong>{identity}</strong>}
          </span>
          <span className="hub-list-row__amount tabular-nums">
            {formatToman(item.expectedAmountToman)}
          </span>
        </div>
        <div className="hub-list-row__line2 muted">
          سفارش {item.orderId} · {masked} · {paymentDeviceLine(item)}
        </div>
        <div className="hub-list-row__line3 payment-reason">
          <StatusBadge tone="no-transfer">{reasonText(item.suspectReason)}</StatusBadge>
          <ReceiptMark item={item} />
        </div>
      </button>
      <div className="hub-list-row__inline-actions">
        {/*
          «بررسی» first, and it is new.

          The row body has always been a button that opens the review, and
          nothing said so — so the only thing an operator could SEE on a claim
          in this queue was «حذف», a destructive action sitting where the
          primary one belongs. Sam looked at this screen on 2026-08-25, saw four
          rows offering nothing but delete, and reported that the receipt he had
          just sent was nowhere. It was there. There was no visible way in.
        */}
        {!confirmRemove ? (
          <>
            <button type="button" className="primary hub-list-row__action" onClick={onReview}>
              بررسی
            </button>
            <button
              type="button"
              className="ghost hub-list-row__action"
              disabled={busy}
              onClick={() => setConfirmRemove(true)}
            >
              حذف
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="danger hub-list-row__action"
              disabled={busy}
              onClick={() => void runRemove()}
            >
              تایید
            </button>
            <button
              type="button"
              className="ghost hub-list-row__action"
              disabled={busy}
              onClick={() => setConfirmRemove(false)}
            >
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
          <span className="hub-list-row__amount tabular-nums">
            {formatToman(item.expectedAmountToman)}
          </span>
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
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onOpen();
              }}
            >
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
        <p className="muted">تحویلی که انجام شده دوباره انجام نمی‌شود و خودکار هم برنمی‌گردد.</p>
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
          <button
            type="button"
            className="primary"
            disabled={busy || !reason.trim()}
            onClick={() => void submit()}
          >
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

function AllRow({ item, onOpen }: { item: PaymentItem; onOpen: () => void }) {
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
          <span className="hub-list-row__amount tabular-nums">
            {formatToman(item.expectedAmountToman)}
          </span>
        </div>
        <div className="hub-list-row__line2 muted">
          سفارش {item.orderId} · {masked} · {paymentDeviceLine(item)}
          <ReceiptMark item={item} />
        </div>
      </button>
    </li>
  );
}

/**
 * «۲۰۰ از ۵۱۰» — and the two buttons that reach the rest.
 *
 * Until 2026-09-03 the list ended in a hard `LIMIT 200` and said nothing. On a
 * busy month the screen showed two hundred rows and the operator had no way to
 * know the others existed: a payment they were looking for was simply absent,
 * with no reason offered. The money figures were never wrong — `summary` and
 * `counts` are their own aggregates over the whole range — so what was lost
 * was a ROW, not a sum.
 *
 * Draws nothing when there is one page, and nothing at all when the tab does
 * not report a total: the income, declined and reseller tabs have their own
 * loaders and are not paginated, and a pager rendered from `undefined` would
 * be a control that promises pages it cannot turn to.
 */
function ClaimPager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  // `| undefined` explicitly, not just `?`: `exactOptionalPropertyTypes` is on,
  // and these arrive as `data?.total` -- present and undefined, which is a
  // different thing from absent and is exactly the state this must handle.
  pageSize: number | undefined;
  total: number | undefined;
  onPage: (next: number) => void;
}) {
  if (total === undefined || pageSize === undefined || total <= pageSize) return null;
  const pages = Math.ceil(total / pageSize);
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  return (
    <div className="claim-pager" aria-label="صفحه‌بندی پرداخت‌ها">
      <button
        type="button"
        className="ghost"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        قبلی
      </button>
      <span className="claim-pager__count">
        {count(first)}–{count(last)} از {count(total)}
      </span>
      <button
        type="button"
        className="ghost"
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
      >
        بعدی
      </button>
    </div>
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
  const { data: cards } = cache.useQuery<{
    items: Array<{ cardDigits: string; cardMasked: string; displayName: string }>;
  }>('cards-analytics-for-filter', {
    fetcher: async (signal) => {
      const r = await fetch('/api/v1/cards/analytics?range=all', { signal });
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
          <option value="">همه</option>
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
          <option value="">همه</option>
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
          <option value="">همه</option>
          {reasons.map((r) => (
            <option key={r} value={r}>
              {reasonText(r)}
            </option>
          ))}
        </select>
      </label>
      <label>
        کارت
        <select value={filters.cardDigits} onChange={(e) => set({ cardDigits: e.target.value })}>
          <option value="">همه</option>
          {(cards?.items ?? []).map((c) => (
            <option key={c.cardDigits} value={c.cardDigits}>
              {c.cardMasked} · {c.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        آی‌دی تلگرام
        <input
          type="text"
          inputMode="numeric"
          placeholder="مثلاً ۱۲۳۴۵۶۷۸۹"
          value={filters.telegramId}
          onChange={(e) => set({ telegramId: e.target.value })}
        />
      </label>
      <label>
        از
        <input type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} />
      </label>
      <label>
        تا
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
  onFulfil,
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
  /** Open «تأیید و تحویل دستی». The dialog and the request live in the parent. */
  onFulfil: () => void;
  onError: (message: string) => void;
}) {
  const w = useWriteProps();
  const [selected, setSelected] = useState<string | null>(() => defaultCandidateId(item));
  const [rejectReason, setRejectReason] = useState<string>('NO_BANK_TRANSACTION');
  const [confirmFake, setConfirmFake] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmManual, setConfirmManual] = useState(false);
  const [manualReason, setManualReason] = useState('');
  const [showReassign, setShowReassign] = useState(false);
  const [busy, setBusy] = useState(false);
  const actionable = item.reviewState === 'NEEDS_REVIEW' || item.reviewState === 'NO_TRANSFER_FOUND';
  /**
   * Deliverable by hand, right now — and deliberately a WIDER set than
   * `actionable`.
   *
   * `actionable` asks «is there a bank transaction to decide about», which is
   * the question the approve/reject controls answer. A `WAITING` claim has no
   * transaction yet, so it is not `actionable`, and the whole «تصمیم» section
   * collapsed to the sentence «در انتظار واریز بانکی» with no control beneath
   * it. That is the state a customer sits in while an operator watches, and it
   * was the one state the panel offered nothing for.
   *
   * The set matches the server's, which is `PENDING`/`MATCH_SUGGESTED` in
   * `fulfilWithoutPayment.ts` — the three states above are exactly the ones
   * `deriveReviewState` produces from those two. Nothing here consults
   * Continuity mode: that switch decides what the INGEST does on its own to
   * every new claim, and an operator deciding one claim in front of them is a
   * different act that must not need a shop-wide switch thrown first.
   */
  const canFulfil =
    item.reviewState === 'NEEDS_REVIEW' ||
    item.reviewState === 'WAITING' ||
    item.reviewState === 'NO_TRANSFER_FOUND';
  const canMarkFake = item.reviewState === 'NO_TRANSFER_FOUND';
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
      {/* The title lives on the page bar now, next to the way back. It was
          here when this was a drawer and the drawer had no header of its
          own. */}
      <section className="drawer-section">
        <h3 className="drawer-section__heading">هویت</h3>
        <PaymentIdentity item={item} />
      </section>

      <section className="drawer-section">
        <h3 className="drawer-section__heading">پرداخت</h3>
        <dl className="payment-review__facts">
          <dt>مبلغ مورد انتظار</dt>
          <dd className="tabular-nums">{formatToman(item.expectedAmountToman)}</dd>
          <dt>کارت نمایش‌داده‌شده</dt>
          <dd>{item.cardMasked ?? '—'}</dd>
          <dt>وضعیت</dt>
          <dd>{stateLabel(item.reviewState)}</dd>
        </dl>
      </section>

      <ReceiptSection item={item} />

      <section className="drawer-section">
        <h3 className="drawer-section__heading">دستگاه</h3>
        <p>{deviceInlineLabel(item.device)}</p>
      </section>

      <section className="drawer-section">
        <h3 className="drawer-section__heading">حساب</h3>
        <AccountRef account={item} />
        {actionable && (
          <ClaimChangeAccount item={item} cache={cache} onSaved={onRefresh} onError={onError} />
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
          {/*
            One flag off `stateLabel`, not two hand-written branches.

            The branches spelled «نیاز به بررسی» and «مشکوک به جعل» out again
            as literals — a second copy of `STATE_LABEL` that nothing kept in
            step with the first. Renaming the state in `paymentReview.ts` is
            exactly the edit that would have left the old accusation standing
            here, on the one screen where money is decided.
          */}
          {actionable && (
            <span className="payment-reason__flag">{stateLabel(item.reviewState)}</span>
          )}{' '}
          {reasonText(item.suspectReason)}
        </p>

        {canFulfil && (
          <div className="payment-review__fulfil">
            <p className="muted">
              مشتری منتظر است و پیامک بانک نرسیده؟ همین سفارش را دستی تحویل بده — سراسری چیزی
              روشن نمی‌شود.
            </p>
            <button
              type="button"
              className="btn btn-danger review-page__fulfil"
              onClick={onFulfil}
              {...w}
            >
              تأیید و تحویل دستی
            </button>
          </div>
        )}

        {actionable && (
          <>
            <div className="payment-review__actions">
              <button
                type="button"
                className="primary"
                disabled={busy || selected == null}
                onClick={() => selected && run(() => onApprove(selected))}
                {...w}
              >
                تایید انتخاب‌شده‌ها
              </button>

              <div className="payment-review__reassign">
                <p className="muted">تراکنش درست را پیدا نمی‌کنی؟</p>
                <button
                  type="button"
                  className="ghost"
                  disabled={busy}
                  onClick={() => setShowReassign(true)}
                >
                  یافتن یا تغییر تراکنش
                </button>
              </div>

              <div className="payment-review__manual-anyway">
                <p className="muted">اصلاً تراکنش بانکی وجود ندارد؟</p>
                {!confirmManual ? (
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => setConfirmManual(true)}
                  >
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
                      {...w}
                    >
                      تایید دستی پرداخت
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy}
                      onClick={() => setConfirmManual(false)}
                    >
                      انصراف
                    </button>
                  </>
                )}
              </div>

              {canMarkFake && (
                <div className="payment-review__remove">
                  {!confirmRemove ? (
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy}
                      onClick={() => setConfirmRemove(true)}
                      {...w}
                    >
                      حذف
                    </button>
                  ) : (
                    <>
                      <p className="muted">
                        Remove this payment from the queue? No bank transfer was found — this is not
                        a fraud classification.
                      </p>
                      <button
                        type="button"
                        className="danger"
                        disabled={busy}
                        onClick={() => run(onRemove)}
                        {...w}
                      >
                        تایید حذف
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy}
                        onClick={() => setConfirmRemove(false)}
                      >
                        انصراف
                      </button>
                    </>
                  )}
                </div>
              )}
              {canMarkFake && (
                <div className="payment-review__mark-fake">
                  {!confirmFake ? (
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      onClick={() => setConfirmFake(true)}
                      {...w}
                    >
                      علامت‌زدن به‌عنوان جعلی
                    </button>
                  ) : (
                    <>
                      <p className="muted">
                        این پرداخت به‌عنوان رسید جعلی علامت زده شود؟ این یک تشخیص دستی تقلب است.
                      </p>
                      <button
                        type="button"
                        className="danger"
                        disabled={busy}
                        onClick={() => run(onMarkFake)}
                        {...w}
                      >
                        تایید جعلی‌بودن رسید
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy}
                        onClick={() => setConfirmFake(false)}
                      >
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
                    {...w}
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
