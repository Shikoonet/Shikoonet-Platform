/**
 * Presentation layer for the payment review inbox.
 */

export type ReviewState =
  | 'AUTO_VERIFIED'
  | 'NEEDS_REVIEW'
  | 'MANUALLY_VERIFIED'
  | 'WAITING'
  | 'SUSPECTED_FAKE'
  | 'REJECTED'
  | 'FAKE'
  | 'EXPIRED';

export type PaymentTab =
  | 'income'
  | 'needs_review'
  | 'declined_income'
  | 'waiting'
  | 'suspected_fake'
  | 'bot_auto_verified'
  | 'manually_verified'
  | 'reseller'
  | 'all';

export type HistoryRange = 'all' | 'today' | '2d' | '3d' | '7d' | '30d' | 'day';

export type HistoryRangePreset = 'all' | '7d' | '30d' | 'day';

export interface HistoryRangeState {
  preset: HistoryRangePreset;
  /** YYYY-MM-DD (Tehran) when preset is `day`. */
  day?: string;
}

export const HISTORY_RANGE_PRESETS: { value: HistoryRangePreset; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'day', label: 'Selected day' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
];

/** @deprecated Use HISTORY_RANGE_PRESETS + HistoryDateNav */
export const HISTORY_RANGE_OPTIONS: { value: HistoryRange; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'today', label: 'Today' },
  { value: '2d', label: 'Last 2 days' },
  { value: '3d', label: 'Last 3 days' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
];

export function defaultHistoryRangeState(): HistoryRangeState {
  return { preset: 'all' };
}

export function historyRangeQueryParams(state: HistoryRangeState): {
  range: HistoryRange;
  day?: string;
} {
  if (state.preset === 'day') {
    return { range: 'day', ...(state.day ? { day: state.day } : {}) };
  }
  return { range: state.preset };
}

export function appendHistoryRangeQuery(qs: URLSearchParams, state: HistoryRangeState): void {
  const { range, day } = historyRangeQueryParams(state);
  qs.set('range', range);
  if (range === 'day' && day) qs.set('day', day);
}

export interface CandidateTransaction {
  id: string;
  amountIrr: number | null;
  bankTimestamp: number | null;
  timeDeltaSeconds: number | null;
  accountId: string | null;
  accountDisplay: string | null;
  accountBank: string | null;
  accountHint: string | null;
  alreadyConsumed: boolean;
}

export interface PaymentItem {
  id: string;
  orderId: string;
  telegramUserId: string | null;
  telegramUsername: string | null;
  expectedAmountIrr: number;
  expectedAmountToman: number;
  cardMasked: string | null;
  accountId: string | null;
  accountDisplay: string | null;
  accountBank: string | null;
  accountHint: string | null;
  paidClickedAt: number | null;
  receiptSubmittedAt: number | null;
  createdAt: number;
  effectiveTs: number;
  reviewState: ReviewState;
  claimStatus: string;
  matchStatus: string | null;
  suspectReason: string | null;
  waitingRemainingMs: number | null;
  waitingElapsedMs: number | null;
  timeDeltaMs: number | null;
  matchedTransaction: {
    id: string;
    amountIrr: number | null;
    bankTimestamp: number | null;
    timeDeltaSeconds: number | null;
    verifiedAt: number | null;
    verifiedBy: string | null;
  } | null;
  candidates: CandidateTransaction[];
  /** SMS source device for the linked (or first candidate) bank transaction. */
  device: { id: string; name: string } | null;
  /** Operator may reopen a manual verification (Manually Verified tab). */
  reopenEligible?: boolean;
  /** @deprecated Use reopenEligible */
  revertEligible?: boolean;
  /** Present when reopenEligible is false — explains why reopen is blocked. */
  reopenBlockedReason?: string | null;
  fulfillmentState?: 'UNKNOWN' | 'NOT_APPLICABLE';
  isNew?: boolean;
  /** DEV-only: business classification (NEW_PURCHASE / RENEWAL / UNKNOWN).
   *  Present only when the worker is built with ENABLE_PURCHASE_TYPE=true. */
  purchaseType?: 'NEW_PURCHASE' | 'RENEWAL' | 'UNKNOWN';
  /** DEV-only: raw Mirzabot step (e.g. getconfigafterpay). */
  operationType?: string | null;
}

export interface IncomeItem {
  id: string;
  amountIrr: number | null;
  amountToman: number | null;
  bankTimestamp: number | null;
  accountId: string | null;
  accountDisplay: string | null;
  accountBank: string | null;
  accountHint: string | null;
  reference: string | null;
  statusLabel: string;
  isNew?: boolean;
}

export interface DeclinedIncomeItem {
  id: string;
  amountIrr: number | null;
  amountToman: number | null;
  bankTimestamp: number | null;
  accountId: string | null;
  accountDisplay: string | null;
  accountBank: string | null;
  accountHint: string | null;
  reference: string | null;
  declinedBy: string;
  declinedAt: number;
  declineReason: string | null;
}

export interface ResellerItem {
  id: string;
  transactionId: string;
  resellerId: string;
  resellerName: string;
  amountIrr: number | null;
  amountToman: number | null;
  bankTimestamp: number | null;
  accountDisplay: string | null;
  accountBank: string | null;
  accountHint: string | null;
  reference: string | null;
  classifiedBy: string;
  classifiedAt: number;
  note: string | null;
  isNew?: boolean;
}

export interface FinancialSummary {
  range: HistoryRange;
  bankIncomeIrr: number;
  botAutoVerified: { payments: number; amountIrr: number };
  reseller: { payments: number; amountIrr: number; activeResellers: number };
  unassignedIncome: { count: number; amountIrr: number };
}

export interface PaymentsResponse {
  ok: boolean;
  tab: PaymentTab;
  range: HistoryRange;
  items: PaymentItem[] | IncomeItem[] | ResellerItem[] | DeclinedIncomeItem[];
  counts: {
    needsReview: number;
    waiting: number;
    suspectedFake: number;
    autoVerified: number;
    botAutoVerified: number;
    income: number;
    declinedIncome?: number;
    reseller: number;
    all: number;
    needsReviewUnread?: number;
    suspectedFakeUnread?: number;
    botAutoVerifiedUnread?: number;
    resellerUnread?: number;
    incomeUnread?: number;
  } & Record<string, number>;
  summary: FinancialSummary;
  incomeTotals?: { count: number; amountIrr: number };
  declinedTotals?: { count: number; amountIrr: number };
  resellerStats?: {
    payments: number;
    amountIrr: number;
    activeResellers: number;
    breakdown: Array<{ reseller_name: string; payments: number; amount_irr: number }>;
  };
}

const REASON_TEXT: Record<string, string> = {
  AMBIGUOUS_TRANSACTIONS: 'Multiple bank transactions match this payment',
  AMBIGUOUS_CLAIMS: 'Multiple payments could match this bank transfer',
  NO_TRANSACTION: 'No matching bank transfer found',
  NO_TRANSACTION_AFTER_10M: 'Receipt submitted, but no bank transfer was found within 10 minutes',
  OUTSIDE_AUTO_MATCH_WINDOW: 'Matching transfer found, but outside the 5-minute auto-verify window',
  UNMAPPED_CARD: 'Card is not linked to a bank account',
  AMBIGUOUS_CARD_MAPPING: 'This card is linked to more than one bank account',
  ACCOUNT_NOT_ACTIVE: 'This bank account is not active',
  AMOUNT_MISMATCH: 'A nearby bank transfer has a different amount',
  TRANSACTION_ALREADY_CONSUMED: 'This bank transaction was already used for another payment',
  PARSER_FAILURE_NEARBY: 'A nearby bank SMS could not be processed',
  DUPLICATE_ORDER: 'This order was already submitted',
  DUPLICATE_EVENT: 'This payment event was already received',
  RECEIPT_REUSED: 'This receipt was already used for another payment',
  INTEGRATION_ERROR: 'The payment bot could not be processed automatically',
};

export function reasonText(code: string | null): string {
  if (!code) return 'Waiting for bank transfer';
  return REASON_TEXT[code] ?? 'Could not be verified automatically';
}

const STATE_LABEL: Record<ReviewState, string> = {
  AUTO_VERIFIED: 'Bot auto verified',
  NEEDS_REVIEW: 'Needs review',
  MANUALLY_VERIFIED: 'Manually verified',
  WAITING: 'Waiting',
  SUSPECTED_FAKE: 'Suspected fake',
  REJECTED: 'Rejected',
  FAKE: 'Fake',
  EXPIRED: 'Expired',
};

export function stateLabel(state: ReviewState): string {
  return STATE_LABEL[state] ?? state;
}

export const ALL_TAB_STATES: ReviewState[] = [
  'AUTO_VERIFIED',
  'NEEDS_REVIEW',
  'MANUALLY_VERIFIED',
  'WAITING',
  'SUSPECTED_FAKE',
  'REJECTED',
  'FAKE',
  'EXPIRED',
];

export function defaultCandidateId(item: PaymentItem): string | null {
  const only = item.candidates.length === 1 ? item.candidates[0] : undefined;
  if (!only) return null;
  return item.suspectReason === 'OUTSIDE_AUTO_MATCH_WINDOW' ? only.id : null;
}

export function userLabel(item: PaymentItem): string {
  if (item.telegramUsername) return `@${item.telegramUsername}`;
  if (item.telegramUserId) return `user ${item.telegramUserId}`;
  return 'Unknown user';
}

/** Compact identity line for list rows (username primary). */
export function userIdentityShort(item: PaymentItem): string {
  const parts: string[] = [];
  if (item.telegramUsername) parts.push(`@${item.telegramUsername}`);
  if (item.telegramUserId) parts.push(`ID ${item.telegramUserId}`);
  parts.push(`Order ${item.orderId}`);
  return parts.join(' · ');
}

export function deviceInlineLabel(device: PaymentItem['device']): string {
  return device?.name ?? '—';
}

export interface AccountRefLike {
  accountBank: string | null;
  accountHint: string | null;
  accountDisplay: string | null;
}

export function bankName(item: AccountRefLike): string | null {
  return item.accountBank ?? item.accountDisplay;
}

export { formatToman } from './format.js';

export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function formatDurationLong(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}s`;
  return `${min}m ${sec}s`;
}

/**
 * "27 minutes ago", from the timestamp itself.
 *
 * Takes the TIMESTAMP, not an elapsed duration. It used to take a duration,
 * sitting in a row with formatDuration and formatDurationLong which genuinely
 * do — and two of its three callers handed it `verifiedAt` straight, which
 * formats the whole epoch as an interval. The manually-verified list on the
 * live dashboard read "Verified 29773038 minutes ago" (56 years) for payments
 * approved that afternoon, while the Bot Auto Verified table beside it — the
 * one caller that remembered to subtract — was right.
 *
 * Making the parameter the timestamp removes the choice: `verifiedAt` is what
 * every caller has, so there is nothing left to get wrong.
 *
 * `now` is injectable so this stays a pure function under test.
 */
export function formatTimeAgo(timestampMs: number, now: number = Date.now()): string {
  const totalSec = Math.max(0, Math.floor((now - timestampMs) / 1000));
  const min = Math.floor(totalSec / 60);
  if (min <= 0) return 'just now';
  if (min === 1) return '1 minute ago';
  return `${min} minutes ago`;
}

/**
 * Format a unix-millisecond timestamp as `YYYY-MM-DD HH:mm:ss` in
 * Asia/Tehran.  Used for the "Verified At" column on the Bot Auto Verified
 * table so operators see the exact dashboard timezone and never see
 * browser-local time.
 *
 * IMPORTANT: this dashboard's authoritative timezone is Asia/Tehran
 * (UTC+3:30, no DST), matching the worker's `historyRangeBounds` math in
 * `packages/domain/src/historyRange.ts`.  Never use `getDate()` /
 * `getHours()` (browser-local) here.
 */
export const DASHBOARD_TIMEZONE = 'Asia/Tehran';

export function formatExactDateTime(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (Number.isNaN(ms)) return '—';
  // Intl.DateTimeFormat with timeZone pulls pieces in the chosen zone.
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: DASHBOARD_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(ms));
  const lookup = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  // en-GB with hour12:false gives "24:00:00" at midnight in some engines —
  // normalize to 00.
  const hh = lookup('hour') === '24' ? '00' : lookup('hour');
  return `${lookup('year')}-${lookup('month')}-${lookup('day')} ${hh}:${lookup('minute')}:${lookup('second')}`;
}

export function formatRelativeFuture(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.max(1, Math.ceil(totalSec / 60));
  if (min === 1) return 'About 1 minute remaining';
  return `About ${min} minutes remaining`;
}

/** Whether the operator can reopen this manually verified payment. */
export function isReopenEligible(item: PaymentItem): boolean {
  if (item.reopenEligible === true) return true;
  if (item.reopenEligible === false) return false;
  return item.revertEligible === true;
}

/** Plain-language reason when reopen is blocked; null when eligible. */
export function reopenBlockedReason(item: PaymentItem): string | null {
  if (isReopenEligible(item)) return null;
  if (item.reopenBlockedReason?.trim()) return item.reopenBlockedReason.trim();
  if (item.matchStatus === 'AUTO_VERIFIED') {
    return 'Bot auto-verified payments cannot be reopened here.';
  }
  if (item.reviewState !== 'MANUALLY_VERIFIED') {
    return 'Only manually verified payments can be reopened.';
  }
  return 'No revert snapshot was saved when this payment was verified. Older manual verifications may not support reopen.';
}
