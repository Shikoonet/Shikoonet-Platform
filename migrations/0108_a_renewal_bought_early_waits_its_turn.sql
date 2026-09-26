-- 0108 — a renewal bought early waits its turn.
--
-- Sam, 2026-09-26: «تمدید موقعی معنی پیدا می‌کنه که یا حجم تموم شده یا زمان».
-- A customer who renews while the service still has BOTH volume and time left
-- is not renewed on the spot — on a RESET panel that burned what they had
-- left. The renewal is reserved instead, and applied the moment the current
-- period runs out, volume or time, whichever comes first.
--
-- The order is COMPLETED when the reserve is made: the money arrived then, and
-- every sales report counts COMPLETED orders by `completed_at`, which is what
-- keeps the books agreeing with the bank. This row is what is still owed to
-- the panel.
--
-- `volume_gb` and `duration_days` are the plan as it was sold. A reserve can
-- wait weeks and a plan can be edited from the dashboard meanwhile; the
-- customer gets what they paid for, not what the plan says on the day. A
-- volume code's bonus is already frozen on the order (`bonus_volume_gb`).
--
-- One waiting reserve per service — one active, one reserved (Sam) — is the
-- partial unique index, not code: two renewals paid in the same minute both
-- reach the insert, and only one of them can win it.
--
-- `status`: WAITING until the sweep applies it (APPLIED, `applied_at`), or
-- FAILED when the panel refused for good and a person has to finish it.
--
-- Undone by dropping the table; nothing else reads it.
BEGIN;

CREATE TABLE renewal_reserves (
  order_id        bigint        PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  subscription_id bigint        NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  -- NULL: unmetered, as on `product_plans`.
  volume_gb       numeric(12,3) CHECK (volume_gb IS NULL OR volume_gb >= 0),
  -- NULL: no expiry.
  duration_days   integer       CHECK (duration_days IS NULL OR duration_days > 0),
  status          text          NOT NULL DEFAULT 'WAITING'
                                CHECK (status IN ('WAITING', 'APPLIED', 'FAILED')),
  failure_reason  text,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  applied_at      timestamptz,
  CHECK ((status = 'APPLIED') = (applied_at IS NOT NULL)),
  CHECK ((status = 'FAILED') = (failure_reason IS NOT NULL))
);

CREATE UNIQUE INDEX renewal_reserves_one_waiting
  ON renewal_reserves (subscription_id) WHERE status = 'WAITING';

COMMIT;
