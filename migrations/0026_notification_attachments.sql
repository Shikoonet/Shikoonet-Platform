-- What a queued message may carry besides its text.
--
-- `bot_notifications` was built for one thing: a line of text the customer is
-- owed. That was enough while the only queued message was "your payment was
-- confirmed". It stopped being enough the moment the message the whole purchase
-- exists to produce — the service itself — went through the queue too: the
-- screen a customer reaches by tapping «سرویس‌های من» has buttons and a QR code,
-- and the one they get at the moment of purchase had neither. The same service,
-- two different screens, and the worse one arrives first.
--
-- Both columns are nullable and both are ignored when null, so every row
-- already in the table keeps behaving exactly as it did.

BEGIN;

-- The inline keyboard, exactly as Telegram's `reply_markup` wants it. Stored
-- rendered rather than as an intent ("service 12") on purpose: the row is the
-- message, and a keyboard rebuilt at send time could disagree with the text it
-- sits under, which was written when the row was enqueued.
ALTER TABLE bot_notifications ADD COLUMN reply_markup jsonb;

-- The string to encode as a QR image, sent as a photo before the text. Not the
-- image: a PNG in a row is bytes nobody can read, it is regenerated in
-- milliseconds, and the payload is the thing worth being able to look at when
-- a customer says the code did not scan.
ALTER TABLE bot_notifications ADD COLUMN qr_payload text;

-- Sent separately from the text, so a retry of the row must not send it twice.
ALTER TABLE bot_notifications ADD COLUMN qr_sent_at timestamptz;

COMMIT;
