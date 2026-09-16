/**
 * «این مشتری خریده؟» — asked in five places, answered in one.
 *
 * The free trial («اکانت تست») is written the way a sale is: a TRIAL order
 * that ends COMPLETED, and an ACTIVE subscription for what it delivered. So
 * every reader that asked «owns a service» or «completed an order» counted it,
 * and the starter panel, the first-purchase code, the «never bought» audience
 * and the nudge all closed on exactly the person they exist for — the one who
 * tried and has not yet paid. Sam, 2026-09-16: «اکانت تست رو نباید جزو خرید
 * اولی‌ها حساب کنیم». `referral.ts` had learned the same thing earlier for the
 * commission, on its own; this is that rule with one spelling.
 *
 * Both fragments are correlated on `u` — the caller must have `users u` in
 * scope, which is the point: there is no way to ask without saying who.
 */

/**
 * Owns a service that was paid for.
 *
 * Services, not orders — legacy `index.php:4249` counts invoice rows in the
 * live statuses, and an order nobody paid for has bought nothing. The join to
 * `orders` is LEFT because imported subscriptions carry no order; those were
 * all sold, so a row with no order counts.
 */
export const OWNS_PAID_SERVICE_SQL = `EXISTS (
  SELECT 1 FROM subscriptions s
    LEFT JOIN orders so ON so.id = s.order_id
   WHERE s.user_id = u.id
     AND s.status <> 'PENDING_PAYMENT'
     AND so.kind IS DISTINCT FROM 'TRIAL')`;

/**
 * Completed an order that was a purchase.
 *
 * What «استارت زده و هیچ خریدی نکرده» means on the audience list and in the
 * nudge. A wallet top-up is money in, not a purchase — the same two
 * exclusions `referral.ts` makes before paying a commission.
 */
export const COMPLETED_A_PURCHASE_SQL = `EXISTS (
  SELECT 1 FROM orders o
   WHERE o.user_id = u.id
     AND o.status = 'COMPLETED'
     AND o.kind NOT IN ('TRIAL', 'WALLET_TOPUP'))`;
