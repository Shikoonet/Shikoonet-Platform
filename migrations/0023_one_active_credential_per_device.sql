-- One device, one working API token, and Postgres is what says so.
--
-- `device_credentials` has a unique index on `token_hash` and nothing else, so
-- "a device has at most one ACTIVE credential" lived only in the three routes
-- that maintain it — and all three read the active row, then write:
--
--   POST /devices/:id/credentials        SELECT active → 409 if found → INSERT
--   POST /devices/:id/credentials/rotate SELECT active → UPDATE it → INSERT
--   POST /devices/:id/credentials/revoke SELECT active LIMIT 1 → UPDATE it
--
-- Two calls arriving together each read nothing, or each read the same row, and
-- each write. The result is two ACTIVE tokens for one phone. What that costs:
--
--   * revoking "the" credential revokes one of them, and the other keeps
--     working — so an operator who has just cut a lost phone off has not;
--   * the dashboard shows whichever `LIMIT 1` returns, with no ordering, so it
--     may print the prefix of a token that is not the one in use;
--   * `findActiveCredentialByPrefix` matches on `(token_prefix, device_id)` and
--     also takes `LIMIT 1`, so with two rows sharing a prefix the authentication
--     answer depends on the plan Postgres happened to pick.
--
-- The last one is why this is not merely untidy. Authentication that is
-- nondeterministic is authentication that cannot be reasoned about.
--
-- Partial and status-scoped, like `0016` and `0022`. A device accumulates
-- REVOKED credentials over its life — that is the audit trail, and rotation
-- would be impossible without it. What must never exist twice is a token that
-- still opens the door.
--
-- Verified before writing: the simulation carries 6 credentials, all ACTIVE,
-- and zero devices hold more than one. The Hub export is the only other source
-- of these rows and it produced them one per device.

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_credentials_one_active
  ON device_credentials (device_id)
  WHERE status = 'ACTIVE';
