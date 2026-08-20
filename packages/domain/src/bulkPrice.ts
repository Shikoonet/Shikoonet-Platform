/**
 * Moving every price on a panel at once.
 *
 * Parity with `admin.php:7586` («⬆️ افزایش گروهی قیمت») and `:7641`
 * («⬇️ کاهش گروهی قیمت»), with four of the legacy's own defects left behind.
 *
 * ## What the legacy asks that we do not
 *
 * Its second step is "which user group?" — `product.agent`, one of `f`, `n`,
 * `n2`. In the production dump **all 21 products are `f`**, so two of the three
 * buttons answer `err_notfound_price_change` every time they are pressed. Our
 * schema collapsed that column into `products.resellers_only` and the filter is
 * one WHERE clause away if a reseller-only product is ever created; building
 * the selector now would be a control for a set that is always empty.
 *
 * ## The four defects
 *
 * **A decrease had no floor.** `price_product - amount` with nothing clamping
 * it: subtract 100,000 from a 50,000 plan and the shop sells at -50,000. Our
 * column has `CHECK (price_irr >= 0)`, so the statement would abort — which
 * turns a silent mispricing into a failed batch, better but still not an
 * answer. So the change is refused BEFORE it runs, naming how many plans it
 * would take under zero.
 *
 * **A decrease could not be a percentage.** The legacy offers percent/fixed on
 * the way up and fixed only on the way down, for no reason anybody wrote down.
 * Both directions take both here.
 *
 * **The decrease looped in PHP**, one UPDATE per product, so a crash halfway
 * left half the panel repriced. One statement.
 *
 * **Nothing showed the operator what would happen.** A bulk price change is the
 * kind of mistake that is invisible until a customer pays the wrong number, and
 * an extra zero is unmissable in a total. `previewBulkPrice` and
 * `applyBulkPrice` build their arithmetic from THE SAME expression, because a
 * preview computed a second way is a preview that can lie.
 *
 * ## Rounding
 *
 * To the nearest whole Toman, which is 10 IRR. Measured rather than assumed:
 * every `product_plans.price_irr` in the simulation is already a multiple of
 * 10, and money in this platform is Toman at the edge times ten. A percentage
 * change is the only thing that can produce a price no customer could be quoted
 * cleanly, and this is where it is put back.
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';

type Db = D1Database | D1DatabaseSession;

export type PriceMode = 'PERCENT' | 'FIXED';
export type PriceDirection = 'UP' | 'DOWN';

export interface BulkPriceChange {
  /** One panel, or null for every panel the shop sells from. */
  providerId: number | null;
  mode: PriceMode;
  direction: PriceDirection;
  /** IRR when `mode` is FIXED; whole percent when it is PERCENT. */
  amount: number;
}

export interface BulkPriceExample {
  name: string;
  fromIrr: number;
  toIrr: number;
}

export interface BulkPricePreview {
  /** Plans the change would touch. */
  plans: number;
  currentTotalIrr: number;
  newTotalIrr: number;
  /** Plans the change would take below zero. Any at all refuses the apply. */
  belowZero: number;
  /** Plans whose price would not move — a percentage too small to round up. */
  unchanged: number;
  /** A handful of real rows, so the operator reads prices rather than a delta. */
  examples: BulkPriceExample[];
}

/**
 * How many examples the preview carries.
 *
 * Enough to see the shape of the change across a panel, few enough that the
 * confirmation screen stays one glance. The cheapest and the dearest are what
 * an operator checks, so the ordering below puts both in reach.
 */
const EXAMPLES = 5;

/**
 * The one place the new price is defined.
 *
 * Returned as SQL rather than computed in TypeScript so that the preview, the
 * count of plans that would go negative, and the UPDATE are literally the same
 * arithmetic. `?2` is the amount in both branches; the mode decides what it
 * means and the direction decides its sign.
 *
 * `numeric` throughout, then rounded once at the end: `price_irr` is bigint and
 * integer division would silently floor every percentage.
 */
function newPriceSql(change: BulkPriceChange): string {
  const signed = change.direction === 'UP' ? '+' : '-';
  const raw =
    change.mode === 'FIXED'
      ? `pl.price_irr::numeric ${signed} ?2::numeric`
      : `pl.price_irr::numeric * ((100::numeric ${signed} ?2::numeric) / 100::numeric)`;
  // To the nearest whole Toman. A price that is not a whole number of Toman
  // cannot be quoted to a customer or matched against a bank SMS, both of
  // which speak Toman.
  return `(round((${raw}) / 10::numeric) * 10)`;
}

/**
 * The plans a change applies to.
 *
 * Only what the shop can actually sell: a DISABLED plan or a HIDDEN product is
 * not part of the price list, and moving its price would be a surprise waiting
 * for whoever turns it back on.
 *
 * `?1` is the provider id, and a NULL means every panel — written as an OR
 * rather than two query strings so there is one WHERE clause to be right.
 */
const SCOPE = `
    FROM product_plans pl
    JOIN products p ON p.id = pl.product_id
   WHERE pl.status = 'ACTIVE'
     AND p.status = 'ACTIVE'
     AND (?1::bigint IS NULL OR p.provider_id = ?1)`;

/** What the change would do, without doing it. */
export async function previewBulkPrice(
  db: Db,
  change: BulkPriceChange,
): Promise<BulkPricePreview> {
  const next = newPriceSql(change);
  const row = await db
    .prepare(
      `SELECT count(*)::int                                        AS plans,
              COALESCE(sum(pl.price_irr), 0)                       AS current_total,
              COALESCE(sum(GREATEST(${next}, 0)), 0)               AS new_total,
              count(*) FILTER (WHERE ${next} < 0)::int             AS below_zero,
              count(*) FILTER (WHERE ${next} = pl.price_irr)::int  AS unchanged
       ${SCOPE}`,
    )
    .bind(change.providerId, change.amount)
    .first<{
      plans: number;
      current_total: number;
      new_total: number;
      below_zero: number;
      unchanged: number;
    }>();

  const { results } = await db
    .prepare(
      `SELECT pl.name, pl.price_irr AS from_irr, ${next} AS to_irr
       ${SCOPE}
       ORDER BY pl.price_irr
       LIMIT ?3`,
    )
    .bind(change.providerId, change.amount, EXAMPLES)
    .all<{ name: string; from_irr: number; to_irr: number }>();

  return {
    plans: row?.plans ?? 0,
    currentTotalIrr: Number(row?.current_total ?? 0),
    newTotalIrr: Number(row?.new_total ?? 0),
    belowZero: row?.below_zero ?? 0,
    unchanged: row?.unchanged ?? 0,
    examples: (results ?? []).map((r) => ({
      name: r.name,
      fromIrr: Number(r.from_irr),
      toIrr: Number(r.to_irr),
    })),
  };
}

export type BulkPriceOutcome =
  | { ok: true; changed: number }
  | { ok: false; reason: 'below_zero'; plans: number }
  | { ok: false; reason: 'nothing_to_change' };

/**
 * Applies the change, or refuses it whole.
 *
 * The refusal is checked inside the same statement that would write, not by
 * asking first: two operators repricing one panel at the same moment would
 * otherwise both read "none would go negative" and the second would write a
 * price the first has already made small. `NOT EXISTS` here is evaluated
 * against the same snapshot the UPDATE runs in.
 *
 * Returns the number of rows actually written, which is not the number of
 * plans in scope: a percentage too small to move a cheap plan by a whole Toman
 * leaves it alone, and saying "12 changed" when 3 did would be a lie the
 * operator has no way to check.
 */
export async function applyBulkPrice(db: Db, change: BulkPriceChange): Promise<BulkPriceOutcome> {
  const next = newPriceSql(change);
  const result = await db
    .prepare(
      `UPDATE product_plans t
          SET price_irr = sub.next_price::bigint,
              updated_at = now()
         FROM (SELECT pl.id, ${next} AS next_price ${SCOPE}) sub
        WHERE t.id = sub.id
          AND sub.next_price <> t.price_irr
          AND NOT EXISTS (SELECT 1 FROM (SELECT ${next} AS n ${SCOPE}) chk WHERE chk.n < 0)`,
    )
    .bind(change.providerId, change.amount)
    .run();

  if (result.meta.changes > 0) return { ok: true, changed: result.meta.changes };

  // Nothing was written, and the two reasons are not the same thing to an
  // operator: one is "your change is impossible", the other is "your change
  // was too small to matter". Asked only on the empty path, so the ordinary
  // case pays for one statement.
  const blocked = await db
    .prepare(`SELECT count(*)::int AS n ${SCOPE} AND ${next} < 0`)
    .bind(change.providerId, change.amount)
    .first<{ n: number }>();
  return (blocked?.n ?? 0) > 0
    ? { ok: false, reason: 'below_zero', plans: blocked!.n }
    : { ok: false, reason: 'nothing_to_change' };
}
