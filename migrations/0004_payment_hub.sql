-- 0004_payment_hub.sql — the payment reconciliation hub, ported from D1.
--
-- Source of truth for this port is the LIVE production schema captured on
-- 2026-08-10 (.production-backups/dashboard-before-dev-20260810T064246Z/
-- d1-schema/all-schema.json), not the migrations/ directory — production has
-- drifted from it (financial_accounts.iban/status, transaction_candidates
-- .processing_disposition, payment_claims.card_digits all exist live).
--
-- This file is deliberately a MECHANICAL port, not a redesign:
--   TEXT            -> text            (ids stay app-generated UUIDs)
--   INTEGER epoch   -> bigint          (epoch MILLISECONDS, unchanged)
--   INTEGER 0/1     -> smallint 0/1    (NOT boolean)
--   REAL            -> double precision
--
-- Why keep epoch-ms and 0/1 instead of timestamptz and boolean: ~800 existing
-- tests and all of packages/domain read these columns. Converting the types
-- turns a database adapter into a rewrite of the one part of this system that
-- is already proven. New tables (0001-0003) use timestamptz and boolean; this
-- file is a port and reads like one.
--
-- No generated timestamptz mirror columns either, though they were tempting:
-- the ported worker returns rows straight to the SPA, and an extra column on
-- `SELECT *` would leak into API responses and break response-shape tests.
-- Reporting calls to_timestamp(bank_timestamp / 1000.0) explicitly instead.
--
-- The partial unique indexes at the bottom are the money invariant. They are
-- the reason this platform is on Postgres and not MySQL.

BEGIN;

CREATE TABLE access_users (
  id           text PRIMARY KEY,
  email        text NOT NULL UNIQUE,
  display_name text,
  role         text NOT NULL CHECK (role IN ('ADMIN','REVIEWER','READ_ONLY')),
  active       smallint NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at   bigint NOT NULL,
  updated_at   bigint NOT NULL
);

CREATE TABLE devices (
  id                   text PRIMARY KEY,
  device_code          text NOT NULL UNIQUE,
  display_name         text NOT NULL,
  description          text,
  active               smallint NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  last_seen_at         bigint,
  last_success_at      bigint,
  last_auth_failure_at bigint,
  created_at           bigint NOT NULL,
  updated_at           bigint NOT NULL
);

CREATE TABLE device_credentials (
  id           text PRIMARY KEY,
  device_id    text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  status       text NOT NULL CHECK (status IN ('ACTIVE','ROTATING','REVOKED')),
  created_at   bigint NOT NULL,
  activated_at bigint,
  revoked_at   bigint,
  last_used_at bigint
);
CREATE INDEX idx_device_credentials_device ON device_credentials(device_id);
CREATE INDEX idx_device_credentials_prefix ON device_credentials(token_prefix);

CREATE TABLE financial_accounts (
  id                   text PRIMARY KEY,
  bank_name            text NOT NULL,
  display_name         text NOT NULL,
  owner_label          text,
  account_type         text NOT NULL CHECK (account_type IN ('CARD','ACCOUNT','IBAN','OTHER')),
  account_hint         text,
  card_last_four       text CHECK (card_last_four IS NULL OR length(card_last_four) = 4),
  account_last_four    text CHECK (account_last_four IS NULL OR length(account_last_four) = 4),
  iban                 text,
  device_id            text REFERENCES devices(id) ON DELETE SET NULL,
  active               smallint NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  status               text NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('PENDING','ACTIVE','MUTED','DECLINED')),
  parser_configuration text NOT NULL DEFAULT '{}',
  created_at           bigint NOT NULL,
  updated_at           bigint NOT NULL
);
CREATE INDEX idx_financial_accounts_device ON financial_accounts(device_id);
CREATE INDEX idx_financial_accounts_active ON financial_accounts(active);
CREATE INDEX idx_fa_status ON financial_accounts(status);
CREATE UNIQUE INDEX idx_fa_unique_active_account_hint
  ON financial_accounts(account_hint) WHERE account_hint IS NOT NULL AND active = 1;
CREATE UNIQUE INDEX idx_fa_unique_active_card_last_four
  ON financial_accounts(card_last_four) WHERE card_last_four IS NOT NULL AND active = 1;
CREATE UNIQUE INDEX idx_fa_unique_active_account_last_four
  ON financial_accounts(account_last_four) WHERE account_last_four IS NOT NULL AND active = 1;
CREATE UNIQUE INDEX idx_fa_unique_active_iban
  ON financial_accounts(iban) WHERE iban IS NOT NULL AND active = 1;

CREATE TABLE financial_account_identifiers (
  id                   text PRIMARY KEY,
  financial_account_id text NOT NULL REFERENCES financial_accounts(id) ON DELETE CASCADE,
  kind                 text NOT NULL CHECK (kind IN (
                         'ACCOUNT_HINT','CARD_LAST_FOUR','ACCOUNT_LAST_FOUR','IBAN','OTHER')),
  value                text NOT NULL,
  label                text,
  created_at           bigint NOT NULL,
  UNIQUE (financial_account_id, kind, value)
);
CREATE INDEX idx_fai_account ON financial_account_identifiers(financial_account_id);
CREATE INDEX idx_fai_lookup  ON financial_account_identifiers(kind, value);
CREATE UNIQUE INDEX idx_fai_unique_active_value
  ON financial_account_identifiers(kind, value);

CREATE TABLE raw_sms_events (
  id                          text PRIMARY KEY,
  device_id                   text NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  sender                      text NOT NULL,
  encrypted_or_protected_body text,   -- OTP/promo: redacted sentinel only
  normalized_body             text,
  body_sha256                 text NOT NULL,
  app_checksum                text NOT NULL,
  sms_timestamp               bigint NOT NULL,
  received_at                 bigint NOT NULL,
  classification              text NOT NULL CHECK (classification IN (
                                'BANK_CREDIT','BANK_DEBIT','BANK_TRANSACTION','BALANCE',
                                'OTP','PROMOTIONAL','UNKNOWN','IGNORED')),
  parser_status               text NOT NULL CHECK (parser_status IN ('OK','WARN','ERROR')),
  parser_id                   text,
  parser_version              text,
  duplicate_of                text REFERENCES raw_sms_events(id) ON DELETE SET NULL,
  processing_error            text,
  created_at                  bigint NOT NULL,
  UNIQUE (device_id, body_sha256)
);
CREATE INDEX idx_raw_sms_device_ts       ON raw_sms_events(device_id, sms_timestamp DESC);
CREATE INDEX idx_raw_sms_classification  ON raw_sms_events(classification);

CREATE TABLE transaction_candidates (
  id                     text PRIMARY KEY,
  raw_sms_event_id       text NOT NULL UNIQUE REFERENCES raw_sms_events(id) ON DELETE CASCADE,
  financial_account_id   text REFERENCES financial_accounts(id) ON DELETE SET NULL,
  direction              text NOT NULL CHECK (direction IN ('CREDIT','DEBIT','UNKNOWN')),
  amount_irr             bigint CHECK (amount_irr IS NULL OR amount_irr >= 0),
  balance_irr            bigint CHECK (balance_irr IS NULL OR balance_irr >= 0),
  transaction_reference  text,
  bank_timestamp         bigint,
  confidence             double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  parser_id              text NOT NULL,
  parser_version         text NOT NULL,
  parser_evidence_json   text NOT NULL DEFAULT '{}',
  status                 text NOT NULL CHECK (status IN (
                           'PARSED','NEEDS_REVIEW','MATCH_SUGGESTED','MATCHED',
                           'APPROVED','REJECTED','IGNORED','ERROR')),
  processing_disposition text NOT NULL DEFAULT 'ACTIONABLE' CHECK (processing_disposition IN (
                           'ACTIONABLE','OUTGOING_IGNORED','ADMIN_EXCLUDED')),
  created_at             bigint NOT NULL,
  updated_at             bigint NOT NULL
);
CREATE INDEX idx_tx_bank_ts  ON transaction_candidates(bank_timestamp DESC);
CREATE INDEX idx_tx_status   ON transaction_candidates(status);
CREATE INDEX idx_tx_account  ON transaction_candidates(financial_account_id);
CREATE INDEX idx_tx_unassigned_recent ON transaction_candidates(created_at DESC)
  WHERE financial_account_id IS NULL;
CREATE INDEX idx_tx_actionable
  ON transaction_candidates(processing_disposition, direction, bank_timestamp DESC)
  WHERE processing_disposition = 'ACTIONABLE';

CREATE TABLE payment_claims (
  id                          text PRIMARY KEY,
  external_order_id           text NOT NULL UNIQUE,
  customer_reference          text,
  expected_amount_irr         bigint NOT NULL CHECK (expected_amount_irr >= 0),
  target_financial_account_id text REFERENCES financial_accounts(id) ON DELETE SET NULL,
  card_digits                 text,
  submitted_at                bigint NOT NULL,
  paid_clicked_at             bigint,
  receipt_submitted_at        bigint,
  receipt_url_or_r2_key       text,
  source_system               text NOT NULL,
  metadata_json               text NOT NULL DEFAULT '{}',
  suspect_reason              text,
  suspect_metadata_json       text NOT NULL DEFAULT '{}',
  -- From migrations/0015; live production had not applied it as of 2026-08-10.
  -- Nullable and unread by existing code, so including it here is safe.
  operation_type              text,
  purchase_type               text CHECK (purchase_type IS NULL OR purchase_type IN (
                                'NEW_PURCHASE','RENEWAL','UNKNOWN')),
  status                      text NOT NULL CHECK (status IN (
                                'PENDING','MATCH_SUGGESTED','VERIFIED','REJECTED',
                                'FAKE_RECEIPT','EXPIRED')),
  created_at                  bigint NOT NULL,
  updated_at                  bigint NOT NULL
);
CREATE INDEX idx_claim_status         ON payment_claims(status);
CREATE INDEX idx_claim_account_status ON payment_claims(target_financial_account_id, status);
CREATE INDEX idx_claim_card_digits    ON payment_claims(card_digits);
CREATE INDEX idx_claim_purchase_type  ON payment_claims(purchase_type);
CREATE INDEX idx_claim_operation_type ON payment_claims(operation_type);

CREATE TABLE reconciliation_matches (
  id                       text PRIMARY KEY,
  transaction_candidate_id text NOT NULL REFERENCES transaction_candidates(id) ON DELETE CASCADE,
  payment_claim_id         text NOT NULL REFERENCES payment_claims(id) ON DELETE CASCADE,
  score                    double precision NOT NULL CHECK (score >= 0 AND score <= 1),
  matching_reasons_json    text NOT NULL DEFAULT '[]',
  mismatch_reasons_json    text NOT NULL DEFAULT '[]',
  status                   text NOT NULL CHECK (status IN (
                             'SUGGESTED','CONFIRMED','REJECTED','AUTO_VERIFIED')),
  reviewed_by              text,
  reviewed_at              bigint,
  created_at               bigint NOT NULL,
  updated_at               bigint NOT NULL,
  UNIQUE (transaction_candidate_id, payment_claim_id)
);
CREATE INDEX idx_match_tx    ON reconciliation_matches(transaction_candidate_id);
CREATE INDEX idx_match_claim ON reconciliation_matches(payment_claim_id);

-- ===========================================================================
-- THE MONEY INVARIANT — do not weaken, do not move into application code.
--
-- One bank transaction can verify at most one claim; one claim is settled at
-- most once. Enforced by the database so a race, a retried webhook, or a bug
-- in a future rewrite cannot double-spend a transaction.
--
-- MySQL cannot express this (no partial indexes) — mirzabot's own
-- card_assignment_leases had to fake it with STORED generated columns. This is
-- the single strongest technical reason the platform is on Postgres.
-- ===========================================================================
CREATE UNIQUE INDEX idx_match_one_confirmed_per_tx
  ON reconciliation_matches(transaction_candidate_id) WHERE status = 'CONFIRMED';
CREATE UNIQUE INDEX idx_match_one_confirmed_per_claim
  ON reconciliation_matches(payment_claim_id)         WHERE status = 'CONFIRMED';
CREATE UNIQUE INDEX idx_match_one_auto_per_tx
  ON reconciliation_matches(transaction_candidate_id) WHERE status IN ('CONFIRMED','AUTO_VERIFIED');
CREATE UNIQUE INDEX idx_match_one_auto_per_claim
  ON reconciliation_matches(payment_claim_id)         WHERE status IN ('CONFIRMED','AUTO_VERIFIED');

CREATE TABLE transaction_detected_identifiers (
  id                       text PRIMARY KEY,
  transaction_candidate_id text NOT NULL REFERENCES transaction_candidates(id) ON DELETE CASCADE,
  identifier_type          text NOT NULL CHECK (identifier_type IN (
                             'ACCOUNT_NUMBER','CARD_LAST_FOUR','IBAN','ACCOUNT_HINT')),
  normalized_value         text NOT NULL,
  display_value_masked     text NOT NULL,
  parser_id                text NOT NULL,
  confidence               double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_at               bigint NOT NULL,
  UNIQUE (transaction_candidate_id, identifier_type, normalized_value)
);
CREATE INDEX idx_tdi_tx         ON transaction_detected_identifiers(transaction_candidate_id);
CREATE INDEX idx_tdi_normalized ON transaction_detected_identifiers(identifier_type, normalized_value);
CREATE INDEX idx_tdi_unassigned ON transaction_detected_identifiers(identifier_type, normalized_value)
  WHERE identifier_type = 'ACCOUNT_NUMBER';

CREATE VIEW v_account_identifier_value AS
  SELECT identifier_type,
         normalized_value,
         transaction_candidate_id AS tx_id
    FROM transaction_detected_identifiers;

CREATE TABLE transaction_reviews (
  id                       text PRIMARY KEY,
  transaction_candidate_id text NOT NULL UNIQUE
                             REFERENCES transaction_candidates(id) ON DELETE CASCADE,
  decision                 text NOT NULL CHECK (decision IN ('ACCEPTED','REJECTED')),
  reviewed_by              text NOT NULL,
  reviewer_role            text NOT NULL CHECK (reviewer_role IN ('ADMIN','REVIEWER')),
  reason                   text CHECK (reason IS NULL OR reason IN (
                             'false_parse','duplicate','irrelevant','wrong_amount','other')),
  comment                  text,
  reviewed_at              bigint NOT NULL,
  created_at               bigint NOT NULL,
  updated_at               bigint NOT NULL
);
CREATE INDEX idx_trx_decision    ON transaction_reviews(decision, reviewed_at DESC);
CREATE INDEX idx_trx_reviewed_by ON transaction_reviews(reviewed_by, reviewed_at DESC);

CREATE TABLE audit_logs (
  id          text PRIMARY KEY,
  actor_email text,
  actor_role  text NOT NULL CHECK (actor_role IN ('ADMIN','REVIEWER','READ_ONLY','SYSTEM')),
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  before_json text,
  after_json  text,
  reason      text,
  request_id  text,
  created_at  bigint NOT NULL
);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id, created_at DESC);
CREATE INDEX idx_audit_actor  ON audit_logs(actor_email, created_at DESC);
CREATE TRIGGER trg_audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

CREATE TABLE transaction_account_assignments (
  id                       text PRIMARY KEY,
  transaction_candidate_id text NOT NULL REFERENCES transaction_candidates(id) ON DELETE CASCADE,
  financial_account_id     text REFERENCES financial_accounts(id) ON DELETE SET NULL,
  assignment_source        text NOT NULL CHECK (assignment_source IN (
                             'AUTO_IDENTIFIER','MANUAL','HISTORICAL_BACKFILL','ACCOUNT_MERGE')),
  identifier_type          text CHECK (identifier_type IS NULL OR identifier_type IN (
                             'ACCOUNT_NUMBER','CARD_LAST_FOUR','IBAN','ACCOUNT_HINT')),
  normalized_identifier    text,
  assigned_by              text NOT NULL,
  assigned_at              bigint NOT NULL,
  replaced_assignment_id   text REFERENCES transaction_account_assignments(id) ON DELETE SET NULL,
  active                   smallint NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  metadata_json            text NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_taa_tx         ON transaction_account_assignments(transaction_candidate_id, assigned_at DESC);
CREATE INDEX idx_taa_account    ON transaction_account_assignments(financial_account_id, assigned_at DESC);
CREATE INDEX idx_taa_source     ON transaction_account_assignments(assignment_source, assigned_at DESC);
CREATE INDEX idx_taa_identifier ON transaction_account_assignments(identifier_type, normalized_identifier);
CREATE UNIQUE INDEX idx_taa_one_active_per_tx
  ON transaction_account_assignments(transaction_candidate_id) WHERE active = 1;

CREATE TABLE comments (
  id           text PRIMARY KEY,
  entity_type  text NOT NULL CHECK (entity_type IN ('RAW_SMS','TRANSACTION','CLAIM','MATCH','DEVICE')),
  entity_id    text NOT NULL,
  author_email text NOT NULL,
  author_role  text NOT NULL CHECK (author_role IN ('ADMIN','REVIEWER','READ_ONLY','SYSTEM')),
  body         text NOT NULL,
  created_at   bigint NOT NULL
);
CREATE INDEX idx_comments_entity ON comments(entity_type, entity_id, created_at DESC);

CREATE TABLE integration_tokens (
  id           text PRIMARY KEY,
  token_hash   text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  label        text NOT NULL,
  status       text NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  created_at   bigint NOT NULL,
  revoked_at   bigint,
  last_used_at bigint
);

CREATE TABLE integration_events (
  event_id          text PRIMARY KEY,
  source            text NOT NULL,
  external_order_id text,
  processed_at      bigint NOT NULL
);
CREATE INDEX idx_integration_events_order ON integration_events(external_order_id);

CREATE TABLE webhook_deliveries (
  id                   text PRIMARY KEY,
  event_type           text NOT NULL CHECK (event_type IN (
                         'PAYMENT_VERIFIED','PAYMENT_REJECTED','FAKE_RECEIPT_DETECTED')),
  payload_json         text NOT NULL,
  attempt_count        integer NOT NULL DEFAULT 0,
  last_response_status integer,
  last_response_body   text,
  last_attempt_at      bigint,
  next_attempt_at      bigint,
  status               text NOT NULL CHECK (status IN ('PENDING','DELIVERED','FAILED','DEAD'))
);

CREATE TABLE resellers (
  id         text PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  status     text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE reseller_transactions (
  id                       text PRIMARY KEY,
  transaction_candidate_id text NOT NULL UNIQUE
                             REFERENCES transaction_candidates(id) ON DELETE CASCADE,
  reseller_id              text NOT NULL REFERENCES resellers(id),
  classified_by            text NOT NULL,
  classified_at            bigint NOT NULL,
  note                     text,
  created_at               bigint NOT NULL
);
CREATE INDEX idx_reseller_tx_reseller   ON reseller_transactions(reseller_id, classified_at DESC);
CREATE INDEX idx_reseller_tx_classified ON reseller_transactions(classified_at DESC);

CREATE TABLE income_declined_transactions (
  id                       text PRIMARY KEY,
  transaction_candidate_id text NOT NULL UNIQUE
                             REFERENCES transaction_candidates(id) ON DELETE CASCADE,
  declined_by              text NOT NULL,
  declined_at              bigint NOT NULL,
  reason                   text,
  restored_by              text,
  restored_at              bigint,
  created_at               bigint NOT NULL
);
CREATE INDEX idx_income_declined_active ON income_declined_transactions(declined_at DESC)
  WHERE restored_at IS NULL;

CREATE TABLE account_assignment_previews (
  id                    text PRIMARY KEY,
  financial_account_id  text NOT NULL REFERENCES financial_accounts(id) ON DELETE CASCADE,
  actor_email           text NOT NULL,
  status                text NOT NULL CHECK (status IN ('OPEN','APPLIED','DECLINED','EXPIRED')),
  account_snapshot_json text NOT NULL,
  counts_json           text NOT NULL,
  created_at            bigint NOT NULL,
  expires_at            bigint NOT NULL,
  result_json           text,
  applied_at            bigint,
  declined_at           bigint,
  audit_log_id          text REFERENCES audit_logs(id) ON DELETE SET NULL
);
CREATE INDEX idx_aap_account      ON account_assignment_previews(financial_account_id, created_at DESC);
CREATE INDEX idx_aap_actor_status ON account_assignment_previews(actor_email, status, created_at DESC);
CREATE INDEX idx_aap_expires      ON account_assignment_previews(expires_at) WHERE status = 'OPEN';

CREATE TABLE account_assignment_preview_items (
  id                        text PRIMARY KEY,
  preview_id                text NOT NULL REFERENCES account_assignment_previews(id) ON DELETE CASCADE,
  transaction_candidate_id  text NOT NULL REFERENCES transaction_candidates(id) ON DELETE CASCADE,
  disposition               text NOT NULL CHECK (disposition IN (
                              'WILL_ASSIGN','WILL_REPAIR_HISTORY','ALREADY_CORRECT',
                              'AMBIGUOUS','SKIPPED_MANUAL','SKIPPED_STATE_CHANGED')),
  identifier_type           text,
  normalized_identifier     text,
  current_account_id        text,
  current_assignment_source text,
  tx_snapshot_json          text NOT NULL,
  selected                  smallint NOT NULL DEFAULT 0 CHECK (selected IN (0,1)),
  applied_disposition       text,
  applied_assignment_id     text REFERENCES transaction_account_assignments(id) ON DELETE SET NULL,
  UNIQUE (preview_id, transaction_candidate_id)
);
CREATE INDEX idx_aapi_preview_disposition ON account_assignment_preview_items(preview_id, disposition);
CREATE INDEX idx_aapi_tx                  ON account_assignment_preview_items(transaction_candidate_id);

CREATE TABLE dashboard_notification_state (
  actor_email              text PRIMARY KEY,
  last_seen_transaction_at bigint,
  last_seen_transaction_id text,
  updated_at               bigint NOT NULL
);

CREATE TABLE dashboard_transaction_reads (
  actor_email              text NOT NULL,
  transaction_candidate_id text NOT NULL REFERENCES transaction_candidates(id) ON DELETE CASCADE,
  seen_at                  bigint NOT NULL,
  PRIMARY KEY (actor_email, transaction_candidate_id)
);
CREATE INDEX idx_dtr_actor_time ON dashboard_transaction_reads(actor_email, seen_at DESC);

CREATE TABLE dashboard_payment_event_reads (
  actor_email text NOT NULL,
  event_key   text NOT NULL,
  seen_at     bigint NOT NULL,
  PRIMARY KEY (actor_email, event_key)
);
CREATE INDEX idx_payment_event_reads_actor ON dashboard_payment_event_reads(actor_email, seen_at DESC);

-- ---------------------------------------------------------------------------
-- payment_cards — the one place the two systems actually merge
-- ---------------------------------------------------------------------------
-- Today the same physical bank cards exist twice: hub `payment_cards` (26 rows,
-- keyed to a financial account, used to resolve a claim) and mirzabot
-- `card_number` (25 rows, used to decide which card to show the customer).
-- 23 of them match by digits. They become one table: the hub columns unchanged,
-- plus mirzabot's rotation state.
--
-- The 4 non-matching rows are NOT merged automatically — see
-- BUGS-FOR-ADMIN.md. One pair differs by a single digit
-- (5054161706277062 / 5054161716277062) and only a human can say which is real.
CREATE TABLE payment_cards (
  id                   text PRIMARY KEY,
  financial_account_id text NOT NULL REFERENCES financial_accounts(id) ON DELETE CASCADE,
  card_digits          text NOT NULL UNIQUE,
  label                text,
  created_at           bigint NOT NULL,
  -- from mirzabot card_number
  holder_name          text,
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  last_assigned_at     bigint
);
CREATE INDEX idx_payment_cards_account  ON payment_cards(financial_account_id);
-- Rotation reads this on every card-to-card checkout: least-recently-used first.
CREATE INDEX idx_payment_cards_rotation ON payment_cards(status, last_assigned_at NULLS FIRST)
  WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- card_leases — was mirzabot card_assignment_leases
-- ---------------------------------------------------------------------------
-- MySQL could not express "at most one ACTIVE lease per user / per card", so
-- the original faked it with two STORED generated columns holding NULL when the
-- row is not ACTIVE, plus a UNIQUE on each. Postgres states it directly.
-- Same guarantee, two fewer columns, and the intent is readable.
CREATE TABLE card_leases (
  id               bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  telegram_user_id bigint      NOT NULL,
  order_public_id  text        NOT NULL,
  -- Denormalised text, no FK: 22 production leases already point at cards that
  -- were deleted, and the record of where a customer was told to pay must
  -- survive the card being removed.
  card_number      text        NOT NULL,
  card_name        text        NOT NULL DEFAULT '',
  status           text        NOT NULL DEFAULT 'ACTIVE'
                     CHECK (status IN ('ACTIVE','COMPLETED','EXPIRED','CANCELLED')),
  assigned_at      timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  completed_at     timestamptz,
  released_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  legacy_id        bigint UNIQUE
);
CREATE UNIQUE INDEX idx_lease_one_active_per_user ON card_leases(telegram_user_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX idx_lease_one_active_per_card ON card_leases(card_number)      WHERE status = 'ACTIVE';
CREATE INDEX idx_lease_order          ON card_leases(order_public_id);
CREATE INDEX idx_lease_status_expires ON card_leases(status, expires_at);
CREATE INDEX idx_lease_card_completed ON card_leases(card_number, status, completed_at);

COMMIT;
