-- 0015_bot_content.sql — the bot's wording and its main keyboard, editable.
--
-- Until now every sentence the customer reads and every button they press was a
-- string literal in `apps/bot/src/menu.ts`, so changing «خرید اشتراک» meant a
-- deploy. Mirzabot has no table for this either — its texts are in the PHP
-- source, and the production dump has no `textbot` table — so there is nothing
-- to migrate. These two tables are new.
--
-- ## Both tables hold overrides, not content
--
-- The default of every text and every button stays in the source. A row here
-- exists only where an admin has changed something, which has three
-- consequences worth stating:
--
--   * A bot with an empty `bot_texts` behaves exactly as it does today.
--   * "Reset to default" is DELETE, not a copy of the original back over it —
--     so a default improved in a later release reaches a shop that never
--     customised that line.
--   * A text nobody has touched cannot be broken by a bad edit, because there
--     is nothing to edit.
--
-- The alternative — seeding every default as a row — makes the database the
-- source of truth for wording that the code must still contain anyway (the bot
-- cannot render a screen whose text failed to load), and then the two drift.
--
-- ## Why the keyboard is all-or-nothing
--
-- `bot_texts` overrides one key at a time, which is safe: keys are independent.
-- A keyboard is not — a button's meaning depends on where the others are. A
-- partially overridden layout would have to answer "the admin moved button 3,
-- and a release then added button 7; where does it go?", and every answer is a
-- surprise. So either the table is empty and the code's layout is used whole,
-- or it holds the entire layout. `bot_keyboard_buttons.action` is the callback
-- the button fires and is checked against the code's known set on write: a row
-- naming an action the bot does not handle is a button that does nothing.

BEGIN;

CREATE TABLE bot_texts (
  -- The registry key in `apps/bot/src/texts.ts`, not free-form. A key the code
  -- does not know is a row nothing will ever read; the write path refuses it.
  key        text        PRIMARY KEY,
  value      text        NOT NULL CHECK (btrim(value) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

-- Telegram rejects a message body over 4096 characters, and the bot would then
-- fail to answer at all rather than answer badly. Enforced here as well as in
-- the API because this is the boundary that cannot be bypassed.
ALTER TABLE bot_texts ADD CONSTRAINT bot_texts_length_check
  CHECK (length(value) <= 4096);

CREATE TABLE bot_keyboard_buttons (
  action     text        PRIMARY KEY,
  label      text        NOT NULL CHECK (btrim(label) <> ''),
  -- Telegram truncates a long inline button and the row stops being readable.
  -- 64 is the practical ceiling for one that still fits on a phone.
  CONSTRAINT bot_keyboard_label_length CHECK (length(label) <= 64),
  row_index  integer     NOT NULL CHECK (row_index >= 0 AND row_index < 20),
  -- Telegram allows 8 buttons in an inline row; more than three is unreadable
  -- in Persian on a phone, which is why the production layout uses two and
  -- three. The wider bound is the protocol's, not a taste.
  col_index  integer     NOT NULL CHECK (col_index >= 0 AND col_index < 8),
  visible    boolean     NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  -- Two buttons cannot occupy one cell. Without this a layout can be saved that
  -- renders in an order decided by the query plan.
  UNIQUE (row_index, col_index)
);

COMMIT;
