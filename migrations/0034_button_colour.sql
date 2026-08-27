-- A category's button in blue, a plan's in green — the colour 0033 said did
-- not exist.
--
-- WHY THIS CONTRADICTS 0033.
--
-- 0033 wrote «Telegram inline buttons have no colour. None: not the label, not
-- the background, not on any client», and stored a coloured square in the badge
-- text because a square was the only colour a customer could see. That was true
-- when it was written. Bot API 9.4, 9 February 2026, added `style` to
-- InlineKeyboardButton and KeyboardButton: "danger" (red), "success" (green),
-- "primary" (blue), and omitted means the client's own default. The square is
-- now the workaround for a thing the API does properly.
--
-- `badge` stays exactly as it is. It is TEXT drawn in front of a name — «🆕»,
-- «آف ۳۰٪» — and a colour is not text; the two say different things and an
-- operator wants both on «🔥 آف» in red. What changes is that the panel stops
-- offering coloured squares as the way to get a colour.
--
-- WHY A CHECK AND NOT AN ENUM.
--
-- Three values that Telegram owns, not us. When 9.x adds a fourth, a CHECK is
-- one line in a migration; a Postgres enum is a type rewrite, and every type
-- in this schema that could have been an enum — `status`, `kind` — is a CHECK
-- for that same reason. NULL is «no style», which is what omitting the field
-- means to Telegram, so the absence of a row value and the absence of a JSON
-- key are the same absence.

BEGIN;

ALTER TABLE product_categories ADD COLUMN button_style text;

ALTER TABLE product_plans ADD COLUMN button_style text;

-- One rule on both, for the reason 0033 gave for its own pair: two screens with
-- two ideas of what a button may be is how the panel being replaced drifted.
ALTER TABLE product_categories ADD CONSTRAINT product_categories_button_style
  CHECK (button_style IS NULL OR button_style IN ('primary', 'success', 'danger'));

ALTER TABLE product_plans ADD CONSTRAINT product_plans_button_style
  CHECK (button_style IS NULL OR button_style IN ('primary', 'success', 'danger'));

COMMIT;
