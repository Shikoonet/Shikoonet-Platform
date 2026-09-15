-- 0063 — a shelf row is held for its invoice from the moment it is printed.
--
-- Sam, 2026-09-15, on a panel with no third party behind it (OpenVPN, a box
-- of bought accounts): «فقط باید از روی قفسه انبار اکانت رو تحویل بده، اگر
-- هم اکانتی موجود نبود … به مشتری بگه اکانتی فعلا موجود نیست و همچنین ازش
-- پول نگیره».
--
-- ## Why a status and not a check at the button
--
-- An invoice lives for 24 hours (`orders.expires_at`, the shop's own TTL).
-- Two customers can tap the last account on the shelf inside that window;
-- the one who pays second has paid for nothing, and a check at the button —
-- «is the shelf empty right now?» — cannot see them. So the row is claimed
-- when the ORDER is written: `RESERVED`, carrying the order's id, inside the
-- transaction that inserts the order. The invoice then names an account that
-- exists, and «پول بدون اکانت» is something the table refuses rather than
-- something the bot remembers to avoid.
--
-- `RESERVED` → `USED` when the paid order is delivered (the same row, not
-- «any available one»); → `AVAILABLE` again when the invoice expires unpaid.
--
-- ## What the constraints say now
--
-- 0010's `stock_used_has_order` said «a sold row names its order, an unsold
-- one does not». A held row names its order too, so the rule becomes «a row
-- that is anybody's — held or sold — names whose». `idx_stock_one_row_per_order`
-- already covers both states: one order, one row, whether held or sold.

BEGIN;

ALTER TABLE provisioning_stock
  DROP CONSTRAINT provisioning_stock_status_check,
  ADD CONSTRAINT provisioning_stock_status_check
    CHECK (status IN ('AVAILABLE', 'RESERVED', 'USED', 'RETIRED')),
  DROP CONSTRAINT stock_used_has_order,
  ADD CONSTRAINT stock_held_has_order
    CHECK ((status IN ('RESERVED', 'USED')) = (order_id IS NOT NULL));

COMMIT;
