-- The tier screen can be arranged, like the two screens either side of it.
--
-- 0032 gave `product_categories` and `product_plans` a `row_index` and left
-- `products` without one, and that was right at the time: a product had no
-- screen. The customer went «خرید اشتراک» → a category → a flat ladder of
-- prices, and the product level existed only in the database.
--
-- It has a screen now. `categoryScreen` draws one button per service —
-- پلاتینیوم, طلایی, نقره‌ای, معمولی — and on the live bot today those four came
-- out as four rows of one, because `productMenu` is the only catalogue keyboard
-- that never learned to ask. The screen before it puts two categories on one
-- row and the screen after it puts two prices on one row; the one in the middle
-- cannot, and an operator has no way to say so.
--
-- Same column, same bound, same shape as 0032 — deliberately, so `groupIntoRows`
-- needs no third idea of what a row is. The bound is 20 because that is the
-- number of rows 0032 fixed on, and a keyboard is one object: three tables
-- disagreeing about how tall a screen may be would be three ways to build a
-- message Telegram refuses.
--
-- NULL keeps meaning «not arranged», which is what every existing row is and
-- what `groupIntoRows` already reads as «a row of its own».

BEGIN;

ALTER TABLE products ADD COLUMN row_index integer
  CONSTRAINT products_row_index_range
  CHECK (row_index IS NULL OR (row_index >= 0 AND row_index < 20));

COMMIT;
