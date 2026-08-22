/**
 * The two things an admin does to a customer, written once.
 *
 * They already existed, correctly, in `apps/dashboard-worker/src/customerRoutes.ts`
 * — and getting them right took three attempts and a test that names the eight
 * audit rows the second attempt produced. The bot's admin panel now needs the
 * same two operations on a phone, and re-deriving them there would mean two
 * ways to move a customer's money that agree today and drift on the first fix
 * applied to only one of them.
 *
 * So the writes moved here and both surfaces call them. What stays with each
 * caller is who the actor is and how they are named — the panel writes an
 * email, the bot writes a Telegram id, and `audit_logs` has a column for each.
 * The action names are deliberately identical, so one search finds both.
 *
 * ## What the comments in the route said, kept because they are the reasons
 *
 * **The balance is never assigned.** `wallets.balance_irr` is derived by a
 * trigger from append-only `wallet_entries`. Mirzabot does `Balance = Balance ±
 * x` as a read-modify-write, which loses one of two concurrent edits and leaves
 * nothing to reconstruct from — production still carries an account at
 * −5,940,000 Toman that nothing can explain.
 *
 * **The lock is on `users`, and it is its own statement.** The transaction
 * alone is not enough: the trigger's `INSERT … ON CONFLICT DO UPDATE` locks the
 * wallet only from the moment the entry lands, so two adjustments both read the
 * same balance before either inserts. And locking and reading in one joined
 * statement does not work either — a query that blocks on `FOR UPDATE`
 * re-checks only the locked table when it wakes and keeps its original snapshot
 * for everything joined to it. Under READ COMMITTED a second statement takes a
 * fresh snapshot, and by then the lock is held.
 *
 * **The amount is part of the idempotency key.** Without it, an admin who types
 * 500,000, notices, corrects it to 5,000,000 and submits again gets a silent
 * no-op: the key is already spent and the response says the money moved. It
 * did — the wrong amount, once.
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';

/**
 * Either a database or a transaction already open on one.
 *
 * The panel calls these from a request handler with nothing open; the bot calls
 * them from inside `handleUpdate`'s session, which is what holds its
 * exactly-once claim on the Telegram update. Opening a second transaction from
 * in there would be a write that commits — or fails — independently of the one
 * that claimed the update, so when a session is handed in it is used as it is.
 * The body needs to be *in* a transaction; it does not need to be the one that
 * started it.
 */
type Db = D1Database | D1DatabaseSession;

function isDatabase(db: Db): db is D1Database {
  return typeof (db as D1Database).withSession === 'function';
}

export interface WalletAdjustment {
  userId: number;
  /** Signed and non-zero. A credit and a debit are one operation. */
  amountIrr: number;
  note: string;
  /** `access_users.email` for the panel, `admin:<telegram id>` for the bot. */
  actor: string;
  /**
   * Whatever makes this attempt distinguishable from the next one — a form
   * token from a browser, the update id from Telegram. Namespaced and combined
   * with the amount below; a caller never sees the final key.
   */
  idempotencyKey: string;
}

export interface WalletAdjustmentResult {
  beforeIrr: number;
  balanceIrr: number;
  /** False when the key had already been spent, which is not an error. */
  applied: boolean;
}

/** Null when there is no such customer. */
export async function adjustWallet(
  db: Db,
  { userId, amountIrr, note, actor, idempotencyKey }: WalletAdjustment,
): Promise<WalletAdjustmentResult | null> {
  const key = `admin-adjust:${userId}:${amountIrr}:${idempotencyKey}`;

  const write = async (tx: D1DatabaseSession): Promise<WalletAdjustmentResult | null> => {
    const exists = await tx
      .prepare(`SELECT id FROM users WHERE id = ?1 FOR UPDATE`)
      .bind(userId)
      .first<{ id: number }>();
    if (!exists) return null;

    const before = await tx
      .prepare(`SELECT COALESCE(balance_irr, 0) AS balance_irr FROM wallets WHERE user_id = ?1`)
      .bind(userId)
      .first<{ balance_irr: number }>();

    const done = await tx
      .prepare(
        `INSERT INTO wallet_entries (user_id, amount_irr, kind, actor, note, idempotency_key)
         VALUES (?1, ?2, 'ADMIN_ADJUST', ?3, ?4, ?5)
         ON CONFLICT (idempotency_key) DO NOTHING`,
      )
      .bind(userId, amountIrr, actor, note, key)
      .run();

    const after = await tx
      .prepare(`SELECT COALESCE(balance_irr, 0) AS balance_irr FROM wallets WHERE user_id = ?1`)
      .bind(userId)
      .first<{ balance_irr: number }>();

    return {
      // No wallet row yet means no entries yet, which is a balance of zero.
      beforeIrr: Number(before?.balance_irr ?? 0),
      balanceIrr: Number(after?.balance_irr ?? 0),
      applied: done.meta.changes !== 0,
    };
  };

  return isDatabase(db) ? db.withSession(write) : write(db);
}

export interface StatusChange {
  userId: number;
  status: 'ACTIVE' | 'BLOCKED';
  reason: string | null;
}

export interface StatusChangeResult {
  changed: boolean;
  before: { status: string; blocked_reason: string | null };
  blockedReason: string | null;
}

/**
 * Blocks or unblocks. Null when there is no such customer.
 *
 * The reason is cleared on unblock rather than kept: a stale «چرا مسدود شد» on
 * an active account is a sentence an operator will read as current.
 */
export async function setCustomerStatus(
  db: Db,
  { userId, status, reason }: StatusChange,
): Promise<StatusChangeResult | null> {
  const before = await db
    .prepare(`SELECT status, blocked_reason FROM users WHERE id = ?1`)
    .bind(userId)
    .first<{ status: string; blocked_reason: string | null }>();
  if (!before) return null;

  const blockedReason = status === 'BLOCKED' ? reason : null;
  if (before.status === status)
    return { changed: false, before, blockedReason: before.blocked_reason };

  await db
    .prepare(`UPDATE users SET status = ?1, blocked_reason = ?2, updated_at = now() WHERE id = ?3`)
    .bind(status, blockedReason, userId)
    .run();
  return { changed: true, before, blockedReason };
}
