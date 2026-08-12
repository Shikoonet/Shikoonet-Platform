-- 0006_bot.sql — the one thing the bot needs that the schema did not have.
--
-- Everything else it touches is already here: users and bot_sessions (0001), the
-- catalog (0002), orders and subscriptions (0003). Only exactly-once processing
-- of Telegram updates was missing.
--
-- Mirzabot's answer was a `.done` file on the disk that every bot update wiped.
-- The answer here is a primary key, claimed inside the SAME transaction as the
-- handler's writes: the claim and the effects commit together or neither does.
-- Telegram redelivers an update until the offset is confirmed, so without this
-- a crash between "handled" and "offset confirmed" charges a wallet twice.

BEGIN;

CREATE TABLE telegram_updates (
  update_id    bigint      PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- The only access that is not a primary-key hit is the prune.
-- ponytail: one bot per database. update_id is unique per bot token, so a second
-- bot sharing this database would collide on ids it never sent. If that day
-- comes the key becomes (bot_id, update_id) — a one-line migration.
CREATE INDEX idx_telegram_updates_processed ON telegram_updates(processed_at);

COMMIT;
