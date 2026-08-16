-- ---------------------------------------------------------------------------
-- 0021 — operators log in with a password instead of Cloudflare Access
-- ---------------------------------------------------------------------------
--
-- ## Why
--
-- Sam's decision, 2026-08-16: Cloudflare Access goes, and the admin panel gets
-- a login page of its own with a password and TOTP.
--
-- It is not only a preference. The two panels cannot be merged while Access
-- stands, and merging them is the head admin's request. Each panel sits behind
-- its own Access application with its own `aud`, and `access.ts` verifies the
-- JWT against the audience chosen by path. A single bundle served from a single
-- path can only ever carry one of those two tokens, so half of its API calls
-- would fail verification no matter which half. The audience split is the
-- structural obstacle, and this is what removes it.
--
-- ## What this costs, said plainly
--
-- Access was an identity layer in front of the origin. After this, our login
-- page is the only wall. That is why the lockout columns are here in the first
-- migration rather than added later once somebody starts guessing: a password
-- form with no lockout on a public origin is a matter of time, not of luck.
--
-- ## Shape
--
-- `access_users` already exists (0004) and already carries the role and the
-- active flag, so this adds credentials to the row that already decides who may
-- do what. Roles do not change; nothing here touches ADMIN/REVIEWER/READ_ONLY
-- or the personal-data boundary `mayRead` draws.
--
-- `password_hash` is deliberately NULLABLE, and existing rows keep NULL. They
-- cannot log in until somebody sets a password with `operator:set-password`.
-- That is the correct direction to fail: an operator who cannot get in says so
-- immediately, where a default password nobody changed says nothing at all.
--
-- `totp_secret` is a credential and belongs to the same blast radius as the
-- password. The six-digit code is NEVER stored — see `packages/domain/src/totp.ts`
-- and the project rule that OTP is never stored, rendered or logged.
--
-- `totp_last_step` is what stops a replay. A code is valid across the drift
-- window for about ninety seconds, which is long enough for anyone who reads it
-- over a shoulder to spend it a second time. `verifyTotp` returns the step it
-- matched and the login must refuse anything not greater than this column.
--
-- Sessions are a separate table rather than a column because one operator has
-- several — a laptop and a phone — and revoking one must not touch the others.
-- Only the SHA-256 of the token is stored: the row is then useless to anybody
-- who reads the table, exactly like `payment_claims` never holding a receipt.
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE access_users
  ADD COLUMN password_hash       text,
  ADD COLUMN password_updated_at timestamptz,
  ADD COLUMN totp_secret         text,
  ADD COLUMN totp_enabled        boolean NOT NULL DEFAULT false,
  ADD COLUMN totp_last_step      bigint,
  ADD COLUMN failed_attempts     integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until        timestamptz;

COMMENT ON COLUMN access_users.password_hash IS
  'scrypt$N$r$p$salt$hash — see packages/domain/src/operatorAuth.ts. NULL means this operator cannot log in yet.';
COMMENT ON COLUMN access_users.totp_secret IS
  'base32 shared secret. A credential: never returned by any read route except once, at enrolment.';
COMMENT ON COLUMN access_users.totp_last_step IS
  'the last TOTP step consumed; a code at or below this is a replay and is refused';
COMMENT ON COLUMN access_users.locked_until IS
  'set by the same UPDATE that counts the failure, never by a read-then-write';

-- `totp_enabled` without a secret would be a door that cannot be opened, and
-- a secret is meaningless without a password to go with it. Both are cheap to
-- state here and expensive to discover as a locked-out operator.
ALTER TABLE access_users
  ADD CONSTRAINT access_users_totp_needs_secret
    CHECK (NOT totp_enabled OR totp_secret IS NOT NULL);

-- `access_users.id` is `text`, not an identity bigint, and `active` is a 0/1
-- smallint: the table came across from the Cloudflare hub's D1 schema in 0004
-- and kept its shape. The foreign key below has to match that, and a reader of
-- `\d access_users` will see the new timestamptz columns sitting beside
-- `created_at bigint`. That mix is deliberate rather than sloppy — the lockout
-- is applied by `now() + interval '15 minutes'` inside the same UPDATE that
-- counts the failure, and expressing that against epoch milliseconds turns one
-- readable expression into arithmetic nobody checks.
CREATE TABLE operator_sessions (
  id             uuid        PRIMARY KEY,
  access_user_id text        NOT NULL REFERENCES access_users(id) ON DELETE CASCADE,
  -- The SHA-256 of the cookie value, never the value. UNIQUE so a duplicate is
  -- a database error rather than two operators sharing one session.
  token_hash     text        NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  -- Shown on the operator's own session list so a login they do not recognise
  -- is visible to them. Not used for any authorisation decision: both are
  -- attacker-controlled headers.
  ip             text,
  user_agent     text
);

-- Every request looks a session up by its hash and cares only about live ones.
CREATE INDEX idx_operator_sessions_live ON operator_sessions (access_user_id)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE operator_sessions IS
  'browser sessions for the admin panel. Replaces the Cloudflare Access cookie.';

COMMIT;
