-- Migration 0002: widen raw_sms_events.classification CHECK so the four
-- new bank parsers (parsian-signed-v1, gardeshgari-credit-v1,
-- shahr-credit-v1, compact-signed-v1) can store BANK_TRANSACTION rows.
-- SQLite CHECK constraints require a table rebuild to change. The table
-- is small enough to recreate in place during local apply.
PRAGMA foreign_keys = OFF;
CREATE TABLE raw_sms_events_new (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  sender TEXT NOT NULL,
  encrypted_or_protected_body TEXT, -- OTP/promo: redacted sentinel only
  normalized_body TEXT,
  body_sha256 TEXT NOT NULL,
  app_checksum TEXT NOT NULL,
  sms_timestamp INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('BANK_CREDIT','BANK_DEBIT','BANK_TRANSACTION','BALANCE','OTP','PROMOTIONAL','UNKNOWN','IGNORED')),
  parser_status TEXT NOT NULL CHECK (parser_status IN ('OK','WARN','ERROR')),
  parser_id TEXT,
  parser_version TEXT,
  duplicate_of TEXT REFERENCES raw_sms_events(id) ON DELETE SET NULL,
  processing_error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (device_id, body_sha256)
);
INSERT INTO raw_sms_events_new
  SELECT id, device_id, sender, encrypted_or_protected_body, normalized_body,
         body_sha256, app_checksum, sms_timestamp, received_at, classification,
         parser_status, parser_id, parser_version, duplicate_of,
         processing_error, created_at
    FROM raw_sms_events;
DROP TABLE raw_sms_events;
ALTER TABLE raw_sms_events_new RENAME TO raw_sms_events;
CREATE INDEX idx_raw_sms_device_ts ON raw_sms_events(device_id, sms_timestamp DESC);
CREATE INDEX idx_raw_sms_classification ON raw_sms_events(classification);
PRAGMA foreign_keys = ON;