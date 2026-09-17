-- 0072_the_books_know_the_account.sql — Sam, 2026-09-17.
--
-- «بعضی موقع‌ها ادمین از یکی از حساب‌ها خرج را انجام می‌دهد … باید بتواند
-- مشخص کند از کدام حساب برداشت کرده و اگر هزینهٔ تراکنش هم داشت بنویسد.»
-- And: «باید سر ماه به ادمین کل حساب پس بدهم» — a monthly statement per
-- account that ties out to the bank's own balance.
--
-- Three things this file adds, and one thing it deliberately does not.
--
--   1. An expense row can say which account paid it, what the bank charged
--      on top, and which withdrawal SMS it is. `fee_irr` is its own column
--      rather than folded into `amount_irr`, so «کارمزدهای بانکی» stays a
--      number of its own and the books can be compared with the bank line
--      by line. `transaction_candidate_id` is one-to-one while the row is
--      live: two expenses cannot claim the same withdrawal.
--
--   2. «خارج از دفتر»: `income_declined_transactions` grows a `category`.
--      The table already records a credit the operator declared not to be
--      income (the 10.6M «جابه‌جایی» of 2026-09-17 sits there); from 0072
--      the same row covers a DEBIT too — a loan instalment, interest that
--      comes and goes, a relative's deposit sent back — and says WHICH of
--      those it is, so the monthly statement can group them. The old free
--      text stays in `reason` as the note.
--
--   3. `account_opening_balances`: the fresh start. Tonight every account's
--      last bank balance is written here once, and their sum is the shop's
--      wallet on day one. A statement for the first month opens from this
--      row; later months open from the last SMS before the month.
--
-- What it does NOT do: it does not compute a balance. «موجودی فعلی» stays
-- the figure in the last bank SMS (`loadAccountBalances`), and 0072 changes
-- nothing about that. An expense subtracted by us would be subtracted again
-- when the next SMS brings the balance the bank already reduced. The
-- statement explains the bank's movements; it never replaces them.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Expenses: account, fee, withdrawal
-- ---------------------------------------------------------------------------
ALTER TABLE revenue_adjustments
  ADD COLUMN financial_account_id     text   REFERENCES financial_accounts(id) ON DELETE SET NULL,
  ADD COLUMN fee_irr                  bigint NOT NULL DEFAULT 0 CHECK (fee_irr >= 0),
  ADD COLUMN transaction_candidate_id text   REFERENCES transaction_candidates(id) ON DELETE SET NULL;

-- A withdrawal explains at most one live expense.
CREATE UNIQUE INDEX idx_revenue_adjustments_withdrawal
  ON revenue_adjustments(transaction_candidate_id)
  WHERE transaction_candidate_id IS NOT NULL AND voided_at IS NULL;

CREATE INDEX idx_revenue_adjustments_account_day
  ON revenue_adjustments(financial_account_id, spent_on)
  WHERE voided_at IS NULL;

-- The view freezes its column list (0040's warning, 0041's precedent).
-- Re-created rather than replaced so the columns land in a sane order.
DROP VIEW shop_books;
CREATE VIEW shop_books AS
  SELECT id, amount_irr, note, created_by, created_at, legacy_id,
         kind, category_id, spent_on, recurrence_id,
         currency, original_amount, fx_rate_irr,
         financial_account_id, fee_irr, transaction_candidate_id
    FROM revenue_adjustments
   WHERE voided_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Off the books, with a category
-- ---------------------------------------------------------------------------
ALTER TABLE income_declined_transactions
  ADD COLUMN category text NOT NULL DEFAULT 'OTHER'
    CHECK (category IN ('TRANSFER', 'PERSONAL', 'MISTAKE_RETURNED', 'BANK_FEE', 'BANK_INTEREST', 'OTHER'));

-- One LIVE tag per movement, history kept. 0004 made `transaction_candidate_id`
-- UNIQUE outright, so a movement put back on the books could never be taken
-- off again — the restored row still held the key. Nobody hit it while the
-- button was a rarity; with a loan instalment every month it would be the
-- first thing the operator hit.
ALTER TABLE income_declined_transactions
  DROP CONSTRAINT income_declined_transactions_transaction_candidate_id_key;
CREATE UNIQUE INDEX idx_income_declined_live
  ON income_declined_transactions(transaction_candidate_id)
  WHERE restored_at IS NULL;

-- The five rows production had on 2026-09-17: one «jabejaei», one «اشتباه»,
-- three with nothing useful. Only the two that say something are mapped.
UPDATE income_declined_transactions SET category = 'TRANSFER'
 WHERE lower(COALESCE(reason, '')) IN ('jabejaei', 'jabeja', 'جابجایی', 'جابه‌جایی', 'جابه جایی');
UPDATE income_declined_transactions SET category = 'MISTAKE_RETURNED'
 WHERE COALESCE(reason, '') IN ('اشتباه', 'اشتباهی');

-- ---------------------------------------------------------------------------
-- 3. The fresh start
-- ---------------------------------------------------------------------------
CREATE TABLE account_opening_balances (
  financial_account_id text   PRIMARY KEY REFERENCES financial_accounts(id) ON DELETE CASCADE,
  balance_irr          bigint NOT NULL,
  -- The bank timestamp of the SMS the balance was read from; the statement
  -- counts movements strictly after it.
  as_of                bigint NOT NULL,
  transaction_candidate_id text REFERENCES transaction_candidates(id) ON DELETE SET NULL,
  created_by           text   NOT NULL,
  created_at           bigint NOT NULL
);

COMMIT;
