/**
 * «این مشتری خریده؟» — asked all over the bot and the dashboard, answered here.
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
 * 2026-09-25, two trials that rule still counted wrong, both measured on
 * production. 849 customers whose only service was a PHP-bot trial were
 * «bought», because the importer wrote that trial as a zero-Toman sale
 * (`legacyTrialSql`). And a trial renewed into a paid tier stayed a trial for
 * ever, because a renewal never moves `subscriptions.order_id` — so a
 * customer who had paid kept «خرید اولی», its codes, and its price on every
 * renewal after (`paidServiceSql`).
 *
 * Both fragments are correlated on `u` — the caller must have `users u` in
 * scope, which is the point: there is no way to ask without saying who.
 */

/**
 * The order `o` is a free trial the PHP bot handed out.
 *
 * The PHP bot wrote a trial as an `invoice` like any sale — price 0, named
 * `testServiceName5`, «سرویس تست» in the shop's Persian (`index.php:3074`) —
 * and `migrateInvoiceOrders` carried it over as a NEW_PURCHASE. It cannot be
 * made a TRIAL now: `orders_trial_is_free` wants a `provider_id` the import
 * never had. So it is recognised by those three facts instead, and a sale
 * the PHP bot really made never has all three.
 *
 * COALESCE because `o` is often the far side of a LEFT JOIN, and NULL there
 * means «no order», which is not a trial.
 */
export function legacyTrialSql(o: string): string {
  return `COALESCE(${o}.legacy_ref LIKE 'invoice:%'
                AND ${o}.total_irr = 0
                AND ${o}.plan_name_at_sale = 'سرویس تست', false)`;
}

/**
 * The subscription `s`, whose own order is `o` (LEFT JOINed), was paid for.
 *
 * Either it was sold — any order but a trial, or no order at all: an imported
 * row with none was sold — or it was a trial that a completed, paid order has
 * since extended. That second half is the renewal «تست → الماس» Sam asked for
 * on 2026-09-13; without it the service stays linked to its TRIAL order and
 * its owner never stops being a newcomer.
 *
 * `paid.user_id` is there for the index (`idx_orders_user`); the target is
 * what decides. `before`, when given, asks it as of that moment — for a
 * reader that classifies a past order rather than the customer today.
 */
export function paidServiceSql(s: string, o: string, before?: string): string {
  return `(
       (${o}.kind IS DISTINCT FROM 'TRIAL' AND NOT ${legacyTrialSql(o)})
    OR EXISTS (
         SELECT 1 FROM orders paid
          WHERE paid.user_id = ${s}.user_id
            AND paid.target_subscription_id = ${s}.id
            AND paid.status = 'COMPLETED'
            AND paid.total_irr > 0${before === undefined ? '' : `
            AND paid.created_at < ${before}`}))`;
}

/**
 * Owns a service that was paid for.
 *
 * Services, not orders — legacy `index.php:4249` counts invoice rows in the
 * live statuses, and an order nobody paid for has bought nothing.
 */
export const OWNS_PAID_SERVICE_SQL = `EXISTS (
  SELECT 1 FROM subscriptions s
    LEFT JOIN orders so ON so.id = s.order_id
   WHERE s.user_id = u.id
     AND s.status <> 'PENDING_PAYMENT'
     AND ${paidServiceSql('s', 'so')})`;

/**
 * Completed an order that was a purchase.
 *
 * What «استارت زده و هیچ خریدی نکرده» means on the audience list and in the
 * nudge. A wallet top-up is money in, not a purchase — the same two
 * exclusions `referral.ts` makes before paying a commission. A trial renewed
 * into a paid tier needs no second clause here: the renewal is an order.
 */
export const COMPLETED_A_PURCHASE_SQL = `EXISTS (
  SELECT 1 FROM orders o
   WHERE o.user_id = u.id
     AND o.status = 'COMPLETED'
     AND o.kind NOT IN ('TRIAL', 'WALLET_TOPUP')
     AND NOT ${legacyTrialSql('o')})`;
