/**
 * SQL predicates for unassigned bank income and bot-matching eligibility.
 *
 * A CREDIT transaction is Income when it is ACTIONABLE, not bot-consumed,
 * not reseller-classified, and not actively SUGGESTED to an open Mirzabot claim.
 */

export const CONSUMING_MATCH_STATUSES = "('CONFIRMED','AUTO_VERIFIED')";

/** Tx is finalized as bot payment. */
export const TX_BOT_CONSUMED = `
  EXISTS (
    SELECT 1 FROM reconciliation_matches m
     WHERE m.transaction_candidate_id = t.id
       AND m.status IN ${CONSUMING_MATCH_STATUSES}
  )`;

/** Tx is classified as reseller income. */
export const TX_RESELLER_CLASSIFIED = `
  EXISTS (
    SELECT 1 FROM reseller_transactions rt
     WHERE rt.transaction_candidate_id = t.id
  )`;

/** Tx is actively suggested to an open Mirzabot claim (Needs Review / Waiting path). */
export const TX_ACTIVE_BOT_SUGGESTION = `
  EXISTS (
    SELECT 1 FROM reconciliation_matches m
     JOIN payment_claims c ON c.id = m.payment_claim_id
     WHERE m.transaction_candidate_id = t.id
       AND m.status = 'SUGGESTED'
       AND c.source_system = 'MIRZABOT'
       AND c.status IN ('PENDING','MATCH_SUGGESTED')
  )`;

/**
 * Operator took this tx off the books (reversible) — a credit that is not
 * income or, since 0073, a debit that is not the shop's spending: a transfer
 * between our own accounts, a loan instalment, a relative's deposit sent
 * back, a bank fee. `income_declined_transactions` is the table's old name;
 * the row carries a `category` saying which of those it is.
 */
export const TX_INCOME_DECLINED = `
  EXISTS (
    SELECT 1 FROM income_declined_transactions idt
     WHERE idt.transaction_candidate_id = t.id
       AND idt.restored_at IS NULL
  )`;
export const TX_OFF_BOOKS = TX_INCOME_DECLINED;

/**
 * The wallet entry a deposit credited by hand writes (`creditDepositToWallet`).
 * Keyed by the deposit, so `wallet_entries.idempotency_key UNIQUE` is what
 * lets one deposit reach a wallet once — and the key is also the link: the
 * deposit is spent exactly when this entry exists.
 */
export function depositWalletKey(transactionId: string): string {
  return `deposit:${transactionId}:wallet`;
}

/** Tx was credited to a customer's wallet by hand. Same key as `depositWalletKey`. */
export const TX_WALLET_CREDITED = `
  EXISTS (
    SELECT 1 FROM wallet_entries we
     WHERE we.idempotency_key = 'deposit:' || t.id || ':wallet'
  )`;

/** Canonical Income tab predicate (alias `t` = transaction_candidates). */
export const INCOME_TX_WHERE = `
  t.direction = 'CREDIT'
  AND t.processing_disposition = 'ACTIONABLE'
  AND t.status NOT IN ('REJECTED','IGNORED')
  AND NOT ${TX_BOT_CONSUMED}
  AND NOT ${TX_RESELLER_CLASSIFIED}
  AND NOT ${TX_ACTIVE_BOT_SUGGESTION}
  AND NOT ${TX_INCOME_DECLINED}
  AND NOT ${TX_WALLET_CREDITED}`;

/**
 * What «واریزی‌ها» lists and counts: income the operator can still owe an
 * answer about. `INCOME_TX_WHERE` minus two kinds of row it never could:
 *
 *   - a credit before the fresh start. «دفتر بانک» and every money report
 *     start there (`booksStartMs`); the queue did not, and on production
 *     (2026-09-23) 17 of its 33 rows were from before the books opened —
 *     rows no screen would ever ask about again.
 *   - a credit on a books-only account (`customer_visible = 0`, 0090). No
 *     customer is ever shown that card, so nothing on it is a customer's
 *     payment: it is the shop moving its own money (Sam: «تنخواه» is filled
 *     from our other accounts and pays the running costs). Its tag belongs
 *     in «دفتر بانک». 29.9M of the 52.1M the queue showed that day.
 *
 * Only the queue. Eligibility (`isIncomeEligible`, off-books) keeps
 * `INCOME_TX_WHERE`: «خارج از دفتر» on a tenkhah credit, or on one from
 * before the start, must still be accepted.
 */
export const INCOME_QUEUE_TX_WHERE = `
  ${INCOME_TX_WHERE}
  AND COALESCE(t.bank_timestamp, t.created_at)
      >= COALESCE((SELECT MIN(aob.created_at) FROM account_opening_balances aob), 0)
  AND NOT EXISTS (
    SELECT 1 FROM financial_accounts qfa
     WHERE qfa.id = t.financial_account_id AND qfa.customer_visible = 0
  )`;

/**
 * Bank income for summary: every valid CREDIT row in range, whatever it was
 * matched to — minus what the operator took off the books. Until 2026-09-17
 * that last clause was missing, and a 10.6M Toman transfer between Sam's own
 * accounts, declared «جابه‌جایی» four minutes after it arrived, still counted
 * as «واریز بانکی» on the account it landed in.
 */
export const BANK_INCOME_TX_WHERE = `
  t.direction = 'CREDIT'
  AND t.processing_disposition IN ('ACTIONABLE','ADMIN_EXCLUDED')
  AND t.status NOT IN ('REJECTED','IGNORED')
  AND NOT ${TX_OFF_BOOKS}`;

/**
 * Money leaving an account: a DEBIT the phone relayed. Ingest writes these
 * with `OUTGOING_IGNORED` (0073), which keeps every matching and income
 * query — all of which ask for `ACTIONABLE` — from ever seeing them. Off the
 * books excluded, same as income.
 */
export const BANK_OUTFLOW_TX_WHERE = `
  t.direction = 'DEBIT'
  AND t.status NOT IN ('REJECTED','IGNORED')
  AND NOT ${TX_OFF_BOOKS}`;

/**
 * What the off-books button may be pressed on: an income-eligible credit, or
 * any live debit. A credit the bot already spent on a claim is not a
 * candidate — refusing that money is a claim decision, not a bookkeeping one.
 */
export const TX_EXPLAINED_BY_EXPENSE = `
  EXISTS (
    SELECT 1 FROM revenue_adjustments ra
     WHERE ra.transaction_candidate_id = t.id AND ra.voided_at IS NULL
  )`;

export const OFF_BOOKS_ELIGIBLE_TX_WHERE = `
  ((${INCOME_TX_WHERE})
   OR (t.direction = 'DEBIT' AND t.status NOT IN ('REJECTED','IGNORED')
       AND NOT ${TX_OFF_BOOKS}
       AND NOT ${TX_EXPLAINED_BY_EXPENSE}))`;
