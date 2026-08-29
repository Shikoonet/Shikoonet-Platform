-- The bot's own token, so the bot can be connected without a redeploy.
--
-- `TELEGRAM_BOT_TOKEN` has only ever come from the process environment, which
-- means the one thing the dashboard could not do was point the shop at a bot.
-- Every other operational fact — the panels, the catalogue, the wording, the
-- cards — moved into the database and became something an admin can set. The
-- identity of the bot itself did not, and «تنظیمات» cannot hold it either:
-- `settingsRoutes.ts` matches `token` against `SECRET_KEY_PATTERN` and refuses
-- both the read and the write, which is correct and is why this table exists
-- instead of a settings row.
--
-- WHY A SEPARATE TABLE. Exactly the reason `provider_secrets` gives: `settings`
-- is listed, searched and rendered by a screen, and a ciphertext in it would
-- make every sentence about that screen something you have to qualify. This is
-- the second table in the schema that is not safe to hand to a support agent,
-- and it says so in one place.
--
-- WHY THE KEY IS NOT IN HERE. `PANEL_SECRET_KEY`, the same key and the same
-- reasoning as `provider_secrets` — the bot and the dashboard both already
-- carry it, and a second key would be a second thing to lose. A stolen dump is
-- ciphertext and nothing else. See `packages/domain/src/secretBox.ts`.
--
-- WHY `env_name` IS A COLUMN. A token is not like a panel password: whoever
-- holds it answers customers. If this database is ever cloned or restored
-- somewhere else — a staging box, a laptop, a restore drill that grows a
-- second step — the copy must not start polling the real bot and replying to
-- real people. So the row names the environment that wrote it and a process
-- whose `ENV_NAME` differs refuses it and falls back to its own environment
-- variable, loudly. A plain column rather than sealed-in associated data on
-- purpose: the threat here is an accident, and an accident deserves an error
-- message that says what happened rather than "authentication failed".

BEGIN;

CREATE TABLE bot_credentials (
  -- One row. A shop has one bot; a table that could hold two would need
  -- something to decide which one polls, and there is no such thing.
  id          smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Which environment set this. Compared against `ENV_NAME` at boot.
  env_name    text        NOT NULL CHECK (length(env_name) > 0),
  -- The sealed token, base64. Never read by any route that answers a browser.
  sealed      text        NOT NULL CHECK (length(sealed) > 0),
  -- Which key sealed it — the key's own SHA-256 prefix, never the key.
  key_id      text        NOT NULL,
  -- What Telegram said this token was, at the moment it was accepted. Not a
  -- secret and not a guess: the dashboard calls `getMe` before it writes this
  -- row, so a token that is not a bot never gets here. Stored so the panel can
  -- say WHICH bot is connected without holding the token to ask again.
  bot_id      bigint      NOT NULL,
  username    text,
  first_name  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Who last set it. `audit_logs` carries the same fact as evidence; this is
  -- here so the screen can say "set by X on Y" without querying an
  -- append-only table for display.
  set_by      text
);

COMMENT ON TABLE bot_credentials IS
  'The Telegram bot token, sealed with PANEL_SECRET_KEY. NOT safe to dump, log '
  'or hand to a support agent. One row, guarded by the id = 1 check. A row '
  'whose env_name does not match the reading process is refused rather than '
  'used — see migrations/0038 and packages/domain/src/botToken.ts.';

COMMIT;
