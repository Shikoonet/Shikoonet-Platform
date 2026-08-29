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

/** Operator declined this tx from the active Income queue (reversible). */
export const TX_INCOME_DECLINED = `
  EXISTS (
    SELECT 1 FROM income_declined_transactions idt
     WHERE idt.transaction_candidate_id = t.id
       AND idt.restored_at IS NULL
  )`;

/** Canonical Income tab predicate (alias `t` = transaction_candidates). */
export const INCOME_TX_WHERE = `
  t.direction = 'CREDIT'
  AND t.processing_disposition = 'ACTIONABLE'
  AND t.status NOT IN ('REJECTED','IGNORED')
  AND NOT ${TX_BOT_CONSUMED}
  AND NOT ${TX_RESELLER_CLASSIFIED}
  AND NOT ${TX_ACTIVE_BOT_SUGGESTION}
  AND NOT ${TX_INCOME_DECLINED}`;

/** Bank income for summary: all valid CREDIT rows in range (any final destination). */
export const BANK_INCOME_TX_WHERE = `
  t.direction = 'CREDIT'
  AND t.processing_disposition IN ('ACTIONABLE','ADMIN_EXCLUDED')
  AND t.status NOT IN ('REJECTED','IGNORED')`;
