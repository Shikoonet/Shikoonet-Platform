-- 0010 — a shelf of ready configs, for the hours the panel is not answering.
--
-- Today a panel that cannot be reached returns `retryable`, the order goes back
-- to PAID, and the sweep tries again forever. The money is already taken, so
-- the customer is paying and waiting. Selling stops until someone notices.
--
-- The shelf is the escape: configs made in advance on a panel that is up, sitting
-- unassigned until an order needs one. It is deliberately dumb — no generation,
-- no panel call, no reservation protocol. A row is a config; taking it is one
-- UPDATE.
--
-- Two things the database guarantees, so no sweep, retry, or second process has
-- to be trusted with them:
--
--   * one config is sold at most once  — `idx_stock_one_order_per_row` plus the
--     status guard inside the claiming UPDATE;
--   * one order takes at most one config — `idx_stock_one_row_per_order`.
--
-- `(provider_id, remote_username)` is unique so the same account cannot be
-- loaded onto the shelf twice and then sold to two people.
--
-- The shelf is for NEW_PURCHASE only. A renewal extends an account that already
-- exists on a specific panel; handing over a different account would silently
-- give the customer a second service and lose the first.

BEGIN;

CREATE TABLE provisioning_stock (
  id               bigserial PRIMARY KEY,
  plan_id          bigint NOT NULL REFERENCES product_plans(id),
  provider_id      bigint NOT NULL REFERENCES provisioning_providers(id),
  remote_username  text   NOT NULL,
  remote_ref       jsonb  NOT NULL DEFAULT '{}'::jsonb,
  subscription_url text   NOT NULL,
  status           text   NOT NULL DEFAULT 'AVAILABLE'
                     CHECK (status IN ('AVAILABLE', 'USED', 'RETIRED')),
  order_id         bigint REFERENCES orders(id),
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  used_at          timestamptz,
  -- A sold row names its order and a shelved one does not. Without this the
  -- unique index below is satisfied by every unsold row carrying NULL.
  CONSTRAINT stock_used_has_order CHECK ((status = 'USED') = (order_id IS NOT NULL))
);

CREATE UNIQUE INDEX idx_stock_one_row_per_order
  ON provisioning_stock (order_id) WHERE order_id IS NOT NULL;

CREATE UNIQUE INDEX idx_stock_one_order_per_row
  ON provisioning_stock (id, order_id) WHERE order_id IS NOT NULL;

CREATE UNIQUE INDEX idx_stock_account_once
  ON provisioning_stock (provider_id, remote_username);

CREATE INDEX idx_stock_available
  ON provisioning_stock (plan_id, id) WHERE status = 'AVAILABLE';

-- When the panel first refused this order. The shelf is finite and refilled by
-- hand, so a thirty-second hiccup must not spend it; the sweep waits out a
-- grace period measured from here. `updated_at` cannot do this job — every
-- retry rewrites it, so the order looks new forever.
ALTER TABLE orders ADD COLUMN provision_first_failed_at timestamptz;

COMMIT;
