/**
 * هزینه‌ها — the shop's own books: what it spent, what it corrected, and what
 * it took in by hand.
 *
 * `revenue_adjustments` arrived with `0005_ops.sql` and the migration has been
 * importing it ever since, and until 2026-08-22 **nothing in this platform read
 * or wrote a single row of it.** This is the screen behind them.
 *
 * ## It is a ledger, and the total is derived
 *
 * The legacy panel keeps a second copy of the answer: every insert and delete
 * also writes `setting.revenue_adjustment = SUM(amount)`, two statements held
 * together by a transaction (`panel/settings.php:21-29`). We do not, for the
 * same reason `wallets.balance_irr` is a trigger over `wallet_entries` rather
 * than a number anybody may set: a cached total is a second thing that can be
 * right or wrong, and the only way to find out is to add the rows up anyway.
 *
 * The importer relies on that legacy total as outside truth exactly once —
 * `verify.ts` asserts our imported sum equals it to the Rial — and then it is
 * never carried forward.
 *
 * ## Three kinds, because the sign was never the type
 *
 * **This section said the opposite until 2026-08-30, and the opposite was
 * wrong.** It read «the sign is the whole design ... there is no `kind`», and
 * on the production dump that produced a screen saying the shop had spent 792
 * million Toman when 35.8 million of that was fake receipts it never spent, and
 * a column labelled «برگشتی و اعتبار» that was entirely reseller income.
 *
 * A signed amount answers «which way» and never «what». So `kind` is a column
 * now, and the 219 imported rows were labelled by the classifier in
 * `0040_expense_ledger.sql`:
 *
 *   `EXPENSE`        money the shop spent — advertising, servers, partner payouts
 *   `REVENUE_FIX`    a correction to income — a fake receipt, a duplicate charge
 *   `MANUAL_INCOME`  a sale an admin recorded by hand, mostly reseller top-ups
 *
 * The three partition the same signed rows, so every total that existed before
 * still adds to the same number; what changed is that the parts now mean
 * something. The form still asks for a positive amount and applies the sign
 * once, here, at the edge — that part was always right.
 *
 * ## Nothing is deleted, and that reversed too
 *
 * This file used to argue that real deletion was correct here, because «an
 * entry typed with a slipped digit needs to be gone rather than corrected by a
 * second entry that also has to be explained». Editing answers that, and the
 * argument had a hole nobody had spotted: `verify.ts` compares
 * `COUNT(*) FROM revenue_adjustment_log` against `COUNT(*) FROM
 * revenue_adjustments`, so one admin deleting one line made the migration's own
 * check red for ever, with nothing on any screen saying why.
 *
 * A row is voided instead. It stays in the table, leaves `shop_books`, and
 * therefore leaves every total the panel shows. Editing writes the before and
 * after into `audit_logs`, which is append-only — so «who changed this, from
 * what, when» is answerable for every row, which is what Sam asked for and what
 * the old delete could never give.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import { parseStatsDay, parseStatsRange, statsRangeBounds } from '@shikoo/domain';
import { audit, type Ident } from './adminAudit.js';

/**
 * The largest single adjustment, in Toman.
 *
 * Ten billion — roughly thirteen times the largest deduction in five weeks of
 * production. Not a policy, a fat-finger guard: the failure this stops is a
 * pasted digit, and the shop's own reporting is the only thing downstream.
 */
const MAX_ADJUSTMENT_TOMAN = 10_000_000_000;

/** Toman in, IRR out — the project's one conversion, at the edge, once. */
const IRR_PER_TOMAN = 10;

/** How many rows one export may carry. A ledger, not a data dump. */
const EXPORT_MAX = 5_000;

const KIND = z.enum(['EXPENSE', 'REVENUE_FIX', 'MANUAL_INCOME']);
type Kind = z.infer<typeof KIND>;

/** A Gregorian day on the wire; the screen picks it in Jalali. */
const ISO_DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/**
 * The sign a kind carries, decided in one place.
 *
 * `REVENUE_FIX` is the only one that takes a direction from the caller: a
 * clawback is negative and a reversed over-deduction is positive, and both are
 * corrections to the same figure. The database says the same thing in
 * `revenue_adjustments_kind_sign`, so a disagreement here is a 500 rather than
 * a wrong row.
 */
function signedIrr(kind: Kind, amountToman: number, direction: 'expense' | 'credit'): number {
  const magnitude = amountToman * IRR_PER_TOMAN;
  if (kind === 'EXPENSE') return -magnitude;
  if (kind === 'MANUAL_INCOME') return magnitude;
  return direction === 'expense' ? -magnitude : magnitude;
}

const AdjustmentBody = z
  .object({
    /**
     * A positive magnitude, in Toman, exactly as the legacy form takes it
     * (`panel/settings.php:12` refuses zero and negatives). The direction is a
     * separate field so that "how much" and "which way" cannot be confused by a
     * stray minus sign, and so a cost typed as `-50000` under `deduct` cannot
     * quietly become a credit.
     */
    amountToman: z.number().int().positive().max(MAX_ADJUSTMENT_TOMAN),
    /**
     * Required, with no default, and that is worth a sentence.
     *
     * A default of `EXPENSE` looked harmless and was not: a caller sending the
     * old `{ direction: 'credit' }` and no kind would have been read as an
     * expense, the sign forced negative, and a credit would have silently
     * become a cost. On a money route the right answer to «you did not say
     * what this is» is a 400, not a guess — and the guess is invisible, which
     * is the kind of quiet this ledger already cost us once.
     */
    kind: KIND,
    /** Only consulted for `REVENUE_FIX`; the other two kinds decide their own. */
    direction: z.enum(['expense', 'credit']).default('expense'),
    categoryId: z.number().int().positive().nullable().optional(),
    /** When the money moved. Defaults to today in Tehran, decided by Postgres. */
    spentOn: ISO_DAY.optional(),
    // Required, like the legacy form. An unexplained line in the books is the
    // one thing nobody can reconstruct later.
    note: z.string().trim().min(1).max(500),
  })
  .strict();

/**
 * An edit.
 *
 * Every field optional and at least one required, so that «save» on an
 * unchanged form is a 400 rather than an audit row recording that nothing
 * happened. `reason` alone does not count as a change.
 */
const EditBody = z
  .object({
    amountToman: z.number().int().positive().max(MAX_ADJUSTMENT_TOMAN).optional(),
    kind: KIND.optional(),
    direction: z.enum(['expense', 'credit']).optional(),
    categoryId: z.number().int().positive().nullable().optional(),
    spentOn: ISO_DAY.optional(),
    note: z.string().trim().min(1).max(500).optional(),
    /** Goes to `audit_logs.reason`, so the history says why and not only what. */
    reason: z.string().trim().max(200).optional(),
  })
  .strict()
  .refine(
    (b) => Object.keys(b).some((k) => k !== 'reason' && k !== 'direction'),
    'nothing to change',
  );

const VoidBody = z
  .object({
    // Required, and three characters is a low bar that still refuses «.» — the
    // whole point of voiding rather than deleting is that the row can be
    // explained afterwards.
    reason: z.string().trim().min(3).max(200),
  })
  .strict();

const AdjustmentQuery = z.object({
  kind: KIND.optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  /** The backlog the classifier could not label. Wins over `categoryId`. */
  uncategorised: z.coerce.boolean().optional(),
  from: ISO_DAY.optional(),
  to: ISO_DAY.optional(),
  q: z.string().trim().max(100).optional(),
  voided: z.enum(['hide', 'show', 'only']).default('hide'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const CategoryBody = z
  .object({
    name: z.string().trim().min(1).max(60),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .strict();

const CategoryPatch = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'nothing to change');

interface AdjustmentRow {
  id: number;
  amount_irr: string | number;
  note: string;
  kind: Kind;
  category_id: number | null;
  category_name: string | null;
  spent_on: string;
  created_by: string | null;
  created_at: string;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
  edit_count: number;
  last_edited_at: string | number | null;
  last_edited_by: string | null;
}

function shape(r: AdjustmentRow) {
  return {
    id: Number(r.id),
    amountIrr: Number(r.amount_irr),
    note: r.note,
    kind: r.kind,
    categoryId: r.category_id === null ? null : Number(r.category_id),
    categoryName: r.category_name,
    spentOn: r.spent_on,
    createdBy: r.created_by,
    createdAt: r.created_at,
    voidedAt: r.voided_at,
    voidedBy: r.voided_by,
    voidReason: r.void_reason,
    /** How many times it has been edited, from `audit_logs` rather than a cache. */
    editCount: Number(r.edit_count ?? 0),
    lastEditedAt: r.last_edited_at === null ? null : Number(r.last_edited_at),
    lastEditedBy: r.last_edited_by,
  };
}

/**
 * The `WHERE` for one filtered view of the ledger, plus its binds.
 *
 * Built by hand rather than by interpolating values: the Postgres adapter
 * closes parameter gaps, so the numbering has to stay contiguous and every
 * value has to be bound. Shared by the list, the totals, the breakdown and the
 * export, so a filter cannot mean one thing in the table and another in the
 * figure above it — which is the misunderstanding this whole screen exists to
 * stop.
 */
function ledgerWhere(q: z.infer<typeof AdjustmentQuery>): { sql: string; binds: unknown[] } {
  const where: string[] = [];
  const binds: unknown[] = [];
  const p = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };

  // The base table, not the view: `voided=show|only` has to be able to see
  // them. `hide` is the default and reproduces what `shop_books` returns.
  if (q.voided === 'hide') where.push('ra.voided_at IS NULL');
  if (q.voided === 'only') where.push('ra.voided_at IS NOT NULL');

  if (q.kind) where.push(`ra.kind = ${p(q.kind)}`);
  if (q.uncategorised) where.push(`ra.category_id IS NULL AND ra.kind = 'EXPENSE'`);
  else if (q.categoryId !== undefined) where.push(`ra.category_id = ${p(q.categoryId)}`);

  // On `spent_on`, never on `created_at`: «چقدر در مرداد خرج کردم» asks when
  // the money left, not when somebody got round to typing it.
  if (q.from) where.push(`ra.spent_on >= ${p(q.from)}::date`);
  if (q.to) where.push(`ra.spent_on <= ${p(q.to)}::date`);
  if (q.q) where.push(`ra.note ILIKE ${p(`%${q.q}%`)}`);

  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', binds };
}

/** The three kinds and the net, over whatever the filter selected. */
const TOTALS_SQL = `
  COALESCE(SUM(ra.amount_irr) FILTER (WHERE ra.kind = 'EXPENSE'), 0)       AS expenses_irr,
  COALESCE(SUM(ra.amount_irr) FILTER (WHERE ra.kind = 'REVENUE_FIX'), 0)   AS revenue_fix_irr,
  COALESCE(SUM(ra.amount_irr) FILTER (WHERE ra.kind = 'MANUAL_INCOME'), 0) AS manual_income_irr,
  COALESCE(SUM(ra.amount_irr), 0)                                          AS net_irr`;

type TotalsRow = {
  expenses_irr: string | number;
  revenue_fix_irr: string | number;
  manual_income_irr: string | number;
  net_irr: string | number;
};

const totals = (r: TotalsRow | null) => ({
  expensesIrr: Number(r?.expenses_irr ?? 0),
  revenueFixIrr: Number(r?.revenue_fix_irr ?? 0),
  manualIncomeIrr: Number(r?.manual_income_irr ?? 0),
  netIrr: Number(r?.net_irr ?? 0),
});

/**
 * The edit history for a row, as a subquery.
 *
 * A lateral join rather than a query per row: fifty rows on a page would
 * otherwise be fifty-one round trips for a badge. `idx_audit_entity`
 * (`0004_payment_hub.sql:290`) is exactly this lookup, so it costs an index
 * scan each.
 */
const EDIT_HISTORY_JOIN = `
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS n,
           max(a.created_at) AS at,
           (array_agg(a.actor_email ORDER BY a.created_at DESC))[1] AS actor
      FROM audit_logs a
     WHERE a.entity_type = 'REVENUE_ADJUSTMENT'
       AND a.entity_id = ra.id::text
       AND a.action = 'revenue_adjustment.edited') edits ON true`;

const SELECT_COLUMNS = `
  ra.id, ra.amount_irr, ra.note, ra.kind, ra.category_id, ec.name AS category_name,
  ra.spent_on::text AS spent_on, ra.created_by, ra.created_at,
  ra.voided_at, ra.voided_by, ra.void_reason,
  edits.n AS edit_count,
  -- Epoch milliseconds, because that is what audit_logs.created_at is: the
  -- payment-hub tables from 0004 carry bigint timestamps while the shop's own
  -- carry timestamptz, and this row joins across that seam. A to_char() here
  -- answered 500 until the type was read off the column rather than assumed.
  edits.at AS last_edited_at,
  edits.actor AS last_edited_by`;

const FROM_LEDGER = `
  FROM revenue_adjustments ra
  LEFT JOIN expense_categories ec ON ec.id = ra.category_id
  ${EDIT_HISTORY_JOIN}`;

/** One CSV cell, quoted the way every spreadsheet agrees on. */
const csvCell = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;

const KIND_FA: Record<Kind, string> = {
  EXPENSE: 'هزینه',
  REVENUE_FIX: 'اصلاح درآمد',
  MANUAL_INCOME: 'درآمد دستی',
};

export function registerRevenueRoutes(
  app: Hono<{ Bindings: { DB: D1Database }; Variables: { identity: Ident } }>,
) {
  // --- categories ---------------------------------------------------------
  //
  // Registered BEFORE `/:id`, because Hono matches in registration order and
  // `/categories` would otherwise be read as an id and answered `invalid_id`.
  //
  // Nested under `/revenue-adjustments` rather than given a path of its own so
  // that `access.ts`'s prefix already withholds it from a READ_ONLY operator. A
  // top-level `/expense-categories` would need an entry in that list and would
  // be open until somebody remembered to add it.

  app.get('/api/v1/admin/revenue-adjustments/categories', async (c) => {
    const rows = await c.env.DB.prepare(
      `SELECT ec.id, ec.name, ec.active, ec.sort_order,
              count(ra.id)::int AS row_count
         FROM expense_categories ec
         LEFT JOIN revenue_adjustments ra
                ON ra.category_id = ec.id AND ra.voided_at IS NULL
        GROUP BY ec.id
        ORDER BY ec.sort_order, ec.name`,
    ).all<{
      id: number;
      name: string;
      active: boolean;
      sort_order: number;
      row_count: number;
    }>();
    return c.json({
      ok: true,
      items: (rows.results ?? []).map((r) => ({
        id: Number(r.id),
        name: r.name,
        active: r.active,
        sortOrder: Number(r.sort_order),
        // So «غیرفعال کردن» can say what it costs before it is pressed.
        rowCount: Number(r.row_count),
      })),
    });
  });

  app.post('/api/v1/admin/revenue-adjustments/categories', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const body = CategoryBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message }, 400);
    }

    const row = await c.env.DB.prepare(
      `INSERT INTO expense_categories (name, sort_order) VALUES (?1, ?2)
       ON CONFLICT (name) DO NOTHING RETURNING id`,
    )
      .bind(body.data.name, body.data.sortOrder ?? 50)
      .first<{ id: number }>();
    // The UNIQUE index answers this, not a SELECT first: two admins adding
    // «تبلیغات» at once would both find it missing and one would 500.
    if (!row) return c.json({ ok: false, error: 'duplicate_name' }, 409);

    await audit(c.env.DB, ident, 'expense_category.added', 'EXPENSE_CATEGORY', String(row.id),
      null, { name: body.data.name }, null);
    return c.json({ ok: true, id: Number(row.id) });
  });

  app.patch('/api/v1/admin/revenue-adjustments/categories/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const body = CategoryPatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message }, 400);
    }

    const before = await c.env.DB.prepare(
      `SELECT name, active, sort_order FROM expense_categories WHERE id = ?1`,
    )
      .bind(id)
      .first<{ name: string; active: boolean; sort_order: number }>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);

    const next = {
      name: body.data.name ?? before.name,
      active: body.data.active ?? before.active,
      sort_order: body.data.sortOrder ?? Number(before.sort_order),
    };
    await c.env.DB.prepare(
      `UPDATE expense_categories SET name = ?2, active = ?3, sort_order = ?4 WHERE id = ?1`,
    )
      .bind(id, next.name, next.active, next.sort_order)
      .run();

    await audit(c.env.DB, ident, 'expense_category.edited', 'EXPENSE_CATEGORY', String(id),
      before, next, null);
    return c.json({ ok: true });
  });

  // There is no DELETE. The foreign key is RESTRICT, so a category with rows
  // against it cannot go anyway, and one without them is a row nobody is paying
  // to keep. `active = false` takes it out of the form and leaves every past
  // expense still saying what it was for.

  // --- the ledger ---------------------------------------------------------

  app.get('/api/v1/admin/revenue-adjustments', async (c) => {
    const q = AdjustmentQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!q.success) return c.json({ ok: false, error: 'invalid_query' }, 400);

    const f = ledgerWhere(q.data);

    const total = await c.env.DB.prepare(
      `SELECT COUNT(*)::int AS n FROM revenue_adjustments ra ${f.sql}`,
    )
      .bind(...f.binds)
      .first<{ n: number }>();

    const rows = await c.env.DB.prepare(
      `SELECT ${SELECT_COLUMNS} ${FROM_LEDGER} ${f.sql}
        ORDER BY ra.spent_on DESC, ra.id DESC
        LIMIT ?${f.binds.length + 1} OFFSET ?${f.binds.length + 2}`,
    )
      .bind(...f.binds, q.data.pageSize, (q.data.page - 1) * q.data.pageSize)
      .all<AdjustmentRow>();

    /**
     * The totals over the filter, not over the page.
     *
     * A running total that changed when you turned the page would be worse than
     * no total at all — and this one is over the SAME filter the table below it
     * shows, which is the arithmetic an admin checks a screen with. Filtering
     * to «تبلیغات» must make the headline the advertising total; if the two
     * disagree, neither gets used again.
     */
    const sums = await c.env.DB.prepare(
      `SELECT ${TOTALS_SQL} FROM revenue_adjustments ra ${f.sql}`,
    )
      .bind(...f.binds)
      .first<TotalsRow>();

    /**
     * «تفکیک» — what the money went on.
     *
     * The breakdown Sam could not get anywhere: the legacy has no category and
     * neither did we, so «چه چیزی خرج شد» had no answer at all. Spending only,
     * because a category on a correction is a field nobody fills.
     */
    const byCategory = await c.env.DB.prepare(
      `SELECT ra.category_id, ec.name, count(*)::int AS n, SUM(ra.amount_irr) AS irr
         FROM revenue_adjustments ra
         LEFT JOIN expense_categories ec ON ec.id = ra.category_id
        ${f.sql}${f.sql ? ' AND' : ' WHERE'} ra.kind = 'EXPENSE'
        GROUP BY ra.category_id, ec.name
        ORDER BY SUM(ra.amount_irr) ASC`,
    )
      .bind(...f.binds)
      .all<{ category_id: number | null; name: string | null; n: number; irr: string | number }>();

    // The lifetime figures, which the whole-ledger view still wants.
    const life = await c.env.DB.prepare(
      `SELECT ${TOTALS_SQL} FROM revenue_adjustments ra WHERE ra.voided_at IS NULL`,
    ).first<TotalsRow>();

    /**
     * The same three figures over the window «آمار فروشگاه» is showing.
     *
     * That screen puts «هزینه‌ها» beside «درآمد» under one set of period
     * buttons, so the two have to be measured over the same window or the
     * subtraction between them is meaningless — a month's revenue against a
     * lifetime of costs is exactly the arithmetic that had the panel showing
     * «درآمد کل: −۶۱۶ میلیون».
     *
     * On `spent_on` since 2026-08-30. It moves nothing today (the backfill set
     * it to the Tehran day of `created_at`) and it is the right axis going
     * forward: a server bill for last month, typed today, belongs in last
     * month's total.
     */
    const rangeParam = c.req.query('range');
    let rangeTotals: (ReturnType<typeof totals> & { startMs: number; endMs: number }) | null = null;
    if (rangeParam) {
      // `rangeDay` / `rangeTo`, not `day` / `to`, because `from` and `to`
      // already mean this route's own spend-date filter. One name for two
      // windows is how a screen ends up filtering by one and totalling by the
      // other, which is the exact confusion this page exists to end.
      const bounds = statsRangeBounds(
        parseStatsRange(rangeParam),
        Date.now(),
        parseStatsDay(c.req.query('rangeDay')),
        parseStatsDay(c.req.query('rangeTo')),
      );
      if (bounds.start !== null && bounds.end !== null) {
        const win = await c.env.DB.prepare(
          `SELECT ${TOTALS_SQL} FROM revenue_adjustments ra
            WHERE ra.voided_at IS NULL
              AND ra.spent_on >= (to_timestamp(?1 / 1000.0) AT TIME ZONE 'Asia/Tehran')::date
              AND ra.spent_on <  (to_timestamp(?2 / 1000.0) AT TIME ZONE 'Asia/Tehran')::date`,
        )
          .bind(bounds.start, bounds.end)
          .first<TotalsRow>();
        rangeTotals = { startMs: bounds.start, endMs: bounds.end, ...totals(win) };
      }
    }

    return c.json({
      ok: true,
      total: total?.n ?? 0,
      page: q.data.page,
      pageSize: q.data.pageSize,
      items: (rows.results ?? []).map(shape),
      /** Over the current filter — the same rows the table shows. */
      totals: totals(sums),
      /** Over the whole ledger, whatever the filter says. */
      lifetime: totals(life),
      rangeTotals,
      byCategory: (byCategory.results ?? []).map((r) => ({
        categoryId: r.category_id === null ? null : Number(r.category_id),
        name: r.name,
        count: Number(r.n),
        irr: Number(r.irr),
      })),
    });
  });

  /**
   * The same rows, as a file.
   *
   * The whole filtered set rather than the page, which is the only reason to
   * have this at all — and capped, because a ledger export that can be asked
   * for every row of a growing table is a memory profile nobody chose.
   *
   * The BOM is not decoration: without it Excel reads a UTF-8 CSV as the local
   * codepage and every Persian note becomes mojibake.
   *
   * UNDER `/revenue-adjustments/`, NOT `/revenue-adjustments.csv`. The first
   * path this had was the second one, and it was a hole: `mayRead` in
   * `access.ts` matches a prefix as `path === p || path.startsWith(p + '/')`,
   * so a sibling ending in `.csv` matched neither and the whole of the shop's
   * spending was readable by a READ_ONLY operator — the one role that list
   * exists to keep it from. A suffix is not a child.
   */
  app.get('/api/v1/admin/revenue-adjustments/export.csv', async (c) => {
    const q = AdjustmentQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!q.success) return c.json({ ok: false, error: 'invalid_query' }, 400);

    const f = ledgerWhere(q.data);
    const rows = await c.env.DB.prepare(
      `SELECT ${SELECT_COLUMNS} ${FROM_LEDGER} ${f.sql}
        ORDER BY ra.spent_on DESC, ra.id DESC LIMIT ${EXPORT_MAX}`,
    )
      .bind(...f.binds)
      .all<AdjustmentRow>();

    const header = ['تاریخ', 'نوع', 'دسته', 'شرح', 'مبلغ (تومان)', 'ثبت‌کننده', 'وضعیت'];
    const body = (rows.results ?? []).map(shape).map((r) =>
      [
        r.spentOn,
        KIND_FA[r.kind],
        r.categoryName ?? '',
        r.note,
        // Toman, because every other figure an admin reads is Toman and a file
        // that silently switched unit is the one mistake this export can make.
        r.amountIrr / IRR_PER_TOMAN,
        r.createdBy ?? '',
        r.voidedAt ? `باطل — ${r.voidReason ?? ''}` : '',
      ]
        .map(csvCell)
        .join(','),
    );

    return c.body(`﻿${[header.map(csvCell).join(','), ...body].join('\r\n')}\r\n`, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="expenses.csv"',
    });
  });

  /**
   * What has been done to one row.
   *
   * Read out of `audit_logs` rather than a history table of its own — the same
   * choice `bulkRoutes.ts` makes. `audit_logs` is append-only in Postgres, so a
   * history assembled from it cannot be edited even by the person editing the
   * row, which is the only property that makes «who changed this» worth asking.
   */
  app.get('/api/v1/admin/revenue-adjustments/:id/history', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const rows = await c.env.DB.prepare(
      `SELECT action, actor_email, created_at, before_json, after_json, reason
         FROM audit_logs
        WHERE entity_type = 'REVENUE_ADJUSTMENT' AND entity_id = ?1
        ORDER BY created_at ASC, id ASC`,
    )
      .bind(String(id))
      .all<{
        action: string;
        actor_email: string;
        created_at: string | number;
        before_json: string | null;
        after_json: string | null;
        reason: string | null;
      }>();

    return c.json({
      ok: true,
      items: (rows.results ?? []).map((r) => ({
        action: r.action,
        actor: r.actor_email,
        at: Number(r.created_at),
        before: r.before_json === null ? null : (JSON.parse(r.before_json) as unknown),
        after: r.after_json === null ? null : (JSON.parse(r.after_json) as unknown),
        reason: r.reason,
      })),
    });
  });

  app.post('/api/v1/admin/revenue-adjustments', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const body = AdjustmentBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }

    // The one place the sign is applied. `amountToman` is validated positive, so
    // an expense is negative here and nowhere else — no caller downstream ever
    // has to decide, and no second reading of `direction` can disagree.
    const amountIrr = signedIrr(body.data.kind, body.data.amountToman, body.data.direction);

    const row = await c.env.DB.prepare(
      `INSERT INTO revenue_adjustments
         (amount_irr, note, created_by, created_at, kind, category_id, spent_on)
       VALUES (?1, ?2, ?3, now(), ?4, ?5,
               COALESCE(?6::date, (now() AT TIME ZONE 'Asia/Tehran')::date))
       RETURNING id`,
    )
      .bind(
        amountIrr,
        body.data.note,
        ident.email,
        body.data.kind,
        // Only spending has a purpose to record; a correction's category would
        // be a field nobody fills and a filter nobody trusts.
        body.data.kind === 'EXPENSE' ? (body.data.categoryId ?? null) : null,
        body.data.spentOn ?? null,
      )
      .first<{ id: number }>();
    if (!row) return c.json({ ok: false, error: 'insert_failed' }, 500);

    await audit(
      c.env.DB,
      ident,
      'revenue_adjustment.added',
      'REVENUE_ADJUSTMENT',
      String(row.id),
      null,
      { amount_irr: amountIrr, note: body.data.note, kind: body.data.kind },
      null,
    );
    return c.json({ ok: true, id: Number(row.id), amountIrr });
  });

  /**
   * An edit, with its history.
   *
   * The write and its audit row share one transaction — `adminAudit.ts` was
   * widened to take a session for exactly this case, and a money edit is that
   * case: the audit row is the only record of what the figure used to be, so a
   * change that lands without one is a change nobody can undo.
   *
   * `before`/`after` carry **only the fields that changed**, with the same key
   * set on both sides. Not the whole row: a twelve-key diff where ten keys are
   * identical is a diff nobody reads, and the row's current state is one query
   * away. Matching key sets let the screen render the history by zipping keys,
   * so a new editable field costs one label and no rendering code.
   */
  app.patch('/api/v1/admin/revenue-adjustments/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const body = EditBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message }, 400);
    }
    const patch = body.data;

    try {
      const result = await c.env.DB.withSession(async (tx) => {
        const before = await tx
          .prepare(
            `SELECT amount_irr, note, kind, category_id, spent_on::text AS spent_on, voided_at
               FROM revenue_adjustments WHERE id = ?1 FOR UPDATE`,
          )
          .bind(id)
          .first<{
            amount_irr: string | number;
            note: string;
            kind: Kind;
            category_id: number | null;
            spent_on: string;
            voided_at: string | null;
          }>();
        if (!before) return { status: 404 as const, error: 'not_found' };
        // A voided row exists; it is simply not editable. 409, not 400 — the
        // request was well formed and the state refused it.
        if (before.voided_at) return { status: 409 as const, error: 'already_voided' };

        const kind = patch.kind ?? before.kind;
        const amountIrr =
          patch.amountToman !== undefined
            ? signedIrr(
                kind,
                patch.amountToman,
                patch.direction ?? (Number(before.amount_irr) < 0 ? 'expense' : 'credit'),
              )
            : // The magnitude is unchanged but the kind may not be, and a kind
              // decides a sign. Re-applying it keeps EXPENSE → MANUAL_INCOME
              // from leaving a negative row under a kind the CHECK forbids.
              signedIrr(
                kind,
                Math.abs(Number(before.amount_irr)) / IRR_PER_TOMAN,
                Number(before.amount_irr) < 0 ? 'expense' : 'credit',
              );

        const next = {
          amount_irr: amountIrr,
          note: patch.note ?? before.note,
          kind,
          category_id:
            kind === 'EXPENSE'
              ? patch.categoryId !== undefined
                ? patch.categoryId
                : before.category_id
              : null,
          spent_on: patch.spentOn ?? before.spent_on,
        };

        const was: Record<string, unknown> = {};
        const now: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(next)) {
          const previous = key === 'amount_irr' ? Number(before.amount_irr) : (before as never)[key];
          if (previous !== value) {
            was[key] = previous;
            now[key] = value;
          }
        }
        // Nothing to do, and nothing recorded. An audit row saying a field
        // changed from a value to itself is noise in the one place that must
        // stay readable.
        if (Object.keys(now).length === 0) return { status: 200 as const, changed: false };

        await tx
          .prepare(
            `UPDATE revenue_adjustments
                SET amount_irr = ?2, note = ?3, kind = ?4, category_id = ?5, spent_on = ?6::date
              WHERE id = ?1`,
          )
          .bind(id, next.amount_irr, next.note, next.kind, next.category_id, next.spent_on)
          .run();

        await audit(tx, ident, 'revenue_adjustment.edited', 'REVENUE_ADJUSTMENT', String(id),
          was, now, patch.reason ?? null);

        return { status: 200 as const, changed: true };
      });

      if (result.status !== 200) return c.json({ ok: false, error: result.error }, result.status);
      return c.json({ ok: true, changed: result.changed });
    } catch (err) {
      // The CHECK in `revenue_adjustments_kind_sign` is the last word on
      // whether a kind may carry a sign, and it answering here means this
      // handler and the schema disagreed — a bug, not bad input.
      return c.json({ ok: false, error: 'edit_failed', detail: String(err) }, 500);
    }
  });

  /**
   * Voiding, which replaces deleting.
   *
   * The row stays in `revenue_adjustments` and leaves `shop_books`, so it drops
   * out of every total the panel shows while still being counted by
   * `verify.ts`, which asks a different question — «did the import land every
   * Rial the legacy printed» — and must keep seeing it.
   *
   * `AND voided_at IS NULL` in the statement rather than a check before it: two
   * admins pressing the button at once would otherwise both read NULL and both
   * write, and the second would overwrite the first's name and reason.
   */
  app.post('/api/v1/admin/revenue-adjustments/:id/void', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const body = VoidBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message }, 400);
    }

    const result = await c.env.DB.withSession(async (tx) => {
      const row = await tx
        .prepare(
          `UPDATE revenue_adjustments
              SET voided_at = now(), voided_by = ?2, void_reason = ?3
            WHERE id = ?1 AND voided_at IS NULL
          RETURNING amount_irr, note, kind, category_id, spent_on::text AS spent_on`,
        )
        .bind(id, ident.email, body.data.reason)
        .first<{
          amount_irr: string | number;
          note: string;
          kind: Kind;
          category_id: number | null;
          spent_on: string;
        }>();

      if (!row) {
        const exists = await tx
          .prepare(`SELECT 1 AS x FROM revenue_adjustments WHERE id = ?1`)
          .bind(id)
          .first<{ x: number }>();
        return exists
          ? { status: 409 as const, error: 'already_voided' }
          : { status: 404 as const, error: 'not_found' };
      }

      // The WHOLE row here, unlike an edit: it is leaving the books, so what
      // the history has to make reconstructable is all of it. This is also what
      // the delete it replaces recorded, so nothing an operator could look up
      // yesterday became unanswerable today.
      await audit(tx, ident, 'revenue_adjustment.voided', 'REVENUE_ADJUSTMENT', String(id),
        { ...row, amount_irr: Number(row.amount_irr) },
        { voided_by: ident.email, void_reason: body.data.reason },
        body.data.reason);

      return { status: 200 as const };
    });

    if (result.status !== 200) return c.json({ ok: false, error: result.error }, result.status);
    return c.json({ ok: true });
  });
}
