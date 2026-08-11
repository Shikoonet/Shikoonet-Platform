/**
 * Shared transaction-candidate creation logic.
 *
 * Used by:
 *   - ingest worker (`ingest.ts`) — runs against the live D1 binding.
 *   - reparse-bank-sms CLI       — runs the same SQL via `wrangler d1
 *                                  execute` so the same idempotency,
 *                                  account-lookup, and warning semantics
 *                                  are preserved.
 *
 * Every function here returns plain SQL + bind parameters so the caller
 * can either:
 *   - bind them directly to a D1Database.prepare(...).bind(...) call, or
 *   - serialise them into `wrangler d1 execute --command=<sql>` form.
 *
 * Keep this file pure SQL — no D1 binding access. Tests pin the SQL
 * shape so any drift breaks loudly.
 */
import type { ParseResult } from '@shikoo/contracts';

export interface PersistTransactionParams {
  id: string;
  rawSmsEventId: string;
  financialAccountId: string | null;
  direction: 'CREDIT' | 'DEBIT' | 'UNKNOWN';
  amountIrr: number | null;
  balanceIrr: number | null;
  transactionReference: string | null;
  bankTimestamp: number | null;
  confidence: number;
  parserId: string;
  parserVersion: string;
  parserEvidenceJson: string;
  createdAt: number;
}

export const INSERT_TRANSACTION_SQL = `INSERT INTO transaction_candidates
  (id, raw_sms_event_id, financial_account_id, direction, amount_irr, balance_irr,
   transaction_reference, bank_timestamp, confidence, parser_id, parser_version,
   parser_evidence_json, status, processing_disposition, created_at, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`;

export const FIND_TRANSACTION_BY_EVENT_SQL = `SELECT id FROM transaction_candidates
  WHERE raw_sms_event_id = ?1 LIMIT 1`;

export const FIND_ACCOUNT_BY_HINT_SQL = `SELECT id FROM financial_accounts
  WHERE account_hint = ?1
     OR card_last_four = ?1
     OR account_last_four = ?1
  LIMIT 1`;

export const UPDATE_TRANSACTION_STATUS_SQL = `UPDATE transaction_candidates
  SET status = ?2, updated_at = ?3 WHERE id = ?1`;

/**
 * True ONLY when this parse result is an actionable CREDIT transaction.
 *
 * Credit-only product invariant:
 *   Only direction === 'CREDIT' may create a transaction_candidates row.
 *   DEBIT (outgoing) and UNKNOWN (direction uncertain) are both excluded
 *   from the actionable product entirely — the raw SMS is still persisted
 *   for audit, but no candidate row is created.
 *
 * This is a positive check on CREDIT, not a negative check on DEBIT.
 * "Anything except DEBIT" would let UNKNOWN through, which violates the
 * invariant. UNKNOWN rows must persist the raw SMS only.
 *
 * Defense in depth: the ingest layer already short-circuits DEBIT and
 * UNKNOWN before calling persistTransaction. This guard ensures any
 * other caller (reparse CLI, future routes, tests) cannot violate the
 * invariant.
 */
export function shouldCreateTransaction(r: ParseResult): boolean {
  return r.direction === 'CREDIT';
}

/**
 * Compute the `processing_disposition` value to write on insert.
 * Only CREDIT rows reach this function (DEBIT and UNKNOWN short-circuit
 * earlier in the pipeline).
 */
export function processingDispositionFor(r: ParseResult): 'ACTIONABLE' {
  void r;
  return 'ACTIONABLE';
}

/** Compute the evidence JSON blob (includes warnings array). */
export function buildEvidenceJson(r: ParseResult): string {
  return JSON.stringify({ ...r.evidence, warnings: r.warnings });
}

/** Status applied at insert time. AMBIGUOUS_CURRENCY escalates to NEEDS_REVIEW. */
export function initialStatus(r: ParseResult): 'PARSED' | 'NEEDS_REVIEW' {
  return r.warnings.includes('AMBIGUOUS_CURRENCY') ? 'NEEDS_REVIEW' : 'PARSED';
}

/**
 * In-place mutator: if the result has an accountHint but no resolved
 * accountId is supplied, append the canonical warning so the parser
 * evidence explains why the transaction is unattributed.
 *
 * Returns the (possibly mutated) warnings array — callers must use this
 * when serialising evidence to JSON.
 */
export function annotateAccountWarning(r: ParseResult, resolvedAccountId: string | null): string[] {
  const warnings = [...r.warnings];
  if (r.accountHint && !resolvedAccountId && !warnings.includes('ACCOUNT_HINT_NOT_CONFIGURED')) {
    warnings.push('ACCOUNT_HINT_NOT_CONFIGURED');
  }
  return warnings;
}
