-- 0094 — a text can leave as a file.
--
-- Sam, 2026-09-22: a WireGuard buyer gets the config itself, as a .conf file
-- the WireGuard app imports and as a QR code its camera reads, beside the
-- subscription link. The bot builds that file from the panel's `links` the
-- moment the service is delivered; there is no file anywhere for a `file_id`
-- to point at.
--
-- So an outbox row may now carry text that is sent AS a document: `body` is
-- the file's content and `doc_name` its name. The row stays one unit of retry,
-- as a shelf's attachment rows are (0087): a document Telegram refuses is
-- retried alone and never sends the service message twice.
--
-- A row is one thing. A Telegram `file_id` and a generated document are two
-- different ways to send a file, and nothing needs both on one row.
--
-- Nullable and ignored when null, so every row already in the table keeps
-- behaving exactly as it did.
BEGIN;

ALTER TABLE bot_notifications
  ADD COLUMN doc_name text,
  ADD CONSTRAINT notification_one_attachment CHECK (doc_name IS NULL OR file_id IS NULL);

COMMIT;
