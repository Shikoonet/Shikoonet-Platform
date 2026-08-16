/**
 * هزینه‌ها و تعدیل‌ها — the shop's costs and the corrections to its income
 * figure.
 *
 * `revenue_adjustments` arrived with `0005_ops.sql` and the migration has been
 * importing it ever since, and until now **nothing in this platform read or
 * wrote a single row of it.** 136 real entries — 99 costs and 37 credits over
 * five weeks — would have landed in Postgres on cutover day and become
 * invisible. This is the screen behind them.
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
 * ## The sign is the whole design
 *
 * A cost is a negative row. There is no `type` column and no `kind`, because
 * the legacy one is a label rather than the sign — its `amount` is already
 * signed, and the one place that treated `type` as authoritative was an
 * importer branch that never ran. The form asks for a positive amount and a
 * direction, and applies the sign here, at the edge, once.
 *
 * ## Deletion is real, and that is deliberate
 *
 * `audit_logs` is append-only and `wallet_entries` is append-only, because both
 * are records of things that happened to somebody else's money. This is not:
 * it is the admin's own note about the shop's own books, and an entry typed
 * with a slipped digit needs to be gone rather than corrected by a second entry
 * that also has to be explained. The legacy panel deletes too. Every deletion
 * is written to `audit_logs` with the amount and the note that went with it, so
 * removing a row from the ledger cannot remove it from the history.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import { audit, type Ident } from './adminAudit.js';

/**
 * The largest single adjustment, in Toman.
 *
 * Ten billion — roughly thirteen times the largest deduction in five weeks of
 * production. Not a policy, a fat-finger guard: the failure this stops is a
 * pasted digit, and the shop's own reporting is the only thing downstream.
 */
const MAX_ADJUSTMENT_TOMAN = 10_000_000_000;

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
    direction: z.enum(['expense', 'credit']),
    // Required, like the legacy form. An unexplained line in the books is the
    // one thing nobody can reconstruct later.
    note: z.string().trim().min(1).max(500),
  })
  .strict();

const AdjustmentQuery = z.object({
  direction: z.enum(['expense', 'credit']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** Toman in, IRR out — the project's one conversion, at the edge, once. */
const IRR_PER_TOMAN = 10;

interface AdjustmentRow {
  id: number;
  amount_irr: string | number;
  note: string;
  created_by: string | null;
  created_at: string;
}

function shape(r: AdjustmentRow) {
  return {
    id: Number(r.id),
    amountIrr: Number(r.amount_irr),
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

export function registerRevenueRoutes(
  app: Hono<{ Bindings: { DB: D1Database }; Variables: { identity: Ident } }>,
) {
  app.get('/api/v1/admin/revenue-adjustments', async (c) => {
    const q = AdjustmentQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!q.success) return c.json({ ok: false, error: 'invalid_query' }, 400);

    const clause =
      q.data.direction === undefined
        ? ''
        : ` WHERE amount_irr ${q.data.direction === 'expense' ? '<' : '>'} 0`;

    const total = await c.env.DB.prepare(
      `SELECT COUNT(*)::int AS n FROM revenue_adjustments${clause}`,
    ).first<{ n: number }>();

    const rows = await c.env.DB.prepare(
      `SELECT id, amount_irr, note, created_by, created_at
         FROM revenue_adjustments${clause}
        ORDER BY created_at DESC, id DESC
        LIMIT ?1 OFFSET ?2`,
    )
      .bind(q.data.pageSize, (q.data.page - 1) * q.data.pageSize)
      .all<AdjustmentRow>();

    // Over the whole ledger, never over the page — a running total that changed
    // when you turned the page would be worse than no total at all. Split in
    // one pass so "what did we spend" and "what came back" are separate numbers
    // rather than a net that hides both.
    const sums = await c.env.DB.prepare(
      `SELECT COALESCE(SUM(amount_irr) FILTER (WHERE amount_irr < 0), 0) AS expenses_irr,
              COALESCE(SUM(amount_irr) FILTER (WHERE amount_irr > 0), 0) AS credits_irr,
              COALESCE(SUM(amount_irr), 0) AS net_irr
         FROM revenue_adjustments`,
    ).first<{ expenses_irr: string | number; credits_irr: string | number; net_irr: string | number }>();

    return c.json({
      ok: true,
      total: total?.n ?? 0,
      page: q.data.page,
      pageSize: q.data.pageSize,
      items: (rows.results ?? []).map(shape),
      totals: {
        expensesIrr: Number(sums?.expenses_irr ?? 0),
        creditsIrr: Number(sums?.credits_irr ?? 0),
        netIrr: Number(sums?.net_irr ?? 0),
      },
    });
  });

  app.post('/api/v1/admin/revenue-adjustments', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const body = AdjustmentBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message }, 400);
    }

    // The one place the sign is applied. `amountToman` is validated positive, so
    // an expense is negative here and nowhere else — no caller downstream ever
    // has to decide, and no second reading of `direction` can disagree.
    const magnitudeIrr = body.data.amountToman * IRR_PER_TOMAN;
    const amountIrr = body.data.direction === 'expense' ? -magnitudeIrr : magnitudeIrr;

    const row = await c.env.DB.prepare(
      `INSERT INTO revenue_adjustments (amount_irr, note, created_by, created_at)
       VALUES (?1, ?2, ?3, now())
       RETURNING id`,
    )
      .bind(amountIrr, body.data.note, ident.email)
      .first<{ id: number }>();
    if (!row) return c.json({ ok: false, error: 'insert_failed' }, 500);

    await audit(
      c.env.DB,
      ident,
      'revenue_adjustment.added',
      'REVENUE_ADJUSTMENT',
      String(row.id),
      null,
      { amount_irr: amountIrr, note: body.data.note },
      null,
    );
    return c.json({ ok: true, id: Number(row.id), amountIrr });
  });

  app.delete('/api/v1/admin/revenue-adjustments/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    // `RETURNING` rather than a read followed by a delete: the row's own values
    // are what the audit entry has to carry, and reading them first leaves a
    // window where two admins both believe they removed it and only one entry
    // records what was in it.
    const gone = await c.env.DB.prepare(
      `DELETE FROM revenue_adjustments WHERE id = ?1 RETURNING amount_irr, note`,
    )
      .bind(id)
      .first<{ amount_irr: string | number; note: string }>();
    if (!gone) return c.json({ ok: false, error: 'not_found' }, 404);

    // The whole row, into a table that cannot be deleted from. Removing a line
    // from the ledger must not remove it from the history.
    await audit(
      c.env.DB,
      ident,
      'revenue_adjustment.deleted',
      'REVENUE_ADJUSTMENT',
      String(id),
      { amount_irr: Number(gone.amount_irr), note: gone.note },
      null,
      null,
    );
    return c.json({ ok: true });
  });
}
