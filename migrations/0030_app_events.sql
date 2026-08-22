-- Where a log line goes to survive the next deploy.
--
-- Today the only destination is `docker logs`, and Coolify replaces the
-- container on every deploy — so the history is destroyed at exactly the
-- moment a deploy makes you want to read it. Two bugs already cost this: the
-- 2026-08-15 `AUTO_MATCH_ENABLED` afternoon and the 2026-08-18
-- `AUTO_FULFILLMENT_ENABLED` order that was paid for and never delivered.
-- Neither left a trace to find.
--
-- The same Postgres, beside `audit_logs`, on purpose: zero new infrastructure,
-- searchable with SQL an admin already writes, and no customer data leaving
-- the box. It is deliberately NOT `audit_logs` — that table is append-only
-- evidence of what an operator did, and it must not be diluted with what the
-- software noticed. This one is prunable, that one is not.

BEGIN;

CREATE TABLE app_events (
  id     bigint      PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  at     timestamptz NOT NULL DEFAULT now(),
  level  text        NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  -- Which service: 'bot', 'ingest', 'dashboard'. Free text rather than an
  -- enum, so adding a service is not a migration.
  svc    text        NOT NULL,
  -- A fixed dotted name — `settle.paid`, `ingest.sms.rejected`. Never a
  -- sentence: this is the column you GROUP BY.
  evt    text        NOT NULL,
  -- Correlation id. `u<update_id>` in the bot, a request id in the workers.
  trace  text,
  -- The single identifier the event is about: an order, a claim, a device.
  ref    text,
  fields jsonb       NOT NULL DEFAULT '{}'::jsonb,
  err    text
);

-- Newest first is how this is always read.
CREATE INDEX app_events_at_idx ON app_events (at DESC);
-- «how often has provision.failed happened this week» — the question that
-- makes a table like this worth writing to at all.
CREATE INDEX app_events_evt_idx ON app_events (evt, at DESC);
-- Partial: most rows have no trace, and an index over those nulls would be
-- larger than the questions it answers.
CREATE INDEX app_events_trace_idx ON app_events (trace) WHERE trace IS NOT NULL;

COMMIT;
