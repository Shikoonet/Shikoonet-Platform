-- 0045 — two things the old bot could say about a panel that this one could not.
--
-- Everything else in this change lives in `provisioning_providers.config`,
-- where the importer already put it: the username convention, the trial size,
-- the group an expired account falls back to. `renew_mode` established that
-- pattern and it needs no migration. Two things could not go there.
--
-- ## 1. Who may not see a panel
--
-- Legacy keeps this as `marzban_panel.hide_user`, a JSON array of Telegram ids
-- on the panel row, and it has two bugs that are properties of that shape
-- rather than of the code around it. Adding is `$hideuserid[] = $text` with no
-- membership test (`admin.php:8651`), so the same id goes in twice; removing is
-- `array_search`, which finds only the first (`admin.php:8686`), so an id added
-- twice needs removing twice and an admin who removes it once believes they
-- did. A PRIMARY KEY makes both impossible to write down.
--
-- The filter is the other half. Legacy re-implements it as a `continue` in
-- seven places (`keyboard.php:616,650,686,707,721,740` and
-- `api/miniapp.php:356`) and forgets it in the single-panel shortcuts, which
-- answer «موقعیتی یافت نشد» instead. Here it is one clause inside `PURCHASABLE`,
-- which every catalogue query already goes through — including the three that
-- validate a callback, so a hidden panel is not reachable by posting its id.
--
-- KEYED ON `users.id`, NOT ON THE TELEGRAM ID. The consequence is that a
-- customer who has never started the bot cannot be hidden in advance, which
-- legacy allows because it stores the bare number. That is the trade: a row
-- here always names somebody the screen can show, and the route says «this
-- person has not started the bot yet» instead of silently storing a number that
-- matches nobody. Swap in a `telegram_id` column the day somebody needs the
-- other behaviour.
--
-- ## 2. An order that names a panel without naming a plan
--
-- A trial is not a plan. It has no price, no `product_plans` row, and its size
-- comes from the panel — which means the sweep cannot find its panel the way it
-- finds every other order's, through `plan → product → provider`. Hence
-- `orders.provider_id`, and `COALESCE` in front of the two existing paths.
--
-- ON DELETE RESTRICT, matching `products.provider_id` in 0002: a panel with
-- history behind it is not something to delete out from under that history.

BEGIN;

-- ---------------------------------------------------------------------------
-- provider_hidden_users — was marzban_panel.hide_user
-- ---------------------------------------------------------------------------
CREATE TABLE provider_hidden_users (
  provider_id bigint      NOT NULL REFERENCES provisioning_providers(id) ON DELETE CASCADE,
  user_id     bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hidden_at   timestamptz NOT NULL DEFAULT now(),
  -- The operator's email, or 'import' for a row the migration recovered.
  hidden_by   text,
  PRIMARY KEY (provider_id, user_id)
);

-- Answering «which panels are hidden from THIS customer» is the direction the
-- shop asks in; the PRIMARY KEY already answers the other one.
CREATE INDEX idx_provider_hidden_by_user ON provider_hidden_users(user_id);

COMMENT ON TABLE provider_hidden_users IS
  'A customer does not see this panel in the shop. Legacy marzban_panel.hide_user.';

-- Recovering whatever the importer carried across.
--
-- All five production panels have `hide_user` NULL, so this moves nothing
-- today. It is here for the reseller case: `packages/migrate` is run again by
-- somebody importing their own Mirzabot database, and a list that silently
-- vanished on the second import would be worse than one that never arrived.
--
-- AS MATERIALIZED is load-bearing, not decoration. Without it the planner may
-- inline the subquery and evaluate `tg::bigint` on rows the regex has not
-- filtered yet, and one non-numeric entry in one panel's list would abort the
-- whole migration. Same documented fence, same reason, as the batch claims in
-- `notify.ts` and `webhook.ts`.
WITH hidden AS MATERIALIZED (
  SELECT pr.id AS provider_id, t.tg AS tg
    FROM provisioning_providers pr
    CROSS JOIN LATERAL jsonb_array_elements_text(
           CASE WHEN jsonb_typeof(pr.config -> 'hide_user') = 'array'
                THEN pr.config -> 'hide_user'
                ELSE '[]'::jsonb
           END) AS t(tg)
   WHERE t.tg ~ '^[0-9]{1,18}$'
)
INSERT INTO provider_hidden_users (provider_id, user_id, hidden_by)
SELECT h.provider_id, u.id, 'import'
  FROM hidden h
  JOIN users u ON u.telegram_id = h.tg::bigint
ON CONFLICT DO NOTHING;

-- One home for the fact. A key left in `config` would be a second source that
-- nothing reads and that drifts the first time somebody edits the list.
UPDATE provisioning_providers
   SET config = config - 'hide_user'
 WHERE config ? 'hide_user';

-- ---------------------------------------------------------------------------
-- orders.provider_id + the TRIAL kind
-- ---------------------------------------------------------------------------
ALTER TABLE orders
  ADD COLUMN provider_id bigint REFERENCES provisioning_providers(id) ON DELETE RESTRICT;

COMMENT ON COLUMN orders.provider_id IS
  'The panel, when the order does not name one through a plan. Set on TRIAL; NULL everywhere else.';

ALTER TABLE orders
  DROP CONSTRAINT orders_kind_check,
  ADD  CONSTRAINT orders_kind_check CHECK (kind IN (
    'NEW_PURCHASE','RENEWAL','ADD_VOLUME','ADD_TIME','WALLET_TOPUP','TRANSFER','TRIAL'));

-- A trial is free, and free is exactly what `place()` in the bot refuses to
-- write for every other kind — a zero-priced order somebody can still be asked
-- to pay for is an invoice no bank transaction can ever match. This CHECK is
-- that rule for the one kind that IS free: it costs nothing, it names its
-- panel, and it never enters the payment path.
ALTER TABLE orders
  ADD CONSTRAINT orders_trial_is_free CHECK (
    kind <> 'TRIAL'
    OR (total_irr = 0 AND provider_id IS NOT NULL AND status <> 'AWAITING_PAYMENT'));

-- ---------------------------------------------------------------------------
-- subscriptions: the two columns a downgrade needs to be reversible
-- ---------------------------------------------------------------------------
--
-- «اینباند اکانت غیرفعال»: when a service ends, the account is not left alone
-- and not deleted -- it is moved onto a group that carries almost nothing, so
-- the customer's app keeps resolving and shows them a service that has run out
-- rather than a link that silently returns nothing.
--
-- Legacy does this and stashes the account's previous proxies in
-- `invoice.uuid` -- a column named for something else entirely, holding a JSON
-- blob, restored by three copies of the same six lines in `panels.php`. The two
-- copies do not even agree: the cron saves `$userData['uuid']` and the webhook
-- saves `$data['proxies']`.
--
-- Here it is two columns that say what they hold. `groups_before_downgrade` may
-- be NULL on a row that IS downgraded -- a sweep interrupted between the panel
-- call and this write -- and the renewal path treats that as «use what the plan
-- would have given a new account», which is the same answer a fresh purchase
-- gets and never worse than the truth.

ALTER TABLE subscriptions
  ADD COLUMN downgraded_at            timestamptz,
  ADD COLUMN groups_before_downgrade  jsonb;

COMMENT ON COLUMN subscriptions.downgraded_at IS
  'When this account was moved onto the panel''s downgrade groups because its service ended. NULL means it is on what it was sold.';

-- The sweep asks «which live rows have ended and are not downgraded yet», and
-- the renewal path asks «is this one downgraded». Both are answered by rows
-- where the marker is set or clear on a bounded set, so one partial index over
-- the ones still to do is the whole cost.
CREATE INDEX idx_subscriptions_to_downgrade ON subscriptions (expires_at)
  WHERE downgraded_at IS NULL AND expires_at IS NOT NULL AND status = 'ACTIVE';

COMMIT;
