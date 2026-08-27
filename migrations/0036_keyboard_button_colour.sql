-- The colour, on the buttons a shop arranges itself.
--
-- 0034 gave `product_categories` and `product_plans` a `button_style` and the
-- bot puts it on the DATA rows — the categories screen, the plans screen. The
-- chrome those rows sit above is the half a shop actually edits by hand, on
-- «چیدمان کیبورد», and it had no colour at all: «خرید اشتراک» and «بازگشت» were
-- the same grey whatever the shop wanted.
--
-- Same three names as 0034, same CHECK, and deliberately not a shared domain:
-- one ALTER on a second table is a smaller thing to read than a type both
-- tables depend on, and the constraint failure names the table it happened on.
--
-- NULL is «the client's own default», which is what every one of these buttons
-- draws today. Adding the column changes no screen until a shop picks a colour.

BEGIN;

ALTER TABLE bot_keyboard_buttons ADD COLUMN style text;

ALTER TABLE bot_keyboard_buttons ADD CONSTRAINT bot_keyboard_buttons_style
  CHECK (style IS NULL OR style IN ('primary', 'success', 'danger'));

COMMIT;
