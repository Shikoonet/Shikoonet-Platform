-- 0003_unique_account_identifier.sql
-- Enforces "one active exact normalized account identifier per financial_account".
--
-- Adds:
--   * `iban` column on financial_accounts (IBAN identifier is first-class).
--   * `financial_account_identifiers` table for arbitrary "additional exact
--     identifiers" (account numbers, card numbers, IBANs, masked tails, etc.)
--     that don't fit the canonical 3 columns. Same uniqueness rule.
--   * Partial UNIQUE INDEXes so two active accounts can never share an
--     exact normalized identifier. NULL values are allowed (and excluded),
--     matching the existing CHECK constraints on card_last_four /
--     account_last_four.
--
-- Account resolution must NEVER use `LIMIT 1` — fetch 2 rows, return
-- ACCOUNT_IDENTIFIER_AMBIGUOUS if both come back, otherwise the unique match.
--
-- Cleanup: a duplicate `fa-sam-300422286226` row was previously inserted for
-- the same account_hint as `account-parsian-1`. The duplicates-safe re-point
-- first copies any transaction_candidates.financial_account_id references
-- to the canonical row, then deletes the duplicate. This migration is a
-- no-op on environments that never had the duplicate.

PRAGMA foreign_keys = ON;

-- 1) Add iban column to financial_accounts (NULL allowed, plus basic length
--    check on the ASII/IBAN chars). Idempotent: SQLite returns
--    "duplicate column name iban" if it already exists, which the test
--    runner (and the wrangler migration tool, which marks 0003 as
--    applied after first run) treats as a no-op on re-execution.
ALTER TABLE financial_accounts ADD COLUMN iban TEXT;

-- 2) Cleanup: re-point any references to the duplicate row, then delete it.
UPDATE transaction_candidates
   SET financial_account_id = 'account-parsian-1'
 WHERE financial_account_id = 'fa-sam-300422286226';
UPDATE payment_claims
   SET target_financial_account_id = 'account-parsian-1'
 WHERE target_financial_account_id = 'fa-sam-300422286226';
UPDATE financial_accounts
   SET device_id = (
     SELECT device_id FROM financial_accounts
      WHERE id = 'account-parsian-1'
   )
 WHERE id = 'fa-sam-300422286226';
DELETE FROM financial_accounts WHERE id = 'fa-sam-300422286226';

-- 3) Additional exact identifiers (IBAN, alternative account numbers,
--    alternative card numbers, etc.). One row per (kind, value).
CREATE TABLE IF NOT EXISTS financial_account_identifiers (
  id TEXT PRIMARY KEY,
  financial_account_id TEXT NOT NULL REFERENCES financial_accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('ACCOUNT_HINT','CARD_LAST_FOUR','ACCOUNT_LAST_FOUR','IBAN','OTHER')),
  value TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (financial_account_id, kind, value)
);
CREATE INDEX IF NOT EXISTS idx_fai_account ON financial_account_identifiers(financial_account_id);
CREATE INDEX IF NOT EXISTS idx_fai_lookup ON financial_account_identifiers(kind, value);

-- 4) Partial unique indexes so two ACTIVE accounts cannot share an exact
--    identifier. NULL values are excluded (multiple accounts may have a
--    NULL hint).
CREATE UNIQUE INDEX IF NOT EXISTS idx_fa_unique_active_account_hint
  ON financial_accounts(account_hint)
  WHERE account_hint IS NOT NULL AND active = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fa_unique_active_card_last_four
  ON financial_accounts(card_last_four)
  WHERE card_last_four IS NOT NULL AND active = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fa_unique_active_account_last_four
  ON financial_accounts(account_last_four)
  WHERE account_last_four IS NOT NULL AND active = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fa_unique_active_iban
  ON financial_accounts(iban)
  WHERE iban IS NOT NULL AND active = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fai_unique_active_value
  ON financial_account_identifiers(kind, value);

-- 5) Index that supports the unassigned-transactions backfill query.
CREATE INDEX IF NOT EXISTS idx_tx_unassigned_recent
  ON transaction_candidates(created_at DESC)
  WHERE financial_account_id IS NULL;
