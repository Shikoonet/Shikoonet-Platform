-- The panel password, so a panel can be added without a redeploy.
--
-- `provisioning_providers.secret_ref` names a credential and has never held
-- one: the value came from `PANEL_<REF>` in the process environment. That was
-- a real property and this migration keeps it — but it also meant panels could
-- only be added by editing the bot's environment in Coolify and redeploying,
-- which is why «مدیریت پنل‌ها» has an edit button and no add button.
--
-- The cost of leaving it that way is not inconvenience. A panel row with no
-- resolvable credential makes `marzban.ts:150` answer `retryable: false`, so
-- every paid order on that panel FAILS and refunds in front of the customer.
-- Forgetting one environment variable on cutover day does that to a whole
-- panel's worth of purchases.
--
-- WHY A SEPARATE TABLE. `provisioning_providers` promises, in its own schema
-- comment, to be safe to dump, log and hand to a support agent. Putting even a
-- ciphertext in it would make that sentence something you have to qualify. Here
-- the promise stays literally true, and this table is the one place that is not
-- safe to hand over.
--
-- WHY THE KEY IS NOT IN HERE. `PANEL_SECRET_KEY` lives in the environment of
-- the two services that provision. A stolen dump is then ciphertext and
-- nothing else — which is also what makes the nightly backups safe to keep
-- where they are kept.
--
-- AES-256-GCM, sealed as `nonce || ciphertext || tag`, base64. Authenticated,
-- so a row edited by hand fails to open rather than decrypting into something
-- the bot sends to a panel as a password. See `packages/domain/src/secretBox.ts`.

BEGIN;

CREATE TABLE provider_secrets (
  provider_id bigint      PRIMARY KEY
                          REFERENCES provisioning_providers(id) ON DELETE CASCADE,
  -- The sealed `username:password`, base64. Never a plaintext value, and never
  -- read by any route that answers a browser.
  sealed      text        NOT NULL CHECK (length(sealed) > 0),
  -- Which key sealed it, so a key rotation can tell what it has already
  -- re-sealed and what it has not. The value is the key's own SHA-256 prefix,
  -- never the key.
  key_id      text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Who last set it. `audit_logs` carries the same fact as evidence; this one
  -- is here so the panel screen can say "set by X on Y" without a join to an
  -- append-only table nobody should be querying for display.
  set_by      text
);

-- PRIMARY KEY on provider_id is the whole constraint: one credential per
-- panel, replaced in place rather than accumulating versions. A history of
-- passwords is a history of passwords.

COMMENT ON TABLE provider_secrets IS
  'Sealed panel credentials. NOT safe to dump or hand to a support agent — unlike provisioning_providers, which is. Opens only with PANEL_SECRET_KEY.';

COMMIT;
