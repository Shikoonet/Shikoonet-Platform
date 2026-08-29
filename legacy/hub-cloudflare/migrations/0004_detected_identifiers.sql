-- 0004_detected_identifiers.sql
--
-- Per-transaction account-identifier detection.
--
-- Each parser extracts one or more account/card/IBAN identifiers from the
-- SMS body. They are persisted in `transaction_detected_identifiers` so the
-- dashboard can show them, the assignment flow can choose one to assign,
-- and the historical backfill can match them exactly.
--
-- Why a separate table (instead of reusing parser_evidence_json):
--   * Queryable — backfill joins on (identifier_type, normalized_value).
--   * Idempotent — UNIQUE(transaction_candidate_id, identifier_type, normalized_value).
--   * Auditable — every parsed identifier the worker has ever seen is here.
--   * Backfillable from existing parser_evidence_json for already-ingested
--     transactions via scripts/backfill-detected-identifiers.ts.
--
-- Normalized form rules:
--   * ACCOUNT_NUMBER : digits + ".", trimmed, no leading zeros. Preserves
--     meaningful dots (e.g. "110.9992.2377306.1").
--   * CARD_LAST_FOUR : exactly 4 digits.
--   * IBAN           : uppercased alnum, no spaces.
--   * ACCOUNT_HINT   : digits only, first 8+ digit run on the account
--     line (Persian/Arabic digits normalised to 0-9).
--
-- masked_value: a UI-safe shape with middle characters replaced by `*`.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS transaction_detected_identifiers (
  id TEXT PRIMARY KEY,
  transaction_candidate_id TEXT NOT NULL REFERENCES transaction_candidates(id) ON DELETE CASCADE,
  identifier_type TEXT NOT NULL CHECK (identifier_type IN (
    'ACCOUNT_NUMBER', 'CARD_LAST_FOUR', 'IBAN', 'ACCOUNT_HINT'
  )),
  normalized_value TEXT NOT NULL,
  display_value_masked TEXT NOT NULL,
  parser_id TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_at INTEGER NOT NULL,
  UNIQUE (transaction_candidate_id, identifier_type, normalized_value)
);

CREATE INDEX IF NOT EXISTS idx_tdi_tx
  ON transaction_detected_identifiers(transaction_candidate_id);
CREATE INDEX IF NOT EXISTS idx_tdi_normalized
  ON transaction_detected_identifiers(identifier_type, normalized_value);
-- Composite index for the backfill: find unassigned txs whose identifiers
-- match a particular (type, value).
CREATE INDEX IF NOT EXISTS idx_tdi_unassigned
  ON transaction_detected_identifiers(identifier_type, normalized_value)
  WHERE identifier_type = 'ACCOUNT_NUMBER';

-- Adapter view: a flat virtual table that exposes *the same* logical
-- identifier columns as financial_account_identifiers but for transactions,
-- which keeps the backfill SQL simple and symmetrical.
CREATE VIEW IF NOT EXISTS v_account_identifier_value AS
  SELECT 'ACCOUNT_NUMBER' AS identifier_type, normalized_value AS normalized_value,
         transaction_candidate_id AS tx_id
    FROM transaction_detected_identifiers
   WHERE identifier_type = 'ACCOUNT_NUMBER'
   UNION ALL
  SELECT 'CARD_LAST_FOUR', normalized_value, transaction_candidate_id
    FROM transaction_detected_identifiers
   WHERE identifier_type = 'CARD_LAST_FOUR'
   UNION ALL
  SELECT 'IBAN', normalized_value, transaction_candidate_id
    FROM transaction_detected_identifiers
   WHERE identifier_type = 'IBAN'
   UNION ALL
  SELECT 'ACCOUNT_HINT', normalized_value, transaction_candidate_id
    FROM transaction_detected_identifiers
   WHERE identifier_type = 'ACCOUNT_HINT';
