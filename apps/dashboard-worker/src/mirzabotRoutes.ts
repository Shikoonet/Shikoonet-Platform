import { Hono } from 'hono';
import { z } from 'zod';
import { SQL, type D1Database, type D1Result } from '@shikoo/database';
import {
  assertTransitionClaim,
  maskCardDigits,
  normalizeCardDigits,
  formatCardDigitsForDisplay,
  identifyBank,
  luhnOk,
  type BankPrefix,
  verifyMirzabotClaim,
  verifyMirzabotClaimWithoutTransaction,
  fulfilMirzabotClaimWithoutPayment,
  retryOrderProvisioning,
  readContinuityMode,
  activateContinuityMode,
  deactivateContinuityMode,
  reassignMirzabotTransaction,
  revertMirzabotManualVerification,
  reopenMirzabotManualVerification,
  isManualVerificationReopenEligible,
  inferPrimaryDevice,
  type D1Database as DomainD1Database,
} from '@shikoo/domain';
import { MIRZABOT_SOURCE, WAITING_TIMEOUT_MS } from '@shikoo/contracts';
import {
  tehranDayFromUtc,
  tehranDayBoundsFromDate,
  parseHistoryRange,
  parseHistoryDay,
  tehranTodayDateString,
  historyRangeBounds,
} from './tehranDay.js';
import {
  registerPaymentsHubRoutes,
  loadIncomeItems,
  loadIncomeTotals,
  loadDeclinedIncomeItems,
  loadDeclinedIncomeTotals,
  loadDeclinedIncomeCount,
  loadResellerItems,
  loadResellerStats,
  loadFinancialSummary,
  loadIncomeCount,
  loadResellerCount,
  OPEN_QUEUE_TABS,
} from './paymentsHubRoutes.js';
import {
  claimEventKey,
  getIncomeUnreadCount,
  getPaymentEventUnreadCounts,
  isPaymentEventUnread,
  markPaymentEventRead,
  markPaymentEventsReadAll,
  resellerEventKey,
} from '@shikoo/domain';

type Ident = { email: string; role: import('@shikoo/contracts').AccessRole };

export type PaymentCardListItem = {
  id: string;
  card_digits: string;
  masked: string;
  display: string;
  label: string | null;
  /** ACTIVE | DISABLED — so a list can say why the bot ignored one. */
  status: string;
};

/** Mirzabot payment_cards for account list views. */
export async function loadPaymentCardsForAccounts(
  db: D1Database,
  accountIds: string[],
): Promise<Map<string, PaymentCardListItem[]>> {
  if (accountIds.length === 0) return new Map();
  const placeholders = accountIds.map((_, i) => `?${i + 1}`).join(',');
  const rows = await db
    .prepare(
      // `status` too: the accounts list drew a disabled card and a live one
      // identically, so «حساب / کارت» could not say why the bot had ignored one.
      `SELECT id, financial_account_id, card_digits, label, status
       FROM payment_cards WHERE financial_account_id IN (${placeholders})
       ORDER BY created_at ASC`,
    )
    .bind(...accountIds)
    .all<{
      id: string;
      financial_account_id: string;
      card_digits: string;
      label: string | null;
      status: string;
    }>();
  const map = new Map<string, PaymentCardListItem[]>();
  for (const r of rows.results ?? []) {
    const item: PaymentCardListItem = {
      id: r.id,
      card_digits: r.card_digits,
      masked: maskCardDigits(r.card_digits),
      display: formatCardDigitsForDisplay(r.card_digits),
      label: r.label,
      status: r.status,
    };
    const list = map.get(r.financial_account_id) ?? [];
    list.push(item);
    map.set(r.financial_account_id, list);
  }
  return map;
}

/**
 * Human-facing buckets for the payment review inbox. These are a *projection*
 * of state the matcher already persisted (payment_claims.status,
 * payment_claims.suspect_reason, reconciliation_matches.status) — no matching
 * decision is re-derived here and no new persisted status exists.
 */
export type ReviewState =
  | 'AUTO_VERIFIED'
  | 'NEEDS_REVIEW'
  | 'MANUALLY_VERIFIED'
  /**
   * Delivered, with no bank credit behind it yet.
   *
   * A state of its own rather than a shade of `WAITING`, which is where it
   * landed before this line existed — and «در انتظار» beside an order the
   * customer is already using is the panel telling an operator the opposite of
   * what happened. It is equally not `MANUALLY_VERIFIED`: nothing has been
   * verified.
   */
  | 'FULFILLED_UNRECONCILED'
  | 'WAITING'
  | 'NO_TRANSFER_FOUND'
  | 'REJECTED'
  | 'FAKE'
  | 'EXPIRED';

/**
 * Re-exported, not restated. The union lives in `paymentsHubRoutes.ts`, which
 * this file already imports from; two copies of it is what this codebase has
 * been paying for elsewhere all week.
 *
 * About `open` — the tab this branch added. It is every claim nobody has
 * decided about yet: the queue an operator works. It replaces `needs_review`,
 * `waiting` and `suspected_fake` on the screen; those three stay in the union
 * because old links carry them and because «همه» still filters by them, but
 * they stopped being the only way to reach a row.
 *
 * The three of them together did not cover the pending claims, and that is the
 * whole reason this exists. Between them they asked for
 * `suspect_reason IS NOT NULL`, `suspect_reason IS NULL AND still inside a
 * ten-minute window`, and `suspect_reason IN (…)` — so a claim with no suspect
 * reason whose ten minutes had elapsed matched none of them. It was PENDING, it
 * was real money, and outside «همه» it appeared on no screen in the panel. Sam
 * pressed «پرداخت کردم» in the bot on 2026-08-24, opened «پرداخت‌ها», and
 * correctly reported seeing nothing.
 */
export type { PaymentTab } from './paymentsHubRoutes.js';
import type { PaymentTab } from './paymentsHubRoutes.js';

const EFFECTIVE_TS = `COALESCE(c.paid_clicked_at, c.receipt_submitted_at, c.created_at)`;
const PENDING_CLAIM = `c.status IN ('PENDING','MATCH_SUGGESTED')`;
const NO_TRANSFER_REASONS = `('NO_TRANSACTION_AFTER_10M','NO_TRANSACTION')`;

/** The one match row that settled a claim, if any (auto beats manual). */
const SETTLED_MATCH_ID = `
  SELECT m2.id FROM reconciliation_matches m2
   WHERE m2.payment_claim_id = c.id AND m2.status IN ('AUTO_VERIFIED','CONFIRMED')
   ORDER BY CASE m2.status WHEN 'AUTO_VERIFIED' THEN 0 ELSE 1 END, m2.created_at DESC
   LIMIT 1`;

function waitingEndsAt(
  receiptSubmittedAt: number | null,
  paidClickedAt: number | null,
): number | null {
  const anchor = receiptSubmittedAt ?? paidClickedAt;
  return anchor != null ? anchor + WAITING_TIMEOUT_MS : null;
}

/**
 * What a claim's row says about itself.
 *
 * Takes no clock. It used to take three more arguments — the receipt stamp, the
 * click stamp and `now` — to decide between two branches that returned the same
 * value, so the timestamps were read, compared, and thrown away. The wait is
 * still shown on the row; it is computed beside this call, where it is used.
 */
function deriveReviewState(
  claimStatus: string,
  matchStatus: string | null,
  suspectReason: string | null,
): ReviewState {
  if (claimStatus === 'VERIFIED') {
    return matchStatus === 'AUTO_VERIFIED' ? 'AUTO_VERIFIED' : 'MANUALLY_VERIFIED';
  }
  if (claimStatus === 'FULFILLED_UNRECONCILED') return 'FULFILLED_UNRECONCILED';
  if (claimStatus === 'FAKE_RECEIPT') return 'FAKE';
  if (claimStatus === 'REJECTED') return 'REJECTED';
  if (claimStatus === 'EXPIRED') return 'EXPIRED';
  if (suspectReason === 'NO_TRANSACTION_AFTER_10M' || suspectReason === 'NO_TRANSACTION') {
    return 'NO_TRANSFER_FOUND';
  }
  if (suspectReason) return 'NEEDS_REVIEW';
  // Everything else pending is WAITING, whether its ten minutes have run out or
  // not. There were two branches here and both returned this, which read as a
  // distinction and was not one: `waitingEndsAt` was computed, compared, and
  // then ignored.
  //
  // Harmless on its own, and not harmless beside `stateSql('WAITING')`, which
  // DID apply that cutoff. The row-mapper labelled a stale claim «در انتظار»
  // while the query refused to select it, so the badge counted rows the list
  // would not show. Deleting the dead branch is what makes the two agree.
  return 'WAITING';
}

/**
 * No clock parameter any more. `WAITING` was the only case that took one, to
 * apply a ten-minute cutoff that turned a label into a disappearance; with that
 * gone every branch is a pure function of the row, and the three call sites stop
 * having to special-case one state.
 */
function stateSql(state: ReviewState): string {
  switch (state) {
    case 'AUTO_VERIFIED':
      return `c.status = 'VERIFIED' AND m.status = 'AUTO_VERIFIED'`;
    case 'MANUALLY_VERIFIED':
      return `c.status = 'VERIFIED' AND (m.status IS NULL OR m.status = 'CONFIRMED')`;
    case 'NEEDS_REVIEW':
      return `${PENDING_CLAIM} AND c.suspect_reason IS NOT NULL AND c.suspect_reason NOT IN ${NO_TRANSFER_REASONS}`;
    case 'WAITING':
      // No upper bound on the wait, and that removal is the fix.
      //
      // It used to add `COALESCE(receipt_submitted_at, paid_clicked_at) +
      // WAITING_TIMEOUT_MS > now`, which
      // reads as "still within the window" and behaves as "disappears from the
      // panel". The ten minutes are how long the MATCHER keeps looking; they
      // were never meant to decide whether an operator can see the row.
      //
      // The claim is supposed to leave this bucket by acquiring a
      // `suspect_reason` — which is exactly what the sweeper that stamps one
      // refuses to do when `target_financial_account_id IS NULL`
      // (`integrations/mirzabot.ts:278`), and the bot opens claims with a null
      // account on purpose whenever the card is not mapped yet. So for those,
      // the exit condition never fires and the timer alone hid them forever.
      return `${PENDING_CLAIM} AND c.suspect_reason IS NULL`;
    case 'FULFILLED_UNRECONCILED':
      return `c.status = 'FULFILLED_UNRECONCILED'`;
    case 'NO_TRANSFER_FOUND':
      return `${PENDING_CLAIM} AND c.suspect_reason IN ${NO_TRANSFER_REASONS}`;
    case 'REJECTED':
      return `c.status = 'REJECTED'`;
    case 'FAKE':
      return `c.status = 'FAKE_RECEIPT'`;
    case 'EXPIRED':
      return `c.status = 'EXPIRED'`;
  }
}

type ClaimRow = {
  id: string;
  external_order_id: string;
  customer_reference: string | null;
  expected_amount_irr: number;
  target_financial_account_id: string | null;
  card_digits: string | null;
  paid_clicked_at: number | null;
  receipt_submitted_at: number | null;
  has_receipt: boolean;
  created_at: number;
  suspect_reason: string | null;
  suspect_metadata_json: string;
  metadata_json: string;
  status: string;
  account_display: string | null;
  account_bank: string | null;
  account_hint: string | null;
  match_status: string | null;
  match_mismatch_reasons_json: string | null;
  match_reviewed_at: number | null;
  match_reviewed_by: string | null;
  matched_tx_id: string | null;
  matched_tx_amount: number | null;
  matched_tx_bank_timestamp: number | null;
  device_id: string | null;
  device_display_name: string | null;
  device_code: string | null;
  effective_ts: number;
  // DEV-only: present when the worker is built with ENABLE_PURCHASE_TYPE=true
  // and the dev D1 has these columns. Production D1 doesn't have them and the
  // SELECT omits them, so these fields are simply absent there.
  purchase_type?: string | null;
  operation_type?: string | null;
};

type DeviceRef = { id: string; name: string };

function deviceDisplayName(
  displayName: string | null | undefined,
  deviceCode: string | null | undefined,
): string | null {
  const name = displayName?.trim();
  if (name) return name;
  const code = deviceCode?.trim();
  return code || null;
}

function deviceFromRow(
  row: Pick<ClaimRow, 'device_id' | 'device_display_name' | 'device_code'>,
): DeviceRef | null {
  if (!row.device_id) return null;
  const name = deviceDisplayName(row.device_display_name, row.device_code);
  return name ? { id: row.device_id, name } : null;
}

/** Batch-resolve SMS source devices for transaction candidates (no per-row N+1). */
async function loadDevicesForTransactions(db: D1Database, txIds: string[]) {
  if (txIds.length === 0) return new Map<string, DeviceRef>();
  const placeholders = txIds.map((_, i) => `?${i + 1}`).join(',');
  const rows = await db
    .prepare(
      `SELECT t.id AS tx_id, d.id AS device_id, d.display_name, d.device_code
       FROM transaction_candidates t
       JOIN raw_sms_events rse ON rse.id = t.raw_sms_event_id
       JOIN devices d ON d.id = rse.device_id
       WHERE t.id IN (${placeholders})`,
    )
    .bind(...txIds)
    .all<{
      tx_id: string;
      device_id: string;
      display_name: string | null;
      device_code: string | null;
    }>();
  const map = new Map<string, DeviceRef>();
  for (const r of rows.results ?? []) {
    const name = deviceDisplayName(r.display_name, r.device_code);
    if (name) map.set(r.tx_id, { id: r.device_id, name });
  }
  return map;
}

/** Infer primary SMS device per financial account from recent parsed transactions. */
async function loadPrimaryDevicesForAccounts(db: D1Database, accountIds: string[]) {
  if (accountIds.length === 0) return new Map<string, DeviceRef>();
  const placeholders = accountIds.map((_, i) => `?${i + 1}`).join(',');
  const rows = await db
    .prepare(
      `SELECT t.financial_account_id, r.device_id, t.bank_timestamp, d.display_name, d.device_code
       FROM transaction_candidates t
       JOIN raw_sms_events r ON r.id = t.raw_sms_event_id
       JOIN devices d ON d.id = r.device_id
       WHERE t.financial_account_id IN (${placeholders})
         AND t.status IN ('PARSED', 'NEEDS_REVIEW', 'MATCH_SUGGESTED', 'MATCHED')
         AND r.device_id IS NOT NULL
       ORDER BY t.financial_account_id, t.bank_timestamp DESC`,
    )
    .bind(...accountIds)
    .all<{
      financial_account_id: string;
      device_id: string;
      bank_timestamp: number;
      display_name: string | null;
      device_code: string | null;
    }>();

  const observationsByAccount = new Map<
    string,
    Array<{ deviceId: string; bankTimestamp: number }>
  >();
  const devicesLookup = new Map<
    string,
    { displayName: string | null; deviceCode: string | null }
  >();
  for (const r of rows.results ?? []) {
    const list = observationsByAccount.get(r.financial_account_id) ?? [];
    if (list.length < 20) {
      list.push({ deviceId: r.device_id, bankTimestamp: r.bank_timestamp });
      observationsByAccount.set(r.financial_account_id, list);
    }
    if (!devicesLookup.has(r.device_id)) {
      devicesLookup.set(r.device_id, {
        displayName: r.display_name,
        deviceCode: r.device_code,
      });
    }
  }

  const map = new Map<string, DeviceRef>();
  for (const accountId of accountIds) {
    const inferred = inferPrimaryDevice(observationsByAccount.get(accountId) ?? [], devicesLookup);
    if (!inferred.primaryDeviceId) continue;
    const name = deviceDisplayName(inferred.primaryDeviceDisplayName, inferred.primaryDeviceCode);
    if (name) map.set(accountId, { id: inferred.primaryDeviceId, name });
  }
  return map;
}

function numParam(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * A card number from the query string, or null.
 *
 * Digits only and 12-19 long, which is the shape `payment_cards.card_digits`
 * holds. Validated rather than passed through because this value reaches a
 * bind slot on an indexed column: anything else is a typo, and answering a
 * typo with «no claims» reads as «this card took no money», which is a
 * sentence about the shop rather than about the input.
 *
 * A four-digit suffix is deliberately NOT accepted. The screen shows
 * «****5678» so it is the obvious thing to type, but matching it means
 * `right(card_digits, 4) = ...`, which `idx_claim_card_digits` cannot serve --
 * a sequential scan of every claim, to save picking from a list of the shop's
 * own cards.
 */
function cardDigitsParam(raw: string | null): string | null {
  if (!raw) return null;
  return /^\d{12,19}$/.test(raw) ? raw : null;
}

/**
 * A Telegram id from the query string, or null.
 *
 * `payment_claims.customer_reference` is text and holds the id as digits.
 * Telegram ids are 64-bit, so this is not parsed as a number -- above 2^53 a
 * `Number()` round trip silently changes the last digits, and the claim it
 * would then fail to find is a real customer's.
 */
function telegramIdParam(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw.trim();
  return /^\d{1,20}$/.test(v) ? v : null;
}

/**
 * `page` and `pageSize`, clamped. `pageSize` was a hard 200 until 2026-09-03.
 *
 * 200 is both the default AND the ceiling, and the ceiling is the interesting
 * half. Each row in the answer costs its own query — `isPaymentEventUnread`
 * runs once per claim, an N+1 that predates this change — so the page size is
 * a multiplier on round trips, not just on bytes. Measured against the local
 * database, which is the friendliest case because it shares a host:
 *
 *   pageSize=200   0.106s
 *   pageSize=500   0.193s
 *
 * Linear in rows, as an N+1 is. A 500 cap was written first and taken back:
 * it would have shipped a 2.5x multiplier on that cost to buy a bigger page
 * nobody asked for. Keeping the old number means this commit adds pages
 * without making any single request slower than it already was.
 *
 * ponytail: per-row unread lookup, batch it into one `WHERE event_key = ANY`
 * if a larger page is ever wanted — then the cap can rise safely.
 */
function pageParams(url: URL): { page: number; pageSize: number } {
  const rawPage = Number(url.searchParams.get('page'));
  const rawSize = Number(url.searchParams.get('pageSize'));
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const pageSize = Number.isInteger(rawSize) && rawSize > 0 ? Math.min(rawSize, 200) : 200;
  return { page, pageSize };
}

function deltaSeconds(paidClickedAt: number | null, bankTimestamp: number | null): number | null {
  if (paidClickedAt == null || bankTimestamp == null) return null;
  return Math.round(Math.abs(bankTimestamp - paidClickedAt) / 1000);
}

/**
 * Bank transactions an operator may pick from when approving manually. The
 * matcher records the exact set it considered in suspect_metadata_json; we only
 * fall back to a same-account/same-amount lookup when it recorded none.
 */
async function loadCandidates(db: D1Database, row: ClaimRow, candidateIds: string[]) {
  const select = `
    SELECT t.id, t.amount_irr, t.bank_timestamp, t.financial_account_id,
           fa.display_name AS account_display, fa.bank_name AS account_bank,
           fa.account_hint,
           EXISTS (SELECT 1 FROM reconciliation_matches m
                    WHERE m.transaction_candidate_id = t.id
                      AND m.status IN ('AUTO_VERIFIED','CONFIRMED')) AS consumed
    FROM transaction_candidates t
    LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id`;

  type Row = {
    id: string;
    amount_irr: number | null;
    bank_timestamp: number | null;
    financial_account_id: string | null;
    account_display: string | null;
    account_bank: string | null;
    account_hint: string | null;
    consumed: number;
  };

  let result: D1Result<Row>;
  if (candidateIds.length > 0) {
    const placeholders = candidateIds.map((_, i) => `?${i + 1}`).join(',');
    result = await db
      .prepare(`${select} WHERE t.id IN (${placeholders})`)
      .bind(...candidateIds)
      .all<Row>();
  } else if (row.target_financial_account_id) {
    result = await db
      .prepare(
        `${select}
         WHERE t.financial_account_id = ?1
           AND t.direction = 'CREDIT'
           AND t.processing_disposition = 'ACTIONABLE'
           AND t.amount_irr = ?2
         ORDER BY t.bank_timestamp DESC LIMIT 10`,
      )
      .bind(row.target_financial_account_id, row.expected_amount_irr)
      .all<Row>();
  } else {
    return [];
  }

  return (result.results ?? [])
    .map((t) => ({
      id: t.id,
      amountIrr: t.amount_irr,
      bankTimestamp: t.bank_timestamp,
      timeDeltaSeconds: deltaSeconds(row.paid_clicked_at, t.bank_timestamp),
      accountId: t.financial_account_id,
      accountDisplay: t.account_display,
      accountBank: t.account_bank,
      accountHint: t.account_hint,
      alreadyConsumed: t.consumed === 1,
    }))
    .sort((a, b) => (a.bankTimestamp ?? 0) - (b.bankTimestamp ?? 0));
}

/** Tab badges + the "today" header, counted over the whole population. */
async function loadCounts(db: D1Database, dayStart: number, dayEnd: number, actorEmail?: string) {
  const rows = await db
    .prepare(
      `SELECT
         CASE
           WHEN c.status = 'VERIFIED' AND m.status = 'AUTO_VERIFIED' THEN 'AUTO_VERIFIED'
           WHEN c.status = 'VERIFIED' THEN 'MANUALLY_VERIFIED'
           WHEN c.status = 'FAKE_RECEIPT' THEN 'FAKE'
           WHEN c.status = 'REJECTED' THEN 'REJECTED'
           WHEN c.status = 'EXPIRED' THEN 'EXPIRED'
           WHEN ${PENDING_CLAIM} AND c.suspect_reason IN ${NO_TRANSFER_REASONS} THEN 'NO_TRANSFER_FOUND'
           WHEN ${PENDING_CLAIM} AND c.suspect_reason IS NOT NULL THEN 'NEEDS_REVIEW'
           WHEN ${PENDING_CLAIM} AND c.suspect_reason IS NULL THEN 'WAITING'
           ELSE 'NEEDS_REVIEW'
         END AS review_state,
         COUNT(*) AS n,
         SUM(CASE WHEN ${EFFECTIVE_TS} BETWEEN ?2 AND ?3 THEN 1 ELSE 0 END) AS n_today
       FROM payment_claims c
       LEFT JOIN reconciliation_matches m ON m.id = (${SETTLED_MATCH_ID})
       WHERE c.source_system = ?1
       GROUP BY review_state`,
    )
    // Three binds, not four. The fourth was the clock, for a `WHEN` arm that
    // applied the ten-minute cutoff and was followed immediately by an
    // identical arm without it — so the first could only ever match rows the
    // second would have caught anyway. Dead, and not harmlessly: that arm was
    // the badge's half of a disagreement with `stateSql`, which DID drop the
    // stale rows. Removing it also has to remove the bind, because
    // `packages/db` refuses a statement with a parameter nothing uses rather
    // than guessing — SQLite ignored those, Postgres cannot.
    .bind(MIRZABOT_SOURCE, dayStart, dayEnd)
    .all<{ review_state: ReviewState; n: number; n_today: number }>();

  const total: Record<ReviewState, number> = {
    AUTO_VERIFIED: 0,
    NEEDS_REVIEW: 0,
    MANUALLY_VERIFIED: 0,
    FULFILLED_UNRECONCILED: 0,
    WAITING: 0,
    NO_TRANSFER_FOUND: 0,
    REJECTED: 0,
    FAKE: 0,
    EXPIRED: 0,
  };
  const today = { ...total };
  let all = 0;
  for (const r of rows.results ?? []) {
    total[r.review_state] += r.n;
    today[r.review_state] += r.n_today ?? 0;
    all += r.n;
  }

  const decidedToday =
    today.AUTO_VERIFIED + today.NEEDS_REVIEW + today.MANUALLY_VERIFIED + today.NO_TRANSFER_FOUND;

  const paymentUnread = actorEmail
    ? await getPaymentEventUnreadCounts(db as unknown as DomainD1Database, actorEmail)
    : {
        needsReview: 0,
        suspectedFake: 0,
        botAutoVerified: 0,
        reseller: 0,
        total: 0,
      };
  const incomeUnread = actorEmail
    ? await getIncomeUnreadCount(db as unknown as DomainD1Database, actorEmail)
    : 0;

  return {
    total: {
      ...total,
      needsReview: total.NEEDS_REVIEW,
      waiting: total.WAITING,
      suspectedFake: total.NO_TRANSFER_FOUND,
      /**
       * The badge on «در انتظار بررسی».
       *
       * Summed from the three undecided states rather than counted by its own
       * query, and that is the point: the number on the tab and the rows in the
       * list are then the same population by construction. A second query is
       * how the old badge came to say «۱» over a list showing nothing.
       *
       * These three are exactly `PENDING`/`MATCH_SUGGESTED` — every other state
       * in this record is a decision somebody already made.
       */
      open: total.NEEDS_REVIEW + total.WAITING + total.NO_TRANSFER_FOUND,
      autoVerified: total.AUTO_VERIFIED,
      botAutoVerified: total.AUTO_VERIFIED,
      manuallyVerified: total.MANUALLY_VERIFIED,
      income: await loadIncomeCount(db),
      declinedIncome: await loadDeclinedIncomeCount(db),
      reseller: await loadResellerCount(db),
      all,
      needsReviewUnread: paymentUnread.needsReview,
      suspectedFakeUnread: paymentUnread.suspectedFake,
      botAutoVerifiedUnread: paymentUnread.botAutoVerified,
      resellerUnread: paymentUnread.reseller,
      incomeUnread,
    },
    today: {
      ...today,
      automationRate: decidedToday === 0 ? null : today.AUTO_VERIFIED / decidedToday,
    },
  };
}

export function registerMirzabotRoutes(
  app: Hono<{
    Bindings: {
      DB: D1Database;
      // DEV-only feature flags. Production workers never set these, so they
      // are intentionally optional. Cast through Partial to keep the existing
      // Bindings type unchanged for callers that don't need the flags.
      ENABLE_PURCHASE_TYPE?: string;
      DEV_BLOCK_DEVICE_ADMIN?: string;
      INGEST_URL?: string;
    };
    Variables: { identity: Ident };
  }>,
) {
  /**
   * The issuer table, read fresh per request.
   *
   * It is a few dozen rows behind Cloudflare Access, so caching it would trade
   * a millisecond for a stale answer right after an admin corrects a prefix —
   * which is the one moment they are looking at the screen to check.
   */
  async function loadPrefixes(db: D1Database): Promise<BankPrefix[]> {
    const rows = await db
      .prepare(`SELECT prefix, bank_name FROM bank_card_prefixes`)
      .all<{ prefix: string; bank_name: string }>();
    return (rows.results ?? []).map((r) => ({ prefix: r.prefix, bankName: r.bank_name }));
  }

  app.get('/api/v1/accounts/:accountId/payment-cards', async (c) => {
    const prefixes = await loadPrefixes(c.env.DB);
    const rows = await c.env.DB.prepare(
      `SELECT id, financial_account_id, card_digits, label, created_at,
              status, display_weight, last_assigned_at
       FROM payment_cards WHERE financial_account_id = ?1 ORDER BY created_at DESC`,
    )
      .bind(c.req.param('accountId'))
      .all<{
        id: string;
        financial_account_id: string;
        card_digits: string;
        label: string | null;
        created_at: number;
        status: string;
        display_weight: number;
        last_assigned_at: number | null;
      }>();
    const items = (rows.results ?? []).map((r) => ({
      id: r.id,
      financial_account_id: r.financial_account_id,
      card_digits: r.card_digits,
      masked: maskCardDigits(r.card_digits),
      display: formatCardDigitsForDisplay(r.card_digits),
      label: r.label,
      created_at: r.created_at,
      status: r.status,
      // How much more often than a weight-1 card this one is handed out.
      display_weight: r.display_weight,
      last_assigned_at: r.last_assigned_at,
      bank_name: identifyBank(r.card_digits, prefixes),
      luhn_ok: luhnOk(r.card_digits),
    }));
    return c.json({ ok: true, items });
  });

  const AddCardBody = z
    .object({
      cardNumber: z.string().min(1).max(64),
      label: z.string().max(128).optional(),
      /** Reassign if this card is mapped to another account (TEST/admin). */
      moveIfMapped: z.boolean().optional(),
    })
    .strict();
  app.post('/api/v1/accounts/:accountId/payment-cards', async (c) => {
    const ident = c.get('identity');
    if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
    const parsed = AddCardBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const digits = normalizeCardDigits(parsed.data.cardNumber);
    if (!digits) {
      return c.json(
        {
          ok: false,
          error: 'invalid_card',
          message:
            'Enter exactly 16 digits (spaces/dashes OK). Do not paste the account name with the number.',
        },
        400,
      );
    }
    const accountId = c.req.param('accountId');
    const account = await c.env.DB.prepare(
      `SELECT id, display_name FROM financial_accounts WHERE id = ?1`,
    )
      .bind(accountId)
      .first<{ id: string; display_name: string }>();
    if (!account) return c.json({ ok: false, error: 'not_found' }, 404);
    const existing = await c.env.DB.prepare(
      `SELECT pc.id, pc.financial_account_id, fa.display_name AS account_display
       FROM payment_cards pc
       LEFT JOIN financial_accounts fa ON fa.id = pc.financial_account_id
       WHERE pc.card_digits = ?1`,
    )
      .bind(digits)
      .first<{ id: string; financial_account_id: string; account_display: string | null }>();
    if (existing) {
      if (existing.financial_account_id === accountId) {
        return c.json({
          ok: true,
          id: existing.id,
          card_digits: digits,
          masked: maskCardDigits(digits),
          display: formatCardDigitsForDisplay(digits),
          alreadyMapped: true,
        });
      }
      if (!parsed.data.moveIfMapped) {
        return c.json(
          {
            ok: false,
            error: 'card_already_mapped',
            message: `Card ****${digits.slice(-4)} is already mapped to "${existing.account_display ?? existing.financial_account_id}". Remove it there or use Move here.`,
            existingCardId: existing.id,
            existingAccountId: existing.financial_account_id,
            existingAccountDisplay: existing.account_display,
          },
          409,
        );
      }
      await c.env.DB.prepare(`DELETE FROM payment_cards WHERE id = ?1`).bind(existing.id).run();
    }
    const now = Date.now();
    const id = crypto.randomUUID();
    try {
      // The rotation cursor starts level with the cards already in service, not
      // at zero. A card starting at zero among peers whose cursors are in the
      // millions wins EVERY checkout until it catches up — which is exactly the
      // behaviour the head admin asked us to remove, so re-introducing it here
      // would undo the whole change.
      await c.env.DB.prepare(
        `INSERT INTO payment_cards (id, financial_account_id, card_digits, label, created_at, rotation_cursor)
         VALUES (?1,?2,?3,?4,?5,
                 COALESCE((SELECT MAX(rotation_cursor) FROM payment_cards WHERE status = 'ACTIVE'), 0))`,
      )
        .bind(id, accountId, digits, parsed.data.label ?? null, now)
        .run();
    } catch {
      return c.json(
        { ok: false, error: 'card_already_mapped', message: 'Could not map card.' },
        409,
      );
    }
    // Reported, never enforced. A card that fails Luhn cannot exist, and one
    // such row is live in production today (BUGS-FOR-ADMIN.md item 4) — but the
    // issuer table can be out of date, so refusing the save on a bank mismatch
    // would block a correct card on our own stale data.
    const prefixes = await loadPrefixes(c.env.DB);
    const detectedBank = identifyBank(digits, prefixes);

    // An account with no bank of its own learns it here, from the issuer of the
    // card just mapped to it.
    //
    // Three of the eight banks the shop receives from — Resalat, Maskan, Mehr —
    // never put their name in the SMS, so the parser reports `bank: UNKNOWN`
    // and every screen that shows a bank reads `financial_accounts.bank_name`
    // instead. Those rows would stay blank forever.
    //
    // Guessing from the ACCOUNT number was measured against the shop's own 26
    // accounts and got 15 right, 1 wrong, 10 don't-know — the wrong one a
    // five-digit Melli account matching a thirteen-digit Shahr one on four
    // leading characters. A card BIN is a real registry rather than a shape, and
    // `bank_card_prefixes` is already in the panel for the operator to correct.
    //
    // FILL only, never correct: `''` and `'UNKNOWN'` are the two ways this
    // column says «nobody has told us», and the `WHERE` treats both as empty.
    // A name a person typed outranks an issuer table that may be stale — the
    // same judgement the Luhn check makes two lines above.
    if (detectedBank) {
      await c.env.DB.prepare(
        `UPDATE financial_accounts
            SET bank_name = ?2, updated_at = ?3
          WHERE id = ?1 AND (bank_name = '' OR bank_name = 'UNKNOWN')`,
      )
        .bind(accountId, detectedBank, now)
        .run();
    }

    return c.json({
      ok: true,
      id,
      card_digits: digits,
      masked: maskCardDigits(digits),
      display: formatCardDigitsForDisplay(digits),
      moved: existing != null && existing.financial_account_id !== accountId,
      luhn_ok: luhnOk(digits),
      bank_name: detectedBank,
    });
  });

  /**
   * Editing one card: how often it is shown, whether it is shown at all, and
   * what it is called.
   *
   * `rotation_cursor` is deliberately NOT here. It is rotation's own state, and
   * an admin setting it by hand would be editing the queue position of every
   * other card at the same time.
   *
   * Every field is optional and at least one is required. A PATCH that asks for
   * nothing is a 400 rather than a no-op, because the alternative is an audit
   * row recording that nothing happened.
   */
  const CardEditBody = z
    .object({
      displayWeight: z.number().int().min(1).max(20).optional(),
      status: z.enum(['ACTIVE', 'DISABLED']).optional(),
      label: z.string().max(120).nullable().optional(),
    })
    .strict()
    .refine((b) => b.displayWeight !== undefined || b.status !== undefined || b.label !== undefined);
  app.patch('/api/v1/payment-cards/:id', async (c) => {
    const ident = c.get('identity');
    // READ_ONLY, not «not ADMIN» — the same guard its two siblings use.
    //
    // Adding a card (POST, above) and deleting one (DELETE, below) both admit a
    // REVIEWER; only turning one off demanded ADMIN, and the screen did not
    // know: the button spreads `useWriteProps`, which is `role !== 'READ_ONLY'`,
    // so a REVIEWER saw an enabled «خاموش کن» that answered 403. Whoever may
    // add and delete a card may certainly disable one.
    if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
    const parsed = CardEditBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const cardId = c.req.param('id');
    const before = await c.env.DB.prepare(
      `SELECT id, card_digits, display_weight, status, label
         FROM payment_cards WHERE id = ?1`,
    )
      .bind(cardId)
      .first<{
        id: string;
        card_digits: string;
        display_weight: number;
        status: string;
        label: string | null;
      }>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);

    const after = {
      displayWeight: parsed.data.displayWeight ?? before.display_weight,
      status: parsed.data.status ?? before.status,
      label: parsed.data.label !== undefined ? parsed.data.label : before.label,
    };
    // Coming back into service is the same event as being added, and it needs
    // the same seed. The cursor is a clock that only moves forward: a card
    // parked at 4,000,000 while its peers climbed to 40,000,000 would take
    // EVERY checkout until it caught up — the behaviour the head admin asked us
    // to remove on 2026-08-13, arriving through a door that did not exist then.
    // Only on the way IN: seeding on the way out would move the queue for an
    // act that should not, and seeding an already-ACTIVE card would reshuffle
    // it every time a UI saved the row unchanged.
    const rejoining = before.status === 'DISABLED' && after.status === 'ACTIVE' ? 1 : 0;

    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO audit_logs
           (id, actor_email, actor_role, action, entity_type, entity_id,
            before_json, after_json, reason, request_id, created_at)
         VALUES (?1, ?2, ?3, 'payment_card.updated', 'PAYMENT_CARD', ?4, ?5, ?6, NULL, NULL, ?7)`,
      ).bind(
        crypto.randomUUID(),
        ident.email,
        ident.role,
        cardId,
        JSON.stringify({
          displayWeight: before.display_weight,
          status: before.status,
          label: before.label,
        }),
        JSON.stringify(after),
        now,
      ),
      // Only the columns the body named. Writing all three from the row read a
      // moment ago is a read-modify-write, and two saves in flight then revert
      // each other — which the panel produces by design, because the label
      // saves on blur and blur is what happens on the way to pressing a button.
      //
      // `label` cannot use COALESCE: null is a real value there, meaning «no
      // label», so a separate flag says whether it was asked for at all.
      //
      // `id <> ?1` rather than relying on the row still reading DISABLED inside
      // its own UPDATE: the snapshot rule is right, but a guard a reader can see
      // is worth more than one they have to derive.
      c.env.DB.prepare(
        `UPDATE payment_cards
            SET display_weight = COALESCE(?2, display_weight),
                status = COALESCE(?3, status),
                label = CASE WHEN ?4 = 1 THEN ?5 ELSE label END,
                rotation_cursor = CASE WHEN ?6 = 1
                  THEN COALESCE((SELECT MAX(rotation_cursor) FROM payment_cards
                                  WHERE status = 'ACTIVE' AND id <> ?1), rotation_cursor)
                  ELSE rotation_cursor END
          WHERE id = ?1`,
      ).bind(
        cardId,
        parsed.data.displayWeight ?? null,
        parsed.data.status ?? null,
        parsed.data.label !== undefined ? 1 : 0,
        parsed.data.label ?? null,
        rejoining,
      ),
    ]);
    return c.json({ ok: true, id: cardId, ...after });
  });

  app.delete('/api/v1/payment-cards/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
    await c.env.DB.prepare(`DELETE FROM payment_cards WHERE id = ?1`).bind(c.req.param('id')).run();
    return c.json({ ok: true });
  });

  app.get('/api/v1/payments', async (c) => {
    const ident = c.get('identity');
    const url = new URL(c.req.url);
    const now = Date.now();
    const range = parseHistoryRange(url.searchParams.get('range'));
    const day =
      range === 'day'
        ? (parseHistoryDay(url.searchParams.get('day')) ?? tehranTodayDateString(now))
        : parseHistoryDay(url.searchParams.get('day'));
    const tab = ((): PaymentTab => {
      const raw = url.searchParams.get('tab');
      const allowed: PaymentTab[] = [
        'income',
        'open',
        'needs_review',
        'declined_income',
        'waiting',
        'suspected_fake',
        'bot_auto_verified',
        'manually_verified',
        'reseller',
        'all',
      ];
      if (raw === 'auto_verified') return 'bot_auto_verified';
      if (raw && allowed.includes(raw as PaymentTab)) return raw as PaymentTab;
      // The landing tab, and it is «واریزی‌ها» on purpose no longer.
      //
      // `income` reads `transaction_candidates` — bank credits nobody has
      // claimed — which is a real screen and the wrong first one. It is also
      // the exact reason Sam opened «پرداخت‌ها» looking for the order he had
      // just placed and found an empty list: his claim was never going to be
      // in that table, whatever the filters said.
      return 'open';
    })();

    const financialSummary = await loadFinancialSummary(c.env.DB, range, now, day);
    const { start, end } = tehranDayFromUtc(now);
    const counts = await loadCounts(c.env.DB, start, end, ident.email);
    const domainDb = c.env.DB as unknown as DomainD1Database;

    if (tab === 'income') {
      const items = await loadIncomeItems(c.env.DB, range, now, day, 200, ident.email);
      const incomeTotals = await loadIncomeTotals(c.env.DB, range, now, day);
      return c.json({
        ok: true,
        tab,
        range,
        items,
        incomeTotals,
        counts: counts.total,
        summary: financialSummary,
      });
    }

    if (tab === 'declined_income') {
      const items = await loadDeclinedIncomeItems(c.env.DB, range, now, day);
      const declinedTotals = await loadDeclinedIncomeTotals(c.env.DB, range, now, day);
      return c.json({
        ok: true,
        tab,
        range,
        items,
        declinedTotals,
        counts: counts.total,
        summary: financialSummary,
      });
    }

    if (tab === 'reseller') {
      const items = await loadResellerItems(c.env.DB, range, now, day);
      const itemsWithNew = await Promise.all(
        items.map(async (item) => ({
          ...item,
          isNew: await isPaymentEventUnread(domainDb, ident.email, resellerEventKey(item.id)),
        })),
      );
      const resellerStats = await loadResellerStats(c.env.DB, range, now, day);
      return c.json({
        ok: true,
        tab,
        range,
        items: itemsWithNew,
        resellerStats,
        counts: counts.total,
        summary: financialSummary,
      });
    }

    const statusFilter = url.searchParams.get('status');
    /**
     * One claim by id, for the review page's deep link.
     *
     * `?claim=` in the address bar opens «بررسی پرداخت» directly, and the
     * screen resolved it by searching the page it had already loaded —
     * `claimItems.find(...)` over `LIMIT 200`. A link to the 201st claim, or
     * to one on another tab, rendered «این پرداخت در فهرست باز نیست», which
     * reads as "somebody decided this" and is not what happened. On a queue of
     * 505 that is most of them.
     *
     * A filter here rather than a `GET /payment-claims/:id`: everything the
     * review page needs — the candidate transactions, the device, whether a
     * receipt exists — is already assembled by the mapper below, and a second
     * route would be a second copy of it that has to stay in step.
     *
     * It overrides the tab, deliberately. The point of the link is to reach a
     * payment without knowing which queue it is sitting in.
     */
    const claimIdParam = url.searchParams.get('claim');
    const claimId = claimIdParam && /^[A-Za-z0-9_-]{1,64}$/.test(claimIdParam) ? claimIdParam : null;
    const accountId = url.searchParams.get('accountId');
    const reason = url.searchParams.get('reason');
    /*
     * `from`/`to` are epoch milliseconds the BROWSER computed, and it computed
     * them wrong: `Date.parse(day + 'T00:00:00')` carries no zone, so it means
     * midnight wherever the operator happens to be sitting. Up to three and a
     * half hours of claims off either edge, on a money screen.
     *
     * `fromDay`/`toDay` are the fix, and they carry the DAY rather than an
     * instant: the server owns «which milliseconds Tehran calls that day»,
     * which is the only place that knowledge is already right. The numeric
     * pair is still read so saved links keep working -- those name an instant
     * on purpose -- and the day pair wins when both are sent.
     */
    const fromDay = parseHistoryDay(url.searchParams.get('fromDay'));
    const toDay = parseHistoryDay(url.searchParams.get('toDay'));
    const from = fromDay
      ? tehranDayBoundsFromDate(fromDay).start
      : numParam(url.searchParams.get('from'));
    // The END of the named day, so «تا ۷ آبان» includes the 7th. Its start
    // would drop everything that happened on the last day asked for -- a
    // figure slightly too small, which nobody queries.
    const to = toDay ? tehranDayBoundsFromDate(toDay).end - 1 : numParam(url.searchParams.get('to'));
    const cardDigits = cardDigitsParam(url.searchParams.get('cardDigits'));
    const telegramId = telegramIdParam(url.searchParams.get('telegramId'));
    const { page, pageSize } = pageParams(url);
    // DEV-only: purchase_type filter (only valid for bot_auto_verified tab).
    const purchaseTypeFilter = url.searchParams.get('purchaseType');
    const featureEnabled = c.env?.ENABLE_PURCHASE_TYPE === 'true';
    const allowedPurchaseTypes = new Set(['NEW_PURCHASE', 'RENEWAL', 'UNKNOWN']);
    const purchaseTypeForQuery =
      featureEnabled &&
      tab === 'bot_auto_verified' &&
      purchaseTypeFilter &&
      allowedPurchaseTypes.has(purchaseTypeFilter)
        ? purchaseTypeFilter
        : null;

    const binds: unknown[] = [];
    const p = (v: unknown) => {
      binds.push(v);
      return `?${binds.length}`;
    };

    const where = [`c.source_system = ${p(MIRZABOT_SOURCE)}`];

    /*
     * `?claim=` answers with that one row and nothing else — no tab predicate,
     * no range, no ordering that could push it past the limit. Returning early
     * is the whole point: every filter below narrows, and any of them could
     * narrow the one row the caller asked for back out of the answer.
     */
    if (claimId) {
      where.push(`c.id = ${p(claimId)}`);
    } else {
      // The whole of «در انتظار بررسی», and it is deliberately not expressed as
      // a `ReviewState`. The three old queues each described a SHAPE of claim
      // and between them left a gap; this one describes the only thing that
      // actually matters to an operator — nobody has decided about it yet — so
      // there is no shape left for a row to fall between.
      if (tab === 'open') where.push(PENDING_CLAIM);

      const tabState: ReviewState | null =
        tab === 'needs_review'
          ? 'NEEDS_REVIEW'
          : tab === 'waiting'
            ? 'WAITING'
            : tab === 'suspected_fake'
              ? 'NO_TRANSFER_FOUND'
              : tab === 'bot_auto_verified'
                ? 'AUTO_VERIFIED'
                : tab === 'manually_verified'
                  ? 'MANUALLY_VERIFIED'
                  : null;
      if (tabState) where.push(stateSql(tabState));
      if (tab === 'all' && statusFilter) {
        const allowed: ReviewState[] = [
          'AUTO_VERIFIED',
          'NEEDS_REVIEW',
          'MANUALLY_VERIFIED',
          'WAITING',
          'NO_TRANSFER_FOUND',
          'REJECTED',
          'FAKE',
          'EXPIRED',
        ];
        if (allowed.includes(statusFilter as ReviewState)) {
          const st = statusFilter as ReviewState;
          where.push(stateSql(st));
        }
      }
      if (accountId) where.push(`c.target_financial_account_id = ${p(accountId)}`);
      // The card the customer was TOLD to pay into, snapshotted on the claim.
      // Not the card's account: one account carries several cards, and «چقدر
      // به این کارت ریخته شد» is a question about the card.
      if (cardDigits) where.push(`c.card_digits = ${p(cardDigits)}`);
      if (telegramId) where.push(`c.customer_reference = ${p(telegramId)}`);
      if (reason) where.push(`c.suspect_reason = ${p(reason)}`);
      if (from != null) where.push(`${EFFECTIVE_TS} >= ${p(from)}`);
      if (to != null) where.push(`${EFFECTIVE_TS} <= ${p(to)}`);
      if (purchaseTypeForQuery) {
        where.push(`c.purchase_type = ${p(purchaseTypeForQuery)}`);
      }

      if (!OPEN_QUEUE_TABS.has(tab) && tab !== 'needs_review') {
        const { start: rs, end: re } = historyRangeBounds(range, now, day);
        if (rs != null && re != null) {
          where.push(`${EFFECTIVE_TS} >= ${p(rs)} AND ${EFFECTIVE_TS} < ${p(re)}`);
        }
      }
    }

    const order =
      tab === 'needs_review' || tab === 'waiting' || tab === 'suspected_fake' ? 'ASC' : 'DESC';

    // DEV-only: when feature flag is on, project purchase_type/operation_type columns
    // back to the dashboard. When off, the SELECT is identical to the production shape,
    // so production D1 (without these columns) is unaffected.
    //
    // DATA LIMITATION (DEV only):
    //   Historical AUTO_VERIFIED rows have purchase_type because of the one-shot backfill
    //   that joined Mirzabot MySQL.Payment_report.id_invoice.
    //   Future claims ingested after this dev deploy WILL NOT auto-populate
    //   purchase_type unless the prepared ingest patch (which extends
    //   apps/ingest-worker/src/integrations/mirzabot.ts to read
    //   operationType/purchaseType from the body and write them via the
    //   prepared `insertPaymentClaimWithPurchaseType` helper) is approved
    //   and deployed.  Until then, any new claim renders with
    //   purchase_type='UNKNOWN'.
    const projectionExtras = featureEnabled ? 'c.purchase_type, c.operation_type,' : '';

    /*
     * How many rows the filters actually match — asked separately, because the
     * page cannot count what it did not fetch.
     *
     * Until 2026-09-03 this query ended in a hard `LIMIT 200` and said nothing
     * about it. On 510 claims the screen listed 200 and the operator had no
     * way to know the other 310 existed: a payment they were looking for was
     * simply not there, and the screen offered no reason. The money figures
     * were never wrong -- `summary` and `counts` are their own aggregates over
     * the whole range -- so this was a lost ROW, not a lost sum.
     *
     * Counted before the LIMIT/OFFSET binds are pushed, so it sees exactly the
     * filters the page below sees and not one parameter more.
     */
    /*
     * Written once and used twice, because the count has to see EXACTLY the
     * joins the page sees. Counting over `payment_claims` alone was tried and
     * is not a narrower count -- it is a 500: `stateSql` builds its predicates
     * on `m.status`, so half the tabs reference an alias that is not there.
     *
     * `COUNT(*)` over this chain is honest because none of the joins can
     * multiply a claim: `m` is matched on a scalar subquery that returns at
     * most one id, and `t`, `rse` and `d` each join on their own primary key.
     */
    const claimsFrom = `
       FROM payment_claims c
       LEFT JOIN financial_accounts fa ON fa.id = c.target_financial_account_id
       LEFT JOIN reconciliation_matches m ON m.id = (${SETTLED_MATCH_ID})
       LEFT JOIN transaction_candidates t ON t.id = m.transaction_candidate_id
       LEFT JOIN raw_sms_events rse ON rse.id = t.raw_sms_event_id
       LEFT JOIN devices d ON d.id = rse.device_id`;

    const totalRow = await c.env.DB.prepare(
      `SELECT COUNT(*)::int AS n ${claimsFrom} WHERE ${where.join(' AND ')}`,
    )
      .bind(...binds)
      .first<{ n: number }>();
    const total = totalRow?.n ?? 0;

    const limitBind = p(pageSize);
    const offsetBind = p((page - 1) * pageSize);

    const rows = await c.env.DB.prepare(
      `SELECT c.id, c.external_order_id, c.customer_reference, c.expected_amount_irr,
              c.target_financial_account_id, c.card_digits, c.paid_clicked_at,
              c.receipt_submitted_at, c.created_at, c.suspect_reason,
              -- Whether there IS one, never the handle itself. A Telegram
              -- file_id is a bearer capability for anyone holding the bot
              -- token, and it has no business in a browser. The picture is
              -- fetched by GET /payment-claims/:id/receipt, which reads the
              -- handle server-side and streams the bytes.
              (c.receipt_url_or_r2_key IS NOT NULL) AS has_receipt,
              c.suspect_metadata_json, c.metadata_json, c.status,
              ${projectionExtras}
              fa.display_name AS account_display, fa.bank_name AS account_bank,
              fa.account_hint,
              m.status AS match_status, m.mismatch_reasons_json AS match_mismatch_reasons_json,
              m.reviewed_at AS match_reviewed_at,
              m.reviewed_by AS match_reviewed_by,
              t.id AS matched_tx_id, t.amount_irr AS matched_tx_amount,
              t.bank_timestamp AS matched_tx_bank_timestamp,
              d.id AS device_id, d.display_name AS device_display_name,
              d.device_code AS device_code,
              ${EFFECTIVE_TS} AS effective_ts
       ${claimsFrom}
       WHERE ${where.join(' AND ')}
       -- c.id is not decoration: it is what makes OFFSET paging honest.
       -- effective_ts ties freely -- two claims paid in the same second, or a
       -- batch imported with one timestamp -- and SQL leaves the order of tied
       -- rows undefined. Postgres is free to answer page 1 and page 2 with
       -- different plans, and a tied row can then appear on both or on
       -- neither. Under the old LIMIT 200, with no second page, this could not
       -- be seen; the moment paging arrived it became a way to lose a payment.
       -- Found by CodeRabbit on #70, against a test of mine that was silent on
       -- it because every fixture row had a distinct timestamp.
       ORDER BY effective_ts ${order}, c.id ${order}
       LIMIT ${limitBind} OFFSET ${offsetBind}`,
    )
      .bind(...binds)
      .all<ClaimRow>();

    const candidateFirstIds: string[] = [];
    for (const row of rows.results ?? []) {
      if (row.matched_tx_id) continue;
      const suspectMeta = JSON.parse(row.suspect_metadata_json || '{}') as {
        candidateTransactionIds?: string[];
      };
      const first = suspectMeta.candidateTransactionIds?.[0];
      if (first) candidateFirstIds.push(first);
    }
    const candidateDevices = await loadDevicesForTransactions(c.env.DB, candidateFirstIds);

    const accountIdsForDevice = [
      ...new Set(
        (rows.results ?? [])
          .filter((row) => !row.matched_tx_id && row.target_financial_account_id)
          .map((row) => row.target_financial_account_id!),
      ),
    ];
    const accountPrimaryDevices = await loadPrimaryDevicesForAccounts(
      c.env.DB,
      accountIdsForDevice,
    );

    const items = await Promise.all(
      (rows.results ?? []).map(async (row) => {
        const meta = JSON.parse(row.metadata_json || '{}') as {
          telegramUserId?: string;
          telegramUsername?: string | null;
          cardDigits?: string | null;
        };
        const suspectMeta = JSON.parse(row.suspect_metadata_json || '{}') as {
          candidateTransactionIds?: string[];
          timeDeltaMs?: number | null;
        };
        const state = deriveReviewState(row.status, row.match_status, row.suspect_reason);
        const ends = waitingEndsAt(row.receipt_submitted_at, row.paid_clicked_at);
        const waitingRemainingMs = ends != null ? Math.max(0, ends - now) : null;
        const waitingElapsedMs =
          (row.receipt_submitted_at ?? row.paid_clicked_at)
            ? now - (row.receipt_submitted_at ?? row.paid_clicked_at)!
            : null;
        const candidates =
          state === 'NEEDS_REVIEW' || state === 'NO_TRANSFER_FOUND'
            ? await loadCandidates(c.env.DB, row, suspectMeta.candidateTransactionIds ?? [])
            : [];
        const cardDigits = row.card_digits ?? meta.cardDigits ?? null;
        let device = deviceFromRow(row);
        if (!device) {
          const firstCandidateId = suspectMeta.candidateTransactionIds?.[0];
          if (firstCandidateId) device = candidateDevices.get(firstCandidateId) ?? null;
        }
        if (!device && row.target_financial_account_id) {
          device = accountPrimaryDevices.get(row.target_financial_account_id) ?? null;
        }
        return {
          id: row.id,
          orderId: row.external_order_id.replace(/^mirzabot:test:/, ''),
          telegramUserId: meta.telegramUserId ?? row.customer_reference,
          telegramUsername: meta.telegramUsername ?? null,
          expectedAmountIrr: row.expected_amount_irr,
          expectedAmountToman: Math.floor(row.expected_amount_irr / 10),
          cardMasked: cardDigits ? maskCardDigits(cardDigits) : null,
          accountId: row.target_financial_account_id,
          accountDisplay: row.account_display,
          accountBank: row.account_bank,
          accountHint: row.account_hint,
          paidClickedAt: row.paid_clicked_at,
          receiptSubmittedAt: row.receipt_submitted_at,
          // `receiptSubmittedAt` was already here and is NOT the same question.
          // The stamp says when the waiting clock was anchored; this says
          // whether there is a document to look at. They come apart in the case
          // that matters: a claim can be stamped without a receipt, because the
          // anchor falls back to the «پرداخت کردم» press.
          hasReceipt: row.has_receipt === true,
          createdAt: row.created_at,
          effectiveTs: row.effective_ts,
          reviewState: state,
          claimStatus: row.status,
          matchStatus: row.match_status,
          suspectReason: row.suspect_reason,
          // DEV-only: present when the worker is built with ENABLE_PURCHASE_TYPE=true.
          // In production, the SELECT omits these columns and these fields are absent.
          ...(featureEnabled
            ? {
                purchaseType: row.purchase_type ?? 'UNKNOWN',
                operationType: row.operation_type ?? null,
              }
            : {}),
          waitingRemainingMs,
          waitingElapsedMs,
          timeDeltaMs: suspectMeta.timeDeltaMs ?? null,
          matchedTransaction: row.matched_tx_id
            ? {
                id: row.matched_tx_id,
                amountIrr: row.matched_tx_amount,
                bankTimestamp: row.matched_tx_bank_timestamp,
                timeDeltaSeconds: deltaSeconds(row.paid_clicked_at, row.matched_tx_bank_timestamp),
                verifiedAt: row.match_reviewed_at,
                verifiedBy: row.match_reviewed_by,
              }
            : null,
          candidates,
          device,
          reopenEligible: isManualVerificationReopenEligible({
            claimStatus: row.status,
            matchStatus: row.match_status,
            mismatchReasonsJson: row.match_mismatch_reasons_json,
            metadataJson: row.metadata_json,
          }),
          revertEligible: isManualVerificationReopenEligible({
            claimStatus: row.status,
            matchStatus: row.match_status,
            mismatchReasonsJson: row.match_mismatch_reasons_json,
            metadataJson: row.metadata_json,
          }),
          fulfillmentState: state === 'MANUALLY_VERIFIED' ? ('UNKNOWN' as const) : undefined,
          isNew: await isPaymentEventUnread(domainDb, ident.email, claimEventKey(row.id)),
        };
      }),
    );

    return c.json({
      ok: true,
      tab,
      range,
      items,
      // What the filters match, against what this page holds. Sent on every
      // response rather than only when it overflows: a screen that shows a
      // pager sometimes is a screen whose absence of one means nothing.
      page,
      pageSize,
      total,
      counts: counts.total,
      summary: financialSummary,
    });
  });

  registerPaymentsHubRoutes(app);

  app.post('/api/v1/payments/events/:eventKey/seen', async (c) => {
    const ident = c.get('identity');
    const eventKey = decodeURIComponent(c.req.param('eventKey'));
    await markPaymentEventRead(c.env.DB as unknown as DomainD1Database, ident.email, eventKey);
    return c.json({ ok: true });
  });

  const TabReadAllBody = z
    .object({
      tab: z.enum(['needs_review', 'suspected_fake', 'bot_auto_verified', 'reseller', 'income']),
    })
    .strict();

  app.post('/api/v1/payments/tabs/read-all', async (c) => {
    const ident = c.get('identity');
    const parsed = TabReadAllBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const marked = await markPaymentEventsReadAll(
      c.env.DB as unknown as DomainD1Database,
      ident.email,
      parsed.data.tab,
    );
    return c.json({ ok: true, marked });
  });

  const SuspectApproveBody = z.object({ transactionId: z.string() }).strict();
  app.post('/api/v1/suspects/:claimId/approve', async (c) => {
    const ident = c.get('identity');
    if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
    const parsed = SuspectApproveBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const claimId = c.req.param('claimId');
    const claim = await c.env.DB.prepare(
      `SELECT id, status, suspect_reason, suspect_metadata_json FROM payment_claims
       WHERE id = ?1 AND source_system = ?2`,
    )
      .bind(claimId, MIRZABOT_SOURCE)
      .first<{
        id: string;
        status: import('@shikoo/contracts').ClaimStatus;
        suspect_reason: string | null;
        suspect_metadata_json: string;
        expected_amount_irr: number;
        target_financial_account_id: string | null;
      }>();
    if (!claim) return c.json({ ok: false, error: 'not_found' }, 404);
    try {
      assertTransitionClaim(claim.status, 'VERIFIED');
    } catch {
      return c.json({ ok: false, error: 'illegal_claim_transition' }, 409);
    }

    // Manual approval writes through the same guarded path as the automatic
    // matcher, so the partial unique indexes arbitrate an admin racing auto.
    // Ambient Cloudflare D1Database is a structural subset of the domain's.
    const verified = await verifyMirzabotClaim(c.env.DB as unknown as DomainD1Database, {
      claimId,
      transactionId: parsed.data.transactionId,
      mode: 'ADMIN_APPROVED',
      actorEmail: ident.email,
    });
    if (!verified.ok) {
      const status = verified.error === 'TRANSACTION_NOT_FOUND' ? 404 : 409;
      return c.json({ ok: false, error: verified.error.toLowerCase() }, status);
    }
    const now = Date.now();
    await c.env.DB.prepare(SQL.insertAudit)
      .bind(
        crypto.randomUUID(),
        ident.email,
        ident.role,
        'claim.approved',
        'CLAIM',
        claimId,
        JSON.stringify({
          status: claim.status,
          suspectReason: claim.suspect_reason,
          suspectMetadataJson: claim.suspect_metadata_json,
        }),
        JSON.stringify({
          status: 'VERIFIED',
          matchId: verified.matchId,
          transactionId: verified.transactionId,
        }),
        'Manual verification with bank transaction',
        c.req.header('cf-ray') ?? null,
        now,
      )
      .run();
    return c.json({ ok: true, matchId: verified.matchId, transactionId: verified.transactionId });
  });

  const SuspectRejectBody = z
    .object({
      reason: z.enum(['FAKE_RECEIPT', 'NO_BANK_TRANSACTION', 'DUPLICATE', 'OTHER']),
      comment: z.string().max(2000).optional(),
    })
    .strict();
  app.post('/api/v1/suspects/:claimId/reject', async (c) => {
    const ident = c.get('identity');
    if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
    const parsed = SuspectRejectBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const claimId = c.req.param('claimId');
    const claim = await c.env.DB.prepare(
      `SELECT status, external_order_id FROM payment_claims WHERE id = ?1`,
    )
      .bind(claimId)
      .first<{ status: import('@shikoo/contracts').ClaimStatus; external_order_id: string }>();
    if (!claim) return c.json({ ok: false, error: 'not_found' }, 404);
    try {
      assertTransitionClaim(claim.status, 'REJECTED');
    } catch {
      return c.json({ ok: false, error: 'illegal_claim_transition' }, 409);
    }
    const now = Date.now();

    /*
     * Three statements in one transaction, and the second is the one that was
     * missing.
     *
     * Rejecting a claim used to write `payment_claims` and stop there, which
     * left the customer's order open FOREVER. `expireUnpaidOrders` refuses to
     * close an order that has a live payment against it — deliberately, and
     * correctly: expiring an order somebody has claimed to have paid is how a
     * verified payment settles onto an order nothing will advance
     * (`apps/bot/src/expire.ts:107-110`). But the payment row stayed
     * AWAITING_REVIEW after a rejection, so that guard went on protecting an
     * order whose payment had just been refused. Not for twenty-four hours —
     * for good.
     *
     * So the rejection is carried through to the payment. The order then meets
     * its ordinary expiry, the customer is told, and the stale card stops
     * being live.
     *
     * `batch()` is a real transaction in `packages/db`. It has to be: a claim
     * marked REJECTED with its payment still AWAITING_REVIEW is exactly the
     * state this is fixing, and a half-applied pair would recreate it.
     */
    await c.env.DB.batch([
      c.env.DB.prepare(SQL.updateClaimStatus).bind(claimId, 'REJECTED', now),
      // Matched through the same string the bot writes when it opens a claim
      // ('shikoo:' || p.public_id). A claim that came from the PHP bot has a
      // different external id and simply matches nothing, which is right — this
      // platform does not own those orders.
      c.env.DB.prepare(
        `UPDATE payments
            SET status = 'REJECTED', reject_reason = ?2, updated_at = now()
          WHERE 'shikoo:' || public_id = ?1
            AND status = 'AWAITING_REVIEW'`,
      ).bind(claim.external_order_id, parsed.data.reason),
      // The rejection is the only claim decision that wrote no audit row.
      // `approve` and `mark-fake` both did, and this one refuses a customer's
      // money — of the three it is the one most likely to be asked about later.
      c.env.DB.prepare(SQL.insertAudit).bind(
        crypto.randomUUID(),
        ident.email,
        ident.role,
        'claim.rejected',
        'CLAIM',
        claimId,
        JSON.stringify({ status: claim.status }),
        JSON.stringify({ status: 'REJECTED', reason: parsed.data.reason }),
        parsed.data.comment ?? 'Manual rejection',
        c.req.header('cf-ray') ?? null,
        now,
      ),
    ]);
    return c.json({ ok: true });
  });

  const MarkFakeBody = z
    .object({
      confirmed: z.literal(true),
      comment: z.string().max(2000).optional(),
    })
    .strict();
  app.post('/api/v1/suspects/:claimId/mark-fake', async (c) => {
    const ident = c.get('identity');
    if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
    const parsed = MarkFakeBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const claimId = c.req.param('claimId');
    const claim = await c.env.DB.prepare(
      `SELECT id, status, external_order_id, suspect_reason FROM payment_claims WHERE id = ?1 AND source_system = ?2`,
    )
      .bind(claimId, MIRZABOT_SOURCE)
      .first<{
        id: string;
        status: import('@shikoo/contracts').ClaimStatus;
        external_order_id: string;
        suspect_reason: string | null;
      }>();
    if (!claim) return c.json({ ok: false, error: 'not_found' }, 404);
    try {
      assertTransitionClaim(claim.status, 'FAKE_RECEIPT');
    } catch {
      return c.json({ ok: false, error: 'illegal_claim_transition' }, 409);
    }
    const now = Date.now();
    await c.env.DB.prepare(SQL.updateClaimStatus).bind(claimId, 'FAKE_RECEIPT', now).run();
    await c.env.DB.prepare(SQL.insertAudit)
      .bind(
        crypto.randomUUID(),
        ident.email,
        ident.role,
        'claim.fake_receipt',
        'CLAIM',
        claimId,
        JSON.stringify({ status: claim.status, suspectReason: claim.suspect_reason }),
        JSON.stringify({ status: 'FAKE_RECEIPT', manual: true }),
        parsed.data.comment ?? 'Manual fraud classification',
        c.req.header('cf-ray') ?? null,
        now,
      )
      .run();
    return c.json({ ok: true });
  });

  const ReassignBody = z
    .object({
      transactionId: z.string(),
      reason: z.string().min(1).max(2000),
      verifyAfterAssign: z.boolean().default(false),
    })
    .strict();

  app.post('/api/v1/payment-claims/:claimId/reassign-transaction', async (c) => {
    const ident = c.get('identity');
    if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
    const parsed = ReassignBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const claimId = c.req.param('claimId');

    const result = await reassignMirzabotTransaction(c.env.DB as unknown as DomainD1Database, {
      transactionId: parsed.data.transactionId,
      targetClaimId: claimId,
      actorEmail: ident.email,
      reason: parsed.data.reason.trim(),
      verifyAfterAssign: parsed.data.verifyAfterAssign,
    });

    if (!result.ok) {
      if (result.error === 'TRANSACTION_ALREADY_CONSUMED') {
        return c.json(
          { ok: false, error: 'transaction_already_consumed', consumedBy: result.consumedBy },
          409,
        );
      }
      if (result.error === 'REASON_REQUIRED') {
        return c.json({ ok: false, error: 'reason_required' }, 400);
      }
      if (result.error === 'TRANSACTION_NOT_FOUND' || result.error === 'CLAIM_NOT_FOUND') {
        return c.json({ ok: false, error: 'not_found' }, 404);
      }
      if (result.error === 'VERIFY_FAILED') {
        return c.json(
          { ok: false, error: result.verifyError?.toLowerCase() ?? 'verify_failed' },
          409,
        );
      }
      return c.json({ ok: false, error: result.error.toLowerCase() }, 409);
    }

    const now = Date.now();
    const oldClaims = await Promise.all(
      result.detachedClaimIds.map(async (oldId) => {
        const row = await c.env.DB.prepare(
          `SELECT external_order_id, metadata_json, customer_reference FROM payment_claims WHERE id = ?1`,
        )
          .bind(oldId)
          .first<{
            external_order_id: string;
            metadata_json: string;
            customer_reference: string | null;
          }>();
        if (!row)
          return { claimId: oldId, orderId: null, telegramUserId: null, telegramUsername: null };
        const meta = JSON.parse(row.metadata_json || '{}') as {
          telegramUserId?: string;
          telegramUsername?: string | null;
        };
        return {
          claimId: oldId,
          orderId: row.external_order_id.replace(/^mirzabot:test:/, ''),
          telegramUserId: meta.telegramUserId ?? row.customer_reference,
          telegramUsername: meta.telegramUsername ?? null,
        };
      }),
    );

    const target = await c.env.DB.prepare(
      `SELECT external_order_id, metadata_json, customer_reference FROM payment_claims WHERE id = ?1`,
    )
      .bind(claimId)
      .first<{
        external_order_id: string;
        metadata_json: string;
        customer_reference: string | null;
      }>();

    const targetMeta = JSON.parse(target?.metadata_json || '{}') as {
      telegramUserId?: string;
      telegramUsername?: string | null;
    };

    await c.env.DB.prepare(SQL.insertAudit)
      .bind(
        crypto.randomUUID(),
        ident.email,
        ident.role,
        'transaction.reassigned',
        'TRANSACTION',
        parsed.data.transactionId,
        JSON.stringify({ detachedClaims: oldClaims }),
        JSON.stringify({
          targetClaimId: claimId,
          targetOrderId: target?.external_order_id.replace(/^mirzabot:test:/, ''),
          targetTelegramUserId: targetMeta.telegramUserId ?? target?.customer_reference ?? null,
          targetTelegramUsername: targetMeta.telegramUsername ?? null,
          verified: result.verified,
          matchId: result.matchId ?? null,
        }),
        parsed.data.reason.trim(),
        c.req.header('cf-ray') ?? null,
        now,
      )
      .run();

    return c.json({
      ok: true,
      transactionId: result.transactionId,
      claimId: result.targetClaimId,
      verified: result.verified,
      matchId: result.matchId ?? null,
      detachedClaimIds: result.detachedClaimIds,
    });
  });

  const ManualVerifyBody = z
    .object({ reason: z.string().max(2000).optional(), comment: z.string().max(2000).optional() })
    .strict();

  app.post('/api/v1/suspects/:claimId/verify-manual', async (c) => {
    const ident = c.get('identity');
    if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
    const parsed = ManualVerifyBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const claimId = c.req.param('claimId');

    const claimBefore = await c.env.DB.prepare(
      `SELECT status, suspect_reason, suspect_metadata_json FROM payment_claims WHERE id = ?1`,
    )
      .bind(claimId)
      .first<{
        status: string;
        suspect_reason: string | null;
        suspect_metadata_json: string;
      }>();

    const verified = await verifyMirzabotClaimWithoutTransaction(
      c.env.DB as unknown as DomainD1Database,
      { claimId, actorEmail: ident.email },
    );
    if (!verified.ok) {
      const status = verified.error === 'CLAIM_NOT_FOUND' ? 404 : 409;
      return c.json({ ok: false, error: verified.error.toLowerCase() }, status);
    }

    const now = Date.now();
    await c.env.DB.prepare(SQL.insertAudit)
      .bind(
        crypto.randomUUID(),
        ident.email,
        ident.role,
        'claim.manual_verified',
        'CLAIM',
        claimId,
        JSON.stringify({
          status: claimBefore?.status ?? null,
          suspectReason: claimBefore?.suspect_reason ?? null,
          suspectMetadataJson: claimBefore?.suspect_metadata_json ?? '{}',
          manual: true,
          withoutTransaction: true,
        }),
        JSON.stringify({ status: 'VERIFIED' }),
        parsed.data.reason ?? parsed.data.comment ?? 'Verified manually without bank transaction',
        c.req.header('cf-ray') ?? null,
        now,
      )
      .run();
    return c.json({ ok: true, claimId });
  });

  app.post('/api/v1/payment-claims/:claimId/reopen-manual-verification', async (c) => {
    const ident = c.get('identity');
    if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
    const claimId = c.req.param('claimId');
    const parsed = z
      .object({ reason: z.string().min(1).max(2000) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'reason_required' }, 400);

    const result = await reopenMirzabotManualVerification(c.env.DB as unknown as DomainD1Database, {
      claimId,
      actorEmail: ident.email,
      reason: parsed.data.reason,
    });
    if (!result.ok) {
      const status =
        result.error === 'CLAIM_NOT_FOUND' ? 404 : result.error === 'REASON_REQUIRED' ? 400 : 409;
      return c.json({ ok: false, error: result.error.toLowerCase() }, status);
    }

    const now = Date.now();
    await c.env.DB.prepare(SQL.insertAudit)
      .bind(
        crypto.randomUUID(),
        ident.email,
        ident.role,
        'claim.manual_verification_reopened',
        'CLAIM',
        claimId,
        JSON.stringify({
          status: 'VERIFIED',
          orderId: result.orderId,
          previousState: result.previousState,
          transactionId: result.transactionId,
          fulfillmentState: result.fulfillmentState,
        }),
        JSON.stringify({
          reviewQueue: result.reviewQueue,
          suspectReason: result.suspectReason,
          transactionId: result.transactionId,
        }),
        parsed.data.reason,
        c.req.header('cf-ray') ?? null,
        now,
      )
      .run();

    return c.json({
      ok: true,
      claimId: result.claimId,
      orderId: result.orderId,
      reviewQueue: result.reviewQueue,
      suspectReason: result.suspectReason,
      transactionId: result.transactionId,
    });
  });

  app.post('/api/v1/payment-claims/:claimId/revert-manual-verification', async (c) => {
    const ident = c.get('identity');
    if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
    const claimId = c.req.param('claimId');

    const result = await revertMirzabotManualVerification(c.env.DB as unknown as DomainD1Database, {
      claimId,
      actorEmail: ident.email,
    });
    if (!result.ok) {
      const status =
        result.error === 'CLAIM_NOT_FOUND'
          ? 404
          : result.error === 'NO_REVERT_SNAPSHOT'
            ? 409
            : 409;
      return c.json({ ok: false, error: result.error.toLowerCase() }, status);
    }

    const now = Date.now();
    await c.env.DB.prepare(SQL.insertAudit)
      .bind(
        crypto.randomUUID(),
        ident.email,
        ident.role,
        'claim.reverted_manual_verification',
        'CLAIM',
        claimId,
        JSON.stringify({ status: 'VERIFIED' }),
        JSON.stringify({
          status: result.restoredClaimStatus,
          suspectReason: result.restoredSuspectReason,
          transactionId: result.transactionId,
        }),
        'Operator reverted manual verification',
        c.req.header('cf-ray') ?? null,
        now,
      )
      .run();

    return c.json({
      ok: true,
      claimId: result.claimId,
      restoredClaimStatus: result.restoredClaimStatus,
      restoredSuspectReason: result.restoredSuspectReason,
      transactionId: result.transactionId,
    });
  });

  app.get('/api/v1/transactions/search', async (c) => {
    const url = new URL(c.req.url);
    const amount = numParam(url.searchParams.get('amount'));
    const accountId = url.searchParams.get('accountId');
    const from = numParam(url.searchParams.get('from'));
    const to = numParam(url.searchParams.get('to'));
    const transactionId = url.searchParams.get('transactionId');
    const reference = url.searchParams.get('reference');
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));

    const binds: unknown[] = [];
    const p = (v: unknown) => {
      binds.push(v);
      return `?${binds.length}`;
    };

    const where = [
      `t.direction = 'CREDIT'`,
      `t.processing_disposition = 'ACTIONABLE'`,
      `t.status NOT IN ('REJECTED','IGNORED')`,
    ];
    if (amount != null) where.push(`t.amount_irr = ${p(amount)}`);
    if (accountId) where.push(`t.financial_account_id = ${p(accountId)}`);
    if (from != null) where.push(`t.bank_timestamp >= ${p(from)}`);
    if (to != null) where.push(`t.bank_timestamp <= ${p(to)}`);
    if (transactionId) where.push(`t.id = ${p(transactionId)}`);
    if (reference) {
      where.push(
        `(t.id LIKE ${p(`%${reference}%`)} OR t.parser_evidence_json LIKE ${p(`%${reference}%`)})`,
      );
    }

    const rows = await c.env.DB.prepare(
      `SELECT t.id, t.amount_irr, t.bank_timestamp, t.financial_account_id, t.status AS tx_status,
              fa.display_name AS account_display, fa.bank_name AS account_bank, fa.account_hint,
              m.id AS match_id, m.status AS match_status, m.payment_claim_id,
              c.external_order_id, c.metadata_json, c.customer_reference, c.status AS claim_status
       FROM transaction_candidates t
       LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
       LEFT JOIN reconciliation_matches m ON m.id = (
         SELECT m2.id FROM reconciliation_matches m2
          WHERE m2.transaction_candidate_id = t.id
            AND m2.status IN ('SUGGESTED','CONFIRMED','AUTO_VERIFIED')
          ORDER BY CASE m2.status
            WHEN 'AUTO_VERIFIED' THEN 0 WHEN 'CONFIRMED' THEN 1 ELSE 2 END,
                   m2.created_at DESC
          LIMIT 1
       )
       LEFT JOIN payment_claims c ON c.id = m.payment_claim_id
       WHERE ${where.join(' AND ')}
       ORDER BY t.bank_timestamp DESC
       LIMIT ${p(limit)}`,
    )
      .bind(...binds)
      .all<{
        id: string;
        amount_irr: number | null;
        bank_timestamp: number | null;
        financial_account_id: string | null;
        tx_status: string;
        account_display: string | null;
        account_bank: string | null;
        account_hint: string | null;
        match_id: string | null;
        match_status: string | null;
        payment_claim_id: string | null;
        external_order_id: string | null;
        metadata_json: string | null;
        customer_reference: string | null;
        claim_status: string | null;
      }>();

    const items = (rows.results ?? []).map((r) => {
      const meta = JSON.parse(r.metadata_json || '{}') as {
        telegramUserId?: string;
        telegramUsername?: string | null;
      };
      const consumed = r.match_status === 'CONFIRMED' || r.match_status === 'AUTO_VERIFIED';
      return {
        id: r.id,
        amountIrr: r.amount_irr,
        bankTimestamp: r.bank_timestamp,
        accountId: r.financial_account_id,
        accountDisplay: r.account_display,
        accountBank: r.account_bank,
        accountHint: r.account_hint,
        txStatus: r.tx_status,
        matchStatus: r.match_status,
        consumed,
        linkedClaim: r.payment_claim_id
          ? {
              claimId: r.payment_claim_id,
              orderId: (r.external_order_id ?? '').replace(/^mirzabot:test:/, ''),
              telegramUserId: meta.telegramUserId ?? r.customer_reference,
              telegramUsername: meta.telegramUsername ?? null,
              claimStatus: r.claim_status,
            }
          : null,
      };
    });

    return c.json({ ok: true, items });
  });

  /**
   * Deliver a claim the bank has not confirmed.
   *
   * Available on any live claim in the review queue, not only on a suspect —
   * that is the whole point of the change: an operator watching a customer wait
   * should not have to wait for the claim to be flagged before they can act.
   *
   * REVIEWER and ADMIN, matching every other decision on a claim; only
   * destructive catalogue work is ADMIN-only. READ_ONLY is refused here as
   * everywhere, and `write-roles.test.ts` enumerates that from the router
   * rather than trusting this comment.
   *
   * The reason is required by the route AND by the domain. Two guards for one
   * rule because the column is nullable — it has to be, 350 rows predate it —
   * so neither the schema nor a single call site can be the thing that refuses
   * a fulfilment nobody explained.
   */
  const FulfilBody = z
    .object({ reason: z.string().min(3).max(2000), confirmed: z.literal(true) })
    .strict();

  app.post('/api/v1/payment-claims/:claimId/fulfil-without-payment', async (c) => {
    const ident = c.get('identity');
    if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
    const parsed = FulfilBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);

    const out = await fulfilMirzabotClaimWithoutPayment(c.env.DB as unknown as DomainD1Database, {
      claimId: c.req.param('claimId'),
      actorEmail: ident.email,
      actorRole: ident.role,
      reason: parsed.data.reason,
      mode: 'MANUAL',
      requestId: c.req.header('cf-ray') ?? null,
    });
    if (!out.ok) {
      const status = out.error === 'CLAIM_NOT_FOUND' ? 404 : out.error === 'REASON_REQUIRED' ? 400 : 409;
      return c.json({ ok: false, error: out.error.toLowerCase() }, status);
    }
    // 200 on a repeat, not 409. The caller asked for the claim to be fulfilled
    // and it is; a retried request after a timeout is the commonest way to
    // arrive here twice and it is not an error.
    return c.json({ ok: true, claimId: out.claimId, mode: out.mode, already: out.already });
  });

  /**
   * «تلاش مجدد برای آماده‌سازی» — try the delivery again, without touching the payment.
   *
   * The payment decision is already made and stays made: nothing here reads or
   * writes a claim, a payment or a ledger row. All this does is move the order
   * from FAILED back to PAID so `provisionPaidOrders` picks it up on its next
   * pass, which is the same path that delivers every other order and therefore
   * the same exactly-once guarantees.
   *
   * On the payments surface rather than under `/api/v1/admin/`, deliberately.
   * A REVIEWER is the role that approves the payment; leaving them unable to
   * finish the job when the preparation fails would put the customer behind an
   * ADMIN who may not be awake. `write-roles.test.ts` asserts both halves — 403
   * for READ_ONLY, and reachable for a REVIEWER.
   *
   * `confirmed` is required for the same reason the fulfilment above requires
   * it: this is a button that spends money on a panel, and a mis-click should
   * not be enough.
   */
  const RetryBody = z.object({ confirmed: z.literal(true) }).strict();

  app.post('/api/v1/orders/:publicId/retry-provisioning', async (c) => {
    const ident = c.get('identity');
    if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
    const parsed = RetryBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);

    const out = await retryOrderProvisioning(c.env.DB as unknown as DomainD1Database, {
      orderPublicId: c.req.param('publicId'),
      actorEmail: ident.email,
      actorRole: ident.role,
      requestId: c.req.header('cf-ray') ?? null,
    });

    if (out.outcome === 'NOT_FOUND') return c.json({ ok: false, error: 'order_not_found' }, 404);
    // 409 for the one outcome an operator must not read as «it is on its way»:
    // the money went back, so delivering now would be giving the service away.
    if (out.outcome === 'REFUNDED')
      return c.json({ ok: false, error: 'refunded', failureReason: out.failureReason }, 409);
    // 200 for QUEUED, ALREADY_DELIVERED and IN_PROGRESS alike. All three mean
    // «the customer is being served or has been», which is what was asked for,
    // and a repeat click is the commonest way to arrive here twice.
    return c.json({ ok: true, outcome: out.outcome, orderPublicId: out.orderPublicId });
  });

  /** The queue of «delivered, still owed an explanation». One index scan. */
  app.get('/api/v1/payment-claims/awaiting-reconciliation', async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT id, external_order_id, expected_amount_irr, fulfilment_mode,
              fulfilled_at, fulfilled_by, fulfilment_reason, customer_reference
         FROM payment_claims
        WHERE fulfilled_at IS NOT NULL AND reconciled_at IS NULL
        ORDER BY fulfilled_at DESC
        LIMIT 200`,
    ).all<{
      id: string;
      external_order_id: string;
      expected_amount_irr: number;
      fulfilment_mode: string | null;
      fulfilled_at: number | null;
      fulfilled_by: string | null;
      fulfilment_reason: string | null;
      customer_reference: string | null;
    }>();
    return c.json({
      ok: true,
      items: (results ?? []).map((r) => ({
        claimId: r.id,
        orderId: (r.external_order_id ?? '').replace(/^mirzabot:test:/, ''),
        amountIrr: r.expected_amount_irr,
        mode: r.fulfilment_mode,
        fulfilledAt: r.fulfilled_at,
        fulfilledBy: r.fulfilled_by,
        reason: r.fulfilment_reason,
        customerReference: r.customer_reference,
      })),
    });
  });

  /** What mode the shop is in. Every role may read it — the banner is for all of them. */
  app.get('/api/v1/continuity-mode', async (c) => {
    const state = await readContinuityMode(c.env.DB as unknown as DomainD1Database);
    return c.json({ ok: true, ...state });
  });

  /**
   * Turn the mode on or off. ADMIN only.
   *
   * Stricter than the per-claim fulfilment above, and deliberately so: that one
   * is a decision about a single customer that a REVIEWER already makes all day,
   * while this suspends the requirement for evidence shop-wide, for everything
   * that arrives next. The blast radius is the difference, so the role is too.
   */
  const ContinuityBody = z
    .discriminatedUnion('active', [
      z.object({
        active: z.literal(true),
        reason: z.string().min(3).max(2000),
        durationMs: z.number().int().positive(),
        confirmed: z.literal(true),
      }).strict(),
      z.object({ active: z.literal(false) }).strict(),
    ]);

  app.post('/api/v1/continuity-mode', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const parsed = ContinuityBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);

    const db = c.env.DB as unknown as DomainD1Database;
    const before = await readContinuityMode(db);
    const now = Date.now();

    if (!parsed.data.active) {
      const state = await deactivateContinuityMode(db, { actorEmail: ident.email });
      await writeContinuityAudit(c, ident, 'continuity.deactivated', before, state, 'deactivated');
      return c.json({ ok: true, ...state });
    }

    const out = await activateContinuityMode(db, {
      actorEmail: ident.email,
      reason: parsed.data.reason,
      durationMs: parsed.data.durationMs,
      confirmed: parsed.data.confirmed,
      now,
    });
    if (!out.ok) return c.json({ ok: false, error: out.error.toLowerCase() }, 400);
    await writeContinuityAudit(c, ident, 'continuity.activated', before, out.state, parsed.data.reason);
    return c.json({ ok: true, ...out.state });
  });
}

/**
 * The mode change written to the append-only trail.
 *
 * Separate from the settings row on purpose: that row is the current answer and
 * is overwritten, and «who turned off the requirement for evidence, and when»
 * is exactly the question an incident review asks about a period that has
 * already ended.
 */
async function writeContinuityAudit(
  c: { env: { DB: D1Database }; req: { header(name: string): string | undefined } },
  ident: { email: string; role: string },
  action: string,
  before: unknown,
  after: unknown,
  reason: string,
): Promise<void> {
  await c.env.DB.prepare(SQL.insertAudit)
    .bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      action,
      'SETTING',
      'pay:continuity_mode',
      JSON.stringify(before),
      JSON.stringify(after),
      reason,
      c.req.header('cf-ray') ?? null,
      Date.now(),
    )
    .run();
}
