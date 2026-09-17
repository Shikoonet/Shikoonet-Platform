-- 0069_claim_purchase_type.sql — 2026-09-17.
--
-- «خریدهای جدید | تمدیدها» on the auto-verified tab filters
-- `payment_claims.purchase_type`, and nothing on this platform wrote it. The
-- column came over with the Mirzabot backfill (legacy 0015), the worker only
-- read it behind ENABLE_PURCHASE_TYPE — never set in production — and the
-- bot's own claim insert left it NULL. So every claim since cutover is NULL
-- and the toggle shows the same rows either way.
--
-- The kind is on the order the claim pays for. This is that mapping, in one
-- place, for the bot's insert and for the rows already there. Same buckets
-- the legacy backfill used: add-time and add-volume are renewals
-- (getextratimeuser / getextravolumeuser → RENEWAL). A wallet top-up buys
-- no service and is UNKNOWN — neither segment shows it.

BEGIN;

CREATE OR REPLACE FUNCTION claim_purchase_type(order_kind text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE order_kind
    WHEN 'NEW_PURCHASE' THEN 'NEW_PURCHASE'
    WHEN 'TRIAL'        THEN 'NEW_PURCHASE'
    WHEN 'RENEWAL'      THEN 'RENEWAL'
    WHEN 'ADD_TIME'     THEN 'RENEWAL'
    WHEN 'ADD_VOLUME'   THEN 'RENEWAL'
    ELSE 'UNKNOWN'
  END
$$;

-- Only the bot's claims have an order to read; imported Mirzabot rows keep
-- what the backfill gave them.
UPDATE payment_claims c
   SET purchase_type = claim_purchase_type(o.kind)
  FROM payments p
  JOIN orders o ON o.id = p.order_id
 WHERE c.external_order_id = 'shikoo:' || p.public_id
   AND c.purchase_type IS NULL;

COMMIT;
