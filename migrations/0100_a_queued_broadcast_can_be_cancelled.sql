-- 0100_a_queued_broadcast_can_be_cancelled.sql — 2026-09-25.
--
-- «پیام همگانی» already queues: the sender claims the oldest broadcast's rows
-- first (`claimBroadcastBatch`, ORDER BY created_at), so a second message sent
-- while one is going waits its turn. Sam, 2026-09-25, wants to see that queue
-- and take a message out of it — one still waiting, or the rest of the one
-- going now.
--
-- A timestamp, not a status. The recipient rows stay the record of what
-- happened: those still PENDING become FAILED with error 'cancelled', those
-- already SENT stay SENT. The column is what stops the sender claiming
-- anything more of this broadcast, including a row a 429 hands back to
-- PENDING after the cancel — the recipients' own status cannot say that.
--
-- NULL on every existing row. Undo: ALTER TABLE broadcasts DROP COLUMN cancelled_at;

BEGIN;

ALTER TABLE broadcasts ADD COLUMN cancelled_at timestamptz;

COMMENT ON COLUMN broadcasts.cancelled_at IS
  'When an admin took this broadcast out of the queue. The sender claims nothing more of it; its PENDING rows become FAILED/cancelled.';

COMMIT;
