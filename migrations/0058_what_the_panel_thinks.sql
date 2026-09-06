-- What the PANEL thinks of an account, kept apart from what we think.
--
-- `subscriptions.status` is ours: six words, decided by our own order and
-- provisioning flow. The panel has five of its own — `active`, `limited`,
-- `expired`, `disabled`, `on_hold` — and `sync.ts` has always refused to write
-- one from the other, on the grounds that no honest mapping exists and a sync
-- that guesses can mark a paid service dead over a bad minute.
--
-- That refusal stands. These two columns are not a mapping; they are the
-- panel's own words, stored verbatim under names that say whose opinion they
-- are. Nothing derives `status` from them and nothing shows them to a customer.
--
-- ## Why they are needed now
--
-- The two removal crons in migration 0057 delete a customer's account from a
-- panel, and Mirzabot — which has run both for months — will not do it on our
-- dates alone. `cronbot/NoticationsService.php` gates both on the panel's own
-- verdict:
--
--   shouldRemoveService        : status IN ('limited','expired')
--   shouldRemoveService_volume : status == 'limited'   (see below)
--                                AND online_at is set
--                                AND days since online_at >= cronvolumere
--
-- The volume one reads oddly and the reading matters, so it is written out
-- here rather than left to whoever opens that file next. Line 155 requires
-- status IN ('limited','expired'); line 163 then RETURNS for status IN
-- ('Unknown','active','on_hold','disabled','expired'). `expired` is in both
-- lists, so the only status that survives the pair is `limited` — an account
-- that ran out of gigabytes, not one that ran out of days. That is the job:
-- days are the other cron's.
--
-- Without these columns our version would delete on our expiry date alone,
-- which would remove services the panel still considers live. That is exactly
-- the failure the original «do not map the panel's status» rule was written
-- against — so honouring it here means storing the panel's word, not ignoring
-- it.
--
-- ## Nullable, and null means «do not act»
--
-- Every read of these is a guard, never a permission: a removal requires the
-- word to be PRESENT and to be one of the two. A panel that stops reporting
-- status, or an adapter that never learns to, makes removals STOP rather than
-- start. Backfilling a default would invert that, so there is none.

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS panel_status text,
  ADD COLUMN IF NOT EXISTS panel_online_at timestamptz;

COMMENT ON COLUMN subscriptions.panel_status IS
  'The panel''s own status word, lowercased and unmapped. NULL = the panel did not say. Never derive subscriptions.status from this.';
COMMENT ON COLUMN subscriptions.panel_online_at IS
  'When the panel last saw this account connect. NULL = the panel did not say.';

-- The removal sweeps ask «which ACTIVE subscriptions does the panel call
-- limited or expired», which is a small answer over a large table. Partial, so
-- the index stays roughly the size of that answer rather than of every row:
-- 8,428 subscriptions in production today and a handful of them limited.
CREATE INDEX IF NOT EXISTS idx_subs_panel_verdict
  ON subscriptions (panel_status, expires_at)
  WHERE status = 'ACTIVE' AND panel_status IN ('limited', 'expired');
