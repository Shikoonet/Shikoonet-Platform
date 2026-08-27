-- «نیو» on one button and «آف» on the next — the one thing a shop screen could
-- not say.
--
-- WHY THE COLUMN IS RENAMED RATHER THAN JOINED BY A SECOND ONE.
--
-- `product_categories.emoji` (0032:82) was never really «an emoji». It is the
-- text drawn immediately before the name on a button, and 0032 sized it at 16
-- characters precisely because a single code point was never going to be all of
-- it. Adding a `badge` column beside it would put TWO prefix fields on one
-- button, in one form, with no honest sentence telling an operator which of
-- them «🆕» belongs in — and whichever one they picked, the other would sit
-- empty forever. One field, named after what it does.
--
-- The rename is a breaking change for exactly as long as a deploy takes, and
-- that is the same bargain 0032 already made when it turned `category_id` NOT
-- NULL under a running bot. Nothing outside this repository reads the column.
--
-- WHY COLOUR IS TEXT AND NOT A `colour` COLUMN.
--
-- Telegram inline buttons have no colour. None: not the label, not the
-- background, not on any client. The only colour that ever reaches a customer's
-- screen is a coloured square they can read as a character — 🔴 🟢 🔵 — which
-- means «colour» here IS badge text and a separate column could only ever be
-- decoration for the admin panel that the shop never shows. The panel offers
-- the squares as one-click chips instead, so the operator picks a colour and
-- the database stores the thing Telegram will actually draw.
--
-- WHY THE LENGTH IS 24 AND WHY IT IS A CHECK.
--
-- A button label is one line on a phone, shared with a name and — one screen
-- down — a price. 0032's 16 fits «🆕 نیو» and not «🔴 🆕 نیو ویژه»; 24 fits the
-- second and still cannot push a name off its own button. It is a CHECK rather
-- than a `varchar(24)` for the same reason every other bound in this schema is:
-- `length()` counts characters, and the failure names the constraint.

BEGIN;

ALTER TABLE product_categories RENAME COLUMN emoji TO badge;

ALTER TABLE product_plans ADD COLUMN badge text;

-- One rule, applied to both, so the two screens cannot drift into different
-- ideas of what fits on a button.
ALTER TABLE product_categories ADD CONSTRAINT product_categories_badge_len
  CHECK (badge IS NULL OR (length(badge) BETWEEN 1 AND 24));

ALTER TABLE product_plans ADD CONSTRAINT product_plans_badge_len
  CHECK (badge IS NULL OR (length(badge) BETWEEN 1 AND 24));

COMMIT;
