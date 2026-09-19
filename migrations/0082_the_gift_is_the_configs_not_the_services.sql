-- 0082_the_gift_is_the_configs_not_the_services.sql — 2026-09-19.
--
-- 0081 put `bonus_percent` on `products`, one number for every config under
-- a service. Sam, the same evening, on seeing it: «هم کار نمی‌کنه هم جاش درست
-- نیست» — the gift is chosen config by config («ستاشون رو از پنج تا انتخاب
-- می‌کنم … ۲۰٪ حجم اضافه»), so it belongs on `product_plans`, beside the
-- badge and colour that are picked the same way.
--
-- The column moves; the pipe behind it does not. `orders.bonus_volume_gb`
-- (0062) still freezes the gigabytes at «سفارش», `provision.ts` still sends
-- that number, and a code's bonus still adds on top. Same range, same
-- default: 0 ≤ p ≤ 100, and 0 is «no gift».
--
-- The values are carried down before the old column goes, so a service that
-- was given +20٪ under 0081 keeps it on every config it had — nothing an
-- admin set is lost by the move. 0081 shipped hours before this, so on most
-- databases that UPDATE touches nothing.

BEGIN;

ALTER TABLE product_plans
  ADD COLUMN bonus_percent numeric(5,2) NOT NULL DEFAULT 0
    CHECK (bonus_percent >= 0 AND bonus_percent <= 100);

UPDATE product_plans pl
   SET bonus_percent = p.bonus_percent
  FROM products p
 WHERE p.id = pl.product_id AND p.bonus_percent > 0;

ALTER TABLE products DROP COLUMN bonus_percent;

COMMIT;
