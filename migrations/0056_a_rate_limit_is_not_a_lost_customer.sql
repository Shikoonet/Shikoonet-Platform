-- A 429 from Telegram meant a customer never heard the announcement. For ever.
--
-- `sweepBroadcasts` recorded EVERY send error as FAILED and never offered the
-- row again. That was defensible while the loop was serial: it managed about
-- four messages a second, Telegram's ceiling is around thirty, and a rate limit
-- was not something the shop was going to meet. The ordinary failure was a
-- customer who had blocked the bot, and retrying that forever is worse than
-- dropping it.
--
-- Concurrency changed the arithmetic and not the code. Twelve sends in flight
-- at a 25-per-second pace makes a 429 an ordinary event rather than a rare one,
-- and every one of them is now a customer who is never told — silently, with
-- nothing on any screen to say why. Issue #90.
--
-- ## Why a 429 is the ONE error worth retrying
--
-- `isPermanentRejection` already sorts 403 and 400 from everything else, and it
-- has been right about that since it was written: a blocked bot stays blocked.
-- But "not permanent" is not the same as "safe to send again". A 5xx, or a
-- socket that closed mid-request, means NOBODY KNOWS whether Telegram accepted
-- the message — and re-sending it is exactly the duplicate that
-- `PRIMARY KEY (broadcast_id, user_id)` exists to prevent. A shop that spams a
-- customer it takes money from has done worse than miss them once.
--
-- A 429 is different in kind, not in degree: Telegram is telling us it did NOT
-- deliver this, and how long to wait. That is the only refusal that carries its
-- own proof of non-delivery, so it is the only one that goes back to PENDING.
--
-- ## Why the attempt is counted
--
-- Without a ceiling, a shop that stays rate-limited retries the same rows every
-- cycle for ever, and the broadcast never finishes and never fails. The count
-- lives on the row rather than in memory because the process that made the
-- attempt may not be the process that makes the next one.
--
-- ## Why the DEADLINE is on the row too, and not only in the sweep
--
-- The first version held the pause in a local variable inside
-- `sweepBroadcasts`, which backs the whole worker pool off correctly and then
-- forgets. A sweep runs for one poll cycle; the next one starts twenty-five
-- seconds later with no memory of anything. So a `retry_after` of sixty
-- seconds was obeyed for the rest of that sweep and ignored by the next three
-- — which would have burned every one of the five attempts inside two minutes
-- and lost the customer, in the code written to stop exactly that.
--
-- Both are needed and they answer different questions. `pauseUntil` in the
-- sweep stops the eleven workers that have already claimed rows and are about
-- to call Telegram; this column stops the NEXT sweep claiming a row that is not
-- due yet. Found by CodeRabbit on PR #95.

BEGIN;

ALTER TABLE broadcast_recipients
  ADD COLUMN attempts integer NOT NULL DEFAULT 0
    CHECK (attempts >= 0),
  -- NULL means «due now», which is what every existing row is and what an
  -- ordinary queued message stays.
  ADD COLUMN next_attempt_at timestamptz;

COMMIT;
