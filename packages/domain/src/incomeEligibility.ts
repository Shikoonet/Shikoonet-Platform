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
 * income or, since 0072, a debit that is not the shop's spending: a transfer
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

/** Canonical Income tab predicate (alias `t` = transaction_candidates). */
export const INCOME_TX_WHERE = `
  t.direction = 'CREDIT'
  AND t.processing_disposition = 'ACTIONABLE'
  AND t.status NOT IN ('REJECTED','IGNORED')
  AND NOT ${TX_BOT_CONSUMED}
  AND NOT ${TX_RESELLER_CLASSIFIED}
  AND NOT ${TX_ACTIVE_BOT_SUGGESTION}
  AND NOT ${TX_INCOME_DECLINED}`;

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
 * with `OUTGOING_IGNORED` (0072), which keeps every matching and income
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
