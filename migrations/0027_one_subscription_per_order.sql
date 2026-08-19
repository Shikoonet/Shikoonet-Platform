-- One order buys one service.
--
-- `provision.ts` read the table and then wrote to it:
--
--   SELECT id FROM subscriptions WHERE order_id = ?  -- anything already?
--   INSERT INTO subscriptions ...                    -- no, so make one
--
-- with a comment saying the guard was that SELECT plus the fact that only one
-- sweep can hold an order in PROVISIONING at a time. The claim on the order is
-- real, and it is not enough: `reclaimStalled` returns a PROVISIONING order to
-- PAID once it has been held longer than the stall window, and a sweep that is
-- slow — a panel taking its time — is not a sweep that died. So the first sweep
-- is still inside its panel call while the second claims the order, and both
-- reach the SELECT before either reaches the INSERT. Two rows, one order, one
-- customer with two services and one payment.
--
-- Count-then-act is not a guard when two writers can count at the same time,
-- and this project has been bitten by exactly that shape twice before. The
-- guarantee belongs in the database, where it holds no matter how many
-- processes are asking.
--
-- Partial, because `order_id` is null for every subscription carried over from
-- the legacy system: those predate orders entirely, and a plain unique index
-- would treat them as distinct anyway while claiming a guarantee it does not
-- make about them.

BEGIN;

CREATE UNIQUE INDEX idx_subscriptions_one_per_order
  ON subscriptions (order_id)
  WHERE order_id IS NOT NULL;

COMMIT;
