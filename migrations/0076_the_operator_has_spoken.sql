-- 0076_the_operator_has_spoken.sql — issue #320, 2026-09-18.
--
-- An operator looking at a claim can now send the customer one of a few
-- ready-made messages through the bot («رسید شما به حساب ما نشسته، لطفاً با
-- پشتیبانی تماس بگیرید»). Once that has happened the claim is a different
-- kind of undecided: somebody has been contacted and the ball is in the
-- customer's court. Sam wants those apart from the rest, in their own tab.
--
-- Same shape as 0072's `parked_at`: a view flag, not a status. The claim
-- stays PENDING, the matcher still sees it, and when the SMS lands it
-- auto-verifies and leaves the tab on its own. `messaged_template` says
-- which text went, so the row can show it.
--
-- The texts themselves live in `settings ('shop', 'review_messages')` as a
-- JSON array of {key, text} — Sam adds more from the panel — so the first
-- one is seeded here rather than hard-coded anywhere. Seeded, not left
-- absent, for the reason 0064 gave: the panel updates the row and has
-- nothing to edit if it does not exist.

BEGIN;

ALTER TABLE payment_claims ADD COLUMN messaged_at bigint;
ALTER TABLE payment_claims ADD COLUMN messaged_template text;

INSERT INTO settings (scope, key, value, updated_at, updated_by)
VALUES (
  'shop',
  'review_messages',
  '[{"key":"receipt_landed_call_support","text":"با سلام، رسید فیش واریزی شما به حساب ما نشسته، لطفاً با پشتیبانی تماس بگیرید."}]'::jsonb,
  now(),
  NULL
)
ON CONFLICT (scope, key) DO NOTHING;

COMMIT;
