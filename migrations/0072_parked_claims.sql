-- 0072_parked_claims.sql — 2026-09-17.
--
-- «در انتظار بررسی» fills with claims whose customer pressed «پرداخت کردم»
-- and never sent a receipt, and whose bank SMS has not arrived. There is
-- nothing to decide about them yet; they just sit in the operator's way.
--
-- `parked_at` moves such a claim to its own tab («کنار گذاشته») and changes
-- nothing else: status stays PENDING, the matcher still sees it, and when the
-- SMS arrives it auto-verifies and leaves the tab on its own. A view flag, not
-- a decision — which is why it is a timestamp on the claim and not a status.

BEGIN;

ALTER TABLE payment_claims ADD COLUMN parked_at bigint;

COMMIT;
