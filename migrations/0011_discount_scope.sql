-- ---------------------------------------------------------------------------
-- 0011 — what a discount code is allowed to do
--
-- `discount_codes` was written from the legacy tables' COLUMNS and missed what
-- the legacy CODE does with them. `index.php:4218` selects a code by four
-- conditions before it will apply it, and only two of them survived into
-- Postgres:
--
--   code_product = product OR 'all'   -> product_id     (column existed, never filled)
--   code_panel   = panel   OR '/all'  -> provider_id    (column existed, never filled)
--   time         = 0 OR now < time    -> expires_at     (column existed, never filled)
--   type         IN ('all', 'buy'|'extend')             -> NOTHING AT ALL
--
-- On the 2026-08-11 dump that is not a rounding error. Of the 33 sale codes,
-- 31 have already expired, 13 are tied to one product, 23 to one panel and 3 to
-- one kind of purchase. Importing them as they were imported until today turns
-- every one of those back on, unscoped.
--
-- `applies_to` is the missing column. The other three are filled by the
-- importer, which is where the reading of the legacy rows belongs.
--
-- `GIFT_CODE` joins the wallet's kinds because a redeemed gift code is money
-- arriving, and calling it ADMIN_ADJUST would put it in the same bucket as an
-- admin correcting a balance by hand.
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE discount_codes
  ADD COLUMN applies_to text NOT NULL DEFAULT 'ALL'
    CHECK (applies_to IN ('ALL', 'BUY', 'RENEW'));

COMMENT ON COLUMN discount_codes.applies_to IS
  'DiscountSell.type: all -> ALL, buy -> BUY, extend -> RENEW';

-- A CHECK cannot be edited in place.
ALTER TABLE wallet_entries DROP CONSTRAINT wallet_entries_kind_check;
ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_kind_check
  CHECK (kind IN ('OPENING', 'TOPUP', 'PURCHASE', 'REFUND', 'ADMIN_ADJUST',
                  'REFERRAL_BONUS', 'WHEEL_PRIZE', 'TRANSFER_IN', 'TRANSFER_OUT',
                  'GIFT_CODE'));

COMMIT;
