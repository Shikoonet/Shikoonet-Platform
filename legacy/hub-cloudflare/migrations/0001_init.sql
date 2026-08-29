-- Payment Reconciliation Hub — initial schema
-- Single migration. All tables, indexes, and constraints needed for MVP.
-- Money is INTEGER IRR. Timestamps are epoch milliseconds.

PRAGMA foreign_keys = ON;

CREATE TABLE access_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'REVIEWER', 'READ_ONLY')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  device_code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  last_seen_at INTEGER,
  last_success_at INTEGER,
  last_auth_failure_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE device_credentials (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ROTATING', 'REVOKED')),
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  revoked_at INTEGER,
  last_used_at INTEGER
);
CREATE INDEX idx_device_credentials_device ON device_credentials(device_id);
CREATE INDEX idx_device_credentials_prefix ON device_credentials(token_prefix);

CREATE TABLE financial_accounts (
  id TEXT PRIMARY KEY,
  bank_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  owner_label TEXT,
  account_type TEXT NOT NULL CHECK (account_type IN ('CARD','ACCOUNT','IBAN','OTHER')),
  account_hint TEXT,
  card_last_four TEXT CHECK (card_last_four IS NULL OR length(card_last_four) = 4),
  account_last_four TEXT CHECK (account_last_four IS NULL OR length(account_last_four) = 4),
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  parser_configuration TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_financial_accounts_device ON financial_accounts(device_id);
CREATE INDEX idx_financial_accounts_active ON financial_accounts(active);

CREATE TABLE raw_sms_events (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  sender TEXT NOT NULL,
  encrypted_or_protected_body TEXT, -- OTP/promo: redacted sentinel only
  normalized_body TEXT,
  body_sha256 TEXT NOT NULL,
  app_checksum TEXT NOT NULL,
  sms_timestamp INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('BANK_CREDIT','BANK_DEBIT','BALANCE','OTP','PROMOTIONAL','UNKNOWN','IGNORED')),
  parser_status TEXT NOT NULL CHECK (parser_status IN ('OK','WARN','ERROR')),
  parser_id TEXT,
  parser_version TEXT,
  duplicate_of TEXT REFERENCES raw_sms_events(id) ON DELETE SET NULL,
  processing_error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (device_id, body_sha256)
);
CREATE INDEX idx_raw_sms_device_ts ON raw_sms_events(device_id, sms_timestamp DESC);
CREATE INDEX idx_raw_sms_classification ON raw_sms_events(classification);

CREATE TABLE transaction_candidates (
  id TEXT PRIMARY KEY,
  raw_sms_event_id TEXT NOT NULL UNIQUE REFERENCES raw_sms_events(id) ON DELETE CASCADE,
  financial_account_id TEXT REFERENCES financial_accounts(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('CREDIT','DEBIT','UNKNOWN')),
  amount_irr INTEGER CHECK (amount_irr IS NULL OR amount_irr >= 0),
  balance_irr INTEGER CHECK (balance_irr IS NULL OR balance_irr >= 0),
  transaction_reference TEXT,
  bank_timestamp INTEGER,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  parser_id TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  parser_evidence_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('PARSED','NEEDS_REVIEW','MATCH_SUGGESTED','MATCHED','APPROVED','REJECTED','IGNORED','ERROR')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_tx_bank_ts ON transaction_candidates(bank_timestamp DESC);
CREATE INDEX idx_tx_status ON transaction_candidates(status);
CREATE INDEX idx_tx_account ON transaction_candidates(financial_account_id);

CREATE TABLE payment_claims (
  id TEXT PRIMARY KEY,
  external_order_id TEXT NOT NULL UNIQUE,
  customer_reference TEXT,
  expected_amount_irr INTEGER NOT NULL CHECK (expected_amount_irr >= 0),
  target_financial_account_id TEXT REFERENCES financial_accounts(id) ON DELETE SET NULL,
  submitted_at INTEGER NOT NULL,
  receipt_url_or_r2_key TEXT,
  source_system TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('PENDING','MATCH_SUGGESTED','VERIFIED','REJECTED','FAKE_RECEIPT','EXPIRED')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_claim_status ON payment_claims(status);
CREATE INDEX idx_claim_account_status ON payment_claims(target_financial_account_id, status);

CREATE TABLE reconciliation_matches (
  id TEXT PRIMARY KEY,
  transaction_candidate_id TEXT NOT NULL REFERENCES transaction_candidates(id) ON DELETE CASCADE,
  payment_claim_id TEXT NOT NULL REFERENCES payment_claims(id) ON DELETE CASCADE,
  score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
  matching_reasons_json TEXT NOT NULL DEFAULT '[]',
  mismatch_reasons_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('SUGGESTED','CONFIRMED','REJECTED','AUTO_VERIFIED')),
  reviewed_by TEXT,
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (transaction_candidate_id, payment_claim_id)
);
CREATE INDEX idx_match_tx ON reconciliation_matches(transaction_candidate_id);
CREATE INDEX idx_match_claim ON reconciliation_matches(payment_claim_id);

-- Enforce "one tx verifies one claim, one claim verified once" at the DB layer:
-- a unique row per (tx, claim) plus a partial unique index on confirmed matches.
CREATE UNIQUE INDEX idx_match_one_confirmed_per_tx
  ON reconciliation_matches(transaction_candidate_id)
  WHERE status = 'CONFIRMED';
CREATE UNIQUE INDEX idx_match_one_confirmed_per_claim
  ON reconciliation_matches(payment_claim_id)
  WHERE status = 'CONFIRMED';

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('RAW_SMS','TRANSACTION','CLAIM','MATCH','DEVICE')),
  entity_id TEXT NOT NULL,
  author_email TEXT NOT NULL,
  author_role TEXT NOT NULL CHECK (author_role IN ('ADMIN','REVIEWER','READ_ONLY','SYSTEM')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_comments_entity ON comments(entity_type, entity_id, created_at DESC);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_email TEXT,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('ADMIN','REVIEWER','READ_ONLY','SYSTEM')),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  request_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id, created_at DESC);
CREATE INDEX idx_audit_actor ON audit_logs(actor_email, created_at DESC);

CREATE TABLE integration_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('PAYMENT_VERIFIED','PAYMENT_REJECTED','FAKE_RECEIPT_DETECTED')),
  payload_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_response_status INTEGER,
  last_response_body TEXT,
  last_attempt_at INTEGER,
  next_attempt_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('PENDING','DELIVERED','FAILED','DEAD'))
);
