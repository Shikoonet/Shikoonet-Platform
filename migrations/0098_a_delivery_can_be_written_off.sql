-- 0098_a_delivery_can_be_written_off.sql — 2026-09-24.
--
-- «در انتظار تطبیق» had one exit, a bank credit, and some of its rows will
-- never get one: an admin's own test purchases on production, a gift.
-- They sat in the queue for ever, and the queue is the one place that says
-- «delivered, and the money still owes an explanation».
--
-- So a seventh status, WRITTEN_OFF: delivered, and an admin has said in words
-- that no money is coming. Terminal, and a status rather than a flag for the
-- reason 0043 gave for FULFILLED_UNRECONCILED — every matcher and sweep reads
-- `status`. A flag would leave the row in the matcher's live set, and a real
-- customer's credit of the same amount on the same account inside the 24h
-- reconcile window would be spent on a test order.
--
-- NOTHING HERE MOVES MONEY. Revenue counts bank credits, and a written-off
-- claim never had one. The CHECK is widened, the columns are NULL on every
-- existing row, and no existing row's status is read or written.

BEGIN;

ALTER TABLE payment_claims DROP CONSTRAINT payment_claims_status_check;
ALTER TABLE payment_claims ADD CONSTRAINT payment_claims_status_check
  CHECK (status IN ('PENDING','MATCH_SUGGESTED','VERIFIED','REJECTED',
                    'FAKE_RECEIPT','EXPIRED','FULFILLED_UNRECONCILED','WRITTEN_OFF'));

-- Who, when and why — the row's own answer, beside the append-only audit row,
-- so «سابقه» can say why a row left the queue without joining the log.
ALTER TABLE payment_claims
  ADD COLUMN written_off_at   bigint,
  ADD COLUMN written_off_by   text,
  ADD COLUMN write_off_reason text;

-- The status and its three columns come together or not at all, and only a
-- delivered, never-reconciled claim can be written off. Every conjunct is an
-- explicit IS NOT NULL: a CHECK whose expression is NULL passes.
ALTER TABLE payment_claims ADD CONSTRAINT payment_claims_written_off_complete
  CHECK ((status <> 'WRITTEN_OFF'
          AND written_off_at IS NULL AND written_off_by IS NULL AND write_off_reason IS NULL)
      OR (status = 'WRITTEN_OFF'
          AND written_off_at IS NOT NULL
          AND written_off_by IS NOT NULL
          AND write_off_reason IS NOT NULL AND length(btrim(write_off_reason)) >= 3
          AND fulfilled_at IS NOT NULL
          AND reconciled_at IS NULL));

COMMIT;
