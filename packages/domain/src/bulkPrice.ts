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
 * would take to nothing.
 *
 * The floor is `<= 0`, not `< 0`. Zero passes the column's CHECK and is written
 * happily, and a plan priced at zero is not free — it is a button that can
 * never be pressed: `order.ts:221` refuses any order whose total is not
 * positive, so the plan stays listed, stays visible, and answers
 * ORDER_NOT_PAYABLE for ever. Reaching it does not take a clumsy operator: a
 * FIXED decrease equal to the price does it, and so does anything within five
 * Rial of it, because the rounding pulls it the rest of the way.
 *
 * And it is `price_irr > 0 AND next <= 0` — what the CHANGE would make
 * unsellable, not what already is. The catalogue really does carry a plan
 * priced at zero today («اکانت تست - ۱ روزه - ۱ گیگ», ACTIVE), and a bare
 * `next <= 0` counts it on every pass: a ten per cent RISE would be refused
 * because one plan that is already zero stays zero. The first version of this
 * fix did exactly that, and Playwright caught it on the increase scenario —
 * which is the whole argument for walking the screen instead of reasoning
 * about it. That plan is worth an operator's attention on its own; it is not
 * this function's to refuse.
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
  /**
   * Plans the change would leave unsellable — zero or below. Any at all
   * refuses the whole apply.
   */
  unsellable: number;
  /** Plans whose price would not move — a percentage too small to round up. */
  unchanged: number;
  /** A handful of real rows, so the operator reads prices rather than a delta. */
  examples: BulkPriceExample[];
}

/**
 * How many examples the preview carries, and from which end.
 *
 * Enough to see the shape of the change across a panel, few enough that the
 * confirmation screen stays one glance. The cheapest and the dearest are what
 * an operator checks — and until 2026-08-21 this was a single `ORDER BY price
 * LIMIT 5` while the comment above it claimed both ends. Every example was the
 * cheapest five, which are also exactly the rows a percentage change is most
 * likely to round to nothing: systematically the least representative sample
 * the query could have returned, described as the most.
 */
const EXAMPLES_CHEAPEST = 3;
const EXAMPLES_DEAREST = 2;

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
 * What the CHANGE would make unsellable — not what already is.
 *
 * A plan the shop already prices at zero is not this function's business: it
 * was that way before the operator pressed anything, and refusing every future
 * repricing because of it would be a permanent lock with no way out from this
 * screen. `price_irr > 0` is what makes the difference, and leaving it out cost
 * a Playwright run on the INCREASE scenario — a ten per cent rise refused
 * because one already-free plan stayed free.
 */
function unsellableSql(next: string): string {
  return `(pl.price_irr > 0 AND ${next} <= 0)`;
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
export async function previewBulkPrice(db: Db, change: BulkPriceChange): Promise<BulkPricePreview> {
  const next = newPriceSql(change);
  const unsellable = unsellableSql(next);
  const row = await db
    .prepare(
      `SELECT count(*)::int                                        AS plans,
              COALESCE(sum(pl.price_irr), 0)                       AS current_total,
              COALESCE(sum(GREATEST(${next}, 0)), 0)               AS new_total,
              count(*) FILTER (WHERE ${unsellable})::int          AS unsellable,
              count(*) FILTER (WHERE ${next} = pl.price_irr)::int  AS unchanged
       ${SCOPE}`,
    )
    .bind(change.providerId, change.amount)
    .first<{
      plans: number;
      current_total: number;
      new_total: number;
      unsellable: number;
      unchanged: number;
    }>();

  // Both ends, in two statements rather than one clever one. A UNION would have
  // to carry the whole scope and the price expression twice, for a query that
  // runs once per button press on an admin screen.
  const end = async (
    direction: 'ASC' | 'DESC',
    take: number,
  ): Promise<{ id: number; name: string; from_irr: number; to_irr: number }[]> => {
    const page = await db
      .prepare(
        `SELECT pl.id, pl.name, pl.price_irr AS from_irr, ${next} AS to_irr
         ${SCOPE}
         ORDER BY pl.price_irr ${direction}, pl.id ${direction}
         LIMIT ?3`,
      )
      .bind(change.providerId, change.amount, take)
      .all<{ id: number; name: string; from_irr: number; to_irr: number }>();
    return page.results ?? [];
  };
  const [cheapest, dearest] = await Promise.all([
    end('ASC', EXAMPLES_CHEAPEST),
    end('DESC', EXAMPLES_DEAREST),
  ]);
  // A panel with four plans would otherwise show one of them twice. Deduped on
  // the id, because nothing makes a plan name unique.
  const seen = new Set<number>();
  const results = [...cheapest, ...dearest]
    .filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    })
    .sort((a, b) => Number(a.from_irr) - Number(b.from_irr));

  return {
    plans: row?.plans ?? 0,
    currentTotalIrr: Number(row?.current_total ?? 0),
    newTotalIrr: Number(row?.new_total ?? 0),
    unsellable: row?.unsellable ?? 0,
    unchanged: row?.unchanged ?? 0,
    examples: (results ?? []).map((r) => ({
      name: r.name,
      fromIrr: Number(r.from_irr),
      toIrr: Number(r.to_irr),
    })),
  };
}

/** One plan that moved, with both prices, so the change can be read back. */
export interface BulkPriceMove {
  planId: number;
  name: string;
  fromIrr: number;
  toIrr: number;
}

export type BulkPriceOutcome =
  | { ok: true; changed: number; replayed: boolean }
  | { ok: false; reason: 'unsellable'; plans: number }
  | { ok: false; reason: 'nothing_to_change' };

/**
 * What has to happen in the same transaction as the write, and once.
 *
 * `id` is the operation, chosen by whoever drew the confirmation screen and
 * held constant across every retry of it. `record` writes the audit row under
 * that id, so the primary key IS the evidence that the operation already ran —
 * no second table, and nothing to keep in step with the first.
 */
export interface BulkPriceOperation {
  id: string;
  record: (tx: D1DatabaseSession, moved: BulkPriceMove[]) => Promise<void>;
}

/**
 * Applies the change once, or refuses it whole.
 *
 * ## Why this is an operation and not a statement
 *
 * A price change compounds. Two deliveries of "up 10%" are not 10% twice, they
 * are 21% — and a lost response is enough to produce them: the operator presses
 * confirm, the reply dies on a flaky link, they press again. Nothing about the
 * result tells them it happened twice, and there is no undo:
 * `round(x / 10) * 10` is lossy, so "down 16.67%" does not put back what "up
 * 20%" took. It was the one irreversible action on this screen and the only one
 * with no key, while the credit and broadcast routes beside it both had one.
 *
 * So: the transaction takes an advisory lock on the operation id, looks for the
 * audit row that id would have written, and if it is there returns what
 * happened the first time. The lock is what makes two SIMULTANEOUS retries
 * safe; without it both would look, both would see nothing, and both would
 * write. It is held for the transaction and released by COMMIT.
 *
 * ## Why the audit row is written here rather than after
 *
 * It used to be a third statement in the route, outside any transaction, after
 * the write it describes. So a crash between them left prices moved with no
 * record of what they had been — and that record is the only thing that could
 * ever put them back. Now the rows that moved are returned by the UPDATE itself
 * (`sub` still holds the old price, which `RETURNING` can read) and written
 * with them, or neither happens.
 *
 * The refusal is still checked inside the writing statement rather than by
 * asking first: two operators repricing one panel at the same moment would
 * otherwise both read "none would go under" and the second would write a price
 * the first has already made small.
 *
 * Returns the number of rows actually written, which is not the number of plans
 * in scope: a percentage too small to move a cheap plan by a whole Toman leaves
 * it alone, and saying "12 changed" when 3 did would be a lie the operator has
 * no way to check.
 */
export async function applyBulkPrice(
  db: D1Database,
  change: BulkPriceChange,
  operation: BulkPriceOperation,
): Promise<BulkPriceOutcome> {
  const next = newPriceSql(change);
  const unsellable = unsellableSql(next);

  return db.withSession(async (tx) => {
    // Held until COMMIT. Two retries of one operation arriving together would
    // otherwise both find no audit row and both write.
    await tx.prepare(`SELECT pg_advisory_xact_lock(hashtext(?1))`).bind(operation.id).run();

    const already = await tx
      .prepare(`SELECT after_json FROM audit_logs WHERE id = ?1`)
      .bind(operation.id)
      .first<{ after_json: string | null }>();
    if (already) {
      // Answered from what the first attempt wrote, not by doing it again.
      const changed = Number(
        (JSON.parse(already.after_json ?? '{}') as { changed?: number }).changed ?? 0,
      );
      return { ok: true, changed, replayed: true };
    }

    const written = await tx
      .prepare(
        `UPDATE product_plans t
            SET price_irr = sub.next_price::bigint,
                updated_at = now()
           FROM (SELECT pl.id, pl.name, pl.price_irr AS was, ${next} AS next_price ${SCOPE}) sub
          WHERE t.id = sub.id
            AND sub.next_price <> t.price_irr
            AND NOT EXISTS (SELECT 1 FROM (SELECT 1 AS one ${SCOPE} AND ${unsellable}) chk)
      RETURNING sub.id AS plan_id, sub.name, sub.was, sub.next_price`,
      )
      .bind(change.providerId, change.amount)
      .all<{ plan_id: number; name: string; was: number; next_price: number }>();

    const moved: BulkPriceMove[] = (written.results ?? []).map((r) => ({
      planId: Number(r.plan_id),
      name: r.name,
      fromIrr: Number(r.was),
      toIrr: Number(r.next_price),
    }));

    if (moved.length > 0) {
      await operation.record(tx, moved);

      return { ok: true, changed: moved.length, replayed: false };
    }

    // Nothing was written, and the two reasons are not the same thing to an
    // operator: one is "your change is impossible", the other is "your change
    // was too small to matter". Asked only on the empty path, so the ordinary
    // case pays for one statement. Neither writes an audit row — a refusal is
    // not an operation that happened, so pressing again must be allowed to.
    const blocked = await tx
      .prepare(`SELECT count(*)::int AS n ${SCOPE} AND ${unsellable}`)
      .bind(change.providerId, change.amount)
      .first<{ n: number }>();
    return (blocked?.n ?? 0) > 0
      ? { ok: false, reason: 'unsellable' as const, plans: blocked!.n }
      : { ok: false, reason: 'nothing_to_change' as const };
  });
}
