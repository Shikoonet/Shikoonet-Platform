-- 0002_catalog.sql — what we sell, and what fulfils it.
--
-- Mirzabot has one shape: `marzban_panel` (43 columns, all VPN-panel specific)
-- and `product` (a row is simultaneously a product AND its single price/volume/
-- duration combination, bound to one panel). Selling anything that is not a VPN
-- means adding columns to a 43-column table.
--
-- Here fulfilment is an adapter behind `kind`. Adding Spotify or an AI account
-- is a new adapter plus rows — no change to orders, wallet, invoices, or
-- payment verification.

BEGIN;

-- ---------------------------------------------------------------------------
-- provisioning_providers — was marzban_panel
-- ---------------------------------------------------------------------------
CREATE TABLE provisioning_providers (
  id           bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  code         text        NOT NULL UNIQUE,      -- legacy code_panel ('7e7a')
  name         text        NOT NULL,             -- shown to the customer
  kind         text        NOT NULL CHECK (kind IN (
                 'marzban','marzneshin','hiddify','xui','wireguard',
                 'ai_account','spotify','manual')),
  status       text        NOT NULL DEFAULT 'ACTIVE'
                 CHECK (status IN ('ACTIVE','DISABLED')),
  base_url     text,
  -- Credentials are NOT stored here. This names a secret in the runtime secret
  -- store; the row stays safe to dump, log, and hand to a support agent.
  secret_ref   text,
  -- Everything adapter-specific: inbounds, proxies, sublink, MethodUsername,
  -- on_hold behaviour, per-panel price overrides. Each adapter validates its
  -- own slice with zod at load; the database does not model 43 VPN columns.
  config       jsonb       NOT NULL DEFAULT '{}',
  capacity     integer,                          -- NULL = unlimited (legacy 'unlimited')
  sort_order   integer     NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  legacy_id    integer UNIQUE                    -- marzban_panel.id
);
CREATE INDEX idx_providers_active ON provisioning_providers(status, sort_order)
  WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- products / product_plans
-- ---------------------------------------------------------------------------
-- A product is the thing ("VIP multi-location", "Spotify Premium").
-- A plan is a purchasable SKU of it (30 days / 50 GB / 1,000,000 IRR).
-- Mirzabot conflates the two, which is why a second duration means a second
-- product row today.

CREATE TABLE product_categories (
  id         bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name       text NOT NULL UNIQUE,
  sort_order integer NOT NULL DEFAULT 0,
  legacy_id  integer UNIQUE
);

CREATE TABLE products (
  id          bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  code        text        NOT NULL UNIQUE,       -- legacy code_product
  name        text        NOT NULL,
  kind        text        NOT NULL CHECK (kind IN (
                'vpn','ai_account','spotify','manual','other')),
  category_id bigint      REFERENCES product_categories(id) ON DELETE SET NULL,
  provider_id bigint      REFERENCES provisioning_providers(id) ON DELETE RESTRICT,
  status      text        NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE','HIDDEN','DISABLED')),
  description text,
  -- true = one purchase per customer, ever (legacy one_buy_status)
  once_per_user boolean   NOT NULL DEFAULT false,
  resellers_only boolean  NOT NULL DEFAULT false,  -- legacy `agent`
  sort_order  integer     NOT NULL DEFAULT 0,
  attrs       jsonb       NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  legacy_id   integer UNIQUE
);
CREATE INDEX idx_products_visible ON products(status, sort_order) WHERE status = 'ACTIVE';
CREATE INDEX idx_products_provider ON products(provider_id);

CREATE TABLE product_plans (
  id            bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  product_id    bigint      NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name          text        NOT NULL,
  price_irr     bigint      NOT NULL CHECK (price_irr >= 0),
  duration_days integer     CHECK (duration_days IS NULL OR duration_days > 0),
  volume_gb     numeric(12,3) CHECK (volume_gb IS NULL OR volume_gb >= 0),  -- NULL = unmetered
  user_limit    integer,
  status        text        NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE','HIDDEN','DISABLED')),
  -- Adapter-specific purchase parameters (inbounds, proxies, data_limit_reset,
  -- spotify seat count, model quota for an AI account, ...).
  attrs         jsonb       NOT NULL DEFAULT '{}',
  sort_order    integer     NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  legacy_id     integer UNIQUE     -- product.id, when the plan came from a legacy row
);
CREATE INDEX idx_plans_product ON product_plans(product_id, sort_order)
  WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- discounts — was Discount (gift codes) + DiscountSell (sale codes)
-- ---------------------------------------------------------------------------
CREATE TABLE discount_codes (
  id             bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  code           text        NOT NULL UNIQUE,
  kind           text        NOT NULL CHECK (kind IN ('GIFT_BALANCE','PERCENT_OFF','AMOUNT_OFF')),
  -- GIFT_BALANCE: credited IRR. AMOUNT_OFF: IRR off. PERCENT_OFF: use percent.
  amount_irr     bigint      CHECK (amount_irr IS NULL OR amount_irr >= 0),
  percent        numeric(5,2) CHECK (percent IS NULL OR (percent > 0 AND percent <= 100)),
  max_uses       integer     CHECK (max_uses IS NULL OR max_uses > 0),
  first_purchase_only boolean NOT NULL DEFAULT false,
  resellers_only boolean     NOT NULL DEFAULT false,
  product_id     bigint      REFERENCES products(id) ON DELETE CASCADE,
  provider_id    bigint      REFERENCES provisioning_providers(id) ON DELETE CASCADE,
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  legacy_table   text CHECK (legacy_table IN ('Discount','DiscountSell')),
  legacy_id      integer,
  UNIQUE (legacy_table, legacy_id),
  CHECK (
    (kind = 'PERCENT_OFF' AND percent IS NOT NULL) OR
    (kind <> 'PERCENT_OFF' AND amount_irr IS NOT NULL)
  )
);

CREATE TABLE discount_redemptions (
  id         bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  code_id    bigint      NOT NULL REFERENCES discount_codes(id) ON DELETE CASCADE,
  user_id    bigint      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  order_id   bigint,                              -- FK added in 0003
  amount_irr bigint      NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  legacy_id  integer UNIQUE                       -- Giftcodeconsumed.id
);
CREATE INDEX idx_redemptions_user ON discount_redemptions(user_id, created_at DESC);
-- One user redeems a given code at most once — the rule Giftcodeconsumed exists
-- to enforce in PHP today, moved to where it cannot be raced.
CREATE UNIQUE INDEX idx_redemption_once_per_user
  ON discount_redemptions(code_id, user_id);

COMMIT;
