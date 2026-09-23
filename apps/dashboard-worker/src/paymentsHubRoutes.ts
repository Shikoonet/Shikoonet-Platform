/**
 * Financial operations extensions: Income, Reseller, history range summaries.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { SQL, type D1Database } from '@shikoo/database';
import {
  OFF_BOOKS_CATEGORIES,
  classifyResellerTransaction,
  createReseller,
  creditDepositToWallet,
  declineAllActiveIncome,
  declineIncomeBulk,
  declineIncomeTransaction,
  INCOME_QUEUE_TX_WHERE,
  BANK_INCOME_TX_WHERE,
  BANK_OUTFLOW_TX_WHERE,
  historyRangeBounds,
  parseHistoryRange,
  restoreAllDeclinedIncome,
  restoreIncomeBulk,
  restoreIncomeTransaction,
  incomeEventKey,
  isPaymentEventUnread,
  type HistoryRange,
  type D1Database as DomainD1Database,
} from '@shikoo/domain';
import type { EnvName } from '@shikoo/contracts';
import { IRR_PER_TOMAN, MIRZABOT_SOURCE, Texts } from '@shikoo/contracts';

/**
 * The tabs of «پرداخت‌ها», defined once.
 *
 * This union used to exist twice — here and in `mirzabotRoutes.ts` — with
 * nothing keeping the two in step. `mirzabotRoutes` already imports from this
 * file, so this is the end that can hold it without a cycle; the other end
 * re-exports this type rather than restating it.
 *
 * `open` is documented at the re-export, next to the queue it replaced.
 */
export type PaymentTab =
  | 'income'
  | 'open'
  /** Undecided like `open`, but the customer has not sent a receipt yet (#307). */
  | 'awaiting_receipt'
  /** `open` rows an operator set aside to wait for the bank SMS (`parked_at`). */
  | 'parked'
  /** Undecided rows whose customer an operator has written to (`messaged_at`, #320). */
  | 'messaged'
  | 'needs_review'
  | 'declined_income'
  | 'waiting'
  | 'suspected_fake'
  | 'continuity'
  | 'bot_auto_verified'
  | 'manually_verified'
  | 'reseller'
  | 'all';

type Ident = { email: string; role: import('@shikoo/contracts').AccessRole };

/**
 * Queues an operator WORKS, as opposed to history they browse.
 *
 * Membership here means one thing: the date filter does not apply. A work queue
 * that hides everything older than the chosen range is not a queue, it is a
 * report — and the oldest row is precisely the one that most needs deciding.
 *
 * `open` joins them for exactly that reason, and it is the tab that made the
 * point: the claim Sam could not find was three days old.
 */
const OPEN_QUEUE_TABS = new Set<PaymentTab>([
  'open',
  'awaiting_receipt',
  'parked',
  'messaged',
  'needs_review',
  'waiting',
  'suspected_fake',
]);

/**
 * Free text from the search box (#333), or null.
 *
 * Whatever an operator has in front of them when a customer calls — an order
 * id, a Telegram id, «@username», the tracking number, a card, an amount.
 * One box rather than one field per kind, because the operator does not
 * always know which kind they are holding. Digits are folded to ASCII for the
 * same reason `referenceParam` folds them; the LIKE metacharacters are
 * escaped so «100%» asks about the text «100%» and not about everything.
 */
export function searchParam(raw: string | null): string | null {
  if (!raw) return null;
  let v = raw.trim().replace(/^@/, '');
  for (let i = 0; i < 10; i++) {
    v = v.replaceAll('۰۱۲۳۴۵۶۷۸۹'[i]!, String(i)).replaceAll('٠١٢٣٤٥٦٧٨٩'[i]!, String(i));
  }
  return v.length >= 1 && v.length <= 64 ? v : null;
}

/** `ILIKE '%…%'` against several columns, the input escaped for LIKE. */
export function searchLikeSql(columns: string[], bind: string): string {
  return `(${columns.map((col) => `${col} ILIKE ${bind} ESCAPE '\\'`).join(' OR ')})`;
}

export function searchLikeBind(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * The «واریزی‌ها» half of the search: the tracking number, the account it
 * landed on, and the amount whole — as the operator reads it (toman) or as
 * the SMS printed it (rial). `fa` must be joined by the caller.
 */
function incomeSearchClause(q: string | null, p: (v: unknown) => string): string {
  if (!q) return '';
  const like = p(searchLikeBind(q));
  return ` AND (${searchLikeSql(
    ['t.transaction_reference', 'fa.account_hint', 'fa.display_name'],
    like,
  )} OR (t.amount_irr / 10)::text = ${p(q)} OR t.amount_irr::text = ${p(q)})`;
}

/**
 * The claims half (#333): order, Telegram id, username, the card and account
 * the customer was told to pay into, the amount whole in toman or rial, and
 * the tracking number through ANY match — settled or only suggested, because
 * a claim whose transfer the matcher found but could not settle is exactly
 * the one an operator is on the phone about. `cu` and `fa` must be joined by
 * the caller. One function for the list and the tab counts, so the number on
 * a tab under a search is the number of rows that tab will draw.
 *
 * ponytail: leading-wildcard ILIKE is a scan over payment_claims; add
 * pg_trgm on customer_reference/external_order_id if the table ever makes
 * this slow.
 */
export function claimSearchClause(q: string | null, p: (v: unknown) => string): string {
  if (!q) return '';
  const like = p(searchLikeBind(q));
  return ` AND (${searchLikeSql(
    ['c.external_order_id', 'c.customer_reference', 'cu.username', 'c.card_digits', 'fa.account_hint', 'fa.display_name'],
    like,
  )}
    OR (c.expected_amount_irr / 10)::text = ${p(q)}
    OR c.expected_amount_irr::text = ${p(q)}
    OR EXISTS (
      SELECT 1 FROM reconciliation_matches rm
        JOIN transaction_candidates rt ON rt.id = rm.transaction_candidate_id
       WHERE rm.payment_claim_id = c.id AND rt.transaction_reference ILIKE ${like} ESCAPE '\\'))`;
}

function rangeClause(
  column: string,
  range: HistoryRange,
  now: number,
  p: (v: unknown) => string,
  day?: string | null,
): { sql: string; binds: unknown[] } {
  const { start, end } = historyRangeBounds(range, now, day);
  if (start == null || end == null) return { sql: '', binds: [] };
  return { sql: ` AND ${column} >= ${p(start)} AND ${column} < ${p(end)}`, binds: [start, end] };
}

/**
 * A declined deposit is still money the bank took in — it just is not a sale.
 * A rejected one (a re-sent text, a false parse) is not money at all, and the
 * off-books tag it may still carry is history, not a disposition: it left
 * «دفتر بانک» on the same rule (books.ts) and it leaves «رد شده» here too.
 * Production, 2026-09-20: a duplicate rejected from this tab kept sitting in
 * it, 1,200,000 in the declined total.
 */
const NOT_REJECTED = `t.status NOT IN ('REJECTED','IGNORED')`;

export async function loadDeclinedIncomeItems(
  db: D1Database,
  range: HistoryRange,
  now: number,
  day?: string | null,
  limit = 200,
  offset = 0,
) {
  const binds: unknown[] = [];
  const p = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };
  const rangeFilter = rangeClause('idt.declined_at', range, now, p, day);

  const rows = await db
    .prepare(
      `SELECT t.id, t.amount_irr, t.bank_timestamp, t.financial_account_id, t.status,
              t.parser_evidence_json,
              fa.display_name AS account_display, fa.bank_name AS account_bank, fa.account_hint,
              idt.declined_by, idt.declined_at, idt.reason
       FROM income_declined_transactions idt
       JOIN transaction_candidates t ON t.id = idt.transaction_candidate_id
       LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
       WHERE idt.restored_at IS NULL AND ${NOT_REJECTED}${rangeFilter.sql}
       -- The id breaks the tie, and it is what makes OFFSET safe. Two rows
       -- with the same timestamp have no defined order between them, so a
       -- plain timestamp sort can hand page 2 a row page 1 already showed and
       -- silently drop another. Bank timestamps collide readily: an SMS burst
       -- lands on the same minute.
       ORDER BY idt.declined_at DESC, idt.id DESC
       LIMIT ${p(limit)} OFFSET ${p(offset)}`,
    )
    .bind(...binds)
    .all<{
      id: string;
      amount_irr: number | null;
      bank_timestamp: number | null;
      financial_account_id: string | null;
      status: string;
      parser_evidence_json: string;
      account_display: string | null;
      account_bank: string | null;
      account_hint: string | null;
      declined_by: string;
      declined_at: number;
      reason: string | null;
    }>();

  return (rows.results ?? []).map((r) => ({
    id: r.id,
    amountIrr: r.amount_irr,
    amountToman: r.amount_irr != null ? Math.floor(r.amount_irr / 10) : null,
    bankTimestamp: r.bank_timestamp,
    accountId: r.financial_account_id,
    accountDisplay: r.account_display,
    accountBank: r.account_bank,
    accountHint: r.account_hint,
    reference: extractReference(r.parser_evidence_json),
    declinedBy: r.declined_by,
    declinedAt: r.declined_at,
    declineReason: r.reason,
  }));
}

export async function loadDeclinedIncomeTotals(
  db: D1Database,
  range: HistoryRange,
  now: number,
  day?: string | null,
) {
  const binds: unknown[] = [];
  const p = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };
  const rangeFilter = rangeClause('idt.declined_at', range, now, p, day);

  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(t.amount_irr), 0) AS amount_irr
       FROM income_declined_transactions idt
       JOIN transaction_candidates t ON t.id = idt.transaction_candidate_id
       WHERE idt.restored_at IS NULL AND ${NOT_REJECTED}${rangeFilter.sql}`,
    )
    .bind(...binds)
    .first<{ count: number; amount_irr: number }>();
  return { count: row?.count ?? 0, amountIrr: row?.amount_irr ?? 0 };
}

export async function loadDeclinedIncomeCount(db: D1Database) {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM income_declined_transactions idt
       JOIN transaction_candidates t ON t.id = idt.transaction_candidate_id
       WHERE idt.restored_at IS NULL AND ${NOT_REJECTED}`,
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** How late a deposit may arrive and still be read as «that invoice». */
export const EXPIRED_INVOICE_HINT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ExpiredInvoiceHint {
  publicId: string;
  /** Epoch ms the invoice was issued. */
  invoiceAt: number;
  customer: { id: number; telegramId: string; username: string | null } | null;
  /** Other expired invoices that fit the same deposit — 0 when this one is alone. */
  others: number;
}

/**
 * «Probably invoice X» on a deposit nobody claimed (#275).
 *
 * Since #274 an invoice expires with the card hold (ten minutes by default)
 * and «پرداخت کردم» after that opens no claim. A customer who pays late
 * anyway lands here, in «واریزی‌ها», and the operator had to guess which
 * invoice the money was for. This names the guess: an EXPIRED card-to-card
 * invoice for the same amount, on a card mapped to the account the SMS
 * came in on, issued in the 24 hours before the bank stamped the deposit.
 *
 * Only an invoice whose ORDER expired. A card checkout also closes as
 * `EXPIRED` when the customer pays the order from their balance instead
 * (`handle.ts`, the wallet button) — the order is PAID and nobody is late
 * with anything, yet the row looked exactly like an unpaid invoice and was
 * named against a stranger's deposit of the same amount on the same account
 * (#339: an operator's own wallet purchase, offered as the owner of a
 * deposit three hours later). The order's status is what says the money is
 * still owed; the payment's alone does not.
 *
 * A hint and nothing more. It is not a match, it verifies nothing, and the
 * rule «auto-verify only for an isolated 1↔1 pair in the five-minute
 * window» is untouched — an expired invoice has no claim to match. The
 * newest fitting invoice is named; `others` says how many more fit, so a
 * regular's third attempt is not presented as certain.
 *
 * One query for the page, `ANY(?1)` over its ids, like `expire.ts`.
 */
export async function loadExpiredInvoiceHints(
  db: D1Database,
  txIds: string[],
): Promise<Map<string, ExpiredInvoiceHint>> {
  const out = new Map<string, ExpiredInvoiceHint>();
  if (txIds.length === 0) return out;
  const rows = await db
    .prepare(
      `SELECT DISTINCT ON (t.id)
              t.id AS tx_id,
              p.public_id,
              (EXTRACT(EPOCH FROM p.created_at) * 1000)::bigint AS invoice_at,
              u.id AS user_id, u.telegram_id, u.username,
              COUNT(*) OVER (PARTITION BY t.id) AS fitting
         FROM transaction_candidates t
         JOIN payments p
           ON p.status = 'EXPIRED'
          AND p.method = 'CARD_TO_CARD'
          AND p.amount_irr = t.amount_irr
          AND p.created_at >  to_timestamp((t.bank_timestamp - ?2) / 1000.0)
          AND p.created_at <= to_timestamp(t.bank_timestamp / 1000.0)
         JOIN payment_cards pc
           ON pc.card_digits = p.assigned_card_number
          AND pc.financial_account_id = t.financial_account_id
         LEFT JOIN users u ON u.id = p.user_id
        WHERE t.id = ANY(?1)
          AND t.bank_timestamp IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM orders o
                           WHERE o.id = p.order_id AND o.status <> 'EXPIRED')
        ORDER BY t.id, p.created_at DESC`,
    )
    .bind(txIds, EXPIRED_INVOICE_HINT_WINDOW_MS)
    .all<{
      tx_id: string;
      public_id: string;
      invoice_at: number;
      user_id: number | null;
      telegram_id: number | string | null;
      username: string | null;
      fitting: number;
    }>();
  for (const r of rows.results ?? []) {
    out.set(r.tx_id, {
      publicId: r.public_id,
      invoiceAt: r.invoice_at,
      customer:
        r.user_id != null && r.telegram_id != null
          ? { id: r.user_id, telegramId: String(r.telegram_id), username: r.username }
          : null,
      others: Math.max(0, Number(r.fitting) - 1),
    });
  }
  return out;
}

export async function loadIncomeItems(
  db: D1Database,
  range: HistoryRange,
  now: number,
  day?: string | null,
  limit = 200,
  actorEmail?: string,
  offset = 0,
  q: string | null = null,
) {
  const binds: unknown[] = [];
  const p = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };
  const rangeFilter = rangeClause('t.bank_timestamp', range, now, p, day);
  const search = incomeSearchClause(q, p);

  const rows = await db
    .prepare(
      `SELECT t.id, t.amount_irr, t.bank_timestamp, t.financial_account_id, t.status,
              t.parser_evidence_json,
              fa.display_name AS account_display, fa.bank_name AS account_bank, fa.account_hint
       FROM transaction_candidates t
       LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
       WHERE ${INCOME_QUEUE_TX_WHERE}${rangeFilter.sql}${search}
       -- The id breaks the tie, and it is what makes OFFSET safe. Two rows
       -- with the same timestamp have no defined order between them, so a
       -- plain timestamp sort can hand page 2 a row page 1 already showed and
       -- silently drop another. Bank timestamps collide readily: an SMS burst
       -- lands on the same minute.
       ORDER BY t.bank_timestamp DESC, t.id DESC
       LIMIT ${p(limit)} OFFSET ${p(offset)}`,
    )
    .bind(...binds)
    .all<{
      id: string;
      amount_irr: number | null;
      bank_timestamp: number | null;
      financial_account_id: string | null;
      status: string;
      parser_evidence_json: string;
      account_display: string | null;
      account_bank: string | null;
      account_hint: string | null;
    }>();

  const hints = await loadExpiredInvoiceHints(
    db,
    (rows.results ?? []).map((r) => r.id),
  );
  const mapped = (rows.results ?? []).map((r) => ({
    id: r.id,
    amountIrr: r.amount_irr,
    amountToman: r.amount_irr != null ? Math.floor(r.amount_irr / 10) : null,
    bankTimestamp: r.bank_timestamp,
    accountId: r.financial_account_id,
    accountDisplay: r.account_display,
    accountBank: r.account_bank,
    accountHint: r.account_hint,
    reference: extractReference(r.parser_evidence_json),
    statusLabel: 'Unassigned income',
    expiredInvoice: hints.get(r.id) ?? null,
  }));

  if (!actorEmail) return mapped;

  const domainDb = db as unknown as DomainD1Database;
  return Promise.all(
    mapped.map(async (item) => ({
      ...item,
      isNew: await isPaymentEventUnread(domainDb, actorEmail, incomeEventKey(item.id)),
    })),
  );
}

export async function loadIncomeTotals(
  db: D1Database,
  range: HistoryRange,
  now: number,
  day?: string | null,
  q: string | null = null,
) {
  const binds: unknown[] = [];
  const p = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };
  const rangeFilter = rangeClause('t.bank_timestamp', range, now, p, day);
  const search = incomeSearchClause(q, p);

  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(t.amount_irr), 0) AS amount_irr
       FROM transaction_candidates t
       LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
       WHERE ${INCOME_QUEUE_TX_WHERE}${rangeFilter.sql}${search}`,
    )
    .bind(...binds)
    .first<{ count: number; amount_irr: number }>();
  return { count: row?.count ?? 0, amountIrr: row?.amount_irr ?? 0 };
}

export async function loadResellerItems(
  db: D1Database,
  range: HistoryRange,
  now: number,
  day?: string | null,
  limit = 200,
  offset = 0,
) {
  const binds: unknown[] = [];
  const p = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };
  const rangeFilter = rangeClause('rt.classified_at', range, now, p, day);

  const rows = await db
    .prepare(
      `SELECT rt.id, rt.transaction_candidate_id, rt.classified_by, rt.classified_at, rt.note,
              r.id AS reseller_id, r.name AS reseller_name,
              t.amount_irr, t.bank_timestamp, t.parser_evidence_json,
              fa.display_name AS account_display, fa.bank_name AS account_bank, fa.account_hint
       FROM reseller_transactions rt
       JOIN resellers r ON r.id = rt.reseller_id
       JOIN transaction_candidates t ON t.id = rt.transaction_candidate_id
       LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
       WHERE 1=1${rangeFilter.sql}
       -- The id breaks the tie, and it is what makes OFFSET safe. Two rows
       -- with the same timestamp have no defined order between them, so a
       -- plain timestamp sort can hand page 2 a row page 1 already showed and
       -- silently drop another. Bank timestamps collide readily: an SMS burst
       -- lands on the same minute.
       ORDER BY rt.classified_at DESC, rt.id DESC
       LIMIT ${p(limit)} OFFSET ${p(offset)}`,
    )
    .bind(...binds)
    .all<{
      id: string;
      transaction_candidate_id: string;
      classified_by: string;
      classified_at: number;
      note: string | null;
      reseller_id: string;
      reseller_name: string;
      amount_irr: number | null;
      bank_timestamp: number | null;
      parser_evidence_json: string;
      account_display: string | null;
      account_bank: string | null;
      account_hint: string | null;
    }>();

  return (rows.results ?? []).map((r) => ({
    id: r.id,
    transactionId: r.transaction_candidate_id,
    resellerId: r.reseller_id,
    resellerName: r.reseller_name,
    amountIrr: r.amount_irr,
    amountToman: r.amount_irr != null ? Math.floor(r.amount_irr / 10) : null,
    bankTimestamp: r.bank_timestamp,
    accountDisplay: r.account_display,
    accountBank: r.account_bank,
    accountHint: r.account_hint,
    reference: extractReference(r.parser_evidence_json),
    classifiedBy: r.classified_by,
    classifiedAt: r.classified_at,
    note: r.note,
  }));
}

export async function loadResellerStats(
  db: D1Database,
  range: HistoryRange,
  now: number,
  day?: string | null,
) {
  const binds: unknown[] = [];
  const p = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };
  const rangeFilter = rangeClause('rt.classified_at', range, now, p, day);

  const totals = await db
    .prepare(
      `SELECT COUNT(*) AS payments, COALESCE(SUM(t.amount_irr), 0) AS amount_irr,
              COUNT(DISTINCT rt.reseller_id) AS active_resellers
       FROM reseller_transactions rt
       JOIN transaction_candidates t ON t.id = rt.transaction_candidate_id
       WHERE 1=1${rangeFilter.sql}`,
    )
    .bind(...binds)
    .first<{ payments: number; amount_irr: number; active_resellers: number }>();

  const breakdown = await db
    .prepare(
      `SELECT r.name AS reseller_name, COUNT(*) AS payments, COALESCE(SUM(t.amount_irr), 0) AS amount_irr
       FROM reseller_transactions rt
       JOIN resellers r ON r.id = rt.reseller_id
       JOIN transaction_candidates t ON t.id = rt.transaction_candidate_id
       WHERE 1=1${rangeFilter.sql}
       GROUP BY r.id, r.name
       ORDER BY amount_irr DESC
       LIMIT 50`,
    )
    .bind(...binds)
    .all<{ reseller_name: string; payments: number; amount_irr: number }>();

  return {
    payments: totals?.payments ?? 0,
    amountIrr: totals?.amount_irr ?? 0,
    activeResellers: totals?.active_resellers ?? 0,
    breakdown: breakdown.results ?? [],
  };
}

export async function loadFinancialSummary(
  db: D1Database,
  range: HistoryRange,
  now: number,
  day?: string | null,
) {
  const income = await loadIncomeTotals(db, range, now, day);

  const binds: unknown[] = [MIRZABOT_SOURCE];
  const p = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };
  const rangeFilter = rangeClause(
    'COALESCE(t.bank_timestamp, m.reviewed_at, c.updated_at)',
    range,
    now,
    p,
    day,
  );

  const botAuto = await db
    .prepare(
      `SELECT COUNT(*) AS payments, COALESCE(SUM(t.amount_irr), 0) AS amount_irr
       FROM payment_claims c
       JOIN reconciliation_matches m ON m.payment_claim_id = c.id AND m.status = 'AUTO_VERIFIED'
       JOIN transaction_candidates t ON t.id = m.transaction_candidate_id
       WHERE c.source_system = ?1${rangeFilter.sql}`,
    )
    .bind(...binds)
    .first<{ payments: number; amount_irr: number }>();

  const resellerStats = await loadResellerStats(db, range, now, day);

  const bankBinds: unknown[] = [];
  const bp = (v: unknown) => {
    bankBinds.push(v);
    return `?${bankBinds.length}`;
  };
  const bankRange = rangeClause('t.bank_timestamp', range, now, bp, day);

  const bankIncome = await db
    .prepare(
      `SELECT COALESCE(SUM(t.amount_irr), 0) AS amount_irr
       FROM transaction_candidates t
       WHERE ${BANK_INCOME_TX_WHERE}${bankRange.sql}`,
    )
    .bind(...bankBinds)
    .first<{ amount_irr: number }>();
  // What left, per the bank — the same range, off-books excluded (0073).
  const bankOutflow = await db
    .prepare(
      `SELECT COALESCE(SUM(t.amount_irr), 0) AS amount_irr
       FROM transaction_candidates t
       WHERE ${BANK_OUTFLOW_TX_WHERE}${bankRange.sql}`,
    )
    .bind(...bankBinds)
    .first<{ amount_irr: number }>();

  return {
    range,
    bankIncomeIrr: bankIncome?.amount_irr ?? 0,
    bankOutflowIrr: bankOutflow?.amount_irr ?? 0,
    botAutoVerified: {
      payments: botAuto?.payments ?? 0,
      amountIrr: botAuto?.amount_irr ?? 0,
    },
    reseller: {
      payments: resellerStats.payments,
      amountIrr: resellerStats.amountIrr,
      activeResellers: resellerStats.activeResellers,
    },
    unassignedIncome: income,
  };
}

export async function loadIncomeCount(db: D1Database, q: string | null = null) {
  const binds: unknown[] = [];
  const p = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };
  const search = incomeSearchClause(q, p);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM transaction_candidates t
       LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
       WHERE ${INCOME_QUEUE_TX_WHERE}${search}`,
    )
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function loadResellerCount(db: D1Database) {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM reseller_transactions`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function extractReference(parserEvidenceJson: string): string | null {
  try {
    const j = JSON.parse(parserEvidenceJson || '{}') as Record<string, unknown>;
    for (const key of ['reference', 'ref', 'transactionRef', 'traceNumber', 'referenceNumber']) {
      const v = j[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function registerPaymentsHubRoutes(
  app: Hono<{
    Bindings: { DB: D1Database; ENV_NAME: EnvName };
    Variables: { identity: Ident };
  }>,
) {
  app.get('/api/v1/resellers', async (c) => {
    const q = c.req.query('q')?.trim() ?? '';
    const rows = await c.env.DB.prepare(
      `SELECT id, name, status, created_at, updated_at FROM resellers
       WHERE status = 'ACTIVE' AND (?1 = '' OR name LIKE ?2)
       ORDER BY name ASC LIMIT 100`,
    )
      .bind(q, `%${q}%`)
      .all<{ id: string; name: string; status: string; created_at: number; updated_at: number }>();
    return c.json({ ok: true, items: rows.results ?? [] });
  });

  const CreateResellerBody = z.object({ name: z.string().min(1).max(128) }).strict();
  app.post('/api/v1/resellers', async (c) => {
    const ident = c.get('identity');
    if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
    const parsed = CreateResellerBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const result = await createReseller(c.env.DB as unknown as DomainD1Database, {
      name: parsed.data.name,
    });
    if (!result.ok) {
      const status = result.error === 'DUPLICATE' ? 409 : 400;
      return c.json({ ok: false, error: result.error.toLowerCase() }, status);
    }
    return c.json({ ok: true, id: result.id, name: result.name });
  });

  const ClassifyBody = z
    .object({
      resellerId: z.string(),
      note: z.string().max(2000).optional(),
    })
    .strict();

  app.post('/api/v1/transactions/:transactionId/classify-reseller', async (c) => {
    const ident = c.get('identity');
    if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
    const parsed = ClassifyBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const transactionId = c.req.param('transactionId');

    const result = await classifyResellerTransaction(c.env.DB as unknown as DomainD1Database, {
      transactionId,
      resellerId: parsed.data.resellerId,
      actorEmail: ident.email,
      note: parsed.data.note ?? null,
    });

    if (!result.ok) {
      if (result.error === 'TRANSACTION_NOT_FOUND' || result.error === 'RESELLER_NOT_FOUND') {
        return c.json({ ok: false, error: result.error.toLowerCase() }, 404);
      }
      return c.json({ ok: false, error: result.error.toLowerCase() }, 409);
    }

    const tx = await c.env.DB.prepare(
      `SELECT amount_irr, financial_account_id FROM transaction_candidates WHERE id = ?1`,
    )
      .bind(transactionId)
      .first<{ amount_irr: number | null; financial_account_id: string | null }>();
    const reseller = await c.env.DB.prepare(`SELECT name FROM resellers WHERE id = ?1`)
      .bind(result.resellerId)
      .first<{ name: string }>();

    const now = Date.now();
    await c.env.DB.prepare(SQL.insertAudit)
      .bind(
        crypto.randomUUID(),
        ident.email,
        ident.role,
        'transaction.classified_reseller',
        'TRANSACTION',
        transactionId,
        JSON.stringify({
          amountIrr: tx?.amount_irr ?? null,
          accountId: tx?.financial_account_id ?? null,
        }),
        JSON.stringify({
          resellerId: result.resellerId,
          resellerName: reseller?.name ?? null,
          note: parsed.data.note ?? null,
        }),
        parsed.data.note ?? null,
        c.req.header('cf-ray') ?? null,
        now,
      )
      .run();

    return c.json(result);
  });

  const DeclineBody = z
    .object({
      reason: z.string().max(2000).optional(),
      /** Which kind of «not ours» — 0073. Absent means the pre-0073 OTHER. */
      category: z.enum(OFF_BOOKS_CATEGORIES).optional(),
    })
    .strict();

  app.post('/api/v1/transactions/:transactionId/decline-income', async (c) => {
    const ident = c.get('identity');
    if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
    const parsed = DeclineBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const transactionId = c.req.param('transactionId');

    const result = await declineIncomeTransaction(c.env.DB as unknown as DomainD1Database, {
      transactionId,
      actorEmail: ident.email,
      reason: parsed.data.reason ?? null,
      category: parsed.data.category ?? null,
    });

    if (!result.ok) {
      const status =
        result.error === 'TRANSACTION_NOT_FOUND'
          ? 404
          : result.error === 'NOT_INCOME_ELIGIBLE' || result.error === 'ALREADY_DECLINED'
            ? 409
            : 400;
      return c.json({ ok: false, error: result.error.toLowerCase() }, status);
    }

    const tx = await c.env.DB.prepare(
      `SELECT amount_irr, financial_account_id FROM transaction_candidates WHERE id = ?1`,
    )
      .bind(transactionId)
      .first<{ amount_irr: number | null; financial_account_id: string | null }>();

    const now = Date.now();
    await c.env.DB.prepare(SQL.insertAudit)
      .bind(
        crypto.randomUUID(),
        ident.email,
        ident.role,
        'transaction.declined_income',
        'TRANSACTION',
        transactionId,
        JSON.stringify({
          amountIrr: tx?.amount_irr ?? null,
          accountId: tx?.financial_account_id ?? null,
        }),
        JSON.stringify({ reason: parsed.data.reason ?? null }),
        parsed.data.reason ?? null,
        c.req.header('cf-ray') ?? null,
        now,
      )
      .run();

    return c.json(result);
  });

  const CreditWalletBody = z
    .object({
      userId: z.number().int().positive(),
      reason: z.string().trim().min(1).max(2000),
    })
    .strict();

  /**
   * «شارژ کیف پول مشتری» — a deposit with no order left to take it (the
   * customer paid an invoice after it expired), paid into their wallet.
   * `creditDepositToWallet` has the why and the locking.
   *
   * ADMIN only, like the wallet adjustment on the customer's page: this moves
   * money into a customer's balance.
   */
  app.post('/api/v1/transactions/:transactionId/credit-wallet', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const parsed = CreditWalletBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const transactionId = c.req.param('transactionId');

    const deposit = await c.env.DB.prepare(
      `SELECT amount_irr, financial_account_id FROM transaction_candidates WHERE id = ?1`,
    )
      .bind(transactionId)
      .first<{ amount_irr: number | null; financial_account_id: string | null }>();

    // The bot's own top-up message (`menu.walletToppedUp`), from the same
    // editable texts, so the customer reads what a bot top-up says.
    const { results } = await c.env.DB.prepare(`SELECT key, value FROM bot_texts`).all<{
      key: string;
      value: string;
    }>();
    const texts = new Texts(Object.fromEntries((results ?? []).map((r) => [r.key, r.value])));
    const toman = Math.round(Number(deposit?.amount_irr ?? 0) / IRR_PER_TOMAN);
    const message = [
      texts.raw('WALLET_TOPPED_UP_TITLE'),
      '',
      texts.render('WALLET_TOPPED_UP_AMOUNT', { amount: `${toman.toLocaleString('en-US')} تومان` }),
      '',
      texts.raw('WALLET_TOPPED_UP_FOOTER'),
    ].join('\n');

    const result = await creditDepositToWallet(c.env.DB as unknown as DomainD1Database, {
      transactionId,
      userId: parsed.data.userId,
      actorEmail: ident.email,
      reason: parsed.data.reason,
      message,
    });

    if (!result.ok) {
      const status =
        result.error === 'TRANSACTION_NOT_FOUND' || result.error === 'USER_NOT_FOUND'
          ? 404
          : result.error === 'NOT_INCOME_ELIGIBLE'
            ? 409
            : 400;
      return c.json({ ok: false, error: result.error.toLowerCase() }, status);
    }

    await c.env.DB.prepare(SQL.insertAudit)
      .bind(
        crypto.randomUUID(),
        ident.email,
        ident.role,
        'transaction.credited_to_wallet',
        'TRANSACTION',
        transactionId,
        JSON.stringify({
          amountIrr: deposit?.amount_irr ?? null,
          accountId: deposit?.financial_account_id ?? null,
        }),
        JSON.stringify({
          userId: parsed.data.userId,
          amountIrr: result.amountIrr,
          balanceIrr: result.balanceIrr,
          notified: result.notified,
        }),
        parsed.data.reason,
        c.req.header('cf-ray') ?? null,
        Date.now(),
      )
      .run();

    return c.json(result);
  });

  const DeclineBulkBody = z
    .object({
      transactionIds: z.array(z.string()).min(1).max(500),
      reason: z.string().max(2000).optional(),
    })
    .strict();

  app.post('/api/v1/transactions/decline-income/bulk', async (c) => {
    const ident = c.get('identity');
    if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
    const parsed = DeclineBulkBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);

    const result = await declineIncomeBulk(c.env.DB as unknown as DomainD1Database, {
      transactionIds: parsed.data.transactionIds,
      actorEmail: ident.email,
      reason: parsed.data.reason ?? null,
    });

    const now = Date.now();
    for (const id of result.declined) {
      await c.env.DB.prepare(SQL.insertAudit)
        .bind(
          crypto.randomUUID(),
          ident.email,
          ident.role,
          'transaction.declined_income',
          'TRANSACTION',
          id,
          null,
          JSON.stringify({ reason: parsed.data.reason ?? null, bulk: true }),
          parsed.data.reason ?? null,
          c.req.header('cf-ray') ?? null,
          now,
        )
        .run();
    }

    return c.json({ ok: true, ...result });
  });

  app.post('/api/v1/transactions/decline-income/all', async (c) => {
    const ident = c.get('identity');
    if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
    const parsed = DeclineBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);

    const result = await declineAllActiveIncome(c.env.DB as unknown as DomainD1Database, {
      actorEmail: ident.email,
      reason: parsed.data.reason ?? null,
    });

    const now = Date.now();
    await c.env.DB.prepare(SQL.insertAudit)
      .bind(
        crypto.randomUUID(),
        ident.email,
        ident.role,
        'transaction.declined_income_all',
        'TRANSACTION',
        'bulk',
        JSON.stringify({ count: result.declined }),
        JSON.stringify({
          reason: parsed.data.reason ?? null,
          transactionIds: result.transactionIds,
        }),
        parsed.data.reason ?? null,
        c.req.header('cf-ray') ?? null,
        now,
      )
      .run();

    return c.json({ ok: true, ...result });
  });

  app.post('/api/v1/transactions/:transactionId/restore-income', async (c) => {
    const ident = c.get('identity');
    if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
    const transactionId = c.req.param('transactionId');

    const result = await restoreIncomeTransaction(c.env.DB as unknown as DomainD1Database, {
      transactionId,
      actorEmail: ident.email,
    });

    if (!result.ok) {
      const status = result.error === 'NOT_DECLINED' ? 409 : 404;
      return c.json({ ok: false, error: result.error.toLowerCase() }, status);
    }

    const now = Date.now();
    await c.env.DB.prepare(SQL.insertAudit)
      .bind(
        crypto.randomUUID(),
        ident.email,
        ident.role,
        'transaction.restored_income',
        'TRANSACTION',
        transactionId,
        null,
        JSON.stringify({ returnedToIncome: result.returnedToIncome }),
        null,
        c.req.header('cf-ray') ?? null,
        now,
      )
      .run();

    return c.json(result);
  });

  const RestoreBulkBody = z
    .object({ transactionIds: z.array(z.string()).min(1).max(500) })
    .strict();

  app.post('/api/v1/transactions/restore-income/bulk', async (c) => {
    const ident = c.get('identity');
    if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
    const parsed = RestoreBulkBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);

    const result = await restoreIncomeBulk(c.env.DB as unknown as DomainD1Database, {
      transactionIds: parsed.data.transactionIds,
      actorEmail: ident.email,
    });

    const now = Date.now();
    for (const id of result.restored) {
      await c.env.DB.prepare(SQL.insertAudit)
        .bind(
          crypto.randomUUID(),
          ident.email,
          ident.role,
          'transaction.restored_income',
          'TRANSACTION',
          id,
          null,
          JSON.stringify({ bulk: true, returnedToIncome: result.returnedToIncome.includes(id) }),
          null,
          c.req.header('cf-ray') ?? null,
          now,
        )
        .run();
    }

    return c.json({ ok: true, ...result });
  });

  app.post('/api/v1/transactions/restore-income/all', async (c) => {
    const ident = c.get('identity');
    if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);

    const result = await restoreAllDeclinedIncome(c.env.DB as unknown as DomainD1Database, {
      actorEmail: ident.email,
    });

    const now = Date.now();
    await c.env.DB.prepare(SQL.insertAudit)
      .bind(
        crypto.randomUUID(),
        ident.email,
        ident.role,
        'transaction.restored_income_all',
        'TRANSACTION',
        'bulk',
        JSON.stringify({ restored: result.restored, returnedToIncome: result.returnedToIncome }),
        null,
        c.req.header('cf-ray') ?? null,
        now,
      )
      .run();

    return c.json({ ok: true, ...result });
  });
}

export { OPEN_QUEUE_TABS, parseHistoryRange, type HistoryRange };
