-- 0089 — an order keeps the name it was sold under.
--
-- Sam, 2026-09-20: a customer bought «خرید اولی» in Mordad and changed it to
-- «الماس» today, and the Mordad order on the customer's card now read «الماس»
-- too. It had no name of its own: the orders list answered
-- `COALESCE(product_plans.name, subscriptions.plan_name_at_sale)`, and a
-- tier change rewrites the subscription's name — rightly, it is the name the
-- service is sold under NOW — so the order that created the service changed
-- with it. Every imported order (plan_id NULL on all 8,909) sat on that
-- fallback; a plan renamed in the catalogue moved the shop's own orders the
-- same way.
--
-- The name is copied onto the order at placement (`place()` in
-- apps/bot/src/order.ts) and read back from there first. Existing rows are
-- filled from what the list showed today: the plan's current name, else the
-- service's. A service already changed before this ran keeps the changed
-- name on its first order — the original is not in this database.
--
-- Undone by dropping the column; the readers fall back to what they read
-- before.
BEGIN;

ALTER TABLE orders ADD COLUMN plan_name_at_sale text;
COMMENT ON COLUMN orders.plan_name_at_sale IS
  'The plan name the customer agreed to, frozen at placement. NULL on an order with no plan (add-on, deposit, trial) and on imported rows that had no service to copy from (0089).';

UPDATE orders o
   SET plan_name_at_sale = COALESCE(
         (SELECT pl.name FROM product_plans pl WHERE pl.id = o.plan_id),
         -- idx_subscriptions_one_per_order is UNIQUE on order_id, so this
         -- is one row or none.
         (SELECT s.plan_name_at_sale FROM subscriptions s WHERE s.order_id = o.id))
 WHERE o.plan_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.order_id = o.id);

COMMIT;
