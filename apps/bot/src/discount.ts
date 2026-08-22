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

/** Why a code cannot be used. Each one gets its own sentence on screen. */
export type DiscountRefusal =
  | 'UNKNOWN_CODE'
  | 'EXPIRED'
  | 'USED_UP'
  | 'ALREADY_USED'
  | 'NOT_FOR_THIS'
  | 'NOT_FOR_YOU'
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

/** The row, or null. Case-insensitive, and never more than one row: `code` is UNIQUE. */
async function findCode(tx: D1DatabaseSession, typed: string) {
  return tx
    .prepare(
      `SELECT id, code, kind, amount_irr, percent, max_uses, first_purchase_only,
              resellers_only, product_id, provider_id, expires_at, applies_to
         FROM discount_codes
        WHERE lower(code) = ?1
        LIMIT 1`,
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
      }
    >();
}

/**
 * How much comes off, in whole IRR, never more than the price itself.
 *
 * `round`, matching `index.php:4280`. A percentage of a Rial price can land on
 * a fraction, and the schema's `total = unit x quantity - discount` is integer
 * arithmetic that a fraction would break.
 */
export function discountFor(code: DiscountCode, priceIrr: number): number {
  const off =
    code.kind === 'PERCENT_OFF'
      ? Math.round((Number(code.percent ?? 0) / 100) * priceIrr)
      : (code.amount_irr ?? 0);
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

  const mine = await tx
    .prepare(`SELECT 1 FROM discount_redemptions WHERE code_id = ?1 AND user_id = ?2`)
    .bind(row.id, userId)
    .first<{ '?column?': number }>();
  if (mine) return { ok: false, reason: 'ALREADY_USED', code: row };

  if (row.max_uses !== null) {
    const used = await tx
      .prepare(`SELECT count(*)::int AS n FROM discount_redemptions WHERE code_id = ?1`)
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

/** Why a redemption did not happen, or that it did. */
export type Redemption = 'OK' | 'ALREADY_USED' | 'USED_UP';

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
    .prepare(`SELECT max_uses FROM discount_codes WHERE id = ?1 FOR UPDATE`)
    .bind(codeId)
    .first<{ max_uses: number | null }>();
  if (code === null) return 'ALREADY_USED';

  if (code.max_uses !== null) {
    const used = await tx
      .prepare(`SELECT count(*)::int AS n FROM discount_redemptions WHERE code_id = ?1`)
      .bind(codeId)
      .first<{ n: number }>();
    if ((used?.n ?? 0) >= code.max_uses) return 'USED_UP';
  }

  const done = await tx
    .prepare(
      `INSERT INTO discount_redemptions (code_id, user_id, order_id, amount_irr)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (code_id, user_id) DO NOTHING`,
    )
    .bind(codeId, userId, orderId, amountIrr)
    .run();
  return done.meta.changes > 0 ? 'OK' : 'ALREADY_USED';
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
): Promise<boolean> {
  const row = await tx
    .prepare(
      `SELECT 1 FROM discount_redemptions r
         JOIN orders o ON o.id = r.order_id
        WHERE r.code_id = ?1 AND r.user_id = ?2
          AND o.plan_id = ?3 AND o.status = 'AWAITING_PAYMENT'
        LIMIT 1`,
    )
    .bind(codeId, userId, planId)
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
  if (spent !== 'OK') return { ok: false, reason: spent };
  await tx
    .prepare(
      `INSERT INTO wallet_entries (user_id, amount_irr, kind, note, idempotency_key)
       VALUES (?1, ?2, 'GIFT_CODE', ?3, ?4)
       ON CONFLICT (idempotency_key) DO NOTHING`,
    )
    .bind(userId, amountIrr, `gift code ${row.code}`, `gift:${row.id}:${userId}`)
    .run();
  return { ok: true, amountIrr };
}
