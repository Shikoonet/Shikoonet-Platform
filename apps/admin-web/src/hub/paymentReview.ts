/**
 * Presentation layer for the payment review inbox.
 */

import { AUTO_MATCH_MAX_TIME_DELTA_MS, WAITING_TIMEOUT_MS } from '@shikoo/contracts';
import { count } from '../format.js';

/**
 * The two windows, in minutes, taken from the constants the engine actually
 * uses rather than typed into the prose beside them.
 *
 * Both numbers were hard-coded in Persian sentences below — «۱۰ دقیقه» and
 * «۵ دقیقه‌ای» — with nothing tying them to `WAITING_TIMEOUT_MS` or
 * `AUTO_MATCH_MAX_TIME_DELTA_MS`. Changing either constant would have left the
 * panel confidently quoting the old figure to an operator deciding about money.
 */
const waitMinutes = count(Math.round(WAITING_TIMEOUT_MS / 60_000));
const matchMinutes = count(Math.round(AUTO_MATCH_MAX_TIME_DELTA_MS / 60_000));

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
  /**
   * Every claim nobody has decided about — the one queue an operator works.
   *
   * `needs_review`, `waiting` and `suspected_fake` stay in this union and keep
   * working, because links and bookmarks carry them and «همه» still filters by
   * them. They are simply no longer drawn as tabs: between them they had a gap,
   * and a pending claim that fell into it was on no screen in the panel.
   */
  | 'open'
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
  { value: 'all', label: 'همه' },
  { value: 'day', label: 'روز انتخاب‌شده' },
  { value: '7d', label: '۷ روز اخیر' },
  { value: '30d', label: '۳۰ روز اخیر' },
];

/** @deprecated Use HISTORY_RANGE_PRESETS + HistoryDateNav */
export const HISTORY_RANGE_OPTIONS: { value: HistoryRange; label: string }[] = [
  { value: 'all', label: 'همه' },
  { value: 'today', label: 'امروز' },
  { value: '2d', label: '۲ روز اخیر' },
  { value: '3d', label: '۳ روز اخیر' },
  { value: '7d', label: '۷ روز اخیر' },
  { value: '30d', label: '۳۰ روز اخیر' },
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
  AMBIGUOUS_TRANSACTIONS: 'چند تراکنش بانکی با این پرداخت می‌خوانند',
  AMBIGUOUS_CLAIMS: 'چند پرداخت می‌توانند با این واریزی بخوانند',
  NO_TRANSACTION: 'واریزی منطبقی پیدا نشد',
  // Says «پرداخت ثبت شد» — the button press — and NOT «رسید ثبت شد», which is
  // what it used to claim. The reason is stamped off
  // `COALESCE(receipt_submitted_at, paid_clicked_at)`, so it fires identically
  // for a claim that has no receipt at all; on 2026-08-24 three such rows sat
  // in «مشکوک به جعل» each telling the operator a receipt had been filed.
  //
  // That is not a wording slip. This reason is one of `SUSPECTED_FAKE_REASONS`,
  // so the sentence arrives on the fake-suspicion screen — and «رسید ثبت شد»
  // there turns "they never paid" into "they forged a receipt" in the mind of
  // the person about to decide. Whether a receipt exists is a separate column;
  // this string must not answer it.
  NO_TRANSACTION_AFTER_10M: `پرداخت ثبت شد، ولی تا ${waitMinutes} دقیقه هیچ واریزی پیدا نشد`,
  OUTSIDE_AUTO_MATCH_WINDOW: `واریزی منطبق پیدا شد، ولی بیرون از پنجرهٔ ${matchMinutes} دقیقه‌ای تایید خودکار`,
  UNMAPPED_CARD: 'کارت به هیچ حساب بانکی وصل نیست',
  AMBIGUOUS_CARD_MAPPING: 'این کارت به بیش از یک حساب بانکی وصل است',
  ACCOUNT_NOT_ACTIVE: 'این حساب بانکی فعال نیست',
  AMOUNT_MISMATCH: 'یک واریزی نزدیک، مبلغش فرق دارد',
  TRANSACTION_ALREADY_CONSUMED: 'این تراکنش بانکی قبلاً برای پرداخت دیگری استفاده شده',
  PARSER_FAILURE_NEARBY: 'یک پیامک بانکی نزدیک پردازش نشد',
  DUPLICATE_ORDER: 'این سفارش قبلاً ثبت شده',
  DUPLICATE_EVENT: 'این رویداد پرداخت قبلاً دریافت شده',
  RECEIPT_REUSED: 'این رسید قبلاً برای پرداخت دیگری استفاده شده',
  INTEGRATION_ERROR: 'این پرداخت به‌صورت خودکار پردازش نشد',
};

export function reasonText(code: string | null): string {
  if (!code) return 'در انتظار واریز بانکی';
  return REASON_TEXT[code] ?? 'به‌صورت خودکار تایید نشد';
}

const STATE_LABEL: Record<ReviewState, string> = {
  AUTO_VERIFIED: 'تایید خودکار ربات',
  NEEDS_REVIEW: 'نیاز به بررسی',
  MANUALLY_VERIFIED: 'تایید دستی',
  WAITING: 'در انتظار',
  SUSPECTED_FAKE: 'مشکوک به جعل',
  REJECTED: 'رد شده',
  FAKE: 'جعلی',
  EXPIRED: 'منقضی',
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
  return 'کاربر نامشخص';
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
  if (min <= 0) return 'همین حالا';
  if (min === 1) return '۱ دقیقه پیش';
  return `${count(min)} دقیقه پیش`;
}

/**
 * Format a unix-millisecond timestamp as `YYYY-MM-DD HH:mm:ss` in
 * Asia/Tehran.  Used for the "زمان تایید" column on the Bot Auto Verified
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
  if (min === 1) return 'حدود ۱ دقیقه مانده';
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
    return 'پرداخت‌های تاییدشدهٔ خودکار ربات را نمی‌شود از این‌جا دوباره باز کرد.';
  }
  if (item.reviewState !== 'MANUALLY_VERIFIED') {
    return 'فقط پرداخت‌های تاییدشدهٔ دستی را می‌شود دوباره باز کرد.';
  }
  return 'No revert snapshot was saved when this payment was verified. Older manual verifications may not support reopen.';
}
