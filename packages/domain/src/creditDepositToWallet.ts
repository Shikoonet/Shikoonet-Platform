/**
 * «شارژ کیف پول مشتری» — a deposit nobody's order can take, paid into the
 * customer's wallet.
 *
 * The case it exists for: an invoice dies with its card hold (#274), the
 * customer pays anyway, and the deposit lands in «واریزی‌ها» with only a hint
 * (#275) — «احتمالاً فاکتور X (منقضی)». There is no order left to attach it
 * to, «رد» would take real customer money off the books, and a wallet
 * adjustment on the customer's page left the deposit in the queue for good.
 *
 * This credits the deposit's own amount, once, and the wallet entry IS the
 * link: its idempotency key is the deposit's (`depositWalletKey`), so
 * `wallet_entries.idempotency_key UNIQUE` refuses a second credit, and
 * `TX_WALLET_CREDITED` takes the deposit out of the queue and out of every
 * other door that could spend it.
 *
 * The one race that matters is this against `verifyMirzabotClaim` spending
 * the same deposit on an order. Both lock the deposit's row before they
 * write, and each refuses what the other committed — see the lock in
 * `verifyMirzabotClaim`'s batch.
 *
 * The bot calls `creditDepositInSession` directly (`wrongAmount.ts`): a
 * transfer that is not its invoice's amount is credited in the same
 * transaction that closes the invoice, and the bot writes its own message.
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';
import { depositWalletKey, INCOME_TX_WHERE } from './incomeEligibility.js';

export type CreditDepositFailure =
  | 'REASON_REQUIRED'
  | 'TRANSACTION_NOT_FOUND'
  | 'NOT_INCOME_ELIGIBLE'
  | 'USER_NOT_FOUND';

export type CreditDepositResult =
  | { ok: true; amountIrr: number; balanceIrr: number; notified: boolean }
  | { ok: false; error: CreditDepositFailure };

export async function creditDepositToWallet(
  db: D1Database,
  args: {
    transactionId: string;
    userId: number;
    actorEmail: string;
    reason: string;
    /** The customer's message, rendered by the caller; sent only to an ACTIVE customer. */
    message: string;
  },
): Promise<CreditDepositResult> {
  const reason = args.reason.trim();
  if (!reason) return { ok: false, error: 'REASON_REQUIRED' };
  return db.withSession((tx) => creditDepositInSession(tx, { ...args, reason }));
}


/** The credit inside a transaction the caller already holds. `reason` must be trimmed and non-empty. */
export async function creditDepositInSession(
  tx: D1DatabaseSession,
  args: {
    transactionId: string;
    userId: number;
    actorEmail: string;
    reason: string;
    /** Null when the caller writes its own message in the same transaction. */
    message: string | null;
  },
): Promise<CreditDepositResult> {
  // The lock first, then every check: a verify that got in first has
  // committed its match by the time this row is ours.
  const locked = await tx
    .prepare(`SELECT id FROM transaction_candidates WHERE id = ?1 FOR UPDATE`)
    .bind(args.transactionId)
    .first<{ id: string }>();
  if (!locked) return { ok: false, error: 'TRANSACTION_NOT_FOUND' };

  const deposit = await tx
    .prepare(`SELECT t.amount_irr FROM transaction_candidates t WHERE t.id = ?1 AND ${INCOME_TX_WHERE}`)
    .bind(args.transactionId)
    .first<{ amount_irr: number | string | null }>();
  const amountIrr = Number(deposit?.amount_irr ?? 0);
  if (!deposit || !(amountIrr > 0)) return { ok: false, error: 'NOT_INCOME_ELIGIBLE' };

  const user = await tx
    .prepare(`SELECT id FROM users WHERE id = ?1 FOR UPDATE`)
    .bind(args.userId)
    .first<{ id: number }>();
  if (!user) return { ok: false, error: 'USER_NOT_FOUND' };

  const credited = await tx
    .prepare(
      `INSERT INTO wallet_entries (user_id, amount_irr, kind, actor, note, idempotency_key)
       VALUES (?1, ?2, 'TOPUP', ?3, ?4, ?5)
       ON CONFLICT (idempotency_key) DO NOTHING`,
    )
    .bind(args.userId, amountIrr, args.actorEmail, args.reason, depositWalletKey(args.transactionId))
    .run();
  if (credited.meta.changes === 0) return { ok: false, error: 'NOT_INCOME_ELIGIBLE' };

  await tx
    .prepare(
      `UPDATE transaction_candidates SET status = 'APPROVED', updated_at = ?2
        WHERE id = ?1 AND status NOT IN ('APPROVED','REJECTED','IGNORED')`,
    )
    .bind(args.transactionId, Date.now())
    .run();

  // In the same transaction as the credit, as `settle.ts` does for a bot
  // top-up: the customer being owed the news is part of the same fact. A
  // blocked customer is credited and not messaged.
  const notified =
    args.message === null
      ? false
      : (
          await tx
            .prepare(
              `INSERT INTO bot_notifications (dedupe_key, chat_id, body)
               SELECT ?1, u.telegram_id, ?2 FROM users u
                WHERE u.id = ?3 AND u.status = 'ACTIVE'
               ON CONFLICT (dedupe_key) DO NOTHING`,
            )
            .bind(`deposit-wallet:${args.transactionId}`, args.message, args.userId)
            .run()
        ).meta.changes > 0;

  const balance = await tx
    .prepare(`SELECT balance_irr FROM wallets WHERE user_id = ?1`)
    .bind(args.userId)
    .first<{ balance_irr: number | string }>();

  return { ok: true, amountIrr, balanceIrr: Number(balance?.balance_irr ?? 0), notified };
}
