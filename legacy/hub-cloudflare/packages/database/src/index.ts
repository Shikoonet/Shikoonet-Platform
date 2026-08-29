/**
 * Thin typed helpers over the D1 binding. No ORM — explicit SQL keeps the
 * query plan readable and the migrations the source of truth.
 *
 * Money: INTEGER IRR. Timestamps: epoch milliseconds (INTEGER).
 */

import type {
  Direction,
  Classification,
  TransactionStatus,
  ClaimStatus,
  MatchStatus,
} from '@hub/contracts';

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(sql: string): Promise<D1ExecResult>;
  dump(): Promise<ArrayBuffer>;
  withSession<T>(fn: (tx: D1DatabaseSession) => Promise<T>): Promise<T>;
}

export interface D1DatabaseSession {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(col?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Result<T> {
  results: T[];
  success: boolean;
  meta: { duration: number; changes: number; last_row_id: number; served_by?: string };
}

export interface D1ExecResult {
  duration: number;
  count: number;
}

export interface DeviceRow {
  id: string;
  device_code: string;
  display_name: string;
  description: string | null;
  active: number;
  last_seen_at: number | null;
  last_success_at: number | null;
  last_auth_failure_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface DeviceCredentialRow {
  id: string;
  device_id: string;
  token_hash: string;
  token_prefix: string;
  status: 'ACTIVE' | 'ROTATING' | 'REVOKED';
  created_at: number;
  activated_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
}

export interface RawSmsEventRow {
  id: string;
  device_id: string;
  sender: string;
  encrypted_or_protected_body: string | null;
  normalized_body: string | null;
  body_sha256: string;
  app_checksum: string;
  sms_timestamp: number;
  received_at: number;
  classification: Classification;
  parser_status: 'OK' | 'WARN' | 'ERROR';
  parser_id: string | null;
  parser_version: string | null;
  duplicate_of: string | null;
  processing_error: string | null;
  created_at: number;
}

export interface TransactionCandidateRow {
  id: string;
  raw_sms_event_id: string;
  financial_account_id: string | null;
  direction: Direction;
  amount_irr: number | null;
  balance_irr: number | null;
  transaction_reference: string | null;
  bank_timestamp: number | null;
  confidence: number;
  parser_id: string;
  parser_version: string;
  parser_evidence_json: string;
  status: TransactionStatus;
  created_at: number;
  updated_at: number;
}

export interface PaymentClaimRow {
  id: string;
  external_order_id: string;
  customer_reference: string | null;
  expected_amount_irr: number;
  target_financial_account_id: string | null;
  submitted_at: number;
  receipt_url_or_r2_key: string | null;
  source_system: string;
  metadata_json: string;
  status: ClaimStatus;
  paid_clicked_at: number | null;
  receipt_submitted_at: number | null;
  suspect_reason: string | null;
  suspect_metadata_json: string;
  created_at: number;
  updated_at: number;
}

export interface PaymentCardRow {
  id: string;
  financial_account_id: string;
  card_digits: string;
  label: string | null;
  created_at: number;
}

export interface IntegrationEventRow {
  event_id: string;
  source: string;
  external_order_id: string | null;
  processed_at: number;
}

export interface ReconciliationMatchRow {
  id: string;
  transaction_candidate_id: string;
  payment_claim_id: string;
  score: number;
  matching_reasons_json: string;
  mismatch_reasons_json: string;
  status: MatchStatus;
  reviewed_by: string | null;
  reviewed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface FinancialAccountRow {
  id: string;
  bank_name: string;
  display_name: string;
  owner_label: string | null;
  account_type: string;
  account_hint: string | null;
  card_last_four: string | null;
  account_last_four: string | null;
  iban: string | null;
  device_id: string | null;
  active: number;
  status: 'PENDING' | 'ACTIVE' | 'MUTED' | 'DECLINED';
  parser_configuration: string;
  created_at: number;
  updated_at: number;
}

/**
 * Identifier type for `transaction_detected_identifiers` — see
 * migrations/0004_detected_identifiers.sql.
 */
export type IdentifierType = 'ACCOUNT_NUMBER' | 'CARD_LAST_FOUR' | 'IBAN' | 'ACCOUNT_HINT';

export interface TransactionDetectedIdentifierRow {
  id: string;
  transaction_candidate_id: string;
  identifier_type: IdentifierType;
  normalized_value: string;
  display_value_masked: string;
  parser_id: string;
  confidence: number;
  created_at: number;
}

export type ReviewDecision = 'ACCEPTED' | 'REJECTED';

export interface TransactionReviewRow {
  id: string;
  transaction_candidate_id: string;
  decision: ReviewDecision;
  reviewed_by: string;
  reviewer_role: 'ADMIN' | 'REVIEWER';
  reason: string | null;
  comment: string | null;
  reviewed_at: number;
  created_at: number;
  updated_at: number;
}

export interface AccessUserRow {
  id: string;
  email: string;
  display_name: string | null;
  role: 'ADMIN' | 'REVIEWER' | 'READ_ONLY';
  active: number;
  created_at: number;
  updated_at: number;
}

export const SQL = {
  // Account operational lifecycle. PENDING / ACTIVE / MUTED / DECLINED.
  // Only ACTIVE accounts participate in Today, matching, totals, reports,
  // and exports. PENDING is the inbox for newly auto-discovered accounts;
  // MUTED is a temporary exclusion; DECLINED is a "not relevant" archive.
  // See migrations/0010_account_status.sql + packages/domain/accountStatus.ts.
  operationalAccountStatus: `'ACTIVE'`,
  /**
   * Predicate for JOIN-against-account queries. COALESCE keeps unassigned
   * transactions (financial_account_id IS NULL) eligible, which is the
   * historical Today behavior. Set to `'ACTIVE'` to exclude every MUTED /
   * PENDING / DECLINED account.
   */
  accountStatusWhere: `COALESCE(fa.status, 'ACTIVE') = 'ACTIVE'`,
  /** Same predicate but with the `fa` alias. */
  accountStatusWhereFa: `fa.status = 'ACTIVE'`,
  /**
   * Lookup by `financial_accounts` row id, after the JOIN. The dashboard
   * uses this when the LEFT JOIN returned a row but the status is not
   * ACTIVE — the tx is dropped from operational views.
   */

  findActiveDevice: `SELECT * FROM devices WHERE device_code = ?1 AND active = 1 LIMIT 1`,
  findActiveCredentialByPrefix: `SELECT * FROM device_credentials WHERE token_prefix = ?1 AND status = 'ACTIVE' LIMIT 1`,
  updateCredentialLastUsed: `UPDATE device_credentials SET last_used_at = ?2 WHERE id = ?1`,
  touchDeviceSeen: `UPDATE devices SET last_seen_at = ?2 WHERE id = ?1`,
  touchDeviceSuccess: `UPDATE devices SET last_success_at = ?2 WHERE id = ?1`,
  touchDeviceAuthFailure: `UPDATE devices SET last_auth_failure_at = ?2 WHERE id = ?1`,

  insertRawSmsEvent: `INSERT INTO raw_sms_events (id, device_id, sender, normalized_body, body_sha256, app_checksum, sms_timestamp, received_at, classification, parser_status, parser_id, parser_version, duplicate_of, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
  findRawSmsByFingerprint: `SELECT id, duplicate_of FROM raw_sms_events WHERE device_id = ?1 AND body_sha256 = ?2 LIMIT 1`,

  insertTransactionCandidate: `INSERT INTO transaction_candidates (id, raw_sms_event_id, financial_account_id, direction, amount_irr, balance_irr, transaction_reference, bank_timestamp, confidence, parser_id, parser_version, parser_evidence_json, status, processing_disposition, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
  listTransactionCandidatesForDay: `SELECT * FROM transaction_candidates WHERE bank_timestamp BETWEEN ?1 AND ?2 ORDER BY bank_timestamp DESC`,

  /**
   * Canonical predicate for the credit-only product. Every product query
   * MUST include this clause (or its DEBIT counterpart below) so that
   * outgoing transactions never enter the actionable workflow.
   *
   * The clause is a single source of truth — adding a new disposition
   * value does not require touching every query, just this constant.
   */
  actionableTransactionWhere: `t.direction = 'CREDIT' AND t.processing_disposition = 'ACTIONABLE'`,
  /** Match against a tx-candidates alias when the table is `t`. */
  actionableTransactionWhereT: `t.direction = 'CREDIT' AND t.processing_disposition = 'ACTIONABLE'`,
  /** Match against `tc` alias. */
  actionableTransactionWhereTc: `tc.direction = 'CREDIT' AND tc.processing_disposition = 'ACTIONABLE'`,
  /**
   * Predicate for the historical DEBIT cleanup tool: any row that is
   * DEBIT (or UNKNOWN) AND still ACTIONABLE. After the migration runs,
   * this predicate matches zero rows until someone manually flips a
   * DEBIT back to ACTIONABLE.
   */
  outgoingTransactionWhere: `t.direction <> 'CREDIT' AND t.processing_disposition = 'ACTIONABLE'`,

  insertPaymentClaim: `INSERT INTO payment_claims (id, external_order_id, customer_reference, expected_amount_irr, target_financial_account_id, submitted_at, receipt_url_or_r2_key, source_system, metadata_json, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,

  // DEV-only: extended insert that also writes operation_type and purchase_type.
  // Mirzabot (or any future integration) can call this directly when those
  // columns are populated upstream. Production ingestion code keeps using
  // insertPaymentClaim so production D1 (without those columns) is unaffected.
  insertPaymentClaimWithPurchaseType: `INSERT INTO payment_claims (id, external_order_id, customer_reference, expected_amount_irr, target_financial_account_id, submitted_at, receipt_url_or_r2_key, source_system, metadata_json, status, created_at, updated_at, operation_type, purchase_type) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
  listOpenClaimsForAccount: `SELECT * FROM payment_claims WHERE target_financial_account_id = ?1 AND status IN ('PENDING','MATCH_SUGGESTED') ORDER BY submitted_at DESC`,

  insertReconciliationMatch: `INSERT OR IGNORE INTO reconciliation_matches (id, transaction_candidate_id, payment_claim_id, score, matching_reasons_json, mismatch_reasons_json, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  updateMatchStatus: `UPDATE reconciliation_matches SET status = ?2, reviewed_by = ?3, reviewed_at = ?4, updated_at = ?4 WHERE id = ?1 AND status IN ('SUGGESTED','AUTO_VERIFIED')`,
  updateTransactionStatus: `UPDATE transaction_candidates SET status = ?2, updated_at = ?3 WHERE id = ?1`,
  updateClaimStatus: `UPDATE payment_claims SET status = ?2, updated_at = ?3 WHERE id = ?1`,

  insertAudit: `INSERT INTO audit_logs (id, actor_email, actor_role, action, entity_type, entity_id, before_json, after_json, reason, request_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,

  insertComment: `INSERT INTO comments (id, entity_type, entity_id, author_email, author_role, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,

  // Detected identifiers per transaction. INSERT OR IGNORE on the
  // UNIQUE(tx, type, normalized_value) index keeps ingest idempotent.
  insertDetectedIdentifier: `INSERT OR IGNORE INTO transaction_detected_identifiers
       (id, transaction_candidate_id, identifier_type, normalized_value,
        display_value_masked, parser_id, confidence, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  listDetectedIdentifiersForTx: `SELECT * FROM transaction_detected_identifiers
     WHERE transaction_candidate_id = ?1
     ORDER BY identifier_type, normalized_value`,
  // Find transactions whose detected identifier matches (type, value)
  // and are not yet assigned to any account — for the backfill query.
  listUnassignedTxsByIdentifier: `SELECT tdi.transaction_candidate_id AS tx_id,
           tdi.identifier_type, tdi.normalized_value, tdi.parser_id
      FROM transaction_detected_identifiers tdi
      JOIN transaction_candidates tc ON tc.id = tdi.transaction_candidate_id
     WHERE tdi.identifier_type = ?1
       AND tdi.normalized_value = ?2
       AND tc.financial_account_id IS NULL
     LIMIT 5000`,
  deleteDetectedIdentifier: `DELETE FROM transaction_detected_identifiers WHERE id = ?1`,

  // Transaction reviews (one per tx).
  upsertTransactionReview: `INSERT INTO transaction_reviews
       (id, transaction_candidate_id, decision, reviewed_by, reviewer_role,
        reason, comment, reviewed_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
     ON CONFLICT(transaction_candidate_id) DO UPDATE SET
       decision = excluded.decision,
       reviewed_by = excluded.reviewed_by,
       reviewer_role = excluded.reviewer_role,
       reason = excluded.reason,
       comment = excluded.comment,
       reviewed_at = excluded.reviewed_at,
       updated_at = excluded.updated_at`,
  getTransactionReview: `SELECT * FROM transaction_reviews WHERE transaction_candidate_id = ?1`,
};
