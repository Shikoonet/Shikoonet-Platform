-- 0005_ops.sql — the operational surface: admins, support, content, promos.
--
-- Mirzabot tables NOT ported here, and why. Each is empty in production and
-- carries no code we are keeping; a table with no rows and no confirmed caller
-- is a guess, and guesses are what made the 43-column panel table.
--   botsaz (0)         multi-tenant bot builder — not a product we sell
--   manualsell (0)     manual account delivery — provisioning_kind 'manual' covers it
--   cancel_service (0) cancellation requests — becomes a support ticket kind
--   logs_api (0)       request log — belongs in the log pipeline, not the OLTP database
--   category (0)       superseded by product_categories (0002)
--   affiliates (1)     a config row, not an entity — becomes settings(scope='shop')
--   topicid (10)       Telegram forum topic ids — becomes settings(scope='bot')
-- If any of these turns out to be live, it comes back as its own migration with
-- its caller named in the commit message.

BEGIN;

-- ---------------------------------------------------------------------------
-- admins — Telegram-side operators
-- ---------------------------------------------------------------------------
-- Distinct from access_users (0004), which is the Cloudflare-Access identity
-- for the web dashboard. Different subjects, different credentials, different
-- blast radius. They stay separate until the dashboard moves to one identity.
CREATE TABLE admins (
  id          bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  telegram_id bigint      NOT NULL UNIQUE,
  username    text,
  role        text        NOT NULL DEFAULT 'ADMIN'
                CHECK (role IN ('OWNER','ADMIN','SUPPORT')),
  -- Legacy `admin.password` is a plaintext web-panel password. It is NOT
  -- migrated. Telegram id is the credential; anything web-facing goes through
  -- access_users.
  permissions jsonb       NOT NULL DEFAULT '{}',
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- support
-- ---------------------------------------------------------------------------
CREATE TABLE support_departments (
  id           bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name         text NOT NULL UNIQUE,
  telegram_id  bigint,          -- operator who receives this department's tickets
  sort_order   integer NOT NULL DEFAULT 0,
  active       boolean NOT NULL DEFAULT true,
  legacy_id    integer UNIQUE
);

CREATE TABLE support_tickets (
  id            bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  tracking_code text        NOT NULL UNIQUE,
  user_id       bigint      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  department_id bigint      REFERENCES support_departments(id) ON DELETE SET NULL,
  subscription_id bigint    REFERENCES subscriptions(id) ON DELETE SET NULL,
  kind          text        NOT NULL DEFAULT 'QUESTION'
                  CHECK (kind IN ('QUESTION','PROBLEM','CANCELLATION','OTHER')),
  status        text        NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN ('OPEN','PENDING','ANSWERED','CUSTOMER_REPLIED','CLOSED')),
  assigned_to   bigint      REFERENCES admins(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  legacy_id     integer UNIQUE
);
CREATE INDEX idx_tickets_open ON support_tickets(status, updated_at DESC)
  WHERE status <> 'CLOSED';
CREATE INDEX idx_tickets_user ON support_tickets(user_id, created_at DESC);

-- The legacy `support_message` row holds the question AND the answer in two
-- columns, so a thread longer than one exchange has nowhere to go.
CREATE TABLE support_messages (
  id          bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  ticket_id   bigint      NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_type text        NOT NULL CHECK (author_type IN ('USER','ADMIN','SYSTEM')),
  author_id   bigint,
  body        text        NOT NULL,
  attachments jsonb       NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ticket_messages ON support_messages(ticket_id, created_at);

-- ---------------------------------------------------------------------------
-- content shown in the bot
-- ---------------------------------------------------------------------------
CREATE TABLE help_articles (
  id          bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  title       text NOT NULL,
  category    text,
  body        text NOT NULL DEFAULT '',
  media_id    text,             -- Telegram file_id
  media_type  text,
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  legacy_id   integer UNIQUE
);

CREATE TABLE client_apps (
  id         bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name       text NOT NULL,
  platform   text,
  link       text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  legacy_id  integer UNIQUE
);

CREATE TABLE required_channels (
  id         bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  title      text NOT NULL,
  chat_ref   text NOT NULL UNIQUE,   -- @username or -100…
  join_link  text NOT NULL,
  active     boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------------------
-- promotions
-- ---------------------------------------------------------------------------
CREATE TABLE wheel_spins (
  id         bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id    bigint      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  prize_code text        NOT NULL,
  amount_irr bigint      NOT NULL DEFAULT 0 CHECK (amount_irr >= 0),
  -- Set when the prize was credited, so a prize can never be granted twice.
  wallet_entry_id bigint UNIQUE REFERENCES wallet_entries(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  legacy_id  integer UNIQUE
);
CREATE INDEX idx_wheel_user ON wheel_spins(user_id, created_at DESC);

CREATE TABLE reseller_requests (
  id          bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id     bigint      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  description text,
  kind        text,
  status      text        NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  decided_by  bigint      REFERENCES admins(id) ON DELETE SET NULL,
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL,
  legacy_id   text UNIQUE             -- Requestagent.id (a varchar in MySQL)
);
CREATE INDEX idx_reseller_requests_open ON reseller_requests(status, created_at DESC)
  WHERE status = 'PENDING';

-- ---------------------------------------------------------------------------
-- revenue_adjustments — manual corrections to the reported revenue figure
-- ---------------------------------------------------------------------------
-- Not wallet money and not customer money: this only moves the number on the
-- admin's income report. Kept separate from wallet_entries precisely so the two
-- can never be confused when the totals are reconciled.
CREATE TABLE revenue_adjustments (
  id         bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  amount_irr bigint      NOT NULL,          -- signed
  note       text        NOT NULL DEFAULT '',
  created_by text,
  created_at timestamptz NOT NULL,
  legacy_id  integer UNIQUE
);
CREATE INDEX idx_revenue_adj_created ON revenue_adjustments(created_at DESC);

COMMIT;
