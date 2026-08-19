-- The state a broadcast row is in while somebody is actually sending it.
--
-- `claimBroadcastBatch` wrote `SENT` at the moment it claimed a row, before
-- Telegram had been asked anything. The comment above it defended the choice
-- and the defence is sound as far as it goes: at most once, never twice. A
-- customer who misses an announcement missed an announcement; a customer who
-- gets it twice was spammed by a shop they trust with their money.
--
-- What it did not defend is the silence. With two states there is no way to
-- tell a message that reached somebody from one that was claimed and then
-- never sent — and that is not only the crash case. `sweepBroadcasts` breaks
-- out of its loop on `signal.aborted`, so an ORDINARY shutdown in the middle
-- of a paced broadcast marks every remaining claimed row as delivered. The
-- shop is told a number that is larger than the number of people who heard.
--
-- SENDING costs one state and changes no policy: a row left in it is still
-- never retried, because whether Telegram accepted the message before the
-- process died is exactly the thing nobody knows. It stops being invisible,
-- which is the whole change.

BEGIN;

ALTER TABLE broadcast_recipients
  DROP CONSTRAINT broadcast_recipients_status_check,
  ADD  CONSTRAINT broadcast_recipients_status_check
       CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED'));

-- When the row was picked up, so a stranded one can be aged. Distinct from
-- `sent_at`, which now means what it says: the moment Telegram accepted it.
ALTER TABLE broadcast_recipients ADD COLUMN claimed_at timestamptz;

-- The claim still only ever reads PENDING rows, so `idx_broadcast_pending`
-- stays exactly right for it. This one answers the other question — "is
-- anything stuck?" — which has no index today because nothing could ask it.
CREATE INDEX idx_broadcast_sending
  ON broadcast_recipients (claimed_at)
  WHERE status = 'SENDING';

COMMIT;
