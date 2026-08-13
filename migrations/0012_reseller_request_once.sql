-- ---------------------------------------------------------------------------
-- 0012 — one open reseller application per person
--
-- `Requestagent` in the legacy schema has the customer's telegram id as its
-- PRIMARY KEY, so MySQL itself allows exactly one row per person, ever
-- (`index.php:6149` then refuses a second one before it is written). Our table
-- carried the rows across but not the rule, so nothing stopped one customer
-- filing the same application a hundred times.
--
-- Deliberately narrower than the legacy: the index covers PENDING only. A
-- person the admin has already turned down can apply again, which the PK could
-- never allow; an approved one is a reseller and the bot refuses them earlier
-- for that reason. What cannot happen is two open applications from one person,
-- and it cannot happen because of this index rather than because of a SELECT
-- that ran a moment before the INSERT.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE UNIQUE INDEX idx_reseller_request_one_open
  ON reseller_requests (user_id)
  WHERE status = 'PENDING';

COMMIT;
