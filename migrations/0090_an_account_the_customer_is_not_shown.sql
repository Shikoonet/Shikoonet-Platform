-- 0090 — an account can be in the books without being on the customer's invoice.
--
-- Sam, 2026-09-20: «چندتا حساب وارد کنیم که حساب کتابشون و اس ام اس هاشون
-- در سیستم حسابداری ما بیان ولی این حسابها نباید به مشتری نشون داده بشن و
-- در صف قرار بگیرن مگر اینکه ادمین دکمه‌اشون رو روشن کنه».
--
-- `active` could not say that: switching it off takes the account out of
-- «آمار مالی», the books and matching as well as out of the bot's card queue
-- (payment.ts, 2026-09-03). This is the second switch — the queue only.
-- `customer_visible = 0` keeps the account ingesting, matching and summing;
-- the bot just never hands out its cards and the queue does not count them.
--
-- Default 0, so every account made from now on — by hand, by ingest from an
-- unknown text, by an import — stays off the invoice until an operator turns
-- it on. Every account already here keeps behaving as it did: on, except the
-- PENDING ones nobody has claimed yet, which were never shown anyway and
-- should not become so by being accepted later.
--
-- Undone by dropping the column; the picker's WHERE is the only reader.
BEGIN;

ALTER TABLE financial_accounts
  ADD COLUMN customer_visible smallint NOT NULL DEFAULT 0
    CHECK (customer_visible IN (0, 1));
COMMENT ON COLUMN financial_accounts.customer_visible IS
  '1: the bot may hand out this account''s cards and the queue counts them. 0: books only — ingest, matching and sums still run (0090).';

UPDATE financial_accounts SET customer_visible = 1 WHERE status <> 'PENDING';

COMMIT;
