-- 0047 — a reseller's discount belongs to their LEVEL, not to their row.
--
-- Sam, 2026-09-03: «دو گروه N و N2 دارم … هر گروه تخفیف خودش را داشته باشد که
-- کم و زیادش کنم». Today there is no such thing. `users.is_reseller` is one
-- boolean and `users.discount_percent` is one number per person, so «everybody
-- at level one gets 20» is done by typing 20 into twenty customer rows and
-- forgetting the twenty-first.
--
-- ## `code` is the primary key because the vocabulary already exists
--
-- `CustomerTier = 'f' | 'n' | 'n2'` has been in
-- `packages/domain/src/provisioning/index.ts` since the add-on prices were
-- built, the per-panel price tables in `config.priceextravolume` and
-- `priceextratime` are keyed `{f,n,n2}`, and the panel screen labels the three
-- of them. An identity integer here would mean a mapping table between two
-- spellings of the same three values, and the `{f,n,n2}` JSON would still be
-- keyed by the string.
--
-- `f` is deliberately NOT a row. It is the absence of a level — an ordinary
-- customer is priced by their own `discount_percent` — and giving it a row
-- would create a second place that could disagree about what "no discount"
-- means.
--
-- ## Two rows, fixed by a CHECK
--
-- Sam was asked whether he wanted a third level and said no, and whether he
-- wanted free-form named groups instead of the ladder and said no. The CHECK
-- says so out loud: a third level is one seeded row and one member added to
-- `CustomerTier`, and until somebody does both, `n3` cannot be written here and
-- then silently priced as `f`.
--
-- ## Why the tier is READ, and never copied onto the customer
--
-- Fanning a level's percentage out into `users.discount_percent` would need no
-- pricing change at all, and it loses to two things already in this repo.
-- `POST /api/v1/admin/customers/:id/discount` writes that column directly, so
-- an operator setting a personal number on a reseller would quietly reprice
-- them against a tier screen that still said otherwise. And
-- `packages/migrate/src/migrate.ts:138` rewrites the column from legacy
-- `pricediscount` on EVERY import run, silently undoing every tier with nothing
-- in any diff to say so.
--
-- Read through a subquery and neither is possible, rather than merely
-- remembered. The customer's own `discount_percent` is left untouched on the
-- row the whole time they are a reseller, and it is what they go back to the
-- moment they stop being one.
--
-- ## The CHECK on the percentage is not decoration
--
-- `priceForUser` THROWS outside 0..100 (`apps/bot/src/money.ts`). A throw
-- inside `handleCallback` rolls back the `telegram_updates` row that makes
-- delivery once-only, and the poller then hands the same update back for ever
-- — the failure `order.ts` describes as one customer's order stopping the bot
-- for everybody. A row at 150 here would not be a wrong price, it would be an
-- outage.
--
-- numeric(5,2) matching `users.discount_percent` exactly, so the COALESCE
-- between them returns the type the driver's NUMERIC parser already hands back
-- as a JS number.
--
-- ## `is_reseller` stays, and stays separate
--
-- The flag decides what a customer may SEE — `products.resellers_only`,
-- `discount_codes.resellers_only`, the catalogue predicate. The tier decides
-- what they PAY. There is deliberately NO check tying the two: making
-- `reseller_tier IS NULL OR is_reseller` a constraint would turn "this person
-- is no longer a reseller" into a constraint error instead of one UPDATE that
-- clears both, which is what the route does.

BEGIN;

CREATE TABLE reseller_tiers (
  code             text PRIMARY KEY CHECK (code IN ('n', 'n2')),
  -- Shown in the panel and deliberately NOT editable there. Seeded with the
  -- labels «قیمت حجم و زمان اضافه» already hardcodes on every panel screen, so
  -- nothing on screen changes on the day this lands — and so there is one name
  -- per level rather than a row that says «طلایی» beside a price box that still
  -- says «نماینده سطح ۲».
  --
  -- Read by the customers screen and the levels table; written by nothing after
  -- this INSERT.
  name             text         NOT NULL,
  discount_percent numeric(5,2) NOT NULL DEFAULT 0
                     CHECK (discount_percent >= 0 AND discount_percent <= 100),
  updated_at       timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE reseller_tiers IS
  'The two reseller levels and the percentage each one pays off list price. `f` is not a row: it is the absence of a level.';

INSERT INTO reseller_tiers (code, name) VALUES
  ('n',  'نماینده'),
  ('n2', 'نماینده سطح ۲');

ALTER TABLE users
  ADD COLUMN reseller_tier text REFERENCES reseller_tiers(code) ON DELETE SET NULL;

COMMENT ON COLUMN users.reseller_tier IS
  'NULL means an ordinary customer, priced by their own discount_percent. Set only alongside is_reseller.';

-- Every reseller today is level one. Nobody has ever been level two — nothing
-- has ever set it, because `tierFor()` could only ever answer `f` or `n` — so
-- there is nothing here to guess at and no row is being retold as something it
-- was not.
UPDATE users SET reseller_tier = 'n' WHERE is_reseller;

-- «چه کسانی در این سطح‌اند» is the direction the panel counts in. The pricing
-- read goes the other way and uses the primary key.
CREATE INDEX idx_users_reseller_tier ON users (reseller_tier)
  WHERE reseller_tier IS NOT NULL;

COMMIT;
