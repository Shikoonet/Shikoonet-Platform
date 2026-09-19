-- 0083_the_customer_has_a_first_name.sql — 2026-09-19.
--
-- Mirzabot's reports print «نام کاربر» — the Telegram first name — on the
-- trial report and on «🎉یک کاربر جدید ربات را استارت کرد». Sam, 2026-09-19:
-- the group has to read exactly like mirzabot's. The name was never stored
-- here; `upsertUser` writes it from now on, and a customer seen before this
-- migration gets it on their next message.
--
-- Nullable and plain text, like `username` beside it. Nothing reads it but
-- the two reports.

BEGIN;

ALTER TABLE users ADD COLUMN first_name text;

COMMENT ON COLUMN users.first_name IS
  'Telegram first name as last seen — for the reports group only (0083).';

COMMIT;
