/**
 * «سود و زیان» — what the shop made in a window, per service, and per partner.
 *
 * Sam, 2026-09-22: «سرویس الماس چقدر فروخته، چقدر برایش خرج کردیم (تبلیغات و
 * سرور و …)، و در آخر چقدر سود ساخته؟» and «سه نفریم و ماهیانه سود برمی‌داریم —
 * معلوم است من چقدر گرفتم؟ شریکام چقدر؟».
 *
 * ## The statement, top to bottom
 *
 *     فروش                       orders, COMPLETED, the four sale kinds (`salesByService`)
 *   + اصلاح درآمد و درآمد دستی   the ledger's REVENUE_FIX and MANUAL_INCOME
 *   − هدیهٔ کیف پول               referral commission, renewal cashback, gift codes,
 *                                the wheel: credit the shop handed out, which the
 *                                customer then spends as if it were paid money
 *   − هزینه‌ها                    the ledger's EXPENSE rows, with the bank's fee
 *   = سود                        what there is to divide
 *   − برداشت شرکا                PARTNER_DRAW — outside the profit, never inside it
 *   = ماندهٔ سود
 *
 * The draw is the line the old screen got wrong: it filed 680 million Toman of
 * partner withdrawals as «هزینه», so there was no figure the panel could call
 * «سود» at all. A draw is the profit being divided; subtracting it before the
 * profit is known answers «how much is left» and calls it «how much we made».
 *
 * ## A cost for a category or a panel is spread by sales
 *
 * An expense names one level of the catalogue or none (0092): a service
 * («الماس») takes it whole; a category («V2ray») or a panel (the server) is
 * split over ITS services in proportion to what each sold in the same window;
 * none is the whole shop and is not split at all — it is shown once, as
 * «هزینهٔ مشترک», under the services. Spreading rent over services by sales
 * would print a precise-looking number that is only a guess.
 *
 * A category or panel whose services sold nothing in the window splits evenly,
 * so the cost stays on the services it was for rather than vanishing. One
 * with no service at all has nowhere to go and is listed as it is.
 *
 * The split is in whole Rial by largest remainder, so the shares add back to
 * the expense exactly — the check `shop-profit.test.ts` makes against the
 * ledger's own total.
 *
 * ## Fees on a draw
 *
 * A draw is what left the account, fee included, the same arithmetic as an
 * expense (`amount_irr − fee_irr`, revenueRoutes `TOTALS_SQL`). The fee on a
 * transfer to a partner is a few thousand Toman, and one figure that means the
 * same on «هزینه‌ها» and here is worth more than moving it to «کارمزد».
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';
import { LEGACY_SERVICE_NAME, ORDER_PRODUCT_JOINS, salesByService } from './shopReport.js';
import { booksStartMs } from './books.js';
import { sinceBooks, statsRangeBounds, type StatsRange } from './statsRange.js';

type Db = D1Database | D1DatabaseSession;

/** Wallet credits the shop gave away. `ADMIN_ADJUST` is an operator moving a balance, not a gift. */
export const GIFT_WALLET_KINDS = ['REFERRAL_BONUS', 'RENEWAL_CASHBACK', 'GIFT_CODE', 'WHEEL_PRIZE'] as const;

export interface ServiceProfit {
  /** null is the one bucket of imported orders that name no service. */
  productId: number | null;
  name: string;
  categoryName: string | null;
  revenueIrr: number;
  /** Expenses named for this service, or its share of its category's and panel's. */
  expensesIrr: number;
  /** Commission and cashback paid on this service's orders. */
  giftsIrr: number;
  profitIrr: number;
  /** Profit over revenue, percent to two places; null when nothing was sold. */
  marginPercent: number | null;
}

export interface PartnerShare {
  partyId: number;
  name: string;
  sharePercent: number | null;
  /** His percent of `profitIrr`. Negative when the window lost money. */
  shareIrr: number;
  drawnIrr: number;
  /** Share minus drawn: positive is owed to him, negative is taken ahead of profit. */
  balanceIrr: number;
}

export interface ShopProfit {
  range: StatsRange;
  startMs: number | null;
  endMs: number | null;
  /** The fresh start; nothing before it is in any figure below (`sinceBooks`). */
  booksStartMs: number | null;

  salesIrr: number;
  revenueFixIrr: number;
  manualIncomeIrr: number;
  /** The three above. */
  revenueIrr: number;
  giftsIrr: number;
  /** Positive: every EXPENSE row in the window, with its fee. */
  expensesIrr: number;
  /** Of `giftsIrr`, what no order carries — a gift code, the wheel. Not on any service. */
  sharedGiftsIrr: number;
  /** Of `expensesIrr`, the part named for a service, a category or a panel. */
  serviceExpensesIrr: number;
  /** The rest — named for nothing, the whole shop's. */
  sharedExpensesIrr: number;
  /** revenue − gifts − expenses. */
  profitIrr: number;
  drawsIrr: number;
  /** profit − draws. */
  retainedIrr: number;

  services: ServiceProfit[];
  /** A category or panel cost with no service under it. Counted in `serviceExpensesIrr`. */
  unallocated: Array<{ name: string; irr: number }>;
  partners: PartnerShare[];
  /** What the partners' percents leave undivided. */
  undividedPercent: number;
}

/**
 * `total` split in proportion to `weights`, in whole units, summing to `total`.
 *
 * Largest remainder: floor every share, then hand the leftover units one by
 * one to the largest fractional parts (ties to the earlier index, so the
 * answer does not depend on sort stability). All-zero weights split evenly.
 */
export function allocate(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const w = weights.some((x) => x > 0) ? weights.map((x) => Math.max(0, x)) : weights.map(() => 1);
  const sum = w.reduce((a, b) => a + b, 0);
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const raw = w.map((x) => (abs * x) / sum);
  const out = raw.map(Math.floor);
  let left = abs - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k]!.i]! += 1;
  return out.map((x) => x * sign);
}

/** The Tehran-day window over `spent_on`, the same one «هزینه‌ها» totals over. */
function spentOnClause(bounds: { start: number | null; end: number | null }, first: number) {
  if (bounds.start === null || bounds.end === null) return { sql: '', binds: [] as number[] };
  return {
    sql: ` AND spent_on >= (to_timestamp(?${first} / 1000.0) AT TIME ZONE 'Asia/Tehran')::date
           AND spent_on <  (to_timestamp(?${first + 1} / 1000.0) AT TIME ZONE 'Asia/Tehran')::date`,
    binds: [bounds.start, bounds.end],
  };
}

const pct = (part: number, whole: number) => Math.round((part / whole) * 10000) / 100;

export async function shopProfit(
  db: Db,
  range: StatsRange,
  nowMs = Date.now(),
  day?: string | null,
  to?: string | null,
): Promise<ShopProfit> {
  const booksStart = await booksStartMs(db);
  const bounds = sinceBooks(statsRangeBounds(range, nowMs, day, to), booksStart, nowMs);
  const spent = spentOnClause(bounds, 1);
  const gifted =
    bounds.start === null || bounds.end === null
      ? { sql: '', binds: [] as number[] }
      : {
          sql: ` AND we.created_at >= to_timestamp(?1 / 1000.0) AND we.created_at < to_timestamp(?2 / 1000.0)`,
          binds: [bounds.start, bounds.end],
        };

  const [sales, products, ledger, scoped, gifts, partners] = await Promise.all([
    salesByService(db, bounds),

    db
      .prepare(
        `SELECT p.id, p.name, p.category_id, p.provider_id, pc.name AS category_name
           FROM products p LEFT JOIN product_categories pc ON pc.id = p.category_id`,
      )
      .all<{ id: number; name: string; category_id: number | null; provider_id: number | null; category_name: string | null }>(),

    db
      .prepare(
        `SELECT
           COALESCE(SUM(amount_irr) FILTER (WHERE kind = 'REVENUE_FIX'), 0)            AS fix_irr,
           COALESCE(SUM(amount_irr) FILTER (WHERE kind = 'MANUAL_INCOME'), 0)          AS manual_irr,
           COALESCE(SUM(fee_irr - amount_irr) FILTER (WHERE kind = 'EXPENSE'), 0)      AS expense_irr,
           COALESCE(SUM(fee_irr - amount_irr) FILTER (WHERE kind = 'PARTNER_DRAW'), 0) AS draw_irr
           FROM shop_books WHERE true${spent.sql}`,
      )
      .bind(...spent.binds)
      .first<{ fix_irr: string | number; manual_irr: string | number; expense_irr: string | number; draw_irr: string | number }>(),

    // Expenses named for part of the catalogue, one row per level and id.
    db
      .prepare(
        `SELECT product_category_id, product_id, provider_id, SUM(fee_irr - amount_irr) AS irr
           FROM shop_books
          WHERE kind = 'EXPENSE'
            AND num_nonnulls(product_category_id, product_id, provider_id) = 1${spent.sql}
          GROUP BY product_category_id, product_id, provider_id`,
      )
      .bind(...spent.binds)
      .all<{ product_category_id: number | null; product_id: number | null; provider_id: number | null; irr: string | number }>(),

    // Resolved to a service the same way a sale is (`ORDER_PRODUCT_JOINS`).
    // A gift code names no order.
    db
      .prepare(
        `SELECT p.id AS product_id, (we.order_id IS NULL) AS orderless, COALESCE(SUM(we.amount_irr), 0) AS irr
           FROM wallet_entries we
           LEFT JOIN orders o ON o.id = we.order_id
           ${ORDER_PRODUCT_JOINS}
          WHERE we.kind IN (${GIFT_WALLET_KINDS.map((k) => `'${k}'`).join(',')})${gifted.sql}
          GROUP BY p.id, (we.order_id IS NULL)`,
      )
      .bind(...gifted.binds)
      .all<{ product_id: number | null; orderless: boolean; irr: string | number }>(),

    // Every partner, archived ones too when they drew in the window: a
    // partner who left still took what he took.
    db
      .prepare(
        `SELECT pa.id, pa.name, pa.share_percent, pa.active,
                COALESCE(SUM(b.fee_irr - b.amount_irr) FILTER (WHERE b.kind = 'PARTNER_DRAW'), 0) AS drawn_irr
           FROM parties pa
           LEFT JOIN shop_books b ON b.party_id = pa.id AND b.kind = 'PARTNER_DRAW'${spent.sql.replaceAll('spent_on', 'b.spent_on')}
          WHERE 'PARTNER' = ANY(pa.roles)
          GROUP BY pa.id
          ORDER BY pa.name`,
      )
      .bind(...spent.binds)
      .all<{ id: number; name: string; share_percent: string | number | null; active: boolean; drawn_irr: string | number }>(),
  ]);

  const catalogue = (products.results ?? []).map((p) => ({
    id: Number(p.id),
    name: p.name,
    categoryId: p.category_id === null ? null : Number(p.category_id),
    providerId: p.provider_id === null ? null : Number(p.provider_id),
    categoryName: p.category_name,
  }));
  const revenueOf = new Map<number, number>();
  for (const s of sales) if (s.productId !== null) revenueOf.set(s.productId, s.irr);

  const expenseOf = new Map<number, number>();
  const add = (m: Map<number, number>, id: number, irr: number) => m.set(id, (m.get(id) ?? 0) + irr);
  const unallocated: Array<{ name: string; irr: number }> = [];

  // Names for a level with no service under it — read only when needed.
  const levelName = async (table: 'product_categories' | 'provisioning_providers' | 'products', id: number) =>
    (await db.prepare(`SELECT name FROM ${table} WHERE id = ?1`).bind(id).first<{ name: string }>())?.name ?? `#${id}`;

  let serviceExpensesIrr = 0;
  for (const row of scoped.results ?? []) {
    const irr = Number(row.irr);
    serviceExpensesIrr += irr;
    if (row.product_id !== null) {
      const id = Number(row.product_id);
      if (catalogue.some((p) => p.id === id)) add(expenseOf, id, irr);
      else unallocated.push({ name: await levelName('products', id), irr });
      continue;
    }
    const members =
      row.product_category_id !== null
        ? catalogue.filter((p) => p.categoryId === Number(row.product_category_id))
        : catalogue.filter((p) => p.providerId === Number(row.provider_id));
    if (members.length === 0) {
      unallocated.push({
        name:
          row.product_category_id !== null
            ? await levelName('product_categories', Number(row.product_category_id))
            : await levelName('provisioning_providers', Number(row.provider_id)),
        irr,
      });
      continue;
    }
    const shares = allocate(irr, members.map((p) => revenueOf.get(p.id) ?? 0));
    members.forEach((p, i) => add(expenseOf, p.id, shares[i]!));
  }

  const giftOf = new Map<number, number>();
  let giftsIrr = 0;
  let legacyGifts = 0;
  let sharedGiftsIrr = 0;
  for (const g of gifts.results ?? []) {
    const irr = Number(g.irr);
    giftsIrr += irr;
    if (g.orderless) sharedGiftsIrr += irr;
    else if (g.product_id === null) legacyGifts += irr;
    else add(giftOf, Number(g.product_id), irr);
  }

  const services: ServiceProfit[] = [];
  const line = (productId: number | null, name: string, categoryName: string | null, revenueIrr: number, expensesIrr: number, giftsIrr: number) => {
    const profitIrr = revenueIrr - expensesIrr - giftsIrr;
    services.push({
      productId,
      name,
      categoryName,
      revenueIrr,
      expensesIrr,
      giftsIrr,
      profitIrr,
      marginPercent: revenueIrr > 0 ? pct(profitIrr, revenueIrr) : null,
    });
  };
  for (const p of catalogue) {
    const revenue = revenueOf.get(p.id) ?? 0;
    const expense = expenseOf.get(p.id) ?? 0;
    const gift = giftOf.get(p.id) ?? 0;
    if (revenue !== 0 || expense !== 0 || gift !== 0) line(p.id, p.name, p.categoryName, revenue, expense, gift);
  }
  // The orders the catalogue cannot place, and the commission paid on them.
  // Revenue with no costs named against it — the page says so beside the row.
  // A gift that names no order at all is not theirs: it is `sharedGiftsIrr`.
  const legacyRevenue = sales.find((s) => s.productId === null)?.irr ?? 0;
  if (legacyRevenue !== 0 || legacyGifts !== 0) line(null, LEGACY_SERVICE_NAME, null, legacyRevenue, 0, legacyGifts);
  services.sort((a, b) => b.revenueIrr - a.revenueIrr || b.profitIrr - a.profitIrr);

  const salesIrr = sales.reduce((a, s) => a + s.irr, 0);
  const revenueFixIrr = Number(ledger?.fix_irr ?? 0);
  const manualIncomeIrr = Number(ledger?.manual_irr ?? 0);
  const revenueIrr = salesIrr + revenueFixIrr + manualIncomeIrr;
  const expensesIrr = Number(ledger?.expense_irr ?? 0);
  const drawsIrr = Number(ledger?.draw_irr ?? 0);
  const profitIrr = revenueIrr - giftsIrr - expensesIrr;

  const partnerRows = (partners.results ?? [])
    .map((p) => {
      // An archived partner keeps his history, not his cut: `sharesOver` in
      // the routes lets a new partner take the percent he left, so counting
      // his too would divide more than all of the profit.
      const sharePercent = p.share_percent === null || !p.active ? null : Number(p.share_percent);
      const shareIrr = sharePercent === null ? 0 : Math.round((profitIrr * sharePercent) / 100);
      const drawnIrr = Number(p.drawn_irr);
      return { partyId: Number(p.id), name: p.name, sharePercent, shareIrr, drawnIrr, balanceIrr: shareIrr - drawnIrr, active: p.active };
    })
    .filter((p) => p.active || p.drawnIrr !== 0)
    .map(({ active: _active, ...p }) => p);
  const divided = partnerRows.reduce((a, p) => a + (p.sharePercent ?? 0), 0);

  return {
    range,
    startMs: bounds.start,
    endMs: bounds.end,
    booksStartMs: booksStart,
    salesIrr,
    revenueFixIrr,
    manualIncomeIrr,
    revenueIrr,
    giftsIrr,
    sharedGiftsIrr,
    expensesIrr,
    serviceExpensesIrr,
    sharedExpensesIrr: expensesIrr - serviceExpensesIrr,
    profitIrr,
    drawsIrr,
    retainedIrr: profitIrr - drawsIrr,
    services,
    unallocated,
    partners: partnerRows,
    undividedPercent: Math.max(0, Math.round((100 - divided) * 100) / 100),
  };
}
