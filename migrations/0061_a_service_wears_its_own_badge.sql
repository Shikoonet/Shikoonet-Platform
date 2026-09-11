-- 0061 — a service gets a badge and a colour of its own.
--
-- ## The screen that had neither
--
-- The shop is three screens deep: categories → services (the tiers: الماس,
-- طلایی, پلاتینیوم) → plans with prices. 0033 and 0034 gave the first and
-- third screens a badge and a button colour, and left the middle one out on
-- purpose — `catalog.ts` explained that a service holding one plan wears that
-- plan's badge, and a service holding several «has three answers and therefore
-- none». That was true and it was the wrong conclusion: the tier screen is
-- exactly where an operator wants «💎 الماس» in blue next to «🥇 طلایی» in
-- green, and a service with five plans is the common case, not the edge.
--
-- Sam, 2026-09-11: «داخل چیدمان محصولات هم بشه رنگبندی و ایموجی پرمیوم اضافه
-- کرد».
--
-- ## Same columns, same rules, same names
--
-- `badge` and `button_style` on `products`, with the constraints copied
-- verbatim from the two sibling tables — including 0060's measure, which
-- counts a `<tg-emoji>` tag as the one glyph it draws. One rule on three
-- tables, so the three screens cannot drift into different ideas of what
-- fits on a button. The single-plan fallback in `catalog.ts` stays: a
-- service with no badge of its own and exactly one plan still borrows that
-- plan's, so nothing a shop already shows changes on deploy.

BEGIN;

ALTER TABLE products ADD COLUMN badge text;
ALTER TABLE products ADD COLUMN button_style text;

ALTER TABLE products ADD CONSTRAINT products_badge_len
  CHECK (badge IS NULL
         OR (length(regexp_replace(badge, '<tg-emoji[^>]*>(.*?)</tg-emoji>', '\1', 'g'))
             BETWEEN 1 AND 24));

ALTER TABLE products ADD CONSTRAINT products_button_style
  CHECK (button_style IS NULL OR button_style IN ('primary', 'success', 'danger'));

COMMIT;
