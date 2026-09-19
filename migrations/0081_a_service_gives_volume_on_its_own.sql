-- 0081_a_service_gives_volume_on_its_own.sql — 2026-09-19.
--
-- Sam: «می‌خوام یه سری سرویس‌ها رو درصد حجم اضافه بهشون بدم — مثلاً ۱۰٪،
-- ۲۰٪ حجم اضافه … توی ویرایش سرویس بتونم انتخاب کنم» (issue #373).
--
-- 0062 built the whole delivery pipe for extra gigabytes — a BONUS_PERCENT
-- code, `bonusGbFor()`, `orders.bonus_volume_gb`, `withBonus()` in
-- provision.ts — with one way in: a code the customer types. This is the
-- second way in: a percent on the SERVICE itself, applied to every config
-- under it, for every customer, with nothing to type.
--
-- On `products`, not `product_plans`: Sam named services («الماس»,
-- «پلاتینیوم»), and one number per service is what the form asks for. A
-- config-level override can come later as the same column on the other
-- table; nothing here stands in its way.
--
-- Same range as the code's `percent` — 0 ≤ p ≤ 100 — and NOT NULL DEFAULT 0
-- so that every service already in the table, and every row the importer
-- writes, means «no bonus» without being asked. The bonus is still frozen on
-- the ORDER (`bonus_volume_gb`), summed with the code's if there is one, so
-- a percent an admin later changes does not change what a paid order
-- delivers. And it never touches money: a service that gives volume takes
-- nothing off `discount_irr`.

BEGIN;

ALTER TABLE products
  ADD COLUMN bonus_percent numeric(5,2) NOT NULL DEFAULT 0
    CHECK (bonus_percent >= 0 AND bonus_percent <= 100);

COMMIT;
