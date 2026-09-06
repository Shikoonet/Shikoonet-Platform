-- Three things a discount code could not do, and the index that has to go.
--
-- ## 1. `uses_per_user`
--
-- Today every code is once per customer, and that is not a rule anybody chose
-- — it is `idx_redemption_once_per_user`, a UNIQUE index on
-- `(code_id, user_id)`. The legacy is looser: on the 08-11 dump, 23 of its 33
-- codes allow 2 or 5 uses per person.
--
-- **And not one of them was ever used twice.** 93 redemptions, 92 distinct
-- customers, zero duplicate (code, user) pairs. So this migration is not
-- fixing a bug and it is not restoring lost behaviour; Sam read that evidence
-- and asked for the ceiling anyway. Written down so the next person knows the
-- structural guarantee was traded for a counted one deliberately, rather than
-- lost by somebody who did not notice the index.
--
-- The count replaces it under the `FOR UPDATE` lock `discount.ts` already
-- takes on `discount_codes` before checking `max_uses` — so the race stays
-- closed without a new index.
--
-- ## Why a DIFFERENT unique index goes in its place
--
-- Dropping the old one on its own would break something the plan does not
-- mention, and it is the kind of break that costs money quietly.
--
-- `handleOrder` calls `redeem()` on EVERY tap of «سفارش», including the taps
-- that land back on an order the customer already has — `place()` reuses the
-- open order rather than writing a second. Today the second call is absorbed
-- by `ON CONFLICT (code_id, user_id) DO NOTHING`. With a per-user ceiling of
-- two, that same second tap would silently spend the customer's second use on
-- an order they already had.
--
-- So the uniqueness moves to where it actually belongs: one redemption per
-- ORDER. A repeated tap is the same order and is absorbed exactly as before; a
-- genuinely new order is a genuinely new use. Partial, because the gift path
-- redeems with no order at all — those are bounded by the counted ceiling
-- under the same lock, which is where every other limit here lives.
--
-- ## 2. `status`
--
-- A code could only be retired by expiring it, which rewrites when it ended
-- and cannot be undone. `DISABLED` turns one off and back on with its history
-- intact. From faoxima as BEHAVIOUR only (`DiscountSupport.php:120`) — it is
-- GPL-3 and no line of it is copied.
--
-- ## 3. `target_user_id`
--
-- A code that works for exactly one customer. `ON DELETE CASCADE` rather than
-- SET NULL: a targeted code whose target is gone must not silently become a
-- code that works for everybody.

ALTER TABLE discount_codes
  ADD COLUMN IF NOT EXISTS uses_per_user integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS target_user_id bigint;

ALTER TABLE discount_codes
  DROP CONSTRAINT IF EXISTS discount_codes_uses_per_user_check,
  ADD CONSTRAINT discount_codes_uses_per_user_check CHECK (uses_per_user > 0);

ALTER TABLE discount_codes
  DROP CONSTRAINT IF EXISTS discount_codes_status_check,
  ADD CONSTRAINT discount_codes_status_check CHECK (status IN ('ACTIVE', 'DISABLED'));

ALTER TABLE discount_codes
  DROP CONSTRAINT IF EXISTS fk_discount_target_user,
  ADD CONSTRAINT fk_discount_target_user
    FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE;

-- The default is 1 and every existing row takes it, so nothing a shop has
-- today becomes reusable because this ran.

-- One redemption per order, before the per-user one is dropped, so there is no
-- window in which a double tap could write two rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_redemption_once_per_order
  ON discount_redemptions (code_id, order_id)
  WHERE order_id IS NOT NULL;

DROP INDEX IF EXISTS idx_redemption_once_per_user;

-- Reading «how many times has THIS person used THIS code» is now on the
-- purchase path, under a lock, so it gets an index rather than a scan of every
-- redemption of a popular code.
CREATE INDEX IF NOT EXISTS idx_redemptions_code_user
  ON discount_redemptions (code_id, user_id);
