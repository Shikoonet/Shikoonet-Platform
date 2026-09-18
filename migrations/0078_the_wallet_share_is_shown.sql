-- 0078_the_wallet_share_is_shown.sql — 2026-09-18.
--
-- A 120,000 Toman invoice reached the review page as «مبلغ مورد انتظار
-- ۱۱۴٬۰۵۰» and Sam asked why. The customer had 5,950 in the wallet and the
-- checkout took it off the card amount (#317) — correct, and invisible: the
-- page names the card's share only, so the operator reads a wrong number.
--
-- The review page now reads the wallet's share off `wallet_entries` by
-- `order_id`, once per listed claim, and the bot already does the same in
-- `walletPaidOnOrder` and `refundOrder`. Nothing indexes that column: every
-- one of those reads is a scan of the whole ledger, and the list does two
-- hundred of them per page. Partial, because most entries are top-ups and
-- adjustments with no order at all.

BEGIN;

CREATE INDEX idx_wallet_entries_order ON wallet_entries(order_id) WHERE order_id IS NOT NULL;

COMMIT;
