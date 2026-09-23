-- 0096 — a renewal remembers what it replaced.
--
-- Sam, 2026-09-23: some customers renew by mistake, early, and a RESET panel
-- then throws away what they had left — «مصرف قبلی صفر می‌گردد». Nothing kept
-- what that was: the adapter read the account from the panel a moment before
-- changing it, used two of the numbers, and dropped them. The admin had no way
-- to know what to give back.
--
-- One row per renewal order, written in the same transaction that marks the
-- order COMPLETED, holding the account as the panel had it just before:
-- used, limit, expiry. `lost_bytes` and `lost_ms` are what this renewal's mode
-- burned — RESET the unused volume and the remaining time, the mode that keeps
-- volume only the time, ADD nothing — so the dashboard's «برگرداندن» adds
-- exactly that back.
--
-- `restored_at` is the claim: the restore route sets it with
-- `WHERE restored_at IS NULL` before it touches the panel, so two admins
-- pressing the button at once give the volume back once.
--
-- Add-ons (extra volume, extra time) are not renewals and write nothing here.
--
-- Undone by dropping the table; nothing else reads it.
BEGIN;

CREATE TABLE renewal_snapshots (
  id                 bigint      PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  order_id           bigint      NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  subscription_id    bigint      NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  mode               text        NOT NULL CHECK (mode IN ('RESET', 'ADD', 'ADD_VOLUME_RESET_TIME')),
  plan_name_before   text,
  used_bytes_before  bigint      CHECK (used_bytes_before IS NULL OR used_bytes_before >= 0),
  -- NULL: unmetered.
  limit_bytes_before bigint      CHECK (limit_bytes_before IS NULL OR limit_bytes_before > 0),
  -- NULL: no date, or an on_hold account whose clock had not started.
  expires_at_before  timestamptz,
  lost_bytes         bigint      NOT NULL DEFAULT 0 CHECK (lost_bytes >= 0),
  lost_ms            bigint      NOT NULL DEFAULT 0 CHECK (lost_ms >= 0),
  restored_at        timestamptz,
  restored_by        text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX renewal_snapshots_subscription ON renewal_snapshots (subscription_id, created_at DESC);

COMMIT;
