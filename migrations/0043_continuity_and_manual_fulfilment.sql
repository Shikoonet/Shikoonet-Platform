-- Fulfilment that happened before the money was proven, and the queue that
-- remembers it is still unproven.
--
-- Until now a claim had exactly two ways to become a delivered order, and both
-- of them said the same word for it. The matcher found a bank credit and wrote
-- `VERIFIED`; an operator pressed «با این حال دستی تایید کن» with no bank
-- credit anywhere and the row ALSO said `VERIFIED`, with no reconciliation
-- match behind it. The panel could tell the two apart — `deriveReviewState`
-- reads the missing match and prints «تایید دستی» — but nothing else in the
-- system could, and everything else in the system reads the STATUS:
-- `financialAnalytics.ts`, `analyticsRoutes.ts` and `incomeEligibility.ts` all
-- count `status = 'VERIFIED'` as money that arrived.
--
-- So an operator who fulfilled an order on the strength of a screenshot moved
-- the shop's revenue figure, and no later reading of the row could undo that
-- claim about the world. That is the thing this migration refuses: a payment
-- nobody has evidence for must not be spelled the same way as a payment the
-- bank confirmed.
--
-- NOTHING HERE MOVES MONEY, AND NOTHING HERE REINTERPRETS HISTORY. Every
-- column added is NULL on all existing rows, the CHECK is widened rather than
-- narrowed, and no existing row's `status` is read or written. Rows that are
-- `VERIFIED` today stay `VERIFIED` — including the manually verified ones. The
-- new status is only ever reached by a write made after this migration, so a
-- historical row is never retold as something it was not. The DO block at the
-- end asserts exactly that.

BEGIN;

CREATE TEMP TABLE _claims_before_0043 ON COMMIT DROP AS
  SELECT status, count(*) AS rows, COALESCE(SUM(expected_amount_irr), 0) AS total_irr
    FROM payment_claims
   GROUP BY status;

-- ---------------------------------------------------------------------------
-- 1. A sixth status: delivered, and still owed an explanation
-- ---------------------------------------------------------------------------
--
-- `FULFILLED_UNRECONCILED` is a LIVE status, not a terminal one. It means the
-- customer has their account and the shop has not yet seen the money. It is
-- deliberately not a flag on `VERIFIED`:
--
--   - every revenue query in the app filters `status = 'VERIFIED'` and none of
--     them would have been taught about a flag, so a flag would have shipped
--     the same false revenue this file exists to prevent;
--   - `settle.ts` keys the fulfilment sweep off the status, so one word here
--     is what makes the delivery happen at all;
--   - a status is visible in `psql` to somebody who has never read this file.
--
-- It leaves for `VERIFIED` when — and only when — a bank credit is matched to
-- it afterwards. That transition is reconciliation, and it must not deliver
-- anything a second time; `settle.ts` cannot, because it only advances a
-- payment whose status is not already `PAID`.
ALTER TABLE payment_claims DROP CONSTRAINT payment_claims_status_check;
ALTER TABLE payment_claims ADD CONSTRAINT payment_claims_status_check
  CHECK (status IN ('PENDING','MATCH_SUGGESTED','VERIFIED','REJECTED',
                    'FAKE_RECEIPT','EXPIRED','FULFILLED_UNRECONCILED'));

-- ---------------------------------------------------------------------------
-- 2. Who decided to deliver without proof, when, and why
-- ---------------------------------------------------------------------------
--
-- `audit_logs` records the act and is the immutable trail; these columns are
-- the row's own answer, so the review queue can sort, filter and explain
-- itself without joining an append-only log for every line it draws.
--
-- `fulfilment_mode` is the whole difference between the two ways to get here
-- and the panel says them differently:
--   MANUAL     — an operator looked at this one payment and decided.
--   CONTINUITY — the shop was running in continuity mode and this claim was
--                opened while it was on. Nobody looked at this one.
ALTER TABLE payment_claims
  ADD COLUMN fulfilment_mode   text CHECK (fulfilment_mode IS NULL
                                           OR fulfilment_mode IN ('MANUAL','CONTINUITY')),
  ADD COLUMN fulfilled_at      bigint,
  ADD COLUMN fulfilled_by      text,
  -- Required by the route, not by the column. A NULL here is a row written
  -- before this migration; NOT NULL would have to invent a reason for 350
  -- historical claims, which is the reinterpretation this file forbids.
  ADD COLUMN fulfilment_reason text,
  -- Stamped when a bank credit is finally matched to a claim that was already
  -- fulfilled. Its presence is what closes the reconciliation task, and its
  -- absence beside a non-null `fulfilled_at` is what keeps the row in the
  -- queue.
  ADD COLUMN reconciled_at     bigint;

-- The whole of «تحویل‌شده، در انتظار تطبیق» is one index scan. Partial, because
-- the queue is a handful of rows in a table of hundreds of thousands and the
-- ordinary claim must not pay for it.
CREATE INDEX idx_claim_awaiting_reconciliation
  ON payment_claims(fulfilled_at DESC)
  WHERE fulfilled_at IS NOT NULL AND reconciled_at IS NULL;

-- A fulfilment is one of the two kinds or it is not a fulfilment. Written as a
-- constraint rather than trusted to three call sites, because the column that
-- decides what the operator is told must not be able to be half-set.
ALTER TABLE payment_claims ADD CONSTRAINT payment_claims_fulfilment_complete
  CHECK ((fulfilled_at IS NULL AND fulfilment_mode IS NULL AND fulfilled_by IS NULL)
      OR (fulfilled_at IS NOT NULL AND fulfilment_mode IS NOT NULL));

-- Reconciliation is something that happens TO a fulfilment. A row that claims
-- to have been reconciled without ever having been fulfilled is a bug in
-- whatever wrote it, and this is where it stops.
ALTER TABLE payment_claims ADD CONSTRAINT payment_claims_reconciled_after_fulfilment
  CHECK (reconciled_at IS NULL OR fulfilled_at IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 3. Continuity mode lives in `settings`, and this is the row it lives in
-- ---------------------------------------------------------------------------
--
-- No new table. `settings(scope, key, value jsonb)` is the shop's existing
-- convention, it already has a primary key that makes the mode a singleton for
-- free, and it already carries `updated_by`. A table with one row and five
-- columns would be the same fact with more to keep in step.
--
-- Seeded OFF, explicitly, rather than left absent. «No row» and «a row that
-- says false» read identically to `continuityMode.ts`, but only one of them
-- proves the default was a decision. It is the same reason `ENV_NAME` has no
-- default.
INSERT INTO settings (scope, key, value, updated_at, updated_by)
VALUES ('pay', 'continuity_mode', '{"active": false}'::jsonb, now(), NULL)
ON CONFLICT (scope, key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Prove nothing above retold an existing row
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  moved int;
BEGIN
  SELECT count(*) INTO moved
    FROM (
      SELECT status, count(*) AS rows, COALESCE(SUM(expected_amount_irr), 0) AS total_irr
        FROM payment_claims GROUP BY status
    ) after
    FULL OUTER JOIN _claims_before_0043 before USING (status)
   WHERE before.rows IS DISTINCT FROM after.rows
      OR before.total_irr IS DISTINCT FROM after.total_irr;
  IF moved <> 0 THEN
    RAISE EXCEPTION '0043 changed % status buckets; it must change none', moved;
  END IF;

  IF EXISTS (SELECT 1 FROM payment_claims WHERE fulfilled_at IS NOT NULL) THEN
    RAISE EXCEPTION '0043 marked an existing claim as fulfilled; every historical row must stay NULL';
  END IF;
END $$;

COMMIT;
