-- 0048 — the name a customer chose for their own account.
--
-- «روش ساخت نام کاربری» gained a mode on 2026-09-03 where the customer types
-- the part before the order number. This is where that text lives.
--
-- ## Per ORDER, not per user
--
-- `remoteUsernameFor` must give the same answer on every retry, and the comment
-- above it says what the alternative costs: a sweep that created the account
-- and died before writing the row asks for a DIFFERENT name next time, makes a
-- second account on the panel, and the customer is billed once for two.
--
-- A column on `users` would move under a half-finished provisioning and
-- reproduce exactly that. Frozen onto the order that used it, it cannot.
--
-- ## Sanitised before it is stored, and the CHECK says so
--
-- `sanitiseUsernamePart` runs in the bot, at the prompt, so what is in this
-- column is what the panel will be asked for. Persian reduces to the empty
-- string under that charset — and Persian is what most customers of a Persian
-- shop will type — so the bot asks again rather than silently falling back,
-- which is the panel setting switched on and inert.
--
-- The CHECK is the database saying the same thing, so a caller that forgets to
-- sanitise fails loudly at the INSERT rather than at the panel, in the middle
-- of a paid order.
--
-- Sixteen characters and not thirty-two: plus a separator and a ten-character
-- public id that is twenty-seven, and `USERNAME_PART_MAX`'s own comment says
-- the panel answers 422 somewhere past forty. The regex is the panel's own
-- charset — must start with a letter, `[a-z0-9_]` only, at least three.
--
-- ## NULL on almost every row, and that is the normal case
--
-- Every order on a panel that is not CUSTOMER_TEXT, and every trial: a trial is
-- never prompted, because its whole point is that it has no steps.
-- `usernamePrefix` falls back to the ORDER_ID digest there rather than to the
-- Telegram id — falling back to the id would put on the customer's phone the
-- one thing these two modes exist to keep off it.
--
-- Renewals and add-ons never reach this column at all: `deliver()` routes them
-- to `renew()`, which uses the subscription's existing `remote_username`.

BEGIN;

ALTER TABLE orders ADD COLUMN username_text text
  CONSTRAINT orders_username_text_charset
  CHECK (username_text IS NULL OR username_text ~ '^[a-z][a-z0-9_]{2,15}$');

COMMENT ON COLUMN orders.username_text IS
  'The customer-chosen prefix of the panel account name, already sanitised. NULL unless the panel is CUSTOMER_TEXT.';

COMMIT;
