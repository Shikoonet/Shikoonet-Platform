-- 0071_wallet_topup_is_a_purchase_type.sql — 2026-09-17.
--
-- «خریدهای جدید | تمدیدها» on the auto-verified tab gets a third segment,
-- «شارژ کیف پول». 0069 filed a wallet top-up under UNKNOWN — "buys no
-- service, neither segment shows it" — and that is exactly the problem: a
-- customer who charged their wallet paid real money through the same card
-- and the same SMS, and the tab that lists what the bot verified today had
-- no place to show it. Sam wants it listed, in its own segment.
--
-- Nothing else reads the bucket: it filters one tab and names one badge.

BEGIN;

ALTER TABLE payment_claims
  DROP CONSTRAINT payment_claims_purchase_type_check,
  ADD  CONSTRAINT payment_claims_purchase_type_check CHECK (purchase_type IS NULL OR purchase_type IN (
    'NEW_PURCHASE','RENEWAL','WALLET_TOPUP','UNKNOWN'));

CREATE OR REPLACE FUNCTION claim_purchase_type(order_kind text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE order_kind
    WHEN 'NEW_PURCHASE' THEN 'NEW_PURCHASE'
    WHEN 'TRIAL'        THEN 'NEW_PURCHASE'
    WHEN 'RENEWAL'      THEN 'RENEWAL'
    WHEN 'ADD_TIME'     THEN 'RENEWAL'
    WHEN 'ADD_VOLUME'   THEN 'RENEWAL'
    WHEN 'WALLET_TOPUP' THEN 'WALLET_TOPUP'
    ELSE 'UNKNOWN'
  END
$$;

-- The top-ups already there were filed as UNKNOWN by 0069; move them.
UPDATE payment_claims c
   SET purchase_type = 'WALLET_TOPUP'
  FROM payments p
  JOIN orders o ON o.id = p.order_id
 WHERE c.external_order_id = 'shikoo:' || p.public_id
   AND o.kind = 'WALLET_TOPUP'
   AND c.purchase_type IS DISTINCT FROM 'WALLET_TOPUP';

COMMIT;
