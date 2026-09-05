/**
 * Financial operations extensions: Income, Reseller, history range summaries.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { SQL, type D1Database } from '@shikoo/database';
import {
  classifyResellerTransaction,
  createReseller,
  declineAllActiveIncome,
  declineIncomeBulk,
  declineIncomeTransaction,
  INCOME_TX_WHERE,
  BANK_INCOME_TX_WHERE,
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
import { MIRZABOT_SOURCE } from '@shikoo/contracts';

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
const OPEN_QUEUE_TABS = new Set<PaymentTab>(['open', 'needs_review', 'waiting', 'suspected_fake']);

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
       WHERE idt.restored_at IS NULL${rangeFilter.sql}
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
       WHERE idt.restored_at IS NULL${rangeFilter.sql}`,
    )
    .bind(...binds)
    .first<{ count: number; amount_irr: number }>();
  return { count: row?.count ?? 0, amountIrr: row?.amount_irr ?? 0 };
}

export async function loadDeclinedIncomeCount(db: D1Database) {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM income_declined_transactions WHERE restored_at IS NULL`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function loadIncomeItems(
  db: D1Database,
  range: HistoryRange,
  now: number,
  day?: string | null,
  limit = 200,
  actorEmail?: string,
  offset = 0,
) {
  const binds: unknown[] = [];
  const p = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };
  const rangeFilter = rangeClause('t.bank_timestamp', range, now, p, day);

  const rows = await db
    .prepare(
      `SELECT t.id, t.amount_irr, t.bank_timestamp, t.financial_account_id, t.status,
              t.parser_evidence_json,
              fa.display_name AS account_display, fa.bank_name AS account_bank, fa.account_hint
       FROM transaction_candidates t
       LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
       WHERE ${INCOME_TX_WHERE}${rangeFilter.sql}
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
) {
  const binds: unknown[] = [];
  const p = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };
  const rangeFilter = rangeClause('t.bank_timestamp', range, now, p, day);

  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(t.amount_irr), 0) AS amount_irr
       FROM transaction_candidates t
       WHERE ${INCOME_TX_WHERE}${rangeFilter.sql}`,
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

  return {
    range,
    bankIncomeIrr: bankIncome?.amount_irr ?? 0,
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

export async function loadIncomeCount(db: D1Database) {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM transaction_candidates t WHERE ${INCOME_TX_WHERE}`)
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
    Bindings: { DB: D1Database };
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
