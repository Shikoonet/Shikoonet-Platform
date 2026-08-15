-- ---------------------------------------------------------------------------
-- 0020 — the two gates a customer passes before the shop opens, and the column
--        one of them was accidentally being written into
-- ---------------------------------------------------------------------------
--
-- ## The bug this migration exists to make fixable
--
-- `packages/migrate/src/migrate.ts` wrote `user.roll_Status` — whether the
-- customer has accepted the shop's rules — into `users.notify_enabled`, which
-- is the only thing gating BOTH expiry warnings (`warn.ts:80,94`). There is no
-- comment claiming that was deliberate; it reads as a boolean landing in the
-- nearest boolean column.
--
-- Measured on the 2026-08-11 dump: **963 customers have `roll_Status = 0`**.
-- Every one of them would have arrived with «سرویس شما رو به اتمام است» switched
-- off for ever — never told their service was ending, and quietly not renewing.
-- Nobody would have reported it, because the missing thing is a message that
-- never arrives.
--
-- `notify_enabled` keeps its own default of true. The legacy schema has no
-- per-customer notification preference to carry: `index.php` warns everybody.
--
-- ## The two gates
--
-- `rules_accepted` is `roll_Status`, in a column that means what it says.
--
-- `channels_checked_at` is ours, and it is a cache rather than a fact. Channel
-- membership lives at Telegram, not here — a customer can leave the channel a
-- minute after joining — so the only honest thing to store is WHEN we last
-- asked. `function.php:613` asks on every single `/start`; this lets the bot ask
-- once per customer per interval instead of once per update, which is the
-- difference between one API call a day and one per button press.
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE users
  ADD COLUMN rules_accepted      boolean NOT NULL DEFAULT false,
  ADD COLUMN channels_checked_at timestamptz;

COMMENT ON COLUMN users.rules_accepted IS
  'legacy user.roll_Status — the customer has accepted the shop rules';
COMMENT ON COLUMN users.channels_checked_at IS
  'when membership of required_channels was last confirmed at Telegram; a cache, not a fact';

COMMIT;
