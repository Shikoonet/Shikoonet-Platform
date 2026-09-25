-- 0102_a_broadcast_still_sending_is_not_finished.sql — 2026-09-25.
--
-- `queueBroadcast` wrote the broadcast row and its recipients as two separate
-- statements, and the bot's `closeFinishedBroadcasts` (every second) could run
-- between them: a broadcast with nothing PENDING yet, stamped finished at the
-- moment it was queued. Seen in production the same day: a 17,362-recipient
-- broadcast 44٪ sent, and «صف پیام همگانی» empty. The sender never reads
-- `finished_at`, so every customer was still messaged; what broke is
-- everything that does — the queue, «لغو», and the header's «which one is
-- going». The code is fixed (one transaction); this undoes the stamp on a
-- broadcast that is demonstrably not finished.
--
-- PENDING only, not SENDING. A row stranded in SENDING by a sweep that died
-- is never picked up again, and reopening its broadcast would pin a long-dead
-- announcement to the top of the queue for good. A PENDING row is one the bot
-- will still send, so its broadcast is going — and the bot stamps it finished
-- again, correctly, once the last one goes.
--
-- Past broadcasts keep the wrong `finished_at` (their queue time rather than
-- their last send); nothing reads it for display.
--
-- Undo: nothing to undo — the bot re-stamps these when they drain.

BEGIN;

UPDATE broadcasts b
   SET finished_at = NULL
 WHERE b.finished_at IS NOT NULL
   AND EXISTS (SELECT 1 FROM broadcast_recipients r
                WHERE r.broadcast_id = b.id AND r.status = 'PENDING');

COMMIT;
