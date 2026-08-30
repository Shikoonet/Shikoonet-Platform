-- The two halves of the approved plan that 0040 left unbuilt: a bill paid in a
-- currency the shop does not keep its books in, and a bill that arrives again
-- next month.
--
-- Both are the same case Sam named — «هزینه یک ماهه سرور آلمان» — which is
-- billed in euro and billed again in thirty days. 0040 could record it once, in
-- Toman, with the rate lost.
--
-- NOTHING HERE MOVES MONEY. Every column added is NULL or a default on all 219
-- imported rows, `amount_irr` appears in no SET list, and the DO block at the
-- end asserts the sum and the row count are unchanged the same way 0040 did.
-- `verify.ts` compares our sum against the legacy panel's printed total to the
-- Rial and must stay green across this file.

BEGIN;

CREATE TEMP TABLE _books_before_0041 ON COMMIT DROP AS
  SELECT COALESCE(SUM(amount_irr), 0) AS total_irr, count(*) AS rows FROM revenue_adjustments;

-- ---------------------------------------------------------------------------
-- 1. A row can name the currency the money actually left in
-- ---------------------------------------------------------------------------
--
-- `amount_irr` STAYS THE ONLY FIGURE ANYTHING ADDS UP. These three columns are
-- the receipt, not the amount: they record what was on the invoice and what the
-- rate was on the day, so «چرا این ماه ۴۲ میلیون بود و ماه قبل ۳۸؟» has an
-- answer that is not «نمی‌دانم». Every total, every breakdown, every export and
-- `verify.ts` itself keep reading `amount_irr` and cannot be affected by a
-- currency they never look at.
--
-- THE RATE IS STORED, NOT LOOKED UP. There is no rate feed on this server and
-- there should not be one: an expense is worth what it cost on the day it was
-- paid, and a report that silently re-values last Mordad's server bill at
-- today's rate is a book that changes when nobody touched it. This is the
-- transaction-date convention, and storing the original amount beside the rate
-- is what makes it auditable rather than merely recorded.
--
-- `numeric`, not `bigint`, for both: 0.5 TON is a real amount and a TON rate
-- is not a whole number of Rial. Money the books are kept in is still integer
-- IRR — this is the foreign side of the conversion, and it is the only place
-- in this platform where a fraction is allowed to exist.
ALTER TABLE revenue_adjustments
  ADD COLUMN currency        text NOT NULL DEFAULT 'IRR',
  ADD COLUMN original_amount numeric(20, 6),
  -- Rial per ONE unit of `currency`, on `spent_on`. IRR and not Toman because
  -- every stored figure in this platform is IRR; the form asks in Toman and
  -- multiplies by ten at the edge, exactly like `amount_irr` itself.
  ADD COLUMN fx_rate_irr     numeric(20, 6),
  ADD CONSTRAINT revenue_adjustments_currency
    CHECK (currency IN ('IRR', 'EUR', 'USD', 'TON')),
  -- All three or none. A currency with no rate is a row whose Toman figure
  -- cannot be explained, and a rate with no currency is a number with no unit —
  -- both are worse than not recording it at all.
  ADD CONSTRAINT revenue_adjustments_fx_complete CHECK (
    (currency =  'IRR' AND original_amount IS NULL AND fx_rate_irr IS NULL)
    OR
    (currency <> 'IRR' AND original_amount > 0     AND fx_rate_irr > 0));

-- The view freezes its column list at creation, which 0040's own comment warned
-- about — this is that moment. `CREATE OR REPLACE` may append columns at the
-- end of the list and may not reorder or retype the existing ones, so the first
-- ten are repeated verbatim.
CREATE OR REPLACE VIEW shop_books AS
  SELECT id, amount_irr, note, created_by, created_at, legacy_id,
         kind, category_id, spent_on, recurrence_id,
         currency, original_amount, fx_rate_irr
    FROM revenue_adjustments
   WHERE voided_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. A recurrence can be yearly
-- ---------------------------------------------------------------------------
--
-- 0040 created `expense_recurrences` with a single `next_due_on` and a comment
-- committing to a Jalali month. A domain renewal is yearly and «دامنه» is
-- already one of the seeded categories, so monthly-only would have shipped a
-- table that could not hold a row the category list implies.
--
-- Advanced by the route using `packages/contracts/src/jalali.ts`, never by
-- `+ interval '1 month'`: Jalali months are 29 to 31 days on a 33-year leap
-- cycle, and a server bill due 31 Mordad has no 31st in Aban.
ALTER TABLE expense_recurrences
  ADD COLUMN period text NOT NULL DEFAULT 'MONTHLY'
    CHECK (period IN ('MONTHLY', 'YEARLY'));

-- What the screen asks on every load: which templates are owed, oldest first.
-- Partial on `active`, because an archived template is never due by definition
-- and there is no query that wants one.
CREATE INDEX idx_expense_recurrence_due
  ON expense_recurrences (next_due_on) WHERE active;

-- ---------------------------------------------------------------------------
-- 3. Prove it moved nothing
-- ---------------------------------------------------------------------------

DO $$
DECLARE before_row record; after_row record;
BEGIN
  SELECT * INTO before_row FROM _books_before_0041;
  SELECT COALESCE(SUM(amount_irr), 0) AS total_irr, count(*) AS rows
    INTO after_row FROM revenue_adjustments;

  IF before_row.total_irr <> after_row.total_irr OR before_row.rows <> after_row.rows THEN
    RAISE EXCEPTION
      'adding currency moved the books: % rows / % IRR became % rows / % IRR',
      before_row.rows, before_row.total_irr, after_row.rows, after_row.total_irr;
  END IF;
END $$;

COMMIT;
