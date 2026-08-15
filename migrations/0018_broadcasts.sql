-- 0017 — broadcasts: one message, every customer, exactly once each
-- ---------------------------------------------------------------------------
-- The riskiest button in the project, so the guarantee is a primary key rather
-- than a loop that promises to be careful.
--
-- A broadcast is written down before a single message leaves: the recipient
-- list is snapshotted at the moment the admin confirms, so somebody who presses
-- /start halfway through does not get a message announcing an outage that
-- started before they existed, and the sweep cannot be handed a moving target.
--
-- `PRIMARY KEY (broadcast_id, user_id)` is what stops a customer being told
-- twice. The sweep claims a batch by moving rows out of PENDING in the same
-- statement that returns them, so two overlapping cycles — or two processes
-- during a rolling deploy — cannot both take the same row.
--
-- There is no retry. A row that fails to send is FAILED and stays FAILED: the
-- ordinary reason is a customer who blocked the bot, retrying that forever
-- costs the shop its rate limit, and re-sending anything else risks the
-- duplicate this table exists to prevent. The failures are counted and shown.

BEGIN;

CREATE TABLE broadcasts (
  id          uuid        PRIMARY KEY,
  body        text        NOT NULL CHECK (body <> ''),
  -- `admins.telegram_id`, not a foreign key: an admin row may be removed later
  -- and the record of who sent this must outlive them.
  created_by  bigint      NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE broadcast_recipients (
  broadcast_id uuid   NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Snapshotted beside the user id. A customer's Telegram id does not change,
  -- but reading it here keeps the sweep to one table.
  telegram_id  bigint NOT NULL,
  status       text   NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  error        text,
  sent_at      timestamptz,
  PRIMARY KEY (broadcast_id, user_id)
);

-- Only the pending rows are ever queried, and by the end of a broadcast they
-- are all gone. A partial index keeps the sweep's lookup proportional to what
-- is left to do rather than to how many broadcasts the shop has ever sent.
CREATE INDEX idx_broadcast_pending
  ON broadcast_recipients (broadcast_id)
  WHERE status = 'PENDING';

COMMIT;
