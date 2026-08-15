-- ---------------------------------------------------------------------------
-- 0019 — a wallet kind for the renewal cashback
--
-- `shopSetting.chashbackextend` is 5 in production, read out of the dump on
-- 2026-08-15 with `COLLATE utf8mb4_bin`, and it has been paying five percent of
-- every renewal back to the customer for years. Nothing in this platform read
-- it, so on cutover night every renewing customer would quietly have received
-- less money than the day before — the one parity gap that costs the customer
-- rather than the shop.
--
-- It gets its own kind rather than borrowing one. `REFERRAL_BONUS` is summed by
-- `referralSummary` to tell a customer what their invitees have earned them, so
-- filing cashback there would inflate a number the customer reads; and
-- `ADMIN_ADJUST` would file an automatic payment as somebody's hand correction.
--
-- The legacy bot pays it two different ways, and this platform deliberately
-- picks one. `index.php:1952` takes it off the wallet price (the customer pays
-- 95%), while `function.php:1147` credits the balance after a card payment —
-- and does it with `update("user","Balance",$result,...)`, which SETS rather
-- than adds and therefore wipes the customer's balance. Both paths tell the
-- customer the same sentence, «حساب شما شارژ گردید», so the credit is what was
-- promised in both and the credit is what is built here. It also means one
-- money path instead of one per payment method.
-- ---------------------------------------------------------------------------

BEGIN;

-- A CHECK cannot be edited in place.
ALTER TABLE wallet_entries DROP CONSTRAINT wallet_entries_kind_check;
ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_kind_check
  CHECK (kind IN ('OPENING', 'TOPUP', 'PURCHASE', 'REFUND', 'ADMIN_ADJUST',
                  'REFERRAL_BONUS', 'WHEEL_PRIZE', 'TRANSFER_IN', 'TRANSFER_OUT',
                  'GIFT_CODE', 'RENEWAL_CASHBACK'));

COMMIT;
