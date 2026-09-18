-- 0078_a_movement_the_bank_did_not_text.sql — 2026-09-18.
--
-- The books (0073) assumed every bank movement arrives as an SMS. Production
-- showed otherwise within two days: several banks text a deposit and never a
-- withdrawal, and even where they do, the message can be lost (PR #342). The
-- balances still fall — 16 breaks in the balance chain in the first 19 hours,
-- 106M IRR — and the statement's «اختلاف با بانک» could only show the hole,
-- never let the operator explain it, because every off-books tag hangs off a
-- `transaction_candidates` row and that row needs a raw SMS.
--
-- So: a movement the operator writes down themselves, against the account,
-- with the same categories the off-books tags use. It is off-books by
-- definition — shop money that left without an SMS is an expense, and the
-- expense ledger already carries those (`revenue_adjustments` with an
-- account and no `transaction_candidate_id`). Both now enter the
-- reconciliation, so a gap that stays open is money nobody has explained.
--
-- Voided, never deleted: the row is a statement of what the operator believed
-- on a date, and the audit trail is what the monthly report to the head admin
-- rests on.

CREATE TABLE manual_bank_movements (
  id                   text PRIMARY KEY,
  financial_account_id text NOT NULL REFERENCES financial_accounts(id) ON DELETE CASCADE,
  direction            text NOT NULL CHECK (direction IN ('CREDIT','DEBIT')),
  amount_irr           bigint NOT NULL CHECK (amount_irr > 0),
  -- When the bank moved it — the operator's word, usually the moment just
  -- before the SMS whose balance revealed the hole.
  moved_at             bigint NOT NULL,
  category             text NOT NULL CHECK (category IN ('TRANSFER','PERSONAL','MISTAKE_RETURNED','BANK_FEE','BANK_INTEREST','OTHER')),
  note                 text,
  created_by           text NOT NULL,
  created_at           bigint NOT NULL,
  voided_at            bigint,
  voided_by            text
);

CREATE INDEX idx_manual_bank_movements_live
  ON manual_bank_movements (financial_account_id, moved_at)
  WHERE voided_at IS NULL;
