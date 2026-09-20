-- 0086 — a discount code may be for several services, not one or all.
--
-- Sam, 2026-09-20: «تمام سرویس‌ها رو بیاره، من تیک بزنم بگم این سرویس رو
-- می‌خوام، این سرویس رو می‌خوام — رو اینا فقط اعمال بشه، رو بقیه نه».
--
-- `discount_codes.product_id` (0002) held ONE service, which is what the
-- legacy `DiscountSell.code_product` could say. A checklist needs a row per
-- service, so the column becomes a table and its rows move over first. An
-- empty set keeps the old meaning of NULL: the code is for every service.
--
-- Cascades both ways, as the column did: a deleted code takes its scope with
-- it, and `productRoutes` still refuses to delete a service a code names.
-- Not undone by dropping the table — the column is gone after this — so the
-- rows of `discount_codes.product_id` at the time of the run are only in the
-- new table from here.
BEGIN;

CREATE TABLE discount_code_products (
  code_id    bigint NOT NULL REFERENCES discount_codes(id) ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (code_id, product_id)
);
COMMENT ON TABLE discount_code_products IS
  'The services a discount code is for. No row for a code means every service.';

INSERT INTO discount_code_products (code_id, product_id)
SELECT id, product_id FROM discount_codes WHERE product_id IS NOT NULL;

ALTER TABLE discount_codes DROP COLUMN product_id;

COMMIT;
