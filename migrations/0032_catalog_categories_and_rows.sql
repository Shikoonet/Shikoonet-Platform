-- The shop's first screen becomes the category list, and the admin gets to say
-- where the rows break.
--
-- WHY `category_id` STOPS BEING OPTIONAL. `product_categories` has been in the
-- schema since 0002 with zero rows, and `products.category_id` is NULL on every
-- row in production — nothing has ever read it. The moment the bot's first
-- screen IS the category list, a product with no category has no button, and
-- none of its plans can be reached from anywhere: an empty shop for every
-- customer, with nothing on any screen saying so.
--
-- There were two ways to deal with that. The first was a synthetic «سایر»
-- bucket in the bot for uncategorised products, and it was rejected: a code
-- path that only runs when the data is already wrong is a path nobody ever
-- watches fire. The backfill plus NOT NULL makes the state unrepresentable
-- instead — which is the same choice this schema already makes everywhere it
-- can, and the reason `payment_claims` keeps its guarantee in an index rather
-- than in the application.
--
-- This is exactly the failure the panel we are replacing ships with:
-- `product.category` there is free text matched against a separate `category`
-- table by string comparison in PHP, because the direct join threw an illegal
-- mix of collations. A category value with no matching row makes the product
-- invisible in the shop, silently. Here the value is a foreign key and the
-- database refuses the state.
--
-- WHY THE FOREIGN KEY HAS TO CHANGE WITH IT. `ON DELETE SET NULL` (0002:71)
-- plus NOT NULL means deleting a category raises a not-null violation at a
-- moment nobody chose — halfway through a delete the admin thought was
-- allowed. RESTRICT says the same thing at the moment they pressed the button,
-- in the voice `provider_id` has used since 0002.
--
-- ORDER MATTERS BELOW: the UPDATE must precede SET NOT NULL. Reordered, this
-- migration fails loudly on a not-null violation rather than applying half of
-- itself — which is the right direction for this particular mistake.
--
-- WHY `row_index` IS NULLABLE, AND WHY THERE IS NO `col_index`.
--
-- NULL means «this screen was never arranged», and the bot reads that as one
-- button per row — which is exactly what `productMenu` and `planMenu` hardcode
-- today. So every existing row keeps its NULL, no backfill runs against it, and
-- nothing on any customer's screen moves the day this ships. `NOT NULL DEFAULT
-- 0` would put every button of a screen into row zero, which Telegram refuses
-- outright.
--
-- The column position is `sort_order`, which both tables already carry and
-- which every ordering query already reads. A second coordinate column would be
-- a second answer to «what order is this list in», and four contradictory
-- answers across four code paths is the state of the panel being replaced.
--
-- WHY THIS IS NOT `bot_keyboard_buttons`, AND MUST NOT BE MERGED INTO IT LATER.
-- That table is keyed on a closed action set validated against `MENUS`; a row
-- naming an action nobody declared is dropped by `isMenuAction`. This one is
-- keyed on database rows that come and go. Merging them would put
-- `isMenuAction` in front of a plan id.

BEGIN;

-- 1. Every product gets a category, and cannot lose it again.

INSERT INTO product_categories (name, sort_order)
     VALUES ('سرویس‌ها', 0)
ON CONFLICT (name) DO NOTHING;

UPDATE products
   SET category_id = (SELECT id FROM product_categories WHERE name = 'سرویس‌ها')
 WHERE category_id IS NULL;

ALTER TABLE products ALTER COLUMN category_id SET NOT NULL;

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_category_id_fkey;
ALTER TABLE products ADD  CONSTRAINT products_category_id_fkey
  FOREIGN KEY (category_id) REFERENCES product_categories(id) ON DELETE RESTRICT;

-- 2. What a category looks like on a button, and whether it is on sale at all.
--
-- `active = false` is a decision, not a trap: it takes the category's products
-- off the shop, and the screen says how many before it lets an operator do it.
-- Deleting a category is what RESTRICT above refuses; switching it off is the
-- thing an operator actually wants when a tier is retired for a month.

ALTER TABLE product_categories
  ADD COLUMN emoji  text,
  ADD COLUMN active boolean NOT NULL DEFAULT true;

-- 3. Where the admin broke the rows.

ALTER TABLE product_categories ADD COLUMN row_index integer
  CONSTRAINT product_categories_row_index_range
  CHECK (row_index IS NULL OR (row_index >= 0 AND row_index < 20));

ALTER TABLE product_plans ADD COLUMN row_index integer
  CONSTRAINT product_plans_row_index_range
  CHECK (row_index IS NULL OR (row_index >= 0 AND row_index < 20));

-- 4. The shop's two new reads.
--
-- The category list is now on the path of every «خرید اشتراک», and the join
-- from products to their category is on the path of every category screen.

CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_categories_shop   ON product_categories(sort_order, id)
  WHERE active;

COMMIT;
