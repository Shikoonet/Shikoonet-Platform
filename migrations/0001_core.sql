-- 0001_core.sql — identity, wallet, settings, audit.
--
-- Conventions for every NEW table (the payment-hub port in 0004 keeps its own,
-- see the header there):
--   money      bigint, IRR, always. Mirzabot stores Toman; migration multiplies by 10.
--   time       timestamptz, always. Never a formatted string, never a bare epoch.
--   enums      text + CHECK, not a Postgres enum type — widening is a one-line
--              migration and there is no driver-level array/cast friction.
--   legacy key every migrated table carries the old natural key under a UNIQUE
--              constraint. That is what makes the migration script idempotent:
--              ON CONFLICT DO NOTHING is then provably correct, not hopeful.

BEGIN;

CREATE TABLE schema_meta (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_meta (key, value) VALUES ('money_unit', 'IRR'), ('legacy_tz', 'Asia/Tehran');

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
-- Split from Mirzabot's 37-column `user`. The conversation FSM columns
-- (step, Processing_value{,_one,_tow,_four}, pagenumber) are written on almost
-- every Telegram update; keeping them here would rewrite the customer row —
-- and every index on it — on each keystroke. They live in bot_sessions.

CREATE TABLE users (
  id                bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  telegram_id       bigint      NOT NULL UNIQUE,
  username          text,
  phone             text,
  phone_verified    boolean     NOT NULL DEFAULT false,
  lang              text        NOT NULL DEFAULT 'fa',
  status            text        NOT NULL DEFAULT 'ACTIVE'
                      CHECK (status IN ('ACTIVE','BLOCKED')),
  blocked_reason    text,
  is_reseller       boolean     NOT NULL DEFAULT false,
  reseller_max_debt bigint      NOT NULL DEFAULT 0,
  referral_code     text UNIQUE,
  referred_by       bigint      REFERENCES users(id) ON DELETE SET NULL,
  referral_bonus_claimed boolean NOT NULL DEFAULT false,
  test_quota_used   integer     NOT NULL DEFAULT 0,
  score             integer     NOT NULL DEFAULT 0,
  notify_enabled    boolean     NOT NULL DEFAULT true,
  registered_at     timestamptz NOT NULL,
  last_seen_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Everything the legacy row carried that has no home above. Nothing is
  -- dropped in migration; unclaimed columns land here and can be promoted
  -- later once we know they are still used.
  legacy_attrs      jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_users_status   ON users(status) WHERE status <> 'ACTIVE';
CREATE INDEX idx_users_reseller ON users(is_reseller) WHERE is_reseller;
CREATE INDEX idx_users_referred ON users(referred_by);

-- Hot, disposable, one row per user. Truncatable without touching customer data.
CREATE TABLE bot_sessions (
  user_id    bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  step       text,
  data       jsonb       NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- wallet — a ledger, not a mutable integer
-- ---------------------------------------------------------------------------
-- Mirzabot keeps `user.Balance` as a single int with no history: when a balance
-- is wrong there is nothing to reconstruct it from. Production already has one
-- account at -5,940,000 Toman and nothing to explain it.
--
-- Here the balance is derived. Application code NEVER writes wallets.balance_irr;
-- it inserts a wallet_entries row and the trigger moves the balance. That makes
-- "the balance equals the sum of its entries" true by construction.

CREATE TABLE wallets (
  user_id     bigint PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  balance_irr bigint      NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- Deliberately NO CHECK (balance_irr >= 0): production contains a negative
-- balance and migration must reproduce reality, not launder it. Overdraft
-- policy is enforced at the point of spend, not by rejecting the fact.

CREATE TABLE wallet_entries (
  id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id         bigint      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount_irr      bigint      NOT NULL CHECK (amount_irr <> 0),  -- signed: + credit, - debit
  kind            text        NOT NULL CHECK (kind IN (
                    'OPENING','TOPUP','PURCHASE','REFUND','ADMIN_ADJUST',
                    'REFERRAL_BONUS','WHEEL_PRIZE','TRANSFER_IN','TRANSFER_OUT')),
  payment_id      bigint,      -- FK added in 0003 (payments is defined there)
  order_id        bigint,      -- FK added in 0003
  actor           text,        -- admin email / 'SYSTEM' / NULL for customer action
  note            text,
  -- A retried webhook, a double-tapped button, a re-run migration: all safe.
  idempotency_key text UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_wallet_entries_user ON wallet_entries(user_id, created_at DESC);
CREATE INDEX idx_wallet_entries_kind ON wallet_entries(kind, created_at DESC);

CREATE FUNCTION wallet_apply_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO wallets (user_id, balance_irr, updated_at)
       VALUES (NEW.user_id, NEW.amount_irr, now())
  ON CONFLICT (user_id) DO UPDATE
      SET balance_irr = wallets.balance_irr + EXCLUDED.balance_irr,
          updated_at  = now();
  RETURN NULL;
END $$;

CREATE TRIGGER trg_wallet_apply_entry
  AFTER INSERT ON wallet_entries
  FOR EACH ROW EXECUTE FUNCTION wallet_apply_entry();

-- wallet_entries is append-only. Editing history would break the derivation.
CREATE FUNCTION deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (attempted %)', TG_TABLE_NAME, TG_OP;
END $$;

CREATE TRIGGER trg_wallet_entries_append_only
  BEFORE UPDATE OR DELETE ON wallet_entries
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- ---------------------------------------------------------------------------
-- settings — replaces `setting` (1 row x 51 cols), `shopSetting`, `PaySetting`
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  scope      text NOT NULL CHECK (scope IN ('bot','shop','pay','panel')),
  key        text NOT NULL,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY (scope, key)
);

-- ---------------------------------------------------------------------------
-- audit — one append-only log for the whole platform
-- ---------------------------------------------------------------------------
-- The hub's own audit_logs (0004) is a 1:1 port kept for its existing readers;
-- this is the bot/admin side. They stay separate until the hub port is retired.
CREATE TABLE activity_log (
  id          bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  actor_type  text NOT NULL CHECK (actor_type IN ('USER','ADMIN','SYSTEM')),
  actor_id    text,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  before_json jsonb,
  after_json  jsonb,
  reason      text,
  request_id  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_activity_entity ON activity_log(entity_type, entity_id, created_at DESC);
CREATE INDEX idx_activity_actor  ON activity_log(actor_type, actor_id, created_at DESC);

CREATE TRIGGER trg_activity_append_only
  BEFORE UPDATE OR DELETE ON activity_log
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

COMMIT;
