-- Where an update the bot gave up on goes.
--
-- `MAX_UPDATE_ATTEMPTS` exists so one poison update cannot freeze the queue for
-- everybody: after three failures in healthy cycles the update is acknowledged
-- to Telegram and the offset moves past it. Acknowledging is what unblocks the
-- bot, and it is also final — Telegram deletes it and will never send it again.
--
-- Until now the only trace was a `console.error`. If that update was a customer
-- pressing «پرداخت کردم» or uploading a receipt, their action was gone with
-- nothing anywhere to find it by. This table is that trace.
--
-- It is a record, not a retry queue. Nothing reads it automatically; replaying
-- one is a decision a person makes with the payload in front of them.

BEGIN;

CREATE TABLE telegram_dead_updates (
  update_id  bigint      PRIMARY KEY,
  -- The whole update as Telegram sent it, so a person can see what was lost
  -- and, if it matters, act on it by hand.
  payload    jsonb       NOT NULL,
  attempts   integer     NOT NULL,
  last_error text,
  dropped_at timestamptz NOT NULL DEFAULT now()
);

-- Telegram can redeliver an update the bot never acknowledged, and after a
-- restart the in-memory attempt count is gone — so the same id can reach this
-- table twice. One row per update with a running total, rather than a second
-- row that reads like a second customer.

-- The prune is the only access that is not a primary-key hit.
CREATE INDEX idx_telegram_dead_updates_dropped ON telegram_dead_updates(dropped_at);

COMMIT;
