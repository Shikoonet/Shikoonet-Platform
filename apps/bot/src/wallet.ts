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
 * Not invented — read out of the production `PaySetting` rows on 2026-08-13:
 *
 *     minbalancecart  80000            Toman, card-to-card floor
 *     maxbalancecart  10000000         Toman, card-to-card ceiling
 *     minbalance      {"f":0,"n":100000,"n2":20000}        per reseller tier
 *     maxbalance      {"f":10000000,"n":400000,"n2":1000000}
 *
 * The first draft of this file offered a 50,000 Toman button, which the admin's
 * own floor forbids, and a 500,000 one, which the ordinary tier's ceiling
 * forbids. Both were guesses that looked reasonable.
 *
 * ponytail: the tier ceilings are collapsed to the tightest one (400,000) and
 * the numbers live here rather than in `settings`. Read them from the database
 * the day an admin can edit them — until then a deploy is the only way they
 * change anyway, and three tiers of arithmetic would model a distinction
 * nothing can currently set.
 */
export const TOPUP_MIN_IRR = 800_000;
export const TOPUP_MAX_IRR = 4_000_000;

/**
 * What a customer may deposit, in IRR.
 *
 * An allow-list, not a range, and the reason is that the amount arrives in
 * `callback_data`. Everywhere else in this bot the price is read from the
 * database precisely because the customer can forge that field; a top-up is the
 * one case where the amount really is theirs to choose, so the choice is
 * offered as an index into this list and the number never crosses the wire.
 * `topupAmount` is the only way to turn a tap into an amount.
 */
export const TOPUP_AMOUNTS_IRR = [1_000_000, 2_000_000, 3_000_000, 4_000_000] as const;

/**
 * The amount for a preset choice, or null if that is not one of ours.
 *
 * One-based, and not by taste: `decode` accepts an id matching
 * `/^[1-9][0-9]{0,18}$/`, so a zero cannot survive the round trip. A
 * zero-based index would make the first button the one that never works.
 */
export function topupAmount(choice: number): number | null {
  return TOPUP_AMOUNTS_IRR[choice - 1] ?? null;
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

export type SpendResult = 'PAID' | 'INSUFFICIENT' | 'ALREADY_PAID';

/**
 * Spends the balance on an order the customer already placed.
 *
 * The balance is read `FOR UPDATE` so two taps arriving together cannot both
 * see the same funds; the second waits and then finds them gone. Without that
 * lock a customer with one plan's worth of credit could buy two.
 *
 * Refuses to go negative. The schema deliberately has no `CHECK (balance >= 0)`
 * — production contains a negative balance and the migration had to reproduce
 * reality rather than launder it — so the overdraft policy lives here, at the
 * point of spend, which is the only place that can tell a customer why.
 */
export async function spendOnOrder(
  tx: D1DatabaseSession,
  userId: number,
  orderId: number,
  amountIrr: number,
): Promise<SpendResult> {
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
export function topupNeededIrr(totalIrr: number, balanceIrr: number): number | null {
  const missing = totalIrr - balanceIrr;
  if (missing <= 0) return null;
  return Math.max(TOPUP_MIN_IRR, Math.ceil(missing / 10) * 10);
}
