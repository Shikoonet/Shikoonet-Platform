/**
 * Discount codes, from the customer's side.
 *
 * One function decides whether a typed code may be used, and both places that
 * take a code call it. Mirzabot spells the same seven conditions out twice —
 * `index.php:1740` for a renewal and `:4218` for a purchase — and the two
 * copies have already drifted: the buy path checks `usefirst`, the renew path
 * does not.
 *
 * The conditions are the PHP's, in the PHP's order:
 *
 *   1. the code exists                             `in_array($text, $SellDiscount)`
 *   2. it is for this product and this panel       `code_product` / `code_panel`
 *   3. it is for this kind of purchase             `type IN ('all','buy'|'extend')`
 *   4. it is for this customer's tier              `agent`
 *   5. it has not expired                          `time`
 *   6. it has uses left                            `limitDiscount <= usedDiscount`
 *   7. this customer has not used it               `Giftcodeconsumed`
 *   8. first-purchase codes need a first purchase  `usefirst`
 *
 * Two of them are deliberately stricter here than in the PHP.
 *
 * `useuser` is gone. Legacy lets a code be redeemed 1, 2, 5 or unlimited times
 * per customer; here `idx_redemption_once_per_user` is a UNIQUE index, so it is
 * exactly once and no code can be raced into a second redemption. 23 of the 33
 * production codes allowed more, and every one of them has expired. The admin
 * who wants repeat use issues a second code; the alternative is moving a money
 * rule out of the database and into a counter that two concurrent taps can both
 * read as "one left".
 *
 * The used-up check counts redemptions rather than trusting a counter column.
 * `DiscountSell.usedDiscount` is incremented by the PHP after the fact and
 * production has rows where it disagrees with `Giftcodeconsumed`.
 */

import type { D1DatabaseSession } from '@shikoo/database';
import { IRR_PER_TOMAN } from './money.js';

/** Why a code cannot be used. Each one gets its own sentence on screen. */
export type DiscountRefusal =
  | 'UNKNOWN_CODE'
  | 'EXPIRED'
  | 'USED_UP'
  | 'ALREADY_USED'
  | 'NOT_FOR_THIS'
  | 'NOT_FOR_YOU'
  /** Switched off by an admin. Distinct from EXPIRED, which is a date. */
  | 'DISABLED'
  | 'FIRST_PURCHASE_ONLY';

export interface DiscountCode {
  id: number;
  code: string;
  kind: 'GIFT_BALANCE' | 'PERCENT_OFF' | 'AMOUNT_OFF';
  amount_irr: number | null;
  percent: number | null;
}

export type DiscountCheck =
  | { ok: true; code: DiscountCode; discountIrr: number }
  /** The row is carried on ALREADY_USED so a caller can ask whether the
   *  redemption is the customer's own, on an order they have not paid yet. */
  | { ok: false; reason: DiscountRefusal; code?: DiscountCode };

/** What the code is being asked to apply to. */
export interface PurchaseContext {
  kind: 'BUY' | 'RENEW';
  /** Before the discount, in IRR. */
  priceIrr: number;
  /**
   * Null when no product has been chosen yet.
   *
   * That happens on the renewal path, where the code is typed against a service
   * and the plan is picked afterwards. The product scope is then checked at the
   * moment the plan IS chosen, in the same transaction that writes the order —
   * so a product-scoped code still cannot reach the wrong product. What null
   * buys is a "your code is accepted" that does not lie later.
   */
  productId: number | null;
  providerId: number;
}

/**
 * A code is typed, so it is untrusted input twice over: as a string and as a
 * claim about what the customer is entitled to. It is trimmed, and nothing
 * else about it is believed.
 *
 * Codes are matched case-insensitively. Production holds `off15` and customers
 * type `OFF15`; the legacy comparison is MySQL's, which is case-insensitive by
 * collation, so matching exactly here would reject codes that work today.
 *
 * Bounded here rather than at each of the four screens that read a typed code,
 * because all four reach the lookup through this one function — a cap at the
 * call sites would be four chances to forget. Nothing is at risk in the
 * database (the value is only ever a parameterised `WHERE` operand, and what
 * gets stored is the shop's own canonical code), so this is about work: a
 * Telegram message may be 4,096 characters and every one of them would
 * otherwise be lowercased and matched against an index, on demand, for free.
 *
 * The cap is set from the dump rather than from taste: the longest real code is
 * 14 characters across the 33 in `DiscountSell`, and 10 across the 4 gift codes
 * in `Discount`. The legacy columns are `varchar(2000)` and `varchar(1000)`,
 * which is what a limit looks like when nobody chose it. Sixty-four leaves room
 * for a code four times longer than any that has ever existed and still refuses
 * a message that was never a code at all.
 */
export const MAX_CODE_LENGTH = 64;

export function normalizeCode(typed: string): string {
  return typed.trim().slice(0, MAX_CODE_LENGTH).toLowerCase();
}

/**
 * A redemption that still counts against a code's ceilings.
 *
 * A use is spent when an order is placed, and given BACK when that order dies
 * without the customer keeping anything. Until now nothing gave it back:
 * `expireUnpaidOrders` closes the order and leaves the redemption, and both
 * ceilings are counted straight off `discount_redemptions` — so one tap on
 * «ثبت سفارش» that the customer never paid burnt a `max_uses = 1` code for the
 * whole shop, for ever, with nothing an operator could look at to see why the
 * code had stopped working.
 *
 * Written as a filter on the COUNT rather than as a DELETE in the expiry sweep,
 * and the difference matters: `discount_redemptions.amount_irr` is a money
 * record, and deleting it so a counter reads correctly destroys the evidence of
 * what was offered to whom. The row stays and simply stops counting, which is
 * what «the use was given back» actually means.
 *
 * `FAILED` is in the list for the same reason as `EXPIRED`, and it was missed
 * on the first pass. `fail()` marks the order FAILED and refunds it in the same
 * transaction, so the customer paid, received nothing, and got their money
 * back — and a `max_uses = 1` code was burnt for the whole shop by an outage on
 * a panel. `EXPIRED` is what `expireUnpaidOrders` writes and `CANCELLED` is
 * what the legacy import carries; between the three, every way an order dies
 * without the customer keeping something is covered.
 *
 * `order_id IS NULL` still counts, and that is not an oversight. The legacy
 * import writes redemptions with only `legacy_id`, `code_id` and `user_id`
 * (`migrate.ts`, out of `Giftcodeconsumed`), so a migrated use has no order to
 * ask about — and it was a real use.
 */
const REDEMPTION_COUNTS = `
  LEFT JOIN orders o ON o.id = r.order_id
   WHERE (r.order_id IS NULL OR o.status NOT IN ('EXPIRED', 'CANCELLED', 'FAILED'))
`;

/**
 * The row, or null. Case-insensitive, and never more than one row: `code` is UNIQUE.
 *
 * `FOR UPDATE`, and it belongs here rather than behind a flag.
 *
 * `redeem` has taken this row for update since migration 0059 so two customers
 * cannot both pass the `max_uses` count. But on the purchase path the ORDER is
 * written before `redeem` runs, and the price on it was decided by a `checkCode`
 * that held no lock — so the guarantee the migration was written to give stopped
 * one step short of the thing it was protecting. Locking on the read closes that
 * without a parameter every future order-writing caller could forget, which is
 * the argument `redeem`'s own comment already makes about where a lock belongs.
 *
 * Nearly free today, and honestly so: `poll.ts` awaits each `handleUpdate` in a
 * plain `for` loop and the singleton advisory lock allows one poller, so two
 * customers are never inside this transaction at once. What it actually defends
 * is the window where that lock is lost or a deploy runs two containers — which
 * is a real window, and the reason not to leave the read unlocked.
 */
async function findCode(tx: D1DatabaseSession, typed: string) {
  return tx
    .prepare(
      `SELECT id, code, kind, amount_irr, percent, max_uses, first_purchase_only,
              resellers_only, product_id, provider_id, expires_at, applies_to,
              uses_per_user, status, target_user_id
         FROM discount_codes
        WHERE lower(code) = ?1
        ORDER BY id
        LIMIT 1
          FOR UPDATE`,
    )
    .bind(normalizeCode(typed))
    .first<
      DiscountCode & {
        max_uses: number | null;
        first_purchase_only: boolean;
        resellers_only: boolean;
        product_id: number | null;
        provider_id: number | null;
        expires_at: string | null;
        applies_to: 'ALL' | 'BUY' | 'RENEW';
        uses_per_user: number;
        status: 'ACTIVE' | 'DISABLED';
        target_user_id: number | null;
      }
    >();
}

/**
 * How much comes off, in whole IRR, never more than the price itself.
 *
 * Floored to a whole TOMAN, not merely to a whole Rial, and that is the whole
 * point of this function rather than a rounding preference.
 *
 * `discount_codes.percent` is `numeric(5,2)`, so 7.25 is a value an admin can
 * save. A percentage of a Rial price then lands on a total like 1,808,625 IRR
 * — 180,862.5 Toman — and a customer cannot transfer half a Toman. They send
 * 180,863, the claim carries `expected_amount_irr = 1_808_625`, and auto-verify
 * compares the two EXACTLY with no tolerance: the payment can never verify
 * itself, and every order bought with such a code lands in manual review.
 *
 * `priceForUser` has floored the standing discount to whole Toman since it was
 * written, for this reason. This is the same rule on the code path, where it
 * was missing. Floored rather than rounded so the discount can never exceed
 * what the code actually grants.
 */
export function discountFor(code: DiscountCode, priceIrr: number): number {
  const raw =
    code.kind === 'PERCENT_OFF'
      ? (Number(code.percent ?? 0) / 100) * priceIrr
      : (code.amount_irr ?? 0);
  const off = Math.floor(raw / IRR_PER_TOMAN) * IRR_PER_TOMAN;
  return Math.max(0, Math.min(priceIrr, off));
}

/**
 * Whether this customer may use this code on this purchase, right now.
 *
 * Reads only. The redemption is written by `redeem`, in the transaction that
 * writes the order, because a code checked in one transaction and spent in
 * another is a code two taps can both pass.
 */
export async function checkCode(
  tx: D1DatabaseSession,
  userId: number,
  isReseller: boolean,
  typed: string,
  context: PurchaseContext,
  now: number,
): Promise<DiscountCheck> {
  const row = await findCode(tx, typed);
  if (!row) return { ok: false, reason: 'UNKNOWN_CODE' };

  // A gift code credits a wallet; it is not a discount on anything.
  if (row.kind === 'GIFT_BALANCE') return { ok: false, reason: 'NOT_FOR_THIS' };

  if (row.expires_at !== null && Date.parse(row.expires_at) <= now) {
    return { ok: false, reason: 'EXPIRED' };
  }
  if (row.applies_to !== 'ALL' && row.applies_to !== context.kind) {
    return { ok: false, reason: 'NOT_FOR_THIS' };
  }
  if (
    row.product_id !== null &&
    context.productId !== null &&
    row.product_id !== context.productId
  ) {
    return { ok: false, reason: 'NOT_FOR_THIS' };
  }
  if (row.provider_id !== null && row.provider_id !== context.providerId) {
    return { ok: false, reason: 'NOT_FOR_THIS' };
  }
  if (row.resellers_only && !isReseller) return { ok: false, reason: 'NOT_FOR_YOU' };
  // Switched off by hand, which is not the same as expired and does not read
  // like it to a customer: «این کد فعلا غیرفعال است» can come back on, and a
  // date that has passed cannot.
  if (row.status !== 'ACTIVE') return { ok: false, reason: 'DISABLED' };
  // A code made for one person. `NOT_FOR_YOU` rather than `UNKNOWN_CODE`,
  // deliberately: the customer typed something that exists, and telling them
  // it does not would send them to support to ask why their friend's code
  // «does not work».
  if (row.target_user_id !== null && row.target_user_id !== userId) {
    return { ok: false, reason: 'NOT_FOR_YOU' };
  }

  // How many times THIS person has used THIS code, against its own ceiling.
  //
  // This was `SELECT 1 ... LIMIT 1` against a UNIQUE index that made the
  // answer structurally at most one. The index is gone (migration 0059) and
  // the guarantee is now a count — under the same `FOR UPDATE` lock in
  // `redeem`, which is the only place it has to hold under load. Here it is a
  // read, so a customer is told before they tap rather than after.
  const mine = await tx
    .prepare(`SELECT count(*)::int AS n FROM discount_redemptions r ${REDEMPTION_COUNTS}
           AND r.code_id = ?1 AND r.user_id = ?2`)
    .bind(row.id, userId)
    .first<{ n: number }>();
  if ((mine?.n ?? 0) >= row.uses_per_user) return { ok: false, reason: 'ALREADY_USED', code: row };

  if (row.max_uses !== null) {
    const used = await tx
      .prepare(`SELECT count(*)::int AS n FROM discount_redemptions r ${REDEMPTION_COUNTS}
           AND r.code_id = ?1`)
      .bind(row.id)
      .first<{ n: number }>();
    if ((used?.n ?? 0) >= row.max_uses) return { ok: false, reason: 'USED_UP' };
  }

  if (row.first_purchase_only) {
    // "First purchase" is about services owned, not orders placed: an order
    // that was never paid for is not a purchase. `index.php:4249` counts
    // invoice rows in the live statuses, which is the same set.
    const owned = await tx
      .prepare(
        `SELECT 1 FROM subscriptions
          WHERE user_id = ?1 AND status <> 'PENDING_PAYMENT' LIMIT 1`,
      )
      .bind(userId)
      .first<{ '?column?': number }>();
    if (owned) return { ok: false, reason: 'FIRST_PURCHASE_ONLY' };
  }

  return { ok: true, code: row, discountIrr: discountFor(row, context.priceIrr) };
}

/**
 * Why a redemption did not happen, or the row that says it did.
 *
 * The id is on the success arm because a redemption is now the unit of one
 * USE, and callers that move money need to key on it. `redeemGift` keyed its
 * wallet credit on `(code, user)` while a code could only be used once per
 * customer; with `uses_per_user = 2` that key silently swallowed the second
 * gift — the customer's redemption was written and their money was not.
 */
export type Redemption =
  | { ok: true; redemptionId: number }
  | { ok: false; reason: 'ALREADY_USED' | 'USED_UP' };

/**
 * Spends the code.
 *
 * ## One customer, twice
 *
 * The INSERT is the check. `idx_redemption_once_per_user` is UNIQUE on
 * (code_id, user_id), so a second attempt writes no row and this returns
 * `ALREADY_USED` — including when two taps arrive together and both passed
 * `checkCode`. Nothing re-reads and decides; the database decides.
 *
 * ## Two customers, together — and why there is a lock here
 *
 * That index says nothing about `max_uses`, which is a ceiling across
 * *different* people. `checkCode` counted the rows and compared, and a count
 * followed by an act is a race the moment two customers are in flight: both
 * counted zero on a `max_uses = 1` code, both inserted without conflicting
 * because their `user_id` differed, and a shop that authorised one gift gave
 * two. Proved on 2026-08-22 by running two redemptions through `Promise.all`
 * — sequential calls cannot show it, because the second sees the first's row.
 *
 * The fix is the smallest one that actually holds: take the code's row before
 * counting. `FOR UPDATE` makes the second transaction wait for the first to
 * commit, so by the time it counts, the row it needs to see is there. No new
 * index, no migration, and the count that was already written becomes true.
 *
 * It lives here rather than in `checkCode` because all three callers route
 * through this function — the gift path and both purchase paths — and a guard
 * in the caller is a guard somebody adds a fourth caller without.
 */
export async function redeem(
  tx: D1DatabaseSession,
  codeId: number,
  userId: number,
  orderId: number | null,
  amountIrr: number,
): Promise<Redemption> {
  // The lock, and the ceiling it protects, in that order. A code with no
  // ceiling still takes the row: the cost is one uncontended lock on a table
  // nobody writes during a purchase, and the alternative is two paths through
  // here that behave differently under load.
  const code = await tx
    .prepare(`SELECT max_uses, uses_per_user FROM discount_codes WHERE id = ?1 FOR UPDATE`)
    .bind(codeId)
    .first<{ max_uses: number | null; uses_per_user: number }>();
  if (code === null) return { ok: false, reason: 'ALREADY_USED' };

  if (code.max_uses !== null) {
    const used = await tx
      .prepare(`SELECT count(*)::int AS n FROM discount_redemptions r ${REDEMPTION_COUNTS}
           AND r.code_id = ?1`)
      .bind(codeId)
      .first<{ n: number }>();
    if ((used?.n ?? 0) >= code.max_uses) return { ok: false, reason: 'USED_UP' };
  }

  // The per-user ceiling, counted under the lock taken above.
  //
  // Until migration 0059 this was a UNIQUE index on `(code_id, user_id)` and
  // therefore structural: no count could disagree with it. It is a count now,
  // and the only reason that is safe is the `FOR UPDATE` two lines up — two
  // taps arriving together serialise on the code's row, so the second one
  // counts a set the first has already committed to. Exactly the argument
  // `max_uses` above rests on, and the same test shape proves it.
  const mine = await tx
    .prepare(`SELECT count(*)::int AS n FROM discount_redemptions r ${REDEMPTION_COUNTS}
           AND r.code_id = ?1 AND r.user_id = ?2`)
    .bind(codeId, userId)
    .first<{ n: number }>();
  if ((mine?.n ?? 0) >= code.uses_per_user) return { ok: false, reason: 'ALREADY_USED' };

  const done = await tx
    .prepare(
      // Once per ORDER, not once per user — see migration 0059. `handleOrder`
      // calls this on every tap of «سفارش», including taps that land back on
      // an order the customer already has, and absorbing those is what this
      // conflict clause is for. A code with `uses_per_user = 2` must not spend
      // the second use on the invoice the customer is already looking at.
      //
      // The gift path passes no order and the partial index does not cover it;
      // its ceiling is the count above, under the same lock.
      `INSERT INTO discount_redemptions (code_id, user_id, order_id, amount_irr)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (code_id, order_id) WHERE order_id IS NOT NULL DO NOTHING
       RETURNING id`,
    )
    .bind(codeId, userId, orderId, amountIrr)
    .first<{ id: number }>();
  // No row back means the conflict clause absorbed it: this order already
  // carries this code, which is a repeated tap rather than a second use.
  return done === null
    ? { ok: false, reason: 'ALREADY_USED' }
    : { ok: true, redemptionId: Number(done.id) };
}

/**
 * Whether this customer's redemption of this code is sitting on an order for
 * this plan that has not been paid for.
 *
 * Pressing "order" twice must produce the order they already have. Without
 * this, the second tap finds the code spent, prices the plan at full, and
 * writes a SECOND order — the duplicate-invoice behaviour `place()` exists to
 * prevent, arriving through the discount instead.
 */
export async function redemptionOnOpenOrder(
  tx: D1DatabaseSession,
  codeId: number,
  userId: number,
  planId: number,
  /** What the order would cost with this code on it, so a stale price does not match. */
  totalIrr: number,
): Promise<boolean> {
  const row = await tx
    .prepare(
      // The TOTAL as well as the plan, because the price is what makes it the
      // same order.
      //
      // Without it this answered yes for any open order of this customer on
      // this plan carrying this code — including one placed at a different
      // price. The `ALREADY_USED` fallback above it would then grant the
      // discount again while `place()` reused nothing, and `redeem` wrote no
      // second row: a discounted, payable invoice with no redemption behind
      // it. A discount is money and the redemption is the only record that a
      // use was spent.
      `SELECT 1 FROM discount_redemptions r
         JOIN orders o ON o.id = r.order_id
        WHERE r.code_id = ?1 AND r.user_id = ?2
          AND o.plan_id = ?3 AND o.status = 'AWAITING_PAYMENT'
          AND o.total_irr = ?4
        LIMIT 1`,
    )
    .bind(codeId, userId, planId, totalIrr)
    .first<{ '?column?': number }>();
  return row !== null;
}

export type GiftResult = { ok: true; amountIrr: number } | { ok: false; reason: DiscountRefusal };

/**
 * Redeems a gift code into the wallet.
 *
 * The money moves the same way every other credit does — an append-only
 * `wallet_entries` row with a unique idempotency key — so the once-only promise
 * is made twice, by two different indexes, and neither is a counter this code
 * reads first.
 */
export async function redeemGift(
  tx: D1DatabaseSession,
  userId: number,
  isReseller: boolean,
  typed: string,
  now: number,
): Promise<GiftResult> {
  const row = await findCode(tx, typed);
  if (!row) return { ok: false, reason: 'UNKNOWN_CODE' };
  if (row.kind !== 'GIFT_BALANCE') return { ok: false, reason: 'NOT_FOR_THIS' };
  if (row.expires_at !== null && Date.parse(row.expires_at) <= now) {
    return { ok: false, reason: 'EXPIRED' };
  }
  if (row.resellers_only && !isReseller) return { ok: false, reason: 'NOT_FOR_YOU' };
  // The same two checks `checkCode` makes, and they have to be repeated
  // because this path does not go through it — a gift is not a discount on
  // anything, so it has its own reading of the same row. Repeated rather than
  // shared: the two functions disagree about `applies_to`, `product_id` and
  // every other purchase-shaped field, and folding them together to save four
  // lines would mean one of them starts enforcing rules that do not apply.
  if (row.status !== 'ACTIVE') return { ok: false, reason: 'DISABLED' };
  if (row.target_user_id !== null && row.target_user_id !== userId) {
    return { ok: false, reason: 'NOT_FOR_YOU' };
  }

  const amountIrr = row.amount_irr ?? 0;
  // Production holds a gift code with a NULL price — `15off`, which credits
  // nothing. The migration reproduced it rather than repairing it, so it has to
  // be refused here instead of crediting a customer zero and calling it a gift.
  if (amountIrr <= 0) return { ok: false, reason: 'UNKNOWN_CODE' };

  // No pre-count here any more. `redeem` takes the code's row and checks the
  // ceiling under it, so counting first would only be a second opinion that can
  // disagree with the one that matters — and the reason it can disagree is a
  // race that cost a shop a duplicate gift.
  const spent = await redeem(tx, row.id, userId, null, amountIrr);
  if (!spent.ok) return { ok: false, reason: spent.reason };
  await tx
    .prepare(
      // Keyed on the REDEMPTION, not on `(code, user)`.
      //
      // It was `gift:<code>:<user>`, which was exactly right while a code could
      // only be used once per customer — and became a silent money bug the
      // moment `uses_per_user` could be 2: the second redemption was written,
      // this insert hit the first one's key, did nothing, and the customer was
      // told their gift had been applied while their wallet did not move.
      //
      // One redemption is one use is one credit, and the id is the only thing
      // that says so.
      `INSERT INTO wallet_entries (user_id, amount_irr, kind, note, idempotency_key)
       VALUES (?1, ?2, 'GIFT_CODE', ?3, ?4)
       ON CONFLICT (idempotency_key) DO NOTHING`,
    )
    .bind(userId, amountIrr, `gift code ${row.code}`, `gift:redemption:${spent.redemptionId}`)
    .run();
  return { ok: true, amountIrr };
}
