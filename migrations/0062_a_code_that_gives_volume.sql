-- 0062 — a discount code may give gigabytes instead of taking money off.
--
-- Sam, 2026-09-11: «کدهای تخفیف رو میخوام بتونم علاوه بر اینکه مبلغ پولی
-- باشه، یک درصد یا مقدار حجم اضافه هم باشه … مثلا ۳۰ گیگ + ۲۰٪».
--
-- ## Two kinds, not one with two fields
--
-- `BONUS_GB` adds a fixed number of gigabytes to the plan's volume; the code
-- carries it in `bonus_gb`. `BONUS_PERCENT` adds a share of the plan's volume;
-- the code carries it in `percent`, the column `PERCENT_OFF` already uses,
-- under the same 0 < p ≤ 100 rule — «+100% volume» means something, more does
-- not. One code, one value, one kind: a code that gave both would need a form
-- with two optional numbers and a sentence explaining which applies first,
-- and Sam chose the two kinds when asked.
--
-- ## What the kind-and-value rule says now
--
-- 0002's CHECK was two arms: PERCENT_OFF carries a percent, everything else
-- carries an amount. It becomes three, one per value column, and the money
-- arm is 0002's arm word for word — no `percent IS NULL` on it. The legacy
-- importer writes both `amount_irr` and `percent` for the rows it brings
-- over, and a CHECK that a row already in the table cannot pass is a
-- migration that does not apply.
--
-- ## The bonus is frozen on the ORDER
--
-- `orders.bonus_volume_gb`, written by `place()` at the moment the customer
-- taps «سفارش» — exactly as `discount_irr` records the money that came off.
-- Delivery runs in another transaction, hours later if the payment is slow,
-- and reads everything it sends to the panel off the one order row; a code an
-- admin has since expired or edited must not change what a paid order
-- delivers. `NOT NULL DEFAULT 0` means add-on, top-up and trial orders never
-- touch it, and the ADD_VOLUME path is provably unaffected.
--
-- `subscriptions.volume_gb` gains no column: it already records the volume
-- that was actually sent, and with a bonus that is the plan plus the bonus.

BEGIN;

ALTER TABLE discount_codes
  ADD COLUMN bonus_gb numeric(12,3) CHECK (bonus_gb IS NULL OR bonus_gb > 0);

ALTER TABLE discount_codes DROP CONSTRAINT discount_codes_kind_check;
ALTER TABLE discount_codes ADD CONSTRAINT discount_codes_kind_check
  CHECK (kind IN ('GIFT_BALANCE', 'PERCENT_OFF', 'AMOUNT_OFF', 'BONUS_GB', 'BONUS_PERCENT'));

ALTER TABLE discount_codes DROP CONSTRAINT discount_codes_check;
ALTER TABLE discount_codes ADD CONSTRAINT discount_codes_check CHECK (
     (kind IN ('PERCENT_OFF', 'BONUS_PERCENT') AND percent    IS NOT NULL)
  OR (kind = 'BONUS_GB'                         AND bonus_gb   IS NOT NULL)
  OR (kind IN ('GIFT_BALANCE', 'AMOUNT_OFF')    AND amount_irr IS NOT NULL)
);

ALTER TABLE orders
  ADD COLUMN bonus_volume_gb numeric(12,3) NOT NULL DEFAULT 0 CHECK (bonus_volume_gb >= 0);

COMMIT;
