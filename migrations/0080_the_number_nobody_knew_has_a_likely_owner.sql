-- 0080_the_number_nobody_knew_has_a_likely_owner.sql — 2026-09-19.
--
-- A Pol transfer of 5,500,000 IRR arrived «to 47045299» — a number no account
-- carried, so ingest made a PENDING account «Auto: ****5299» and the row sat
-- on it, off every total. The bank had written the answer in the same text:
-- the balance after was 8,354,098, and the last balance «کشاورزی-مامان» had
-- texted, seven hours earlier, was 2,854,098. 2,854,098 + 5,500,000 is
-- 8,354,098 exactly. The balance chains; it is the same account.
--
-- So when ingest creates a PENDING account for a number nobody knew, it now
-- looks for the one live account whose last texted balance, plus or minus
-- this movement, lands on this text's balance — and writes that account here
-- as a SUGGESTION. Exactly one; two candidates is silence, the same rule
-- auto-verify lives by. Nothing merges on its own: the review queue shows
-- «احتمالاً همان … است» and one click runs the existing merge.

BEGIN;

ALTER TABLE financial_accounts
  ADD COLUMN suggested_owner_id text REFERENCES financial_accounts(id) ON DELETE SET NULL,
  ADD COLUMN suggested_reason   text;

COMMIT;
