/**
 * Turning "I want this" into a row.
 *
 * Two rules govern everything here.
 *
 * The price is read from the database inside the same transaction that writes
 * the order. It never comes from `callback_data`, never from a message, never
 * from anything the customer can influence. What they choose is WHICH plan;
 * what it costs is not theirs to send.
 *
 * A repeated tap does not become a second order. Mirzabot writes a fresh
 * invoice per attempt, which is why production carries unpaid invoice rows
 * nobody can tell apart. Here an open order for the same plan at the same price
 * is handed back instead — the customer sees the order they already have, which
 * is also what they expect.
 */

import { randomBytes } from 'node:crypto';
import type { D1DatabaseSession } from '@shikoo/database';
import type { CatalogPlan } from './catalog.js';
import { ORDER_TTL_MS } from './expire.js';
import { priceForUser, type Price } from './money.js';

export interface PlacedOrder {
  id: number;
  publicId: string;
  totalIrr: number;
  /** True when this returned an order the customer already had. */
  reused: boolean;
}

/**
 * `null` from any of the `place*` functions means the order came to nothing and
 * was refused. It is a return value rather than a throw on purpose: the whole
 * update runs inside one transaction, so a throw rolls back the
 * `telegram_updates` row that makes delivery once-only, and the poller then
 * hands the same update back for ever. One customer's free order would stop the
 * bot for everybody.
 */
export type PlaceResult = PlacedOrder | null;

/**
 * Ten hex characters, the shape production already uses for `payments.public_id`
 * ('b5baf9f689'), so support staff read one format everywhere. Collisions are
 * caught by the UNIQUE index rather than assumed away.
 */
export function newPublicId(): string {
  return randomBytes(5).toString('hex');
}

export async function placeOrder(
  tx: D1DatabaseSession,
  userId: number,
  plan: CatalogPlan,
  discountPercent: number,
  /** A code the customer typed and `checkCode` allowed, already in IRR. */
  codeDiscountIrr = 0,
  /**
   * The name the customer chose for the account, already sanitised, on a panel
   * whose «روش ساخت نام کاربری» is CUSTOMER_TEXT. Null everywhere else.
   *
   * Only this one of the five `place` callers takes it. A renewal and an add-on
   * change an account that already exists and must never be renamed; a top-up
   * has no account at all; a trial is never prompted. Saying so here is cheaper
   * than discovering it from a customer whose service was renamed mid-month.
   */
  usernameText: string | null = null,
): Promise<PlaceResult> {
  return place(
    tx,
    userId,
    plan.planId,
    withCode(priceForUser(plan.priceIrr, discountPercent), codeDiscountIrr),
    'NEW_PURCHASE',
    null,
    1,
    usernameText,
  );
}

/**
 * A typed code on top of the customer's standing discount.
 *
 * Both come off the same total and the schema checks the arithmetic
 * (`total = unit x quantity - discount`), so they are added into one
 * `discount_irr` rather than modelled as two. The floor at zero is the PHP's
 * (`index.php:4285`): a 100% code plus a standing discount would otherwise
 * produce a negative price, which is an order that pays the customer.
 */
function withCode(price: Price, codeDiscountIrr: number): Price {
  if (codeDiscountIrr <= 0) return price;
  const discountIrr = Math.min(price.unitPriceIrr, price.discountIrr + codeDiscountIrr);
  return { ...price, discountIrr, totalIrr: price.unitPriceIrr - discountIrr };
}

/**
 * The same thing, pointed at a service the customer already has.
 *
 * `target_subscription_id` is what makes it a renewal rather than a purchase,
 * and it is part of the open-order lookup: a customer renewing two services
 * onto the same plan is placing two orders, not pressing one button twice.
 */
export async function placeRenewalOrder(
  tx: D1DatabaseSession,
  userId: number,
  plan: CatalogPlan,
  discountPercent: number,
  subscriptionId: number,
  codeDiscountIrr = 0,
): Promise<PlaceResult> {
  return place(
    tx,
    userId,
    plan.planId,
    withCode(priceForUser(plan.priceIrr, discountPercent), codeDiscountIrr),
    'RENEWAL',
    subscriptionId,
  );
}

/**
 * Money in, not a thing out.
 *
 * A top-up carries no plan, so `plan_id` is NULL and there is nothing to
 * provision — `settleVerifiedPayments` completes it by crediting the wallet.
 *
 * The standing discount is deliberately NOT applied. It is a discount on
 * merchandise; applied to a deposit it would mean paying 90,000 Toman to
 * receive 100,000, which is not a discount but a mint.
 */
export async function placeTopupOrder(
  tx: D1DatabaseSession,
  userId: number,
  amountIrr: number,
): Promise<PlaceResult> {
  if (!Number.isSafeInteger(amountIrr) || amountIrr <= 0) {
    throw new Error(`top-up amount ${amountIrr} is not a usable amount`);
  }
  return place(
    tx,
    userId,
    null,
    { unitPriceIrr: amountIrr, discountIrr: 0, totalIrr: amountIrr },
    'WALLET_TOPUP',
    null,
  );
}

/**
 * Extra gigabytes or extra days on a service the customer already has.
 *
 * `quantity` is the thing bought — gigabytes or days — and `unit_price_irr` is
 * the panel's rate for one of them, so the schema's arithmetic check is what
 * verifies the total rather than this function claiming it. The plan is NULL:
 * an add-on is not a plan and must never look like one to the sweep, which
 * would otherwise try to provision a whole new account for it.
 *
 * The standing discount applies. Unlike a deposit, this IS merchandise.
 */
export async function placeAddonOrder(
  tx: D1DatabaseSession,
  userId: number,
  subscriptionId: number,
  kind: 'ADD_VOLUME' | 'ADD_TIME',
  quantity: number,
  unitPriceIrr: number,
  discountPercent: number,
): Promise<PlaceResult> {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error(`add-on quantity ${quantity} is not a usable amount`);
  }
  if (!Number.isSafeInteger(unitPriceIrr) || unitPriceIrr <= 0) {
    throw new Error(`add-on unit price ${unitPriceIrr} is not a usable price`);
  }
  const gross = priceForUser(unitPriceIrr * quantity, discountPercent);
  // The discount is taken off the total, so it is the unit price that must be
  // restated for the check `total = unit x quantity - discount` to hold.
  return place(
    tx,
    userId,
    null,
    {
      unitPriceIrr,
      discountIrr: unitPriceIrr * quantity - gross.totalIrr,
      totalIrr: gross.totalIrr,
    },
    kind,
    subscriptionId,
    quantity,
  );
}

/**
 * The free account, and the counter that is the only thing rationing it.
 *
 * ## Why this does not go through `place`
 *
 * `place` refuses anything priced at zero, on purpose and for four reasons
 * spelled out where it does it — all four are about a zero-priced order that
 * somebody can still be ASKED to pay for. A trial is never asked: it is
 * written PAID, it has no payment row, it has no wallet entry, and
 * `orders_trial_is_free` in 0045 is the database saying the same thing.
 *
 * ## The quota is the UPDATE, not a SELECT before it
 *
 * Legacy reads `user.limit_usertest`, compares it in PHP, and writes the new
 * value back (`index.php:3132`). Two taps in the same second both read the old
 * number and both pass. Here the comparison IS the WHERE clause: Postgres takes
 * the row lock, and the second statement sees the incremented value and matches
 * nothing. No row back means the quota is spent.
 *
 * The counter moves BEFORE the order exists, so a failure between the two
 * spends a trial nobody received. That is the safe direction and it is only
 * reachable inside one transaction — the caller's — so in practice both land or
 * neither does. Failing the other way would hand out unlimited free accounts to
 * anybody who can make an insert fail.
 *
 * `providerId` is trusted here only because the caller took it from
 * `trialPanelsForUser`, which is scoped to this customer. Nothing in this
 * function may be handed a number straight out of `callback_data`.
 */
export async function placeTrialOrder(
  tx: D1DatabaseSession,
  userId: number,
  providerId: number,
  quotaPerUser: number,
): Promise<PlaceResult> {
  if (!Number.isSafeInteger(quotaPerUser) || quotaPerUser <= 0) return null;

  const claimed = await tx
    .prepare(
      `UPDATE users
          SET test_quota_used = test_quota_used + 1, updated_at = now()
        WHERE id = ?1 AND test_quota_used < ?2
        RETURNING test_quota_used`,
    )
    .bind(userId, quotaPerUser)
    .first<{ test_quota_used: number }>();
  if (!claimed) return null;

  const row = await tx
    .prepare(
      // PAID with no payment behind it, which is the whole shape of a free
      // fulfilment: the provisioning sweep reads PAID and does not ask how it
      // got there. completed_at stays null until the sweep sets it.
      `INSERT INTO orders
         (public_id, user_id, kind, provider_id, quantity,
          unit_price_irr, discount_irr, total_irr, status)
       VALUES (?1, ?2, 'TRIAL', ?3, 1, 0, 0, 0, 'PAID')
       RETURNING id, public_id, total_irr`,
    )
    .bind(newPublicId(), userId, providerId)
    .first<{ id: number; public_id: string; total_irr: number }>();
  if (!row) throw new Error('trial order insert returned no row');

  return { id: row.id, publicId: row.public_id, totalIrr: 0, reused: false };
}
async function place(
  tx: D1DatabaseSession,
  userId: number,
  planId: number | null,
  price: Price,
  kind: 'NEW_PURCHASE' | 'RENEWAL' | 'WALLET_TOPUP' | 'ADD_VOLUME' | 'ADD_TIME',
  subscriptionId: number | null,
  /** Gigabytes or days on an add-on; one of everything else. The schema's
   *  `total = unit x quantity - discount` check is what keeps the three
   *  honest, so the caller cannot quietly disagree with itself. */
  quantity = 1,
  /** See `placeOrder` — null for every other caller, deliberately. */
  usernameText: string | null = null,
): Promise<PlaceResult> {
  // An order that costs nothing is refused here, once, for all four callers.
  //
  // Downstream nothing survives it. `checkoutMenu` renders «pay from wallet»
  // because `0 >= 0`; `spendOnOrder`'s overdraft guard passes because `0 < 0`
  // is false; and the ledger row it then writes is `-0`, which
  // `CHECK (amount_irr <> 0)` refuses — deliberately, since an entry that moves
  // no money is not an entry. The card path does not throw but strands the
  // order instead: a claim for 0 IRR is one no bank transaction can ever match.
  //
  // Free fulfilment is the other possible answer and is not written, because
  // the dump says nobody needs it: the single production account with
  // `pricediscount = 100` has zero invoices and zero payments. Building the
  // path would mean a second money path for a case that has never happened.
  //
  // ## Why this floor is here and NOT in the schema
  //
  // The project rule is that a guarantee belongs to Postgres, so the obvious
  // next step is tightening `orders.total_irr >= 0` to `> 0` in a migration.
  // Measured against the production dump on 2026-08-15, that migration would
  // fail: **937 of 5,131 `invoice` rows are priced at zero** — 705 of them
  // `send_on_hold`, and `cron_status.on_hold` is switched on — so the CHECK
  // would refuse legitimate history on cutover night, with the shop down.
  //
  // Zero-priced orders are a real part of what this shop sells. What must not
  // exist is a zero-priced order somebody can still be asked to *pay for*, and
  // that is a rule about the AWAITING_PAYMENT path rather than about the
  // column. The same dump says none arrive that way — of the 22 `unpaid`
  // `service_other` rows, the only ones the migration writes as
  // AWAITING_PAYMENT, zero are priced at nothing.
  //
  // So: the floor here for new orders, matching guards in `spendOnOrder` and
  // `checkoutFor` for rows that predate it, and the column left alone.
  if (!Number.isSafeInteger(price.totalIrr) || price.totalIrr <= 0) return null;

  // Same plan, same price, same target, still waiting to be paid. A price
  // change makes the old order stale, so it is left alone and a new one is
  // written instead — quietly charging yesterday's price is worse than a
  // duplicate row.
  const open = await tx
    .prepare(
      // `IS NOT DISTINCT FROM` on plan_id, not `=`: a top-up has no plan, and
      // `NULL = NULL` is unknown, so `=` would never match its own open order
      // and every tap would write another one.
      `SELECT id, public_id, total_irr
         FROM orders
        WHERE user_id = ?1
          AND plan_id IS NOT DISTINCT FROM ?2
          AND total_irr = ?3
          AND kind = ?4
          AND target_subscription_id IS NOT DISTINCT FROM ?5
          AND quantity = ?6
          AND status = 'AWAITING_PAYMENT'
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .bind(userId, planId, price.totalIrr, kind, subscriptionId, quantity)
    .first<{ id: number; public_id: string; total_irr: number }>();
  if (open) {
    /*
     * The chosen name is NOT part of the tuple above, and must not become part
     * of it: a customer who changes their mind would then get a second
     * AWAITING_PAYMENT row for the same plan, which is the duplicate this
     * file's header exists to prevent.
     *
     * So it is written onto the order that already exists — with the status in
     * the WHERE clause, not read beforehand. PAID and PROVISIONING match
     * nothing, so a name cannot move under a half-finished provisioning and
     * strand an account the panel already made under the old one.
     */
    if (usernameText !== null) {
      await tx
        .prepare(
          `UPDATE orders SET username_text = ?2, updated_at = now()
            WHERE id = ?1 AND status = 'AWAITING_PAYMENT'`,
        )
        .bind(open.id, usernameText)
        .run();
    }
    return { id: open.id, publicId: open.public_id, totalIrr: open.total_irr, reused: true };
  }

  // `expires_at` is set here and never refreshed, including on the reuse above.
  // The deadline belongs to the invoice, and a customer who could push it out by
  // tapping the same plan again would be keeping a card-to-card invoice — and
  // the card printed on it — alive indefinitely. `expire.ts` says what that
  // costs.
  const row = await tx
    .prepare(
      `INSERT INTO orders
         (public_id, user_id, kind, plan_id, target_subscription_id, quantity,
          unit_price_irr, discount_irr, total_irr, status, expires_at, username_text)
       VALUES (?1, ?2, ?3, ?4, ?5, ?9, ?6, ?7, ?8, 'AWAITING_PAYMENT',
               now() + make_interval(secs => ?10), ?11)
       RETURNING id, public_id, total_irr`,
    )
    .bind(
      newPublicId(),
      userId,
      kind,
      planId,
      subscriptionId,
      price.unitPriceIrr,
      price.discountIrr,
      price.totalIrr,
      quantity,
      ORDER_TTL_MS / 1000,
      usernameText,
    )
    .first<{ id: number; public_id: string; total_irr: number }>();
  if (!row) throw new Error('order insert returned no row');

  return { id: row.id, publicId: row.public_id, totalIrr: row.total_irr, reused: false };
}
