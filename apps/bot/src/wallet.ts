/**
 * The wallet, from the bot's side.
 *
 * The hard part is already solved in the schema (`migrations/0001_core.sql`):
 * `wallets.balance_irr` is derived by a trigger from append-only
 * `wallet_entries`, so "the balance equals the sum of its entries" is true by
 * construction rather than by care. Nothing here ever writes `balance_irr`.
 *
 * What this file adds is the two ways money moves for a customer, and the
 * promise that neither happens twice. That promise is `wallet_entries
 * .idempotency_key`, which is UNIQUE: a double-tapped button, a retried sweep
 * and a re-run migration all collapse onto the same row. It is checked by the
 * database, not by reading the balance first and hoping.
 *
 * Mirzabot is the counter-example this replaces: `user.Balance` is a single
 * mutable integer with no history, and production carries an account at
 * -5,940,000 Toman that nothing can explain.
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';

type Db = D1Database | D1DatabaseSession;

/**
 * The admin's own limits on a card-to-card deposit, in IRR.
 *
 * Read from `settings` now — `pay/minbalancecart` and `pay/maxbalancecart`,
 * both Toman in the legacy schema — with these as the fallback when the read
 * fails. See `settings.ts`.
 *
 * The numbers are production's, verified against the dump on 2026-08-15:
 *
 *     minbalancecart  80,000       Toman
 *     maxbalancecart  10,000,000   Toman
 *
 * The first draft of this file collapsed the tier-keyed `maxbalance` JSON to
 * its tightest value, 400,000 Toman, and applied it to everyone. That was
 * wrong twice over: the tier that applies to an ordinary customer is `f`, whose
 * ceiling is 10,000,000 — and the card path does not read the tier JSON at all.
 * `index.php:4712` enforces `minbalancecart`/`maxbalancecart` and uses the
 * tier values only to word the "not enough balance" message. A 400,000 Toman
 * ceiling was 25× too low for every customer the shop has.
 */
export const TOPUP_MIN_IRR = 800_000;
export const TOPUP_MAX_IRR = 100_000_000;

/**
 * What a customer may deposit, in IRR.
 *
 * An allow-list, not a range, and the reason is that the amount arrives in
 * `callback_data`. Everywhere else in this bot the price is read from the
 * database precisely because the customer can forge that field; a top-up is the
 * one case where the amount really is theirs to choose, so the choice is
 * offered as an index into this list and the number never crosses the wire.
 * `topupAmount` is the only way to turn a tap into an amount.
 *
 * Derived from the shop's own floor and ceiling rather than fixed, because both
 * are now editable and a preset outside them is a button that leads to a
 * refusal. Six of them: enough to cover a range of 125× without a wall of
 * buttons on a phone.
 */
export function topupPresetsIrr(minIrr: number, maxIrr: number): readonly number[] {
  if (!(minIrr > 0) || maxIrr < minIrr) return TOPUP_AMOUNTS_IRR;
  const steps = 6;
  const presets: number[] = [];
  for (let i = 0; i < steps; i++) {
    // Geometric, so the small amounts most customers use are not crowded out by
    // the ceiling: a linear spread from 80,000 to 10,000,000 Toman would make
    // every button but the first useless.
    const value = minIrr * Math.pow(maxIrr / minIrr, i / (steps - 1));
    // Rounded to a whole Toman, which is the only unit a customer can transfer.
    const rounded = Math.round(value / 10) * 10;
    if (!presets.includes(rounded)) presets.push(rounded);
  }
  return presets;
}

export const TOPUP_AMOUNTS_IRR = [1_000_000, 2_000_000, 3_000_000, 4_000_000] as const;

/**
 * The amount for a preset choice, or null if that is not one of ours.
 *
 * One-based, and not by taste: `decode` accepts an id matching
 * `/^[1-9][0-9]{0,18}$/`, so a zero cannot survive the round trip. A
 * zero-based index would make the first button the one that never works.
 *
 * The list is passed in rather than read from a constant, because it now
 * depends on the shop's limits — and the presets a tap is resolved against
 * must be the same ones the buttons were drawn from.
 */
export function topupAmount(
  choice: number,
  presets: readonly number[] = TOPUP_AMOUNTS_IRR,
): number | null {
  return presets[choice - 1] ?? null;
}

export interface WalletEntry {
  amount_irr: number;
  kind: string;
  note: string | null;
  created_at: string;
}

/**
 * The balance, or zero.
 *
 * A customer with no entries has no `wallets` row — the trigger writes it on
 * the first entry — and that is a zero balance, not a missing one.
 */
export async function balanceFor(db: Db, userId: number): Promise<number> {
  const row = await db
    .prepare(`SELECT balance_irr FROM wallets WHERE user_id = ?1`)
    .bind(userId)
    .first<{ balance_irr: number }>();
  return row?.balance_irr ?? 0;
}

/** The most recent movements, newest first. */
export async function entriesFor(db: Db, userId: number, limit: number): Promise<WalletEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT amount_irr, kind, note, created_at
         FROM wallet_entries
        WHERE user_id = ?1
        ORDER BY created_at DESC, id DESC
        LIMIT ?2`,
    )
    .bind(userId, limit)
    .all<WalletEntry>();
  return results ?? [];
}

/**
 * Credits a confirmed top-up.
 *
 * Returns false when this order's credit already exists, which is the ordinary
 * outcome of a sweep running twice — not an error. The caller distinguishes
 * them so it does not tell the customer about the same deposit twice.
 */
export async function creditTopup(
  tx: D1DatabaseSession,
  userId: number,
  orderId: number,
  amountIrr: number,
): Promise<boolean> {
  const done = await tx
    .prepare(
      `INSERT INTO wallet_entries (user_id, amount_irr, kind, order_id, idempotency_key)
       VALUES (?1, ?2, 'TOPUP', ?3, ?4)
       ON CONFLICT (idempotency_key) DO NOTHING`,
    )
    .bind(userId, amountIrr, orderId, `order:${orderId}:topup`)
    .run();
  return done.meta.changes > 0;
}

/**
 * Pays the shop's renewal cashback into the customer's own wallet.
 *
 * `shopSetting.chashbackextend` is 5 in production and has been for years, so a
 * customer who renews today gets five percent back and would have got nothing
 * the day after cutover. It is the only parity gap that costs the CUSTOMER
 * money, which is why it is built and the rest of that list is a decision.
 *
 * Called from inside the transaction that marks a renewal COMPLETED, not when
 * the order is paid. A renewal whose panel call fails is refunded, and cashback
 * on top of a refund is the shop paying a customer to have a bad night.
 *
 * Paid once by `wallet_entries.idempotency_key`, like every other movement here
 * — the sweep retries, and the customer is credited once. The percentage is in
 * the key: an admin who corrects the rate and re-runs is making a second, real
 * decision, and silently collapsing it onto the first would hide that.
 */
export async function creditRenewalCashback(
  tx: D1DatabaseSession,
  orderId: number,
  percent: number,
): Promise<number | null> {
  if (!Number.isFinite(percent) || percent <= 0) return null;

  const order = await tx
    .prepare(`SELECT user_id, total_irr, kind FROM orders WHERE id = ?1`)
    .bind(orderId)
    .first<{ user_id: number; total_irr: number; kind: string }>();
  // Renewals only. `function.php:1147` and `index.php:1952` are both inside the
  // extend path and nowhere else; paying it on a first purchase would be a
  // discount the shop never agreed to.
  if (!order || order.kind !== 'RENEWAL' || order.total_irr <= 0) return null;

  // Rounded down, like the referral commission: money leaving the shop does not
  // get the benefit of a half Rial nobody has.
  const amountIrr = Math.floor((order.total_irr * percent) / 100);
  if (amountIrr <= 0) return null;

  const done = await tx
    .prepare(
      `INSERT INTO wallet_entries (user_id, amount_irr, kind, order_id, note, idempotency_key)
       VALUES (?1, ?2, 'RENEWAL_CASHBACK', ?3, ?4, ?5)
       ON CONFLICT (idempotency_key) DO NOTHING`,
    )
    .bind(
      order.user_id,
      amountIrr,
      orderId,
      `${percent}% of a renewal`,
      `cashback:${orderId}:${percent}`,
    )
    .run();
  return done.meta.changes > 0 ? amountIrr : null;
}

export type SpendResult = 'PAID' | 'INSUFFICIENT' | 'ALREADY_PAID';

/**
 * Spends the balance on an order the customer already placed.
 *
 * The balance is read `FOR UPDATE` so two taps arriving together cannot both
 * see the same funds; the second waits and then finds them gone. Without that
 * lock a customer with one plan's worth of credit could buy two.
 *
 * With one exception, and it is said out loud because the sentence above is
 * otherwise a small lie: **a customer who has no `wallets` row is not locked at
 * all.** `SELECT … FOR UPDATE` on a row that does not exist locks nothing, so
 * two transactions both walk straight past it. That is safe today for a reason
 * that has nothing to do with locking — no row means no entries, which means a
 * balance of zero, so the overdraft refusal below stops both of them. It is the
 * absence of money, not the presence of a lock, and if a `wallets` row ever
 * starts being created ahead of the first entry that changes silently.
 *
 * Refuses to go negative. The schema deliberately has no `CHECK (balance >= 0)`
 * — production contains a negative balance and the migration had to reproduce
 * reality rather than launder it — so the overdraft policy lives here, at the
 * point of spend, which is the only place that can tell a customer why.
 *
 * The second guarantee is not this lock and is worth separating: paying twice
 * for the SAME order is stopped by `wallet_entries.idempotency_key` being
 * UNIQUE, in the database, whatever the callers do. The lock only settles two
 * DIFFERENT orders racing for one balance.
 */
export async function spendOnOrder(
  tx: D1DatabaseSession,
  userId: number,
  orderId: number,
  amountIrr: number,
): Promise<SpendResult> {
  // The amount was taken on trust, and both ways of getting that wrong end
  // badly. A negative one becomes `-amountIrr` — a positive entry — so a
  // purchase credits the buyer and the sale pays them. A zero one writes an
  // entry of nothing, which violates `CHECK (amount_irr <> 0)`, and that
  // exception rolls back the whole update including the `telegram_updates` row
  // that makes handling exactly-once: the C1 freeze, reached from the one
  // direction the floor in `place()` cannot cover, an order that was already
  // there. Its sibling `payReferralCommission` has guarded this since it was
  // written; this one did not.
  //
  // Zero is 'PAID' rather than a refusal because it is true — nothing is owed,
  // so nothing is charged, and what must not happen is a ledger row for no
  // money.
  if (!Number.isSafeInteger(amountIrr) || amountIrr < 0) return 'INSUFFICIENT';
  if (amountIrr === 0) return 'PAID';

  const locked = await tx
    .prepare(`SELECT balance_irr FROM wallets WHERE user_id = ?1 FOR UPDATE`)
    .bind(userId)
    .first<{ balance_irr: number }>();
  const balance = locked?.balance_irr ?? 0;
  if (balance < amountIrr) return 'INSUFFICIENT';

  const spent = await tx
    .prepare(
      `INSERT INTO wallet_entries (user_id, amount_irr, kind, order_id, idempotency_key)
       VALUES (?1, ?2, 'PURCHASE', ?3, ?4)
       ON CONFLICT (idempotency_key) DO NOTHING`,
    )
    .bind(userId, -amountIrr, orderId, `order:${orderId}:purchase`)
    .run();
  return spent.meta.changes > 0 ? 'PAID' : 'ALREADY_PAID';
}

/**
 * Puts a wallet payment back when the order it paid for cannot be delivered.
 *
 * Only for orders paid from the balance. A card-to-card payment is real money
 * in a real bank account and is a person's decision to return; a wallet payment
 * is credit we hold, and holding it for a service that failed is simply keeping
 * the customer's money. The legacy bot refunds here too (`function.php:863`).
 *
 * Returns the amount put back, or null when there is nothing to put back —
 * which covers both "this was not paid from the wallet" and "already refunded".
 *
 * Found by walking the screen: paying from the wallet for a panel with no
 * address left the customer 100,000 Toman lighter, the order FAILED, and a
 * message saying their payment was safe.
 */
export async function refundOrder(db: Db, orderId: number): Promise<number | null> {
  const paid = await db
    .prepare(
      `SELECT user_id, amount_irr FROM payments
        WHERE order_id = ?1 AND method = 'WALLET' AND status = 'PAID'
        ORDER BY id LIMIT 1`,
    )
    .bind(orderId)
    .first<{ user_id: number | null; amount_irr: number }>();
  if (!paid || paid.user_id === null || paid.amount_irr <= 0) return null;

  const done = await db
    .prepare(
      `INSERT INTO wallet_entries (user_id, amount_irr, kind, order_id, actor, note, idempotency_key)
       VALUES (?1, ?2, 'REFUND', ?3, 'SYSTEM', 'order could not be delivered', ?4)
       ON CONFLICT (idempotency_key) DO NOTHING`,
    )
    .bind(paid.user_id, paid.amount_irr, orderId, `order:${orderId}:refund`)
    .run();
  return done.meta.changes > 0 ? paid.amount_irr : null;
}

/**
 * What to deposit so this order can be paid from the balance.
 *
 * Rounded UP to a whole Toman, because asking for a deposit that leaves the
 * customer a Rial short is a second trip to the bank for nothing — and then
 * raised to the admin's card-to-card floor, because a transfer below it is one
 * the shop does not accept. A customer 30,000 Toman short is asked for 80,000
 * and keeps the difference as credit; being told to send an amount that will be
 * refused is worse.
 *
 * Returns null when the order is already affordable, and when even the floor
 * would not cover it the honest answer is the shortfall itself — capped is a
 * decision for the caller, not a silent truncation here.
 */
export function topupNeededIrr(
  totalIrr: number,
  balanceIrr: number,
  minIrr: number = TOPUP_MIN_IRR,
): number | null {
  const missing = totalIrr - balanceIrr;
  if (missing <= 0) return null;
  return Math.max(minIrr, Math.ceil(missing / 10) * 10);
}
