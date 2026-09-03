-- 0052 — a stable id for one emoji, so a button can name it.
--
-- `emoji_pack_items` (0050) is keyed on `(pack_id, custom_emoji_id)`, which is
-- the right key for the table and useless in a `callback_data`: Telegram caps
-- that field at 64 bytes and a custom emoji id is a 64-bit number — nineteen
-- digits, past `Number.MAX_SAFE_INTEGER`, so it cannot travel as the numeric id
-- the bot's callbacks are parsed into.
--
-- The first draft numbered the rows with `ROW_NUMBER()` at read time. That is
-- the same mistake migration 0051 was written to prevent, wearing different
-- clothes: the number is a position, not an identity, so adding a pack renumbers
-- everything after it and a button pressed a minute later means a different
-- emoji than the one the admin picked. Nothing errors; the wrong glyph is simply
-- saved onto the wrong screen.
--
-- An identity column costs one migration and cannot drift.
--
-- ## The counting sentence
--
-- Absent again, and for the same reason 0051's was: the production dump is not
-- on this machine. What can be said instead is that this table was created by
-- 0050 in the same week and holds only what the panel and the bot have written
-- since — three seeded rows on a fresh install, plus whatever an admin has
-- imported. `ADD COLUMN ... IDENTITY` backfills them in insertion order.

BEGIN;

ALTER TABLE emoji_pack_items
  ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY;

CREATE UNIQUE INDEX idx_emoji_pack_items_id ON emoji_pack_items (id);

COMMIT;
