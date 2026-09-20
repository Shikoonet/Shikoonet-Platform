-- 0088 — the outbox answers «what has this rule already sent about this service».
--
-- Sam, 2026-09-20: «هفت بار بیشتر به طرف پیغام نده … هر دو روز یه بار». A
-- retention rule with a cap or a pace has to read its own history per
-- service before writing the next row, and that history is the keys
-- `retention:<rule>:<sub>:<expiry>:<day>` — a prefix of `dedupe_key`.
--
-- The UNIQUE index on `dedupe_key` (0024) answers equality only: a prefix
-- range on it depends on the database collation ordering bytes, which
-- `C.UTF-8` does and `en_US` does not, and the sweep's prefix is built per
-- row so `LIKE` could never use an index at all. An index in collation "C"
-- makes `dedupe_key COLLATE "C" >= prefix AND < prefix || ';'` a plain
-- range scan on every server, whatever its own collation is.
--
-- Undone by dropping the index; nothing else changes.
BEGIN;

CREATE INDEX bot_notifications_dedupe_key_bytes
  ON bot_notifications (dedupe_key COLLATE "C");
COMMENT ON INDEX bot_notifications_dedupe_key_bytes IS
  'Prefix scans on dedupe_key in byte order, for a sweep reading its own earlier rows (0088).';

COMMIT;
