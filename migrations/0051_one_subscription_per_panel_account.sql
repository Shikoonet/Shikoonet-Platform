-- 0051 — one account on a panel belongs to one subscription.
--
-- The number is 0051 and not 0050 on purpose: `0050_emoji_packs.sql` is on the
-- premium-emoji branch, unmerged at the time this was written. The ledger keys
-- on the filename rather than the number, so the two coexist whichever order
-- they land in — but two files called 0050 would still be a thing somebody has
-- to work out at 3am.
--
-- ## What is being prevented
--
-- «روش ساخت نام کاربری» gains a mode on 2026-09-03 whose name is
-- `<panel text>_<telegram id>_<purchase number>` — the first shape in this
-- product whose suffix is NOT the order's public id. Every other mode is unique
-- because that id is; this one is unique because the count is, and a count is
-- computed rather than given.
--
-- The failure it is guarding against is silent, which is why it is worth a
-- constraint rather than a careful function. If two orders ever resolve to the
-- same name on the same panel, the adapter does not report a clash: it FINDS
-- the account that already exists and reports success. The customer pays for a
-- second service and is handed their first one again, the order completes, and
-- every number in the shop's reports is right. Nothing anywhere says no.
--
-- ## Why `provider_id IS NOT NULL` is in the predicate
--
-- A subscription whose panel row was deleted keeps `remote_username` and loses
-- `provider_id`. Those rows are not answering the question this index asks —
-- «is this name taken ON THAT PANEL» — and without the clause they would all
-- collide with each other on NULL. They are excluded rather than repaired: the
-- account they name is on a panel this system no longer has, and inventing a
-- provider for it would be inventing a fact.
--
-- ## The count that is NOT in this header
--
-- Every other migration here says what it counted in the production dump before
-- it ran. This one cannot: `legacy/mirzabot-php/db/` is an empty directory on
-- the machine this was written on, and the sim database has zero subscriptions.
-- So the honest statement is the negative one — nothing was counted, and the
-- number quoted in the handoff that led to this file (183 rows with no panel)
-- comes from a dump nobody here can open today.
--
-- What that means operationally: **this migration can fail**, and failing is
-- the correct outcome. A database that already holds two live subscriptions
-- with one name on one panel is a database where the bug has already happened,
-- and creating the index is how it is found rather than the moment it is
-- caused. Before running it anywhere with real rows:
--
--     SELECT provider_id, remote_username, count(*)
--       FROM subscriptions
--      WHERE provider_id IS NOT NULL
--        AND remote_username IS NOT NULL
--        AND status <> 'CANCELLED'
--      GROUP BY 1, 2 HAVING count(*) > 1;
--
-- ## And why a CANCELLED row does not hold a name
--
-- A cancelled subscription's account is gone from the panel — `revoke` removes
-- it — so the name is free again, and a customer buying a second service after
-- cancelling their first would otherwise be refused for ever by a row that
-- refers to nothing.

BEGIN;

CREATE UNIQUE INDEX idx_subscription_one_per_panel_account
  ON subscriptions (provider_id, remote_username)
  WHERE provider_id IS NOT NULL
    AND remote_username IS NOT NULL
    AND status <> 'CANCELLED';

COMMIT;
