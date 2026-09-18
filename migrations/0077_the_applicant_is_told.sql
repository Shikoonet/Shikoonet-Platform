-- 0077_the_applicant_is_told.sql — issue #330, 2026-09-18.
--
-- Sam, right after #327 merged: «قابلیت ارسال پیغام توی پرداخت‌ها خوب بود،
-- همینو می‌خوام برای نماینده‌ها». The reseller-request page sends the
-- applicant nothing today — not while reviewing, not even on approve or
-- reject — so a customer who pressed the button in the bot is in the dark
-- until they come back and ask.
--
-- Same shape as 0076 on `payment_claims`: two columns that say whether the
-- operator has written to the applicant, and with which text. A badge, not
-- a status — the request stays PENDING and is decided the way it always was.
-- The texts live beside the review ones, `('shop','reseller_request_messages')`,
-- seeded with a placeholder until Sam writes the real first one.

BEGIN;

ALTER TABLE reseller_requests ADD COLUMN messaged_at bigint;
ALTER TABLE reseller_requests ADD COLUMN messaged_template text;

INSERT INTO settings (scope, key, value, updated_at, updated_by)
VALUES (
  'shop',
  'reseller_request_messages',
  '[{"key":"request_received_under_review","text":"با سلام، درخواست نمایندگی شما دریافت شد و در حال بررسی است."}]'::jsonb,
  now(),
  NULL
)
ON CONFLICT (scope, key) DO NOTHING;

COMMIT;
