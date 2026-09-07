-- 0060 — a reseller, and the meter that bills them
--
-- ## Why a table rather than the boolean we already have
--
-- `users.is_reseller` changes five things and none of them is "this is a
-- separate business". It is a flag on a PERSON: it opens `resellers_only`
-- products, picks the 'n' price column, hides the apply button, unlocks
-- reseller discount codes, and ranks them in the nightly report.
--
-- Sam drew the line in his own words: a reseller is a LEGAL person where a
-- customer is a natural one. A franchise, not a flag — its own installation,
-- its own bot, its own database, its own dashboard, connected only to OUR VPN
-- panels. Nothing here is a tenant column, and no route grows a tenant filter:
-- the reseller's own customers never reach this database at all.
--
-- What DOES reach us is the meter. That is this file.
--
-- ## There is already a table called `resellers`, and it is NOT this
--
-- `0004_payment_hub.sql:361` created `resellers` + `reseller_transactions`.
-- Same word, different question: those exist so an incoming BANK TRANSACTION
-- can be attributed to a reseller — the badge that reads "this payment is from
-- a reseller" on the money screens. It is about money arriving, not about an
-- installation running.
--
-- They were left alone rather than extended, and the reason is measured: on
-- the live simulation `resellers` holds **zero rows** and nothing has ever
-- classified a transaction into it. Widening an empty, unused table to carry a
-- panel admin username and a traffic cap would be designing for a feature
-- nobody has used yet, in the old `text` id and epoch-`bigint` shape that the
-- mechanical D1 port left behind.
--
-- The day both are real, the join is one nullable column from here to there,
-- and then "what this reseller paid us" and "what this reseller used" answer
-- side by side. That column is deliberately not added today.
--
-- ## Measured on the real panel, 2026-09-07 — and one plan assumption was wrong
--
-- `GET /api/admins` on PasarGuard 5.2.1 returns, per admin:
--
--     used_traffic  lifetime_used_traffic  data_limit  total_users
--     status        is_disabled            is_limited  role
--
-- So the meter is the panel's own field, not something we compute — which is
-- the whole reason the reseller's own installation is never asked how much it
-- used. Neither side can move that number.
--
-- **But an admin row carries NO expiry.** The plan assumed the panel would
-- enforce a term the way it enforces `data_limit`; it does not — there is no
-- `expire`, `expire_at` or equivalent key on the object, checked directly
-- against the panel rather than read off its documentation.
-- (`role.limits.expire_min/max` do exist and are a bound on the USERS an admin
-- creates, not on the admin.) So `expires_at` below is OURS to enforce, and
-- that is why it is a column here rather than a mirror of a panel field.
--
-- The volume half IS the panel's: `data_limit` plus `is_limited`, and the role
-- carries `disconnect_users_when_limited`. Over its cap, the panel stops the
-- reseller's customers without us doing anything.

-- ---------------------------------------------------------------------------
-- 1. The reseller
-- ---------------------------------------------------------------------------
CREATE TABLE reseller_accounts (
  id                    bigserial   PRIMARY KEY,

  -- The person we already know, kept rather than duplicated: they have a
  -- telegram id, a wallet and an order history, and capacity is bought through
  -- that same wallet. `is_reseller` on that row stays what it is — a flag about
  -- what the BOT shows them — and this table is the business beside it.
  user_id               bigint      NOT NULL
                                    REFERENCES users(id) ON DELETE RESTRICT,

  -- Which of our panels their installation provisions against, and the admin
  -- account on it that is theirs. The pair is what makes the meter readable:
  -- everything the panel counts under this username is theirs and nobody
  -- else's — which is also the separation that stops one shop's order number
  -- colliding with another's on a shared panel.
  provider_id           bigint      NOT NULL
                                    REFERENCES provisioning_providers(id)
                                    ON DELETE RESTRICT,
  panel_admin_username  text        NOT NULL CHECK (length(panel_admin_username) > 0),

  -- The display name in OUR dashboard. Sam asked for a separate name — a
  -- business, not a telegram handle.
  name                  text        NOT NULL CHECK (length(name) > 0),

  -- What they bought. Volume only: Sam decided against a user cap on
  -- 2026-09-02, so there is no `max_users` here even though the panel offers
  -- one. We sell traffic; how many customers they serve with it is theirs.
  --
  -- NULL means unlimited, matching the panel's own `data_limit: null`.
  data_limit_bytes      bigint      CHECK (data_limit_bytes IS NULL OR data_limit_bytes > 0),

  -- The term. OURS to enforce — see the header. NULL means open-ended.
  expires_at            timestamptz,

  -- ACTIVE    — provisioning, and the meter is read
  -- SUSPENDED — we switched them off (term ended, or by hand)
  -- CLOSED    — over, kept because the ledger below still references it
  status                text        NOT NULL DEFAULT 'ACTIVE'
                                    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),

  -- Where their own panel lives, so an operator can click through. Never
  -- called by us: their installation is theirs.
  installation_url      text,

  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- One reseller per admin account per panel. Two rows pointing at one panel
-- admin would be two meters reading one number, and both would bill it.
-- Lowercased because the panel treats its admin names case-insensitively.
CREATE UNIQUE INDEX idx_reseller_panel_admin
  ON reseller_accounts (provider_id, lower(panel_admin_username));

-- The sweep's own question: which resellers to read this round.
CREATE INDEX idx_reseller_active
  ON reseller_accounts (provider_id) WHERE status = 'ACTIVE';

COMMENT ON TABLE reseller_accounts IS
  'A franchise: their own installation, connected to our panels. Their customers never appear in this database.';

-- ---------------------------------------------------------------------------
-- 2. The meter — append-only, like every other ledger here
-- ---------------------------------------------------------------------------
--
-- Why snapshots rather than a running total on the row above: a total that is
-- overwritten cannot be audited and cannot be recomputed. When a reseller asks
-- "why is this the bill", the answer has to be a list of readings with times
-- on them, not one number that has been UPDATEd two thousand times.
--
-- It is also what makes the sweep idempotent in the way that matters. Reading
-- twice in one minute writes two rows and changes no total, because the total
-- is `max(lifetime_used_bytes)`, not `sum(...)`.
CREATE TABLE reseller_usage_snapshots (
  id                    bigserial   PRIMARY KEY,
  reseller_id           bigint      NOT NULL
                                    REFERENCES reseller_accounts(id) ON DELETE RESTRICT,

  -- `used_traffic` — resets when the panel resets it.
  used_bytes            bigint      NOT NULL CHECK (used_bytes >= 0),

  -- `lifetime_used_traffic` — the one that only goes up, and therefore the one
  -- a bill can be built on. Kept beside the resettable figure rather than
  -- instead of it, because "they used 3 TB this period" and "they have used
  -- 40 TB ever" are different questions and the screen asks both.
  lifetime_used_bytes   bigint      NOT NULL CHECK (lifetime_used_bytes >= 0),

  -- What the panel said the cap was AT THE MOMENT OF READING. A cap raised
  -- mid-period would otherwise make every earlier reading look wrong.
  data_limit_bytes      bigint      CHECK (data_limit_bytes IS NULL OR data_limit_bytes >= 0),

  -- Display only, and deliberately so: Sam said we do not need to know who the
  -- reseller's users are. A count is not a user.
  total_users           integer     NOT NULL DEFAULT 0 CHECK (total_users >= 0),

  -- The panel's own words, so a suspension can be told apart from a cap.
  panel_status          text,
  panel_is_limited      boolean,

  taken_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_reseller_snapshot_latest
  ON reseller_usage_snapshots (reseller_id, taken_at DESC);

-- Append-only, the same way `wallet_entries` and `activity_log` are. A meter
-- that can be edited is not evidence — and this one is what an invoice is
-- built from.
CREATE TRIGGER reseller_usage_snapshots_append_only
  BEFORE UPDATE OR DELETE ON reseller_usage_snapshots
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

COMMENT ON TABLE reseller_usage_snapshots IS
  'Append-only meter readings taken from the panel. The bill is built from lifetime_used_bytes, never from what the reseller reports.';
