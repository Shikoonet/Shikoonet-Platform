-- 0003_sales.sql — subscriptions, orders, payments.
--
-- The structural finding that drives this file: in production, `Payment_report`
-- and `invoice` are NOT linked. Verified on the 2026-08-11 dump —
--   SELECT COUNT(*) FROM Payment_report p JOIN invoice i
--          ON i.id_invoice = SUBSTRING_INDEX(p.id_invoice,'|',-1);   -- 0
-- `Payment_report.id_invoice` holds 'getconfigafterpay|<user>_<token>', a step
-- token, not an invoice key. So today there is no way to ask "which payment
-- bought this service", for any of the 4,629 payments.
--
-- New rows get that link through `orders`. Migrated rows do NOT get a
-- fabricated one: legacy payments land with order_id NULL and their step token
-- preserved. A guessed link on money data is worse than an absent one.

BEGIN;

-- ---------------------------------------------------------------------------
-- subscriptions — was `invoice`; what the customer actually owns
-- ---------------------------------------------------------------------------
CREATE TABLE subscriptions (
  id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  public_id       text        NOT NULL UNIQUE,   -- legacy invoice.id_invoice
  user_id         bigint      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan_id         bigint      REFERENCES product_plans(id) ON DELETE SET NULL,
  provider_id     bigint      REFERENCES provisioning_providers(id) ON DELETE SET NULL,

  -- Snapshots. 183 live invoices point at panels that no longer exist and 4 at
  -- product names that no longer exist; a FK alone would lose what was sold.
  -- What the customer bought must stay readable after the catalogue moves on.
  provider_name_at_sale text,
  plan_name_at_sale     text NOT NULL,
  price_irr       bigint      NOT NULL CHECK (price_irr >= 0),

  -- Adapter-owned handle to the remote thing: marzban username, Spotify seat
  -- id, AI account id. Every adapter reads and writes only its own keys.
  remote_ref      jsonb       NOT NULL DEFAULT '{}',
  remote_username text,

  volume_gb       numeric(12,3) CHECK (volume_gb IS NULL OR volume_gb >= 0),
  duration_days   integer,
  status          text        NOT NULL CHECK (status IN (
                    'ACTIVE','PENDING_PAYMENT','ON_HOLD','DISABLED','REMOVED','FAILED')),
  -- Production has ten distinct legacy values including 'disabled' AND the
  -- typo 'disabledn'. They collapse into the six above; the original is kept
  -- so the collapse is auditable and reversible.
  legacy_status   text,
  notify          jsonb       NOT NULL DEFAULT '{}',   -- {"volume":bool,"time":bool}
  referral_code   text,
  note            text,
  purchased_at    timestamptz NOT NULL,
  activated_at    timestamptz,
  expires_at      timestamptz,
  last_synced_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  legacy_attrs    jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_subs_user     ON subscriptions(user_id, purchased_at DESC);
CREATE INDEX idx_subs_provider ON subscriptions(provider_id, status);
CREATE INDEX idx_subs_expiring ON subscriptions(expires_at)
  WHERE status = 'ACTIVE' AND expires_at IS NOT NULL;
CREATE INDEX idx_subs_remote   ON subscriptions(provider_id, remote_username)
  WHERE remote_username IS NOT NULL;

-- ---------------------------------------------------------------------------
-- orders — the intent: "this customer wants this, for this price"
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  public_id       text        NOT NULL UNIQUE,   -- what the customer and the hub see
  user_id         bigint      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind            text        NOT NULL CHECK (kind IN (
                    'NEW_PURCHASE','RENEWAL','ADD_VOLUME','ADD_TIME','WALLET_TOPUP','TRANSFER')),
  plan_id         bigint      REFERENCES product_plans(id) ON DELETE SET NULL,
  target_subscription_id bigint REFERENCES subscriptions(id) ON DELETE SET NULL,
  quantity        integer     NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_irr  bigint      NOT NULL CHECK (unit_price_irr >= 0),
  discount_irr    bigint      NOT NULL DEFAULT 0 CHECK (discount_irr >= 0),
  total_irr       bigint      NOT NULL CHECK (total_irr >= 0),
  status          text        NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
                    'DRAFT','AWAITING_PAYMENT','PAID','PROVISIONING',
                    'COMPLETED','FAILED','CANCELLED','EXPIRED')),
  failure_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  completed_at    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- 'service_other:214' etc. Lets the migration be re-run safely and lets any
  -- row be traced back to the MySQL row it came from.
  legacy_ref      text UNIQUE,
  CHECK (total_irr = unit_price_irr * quantity - discount_irr)
);
CREATE INDEX idx_orders_user   ON orders(user_id, created_at DESC);
CREATE INDEX idx_orders_status ON orders(status, created_at DESC);
CREATE INDEX idx_orders_open   ON orders(expires_at)
  WHERE status IN ('DRAFT','AWAITING_PAYMENT');

ALTER TABLE subscriptions
  ADD COLUMN order_id bigint REFERENCES orders(id) ON DELETE SET NULL;
CREATE INDEX idx_subs_order ON subscriptions(order_id);

-- ---------------------------------------------------------------------------
-- payments — was Payment_report; money movement, not intent
-- ---------------------------------------------------------------------------
CREATE TABLE payments (
  id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  public_id       text        NOT NULL UNIQUE,   -- legacy id_order ('b5baf9f689')
  -- Nullable on purpose: 25 production payments belong to users that were
  -- deleted. Dropping them would move the money total; inventing a user would
  -- corrupt the customer table. They keep their telegram id and nothing else.
  user_id         bigint      REFERENCES users(id) ON DELETE RESTRICT,
  legacy_telegram_id bigint,
  order_id        bigint      REFERENCES orders(id) ON DELETE SET NULL,
  amount_irr      bigint      NOT NULL CHECK (amount_irr >= 0),
  method          text        NOT NULL CHECK (method IN (
                    'CARD_TO_CARD','CRYPTO','TELEGRAM_STARS','GATEWAY',
                    'WALLET','ADMIN_CREDIT','ADMIN_DEBIT')),
  status          text        NOT NULL CHECK (status IN (
                    'PENDING','AWAITING_REVIEW','PROCESSING','PAID','REJECTED','EXPIRED')),
  reject_reason   text,
  -- The card the customer was told to pay into. Denormalised text, not a FK:
  -- 22 production leases already point at cards that were since removed, and
  -- the receipt must stay truthful about where the money was sent.
  assigned_card_number text,
  assigned_card_name   text,
  -- Legacy step token, e.g. 'getconfigafterpay|6714538686_28ed'. Kept whole;
  -- `operation_type` is its prefix, which is all that was ever readable.
  operation_type  text,
  legacy_step_token text,
  -- The raw Payment_Method string ('arze digital offline', 'plisio', …). `method`
  -- above is the normalised form; this keeps the original so a collapse can
  -- always be undone.
  legacy_method   text,
  telegram_message_id bigint,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz,
  legacy_id       integer UNIQUE                 -- Payment_report.id
);
CREATE INDEX idx_payments_user    ON payments(user_id, created_at DESC);
CREATE INDEX idx_payments_status  ON payments(status, created_at DESC);
CREATE INDEX idx_payments_order   ON payments(order_id);
CREATE INDEX idx_payments_pending ON payments(created_at)
  WHERE status IN ('PENDING','AWAITING_REVIEW');

-- Deferred FKs from 0001/0002, now that their targets exist.
ALTER TABLE wallet_entries
  ADD CONSTRAINT fk_wallet_entries_payment
      FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_wallet_entries_order
      FOREIGN KEY (order_id)   REFERENCES orders(id)   ON DELETE SET NULL;

ALTER TABLE discount_redemptions
  ADD CONSTRAINT fk_redemption_order
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;

COMMIT;
