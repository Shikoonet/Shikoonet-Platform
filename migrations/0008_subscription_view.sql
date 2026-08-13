-- 0008_subscription_view.sql — what a customer needs to SEE about a service
-- they already own.
--
-- Until now `subscriptions` recorded what was sold and where the account lives
-- (`remote_username`, `remote_ref`), but not the two things the customer opens
-- the bot to look at: the subscription link, and how much of their volume is
-- left. Both were thrown away.
--
-- Mirzabot does not store either. `admin.php:6212` reads
-- `$DataUserOut['subscription_url']` straight off the panel every time anyone
-- looks at a service, and the volume figure comes from the same call. That
-- works, but it puts a 20-second network call in the middle of answering a
-- button press — and here that button press runs inside the transaction that
-- claims `update_id`, so a slow panel would hold the exactly-once lock open.
--
-- So the numbers are kept here instead, refreshed by a sweep. `last_synced_at`
-- already existed for exactly this and was never written; now it means "when
-- these two columns were last true".
--
-- Deliberately NOT synced from the panel: `status`. Marzban's vocabulary
-- (active / limited / expired / disabled / on_hold) does not map onto the six
-- values this column is CHECKed against, and guessing would let a panel hiccup
-- mark a paid service REMOVED. Expiry and exhaustion are derived for display
-- from `expires_at` and the two columns below, which cannot lose data.

BEGIN;

ALTER TABLE subscriptions
  -- What the customer taps. NULL is honest: a manual product has no link, and
  -- a migrated row has none until the first sync fetches it.
  ADD COLUMN subscription_url text,
  -- Bytes, as the panel reports them — not gigabytes. `volume_gb` is
  -- numeric(12,3) because that is how a plan is sold; usage is counted, and
  -- rounding a counter to three decimals of a gigabyte loses 500KB per read.
  ADD COLUMN used_bytes bigint CHECK (used_bytes IS NULL OR used_bytes >= 0);

-- The sweep asks for the oldest first, so it needs to find them without
-- reading every row. Partial: a subscription with no remote account has
-- nothing to sync and must not take up space in the index.
CREATE INDEX idx_subs_sync ON subscriptions(last_synced_at NULLS FIRST)
  WHERE status = 'ACTIVE' AND remote_username IS NOT NULL;

COMMIT;
