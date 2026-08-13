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
      `SELECT id, financial_account_id, card_digits, label
       FROM payment_cards WHERE financial_account_id IN (${placeholders})
       ORDER BY created_at ASC`,
    )
    .bind(...accountIds)
    .all<{ id: string; financial_account_id: string; card_digits: string; label: string | null }>();
  const map = new Map<string, PaymentCardListItem[]>();
  for (const r of rows.results ?? []) {
    const item: PaymentCardListItem = {
      id: r.id,
      card_digits: r.card_digits,
      masked: maskCardDigits(r.card_digits),
      display: formatCardDigitsForDisplay(r.card_digits),
      label: r.label,
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

const EFFECTIVE_TS = `COALESCE(c.paid_clicked_at, c.receipt_submitted_at, c.created_at)`;
const WAITING_ANCHOR = `COALESCE(c.receipt_submitted_at, c.paid_clicked_at)`;
const PENDING_CLAIM = `c.status IN ('PENDING','MATCH_SUGGESTED')`;
const SUSPECTED_FAKE_REASONS = `('NO_TRANSACTION_AFTER_10M','NO_TRANSACTION')`;

/** The one match row that settled a claim, if any (auto beats manual). */
const SETTLED_MATCH_ID = `
  SELECT m2.id FROM reconciliation_matches m2
   WHERE m2.payment_claim_id = c.id AND m2.status IN ('AUTO_VERIFIED','CONFIRMED')
   ORDER BY CASE m2.status WHEN 'AUTO_VERIFIED' THEN 0 ELSE 1 END, m2.created_at DESC
   LIMIT 1`;

function waitingEndsAt(receiptSubmittedAt: number | null, paidClickedAt: number | null): number | null {
  const anchor = receiptSubmittedAt ?? paidClickedAt;
  return anchor != null ? anchor + WAITING_TIMEOUT_MS : null;
}

function deriveReviewState(
  claimStatus: string,
  matchStatus: string | null,
  suspectReason: string | null,
  receiptSubmittedAt: number | null,
  paidClickedAt: number | null,
  now: number,
): ReviewState {
  if (claimStatus === 'VERIFIED') {
    return matchStatus === 'AUTO_VERIFIED' ? 'AUTO_VERIFIED' : 'MANUALLY_VERIFIED';
  }
  if (claimStatus === 'FAKE_RECEIPT') return 'FAKE';
  if (claimStatus === 'REJECTED') return 'REJECTED';
  if (claimStatus === 'EXPIRED') return 'EXPIRED';
  if (suspectReason === 'NO_TRANSACTION_AFTER_10M' || suspectReason === 'NO_TRANSACTION') {
    return 'SUSPECTED_FAKE';
  }
  if (suspectReason) return 'NEEDS_REVIEW';
  const ends = waitingEndsAt(receiptSubmittedAt, paidClickedAt);
  if (ends != null && now <= ends) return 'WAITING';
  return 'WAITING';
}

function stateSql(state: ReviewState, nowParam: string): string {
  switch (state) {
    case 'AUTO_VERIFIED':
      return `c.status = 'VERIFIED' AND m.status = 'AUTO_VERIFIED'`;
    case 'MANUALLY_VERIFIED':
      return `c.status = 'VERIFIED' AND (m.status IS NULL OR m.status = 'CONFIRMED')`;
    case 'NEEDS_REVIEW':
      return `${PENDING_CLAIM} AND c.suspect_reason IS NOT NULL AND c.suspect_reason NOT IN ${SUSPECTED_FAKE_REASONS}`;
    case 'WAITING':
      return `${PENDING_CLAIM} AND c.suspect_reason IS NULL AND ${WAITING_ANCHOR} + ${WAITING_TIMEOUT_MS} > ${nowParam}`;
    case 'SUSPECTED_FAKE':
      return `${PENDING_CLAIM} AND c.suspect_reason IN ${SUSPECTED_FAKE_REASONS}`;
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

function deviceFromRow(row: Pick<ClaimRow, 'device_id' | 'device_display_name' | 'device_code'>): DeviceRef | null {
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

  const observationsByAccount = new Map<string, Array<{ deviceId: string; bankTimestamp: number }>>();
  const devicesLookup = new Map<string, { displayName: string | null; deviceCode: string | null }>();
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
    const inferred = inferPrimaryDevice(
      observationsByAccount.get(accountId) ?? [],
      devicesLookup,
    );
    if (!inferred.primaryDeviceId) continue;
    const name = deviceDisplayName(
      inferred.primaryDeviceDisplayName,
      inferred.primaryDeviceCode,
    );
    if (name) map.set(accountId, { id: inferred.primaryDeviceId, name });
  }
  return map;
}

function numParam(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
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
  const now = Date.now();
  const nowParam = '?4';
  const rows = await db
    .prepare(
      `SELECT
         CASE
           WHEN c.status = 'VERIFIED' AND m.status = 'AUTO_VERIFIED' THEN 'AUTO_VERIFIED'
           WHEN c.status = 'VERIFIED' THEN 'MANUALLY_VERIFIED'
           WHEN c.status = 'FAKE_RECEIPT' THEN 'FAKE'
           WHEN c.status = 'REJECTED' THEN 'REJECTED'
           WHEN c.status = 'EXPIRED' THEN 'EXPIRED'
           WHEN ${PENDING_CLAIM} AND c.suspect_reason IN ${SUSPECTED_FAKE_REASONS} THEN 'SUSPECTED_FAKE'
           WHEN ${PENDING_CLAIM} AND c.suspect_reason IS NOT NULL THEN 'NEEDS_REVIEW'
           WHEN ${PENDING_CLAIM} AND c.suspect_reason IS NULL
                AND ${WAITING_ANCHOR} + ${WAITING_TIMEOUT_MS} > ${nowParam} THEN 'WAITING'
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
    .bind(MIRZABOT_SOURCE, dayStart, dayEnd, now)
    .all<{ review_state: ReviewState; n: number; n_today: number }>();

  const total: Record<ReviewState, number> = {
    AUTO_VERIFIED: 0,
    NEEDS_REVIEW: 0,
    MANUALLY_VERIFIED: 0,
    WAITING: 0,
    SUSPECTED_FAKE: 0,
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
    today.AUTO_VERIFIED + today.NEEDS_REVIEW + today.MANUALLY_VERIFIED + today.SUSPECTED_FAKE;

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
      suspectedFake: total.SUSPECTED_FAKE,
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
          message: 'Enter exactly 16 digits (spaces/dashes OK). Do not paste the account name with the number.',
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
      return c.json({ ok: false, error: 'card_already_mapped', message: 'Could not map card.' }, 409);
    }
    // Reported, never enforced. A card that fails Luhn cannot exist, and one
    // such row is live in production today (BUGS-FOR-ADMIN.md item 4) — but the
    // issuer table can be out of date, so refusing the save on a bank mismatch
    // would block a correct card on our own stale data.
    const prefixes = await loadPrefixes(c.env.DB);
    const detectedBank = identifyBank(digits, prefixes);
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
   * How often this card is shown, relative to the others.
   *
   * Weight only, on purpose: the rotation cursor is rotation's own state and an
   * admin editing it by hand would be editing the queue position of every other
   * card at the same time.
   */
  const CardWeightBody = z.object({ displayWeight: z.number().int().min(1).max(20) }).strict();
  app.patch('/api/v1/payment-cards/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const parsed = CardWeightBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const cardId = c.req.param('id');
    const before = await c.env.DB.prepare(
      `SELECT id, card_digits, display_weight FROM payment_cards WHERE id = ?1`,
    )
      .bind(cardId)
      .first<{ id: string; card_digits: string; display_weight: number }>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);

    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO audit_logs
           (id, actor_email, actor_role, action, entity_type, entity_id,
            before_json, after_json, reason, request_id, created_at)
         VALUES (?1, ?2, ?3, 'payment_card.weight_changed', 'PAYMENT_CARD', ?4, ?5, ?6, NULL, NULL, ?7)`,
      ).bind(
        crypto.randomUUID(),
        ident.email,
        ident.role,
        cardId,
        JSON.stringify({ displayWeight: before.display_weight }),
        JSON.stringify({ displayWeight: parsed.data.displayWeight }),
        now,
      ),
      c.env.DB.prepare(`UPDATE payment_cards SET display_weight = ?2 WHERE id = ?1`).bind(
        cardId,
        parsed.data.displayWeight,
      ),
    ]);
    return c.json({ ok: true, id: cardId, display_weight: parsed.data.displayWeight });
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
    const nowBind = now;
    const range = parseHistoryRange(url.searchParams.get('range'));
    const day =
      range === 'day'
        ? (parseHistoryDay(url.searchParams.get('day')) ?? tehranTodayDateString(now))
        : parseHistoryDay(url.searchParams.get('day'));
    const tab = ((): PaymentTab => {
      const raw = url.searchParams.get('tab');
      const allowed: PaymentTab[] = [
        'income',
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
      return 'income';
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
    const accountId = url.searchParams.get('accountId');
    const reason = url.searchParams.get('reason');
    const from = numParam(url.searchParams.get('from'));
    const to = numParam(url.searchParams.get('to'));
    // DEV-only: purchase_type filter (only valid for bot_auto_verified tab).
    const purchaseTypeFilter = url.searchParams.get('purchaseType');
    const featureEnabled = c.env?.ENABLE_PURCHASE_TYPE === 'true';
    const allowedPurchaseTypes = new Set(['NEW_PURCHASE', 'RENEWAL', 'UNKNOWN']);
    const purchaseTypeForQuery =
      featureEnabled && tab === 'bot_auto_verified' && purchaseTypeFilter &&
      allowedPurchaseTypes.has(purchaseTypeFilter)
        ? purchaseTypeFilter
        : null;

    const binds: unknown[] = [];
    const p = (v: unknown) => {
      binds.push(v);
      return `?${binds.length}`;
    };

    const where = [`c.source_system = ${p(MIRZABOT_SOURCE)}`];
    const tabState: ReviewState | null =
      tab === 'needs_review'
        ? 'NEEDS_REVIEW'
        : tab === 'waiting'
          ? 'WAITING'
          : tab === 'suspected_fake'
            ? 'SUSPECTED_FAKE'
            : tab === 'bot_auto_verified'
              ? 'AUTO_VERIFIED'
              : tab === 'manually_verified'
                ? 'MANUALLY_VERIFIED'
                : null;
    if (tabState) {
      if (tabState === 'WAITING') {
        where.push(stateSql(tabState, p(nowBind)));
      } else {
        where.push(stateSql(tabState, ''));
      }
    }
    if (tab === 'all' && statusFilter) {
      const allowed: ReviewState[] = [
        'AUTO_VERIFIED',
        'NEEDS_REVIEW',
        'MANUALLY_VERIFIED',
        'WAITING',
        'SUSPECTED_FAKE',
        'REJECTED',
        'FAKE',
        'EXPIRED',
      ];
      if (allowed.includes(statusFilter as ReviewState)) {
        const st = statusFilter as ReviewState;
        if (st === 'WAITING') {
          where.push(stateSql(st, p(nowBind)));
        } else {
          where.push(stateSql(st, ''));
        }
      }
    }
    if (accountId) where.push(`c.target_financial_account_id = ${p(accountId)}`);
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
    const projectionExtras = featureEnabled
      ? 'c.purchase_type, c.operation_type,'
      : '';

    const rows = await c.env.DB.prepare(
      `SELECT c.id, c.external_order_id, c.customer_reference, c.expected_amount_irr,
              c.target_financial_account_id, c.card_digits, c.paid_clicked_at,
              c.receipt_submitted_at, c.created_at, c.suspect_reason,
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
       FROM payment_claims c
       LEFT JOIN financial_accounts fa ON fa.id = c.target_financial_account_id
       LEFT JOIN reconciliation_matches m ON m.id = (${SETTLED_MATCH_ID})
       LEFT JOIN transaction_candidates t ON t.id = m.transaction_candidate_id
       LEFT JOIN raw_sms_events rse ON rse.id = t.raw_sms_event_id
       LEFT JOIN devices d ON d.id = rse.device_id
       WHERE ${where.join(' AND ')}
       ORDER BY effective_ts ${order}
       LIMIT 200`,
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
        const state = deriveReviewState(
          row.status,
          row.match_status,
          row.suspect_reason,
          row.receipt_submitted_at,
          row.paid_clicked_at,
          now,
        );
        const ends = waitingEndsAt(row.receipt_submitted_at, row.paid_clicked_at);
        const waitingRemainingMs = ends != null ? Math.max(0, ends - now) : null;
        const waitingElapsedMs =
          row.receipt_submitted_at ?? row.paid_clicked_at
            ? now - (row.receipt_submitted_at ?? row.paid_clicked_at)!
            : null;
        const candidates =
          state === 'NEEDS_REVIEW' || state === 'SUSPECTED_FAKE'
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
          fulfillmentState:
            state === 'MANUALLY_VERIFIED' ? ('UNKNOWN' as const) : undefined,
          isNew: await isPaymentEventUnread(domainDb, ident.email, claimEventKey(row.id)),
        };
      }),
    );

    return c.json({
      ok: true,
      tab,
      range,
      items,
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
    .object({ reason: z.enum(['FAKE_RECEIPT', 'NO_BANK_TRANSACTION', 'DUPLICATE', 'OTHER']), comment: z.string().max(2000).optional() })
    .strict();
  app.post('/api/v1/suspects/:claimId/reject', async (c) => {
    const ident = c.get('identity');
    if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
    const parsed = SuspectRejectBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const claimId = c.req.param('claimId');
    const claim = await c.env.DB.prepare(`SELECT status FROM payment_claims WHERE id = ?1`)
      .bind(claimId)
      .first<{ status: import('@shikoo/contracts').ClaimStatus }>();
    if (!claim) return c.json({ ok: false, error: 'not_found' }, 404);
    try {
      assertTransitionClaim(claim.status, 'REJECTED');
    } catch {
      return c.json({ ok: false, error: 'illegal_claim_transition' }, 409);
    }
    const now = Date.now();
    await c.env.DB.prepare(SQL.updateClaimStatus).bind(claimId, 'REJECTED', now).run();
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
      .first<{ id: string; status: import('@shikoo/contracts').ClaimStatus; external_order_id: string; suspect_reason: string | null }>();
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
          .first<{ external_order_id: string; metadata_json: string; customer_reference: string | null }>();
        if (!row) return { claimId: oldId, orderId: null, telegramUserId: null, telegramUsername: null };
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
      .first<{ external_order_id: string; metadata_json: string; customer_reference: string | null }>();

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
    const parsed = z.object({ reason: z.string().min(1).max(2000) }).strict().safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ ok: false, error: 'reason_required' }, 400);

    const result = await reopenMirzabotManualVerification(
      c.env.DB as unknown as DomainD1Database,
      { claimId, actorEmail: ident.email, reason: parsed.data.reason },
    );
    if (!result.ok) {
      const status =
        result.error === 'CLAIM_NOT_FOUND'
          ? 404
          : result.error === 'REASON_REQUIRED'
            ? 400
            : 409;
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

    const result = await revertMirzabotManualVerification(
      c.env.DB as unknown as DomainD1Database,
      { claimId, actorEmail: ident.email },
    );
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
}
