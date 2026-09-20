-- 0087 — a shelf carries its papers (#377).
--
-- An OpenVPN service is unusable without its config file and a video that
-- shows where to put it; until now both were sent by hand after every sale.
-- Here they are filed on the shelf itself, and the bot sends them after the
-- delivery message of every NEW purchase from that shelf.
--
-- No bytes are stored, as nowhere in this platform: each row is a Telegram
-- `file_id` the bot obtained by sending the file to the reports group once.
-- The id belongs to that bot; a new bot means adding the files again.
--
-- `bot_notifications` learns to carry a file instead of a text: a queued row
-- with `file_id` is sent with `sendDocument`/`sendVideo`/`sendPhoto` — which
-- one, `file_kind` says, because Telegram's three id spaces are distinct —
-- and its `body` is ignored. Both nullable and both ignored when null, so
-- every row already in the table keeps behaving exactly as it did.
BEGIN;

CREATE TABLE shelf_attachments (
  id          bigserial PRIMARY KEY,
  plan_id     bigint NOT NULL REFERENCES product_plans(id) ON DELETE CASCADE,
  kind        text   NOT NULL CHECK (kind IN ('document', 'video', 'photo')),
  file_id     text   NOT NULL,
  file_name   text   NOT NULL,
  size_bytes  bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE shelf_attachments IS
  'Files the bot sends after delivering a purchase from this shelf, in id order. file_id is Telegram''s, for this bot.';
CREATE INDEX idx_shelf_attachments_plan ON shelf_attachments (plan_id, id);

ALTER TABLE bot_notifications
  ADD COLUMN file_kind text CHECK (file_kind IN ('document', 'video', 'photo')),
  ADD COLUMN file_id   text,
  ADD CONSTRAINT notification_file_pair CHECK ((file_kind IS NULL) = (file_id IS NULL));

COMMIT;
