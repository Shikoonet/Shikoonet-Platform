-- 0106_support_answers_know_how_customers_ask.sql — Sam, 2026-09-26.
--
-- The support bot's answers (0105) grow from ten to the two hundred read out
-- of 1,728 support chats. With that many, the bot is no longer handed the
-- whole list: it is shown every question, picks the ones that fit the
-- customer's message, and only those answers are read back. What that needs:
--
--   variants   — how real customers asked it, one per line. Shown to the
--                bot beside the question so it recognises «نمیشه» and
--                «سرویسم نمیاد» as the same question.
--   category   — the reader's grouping (connection, renewal, reseller …),
--                for the panel's filter.
--   hand_off   — the right reply is a person, not this text: a deposit to
--                confirm, a reseller to price. The bot passes these on.
--   note       — for the admin reviewing the row: values that change
--                (prices, app names) and why a person is needed.
--   source_key — the dataset's own id, so importing the file again adds the
--                new rows and leaves the ones already here, edited or not.
--
-- Undo: ALTER TABLE support_answers DROP COLUMN variants, DROP COLUMN category,
--       DROP COLUMN hand_off, DROP COLUMN note, DROP COLUMN source_key;

BEGIN;

ALTER TABLE support_answers
  ADD COLUMN variants   text    NOT NULL DEFAULT '' CHECK (length(variants) <= 4000),
  ADD COLUMN category   text    NOT NULL DEFAULT '' CHECK (length(category) <= 60),
  ADD COLUMN hand_off   boolean NOT NULL DEFAULT false,
  ADD COLUMN note       text    NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  ADD COLUMN source_key text    UNIQUE CHECK (source_key IS NULL OR length(source_key) BETWEEN 1 AND 80);

COMMIT;
