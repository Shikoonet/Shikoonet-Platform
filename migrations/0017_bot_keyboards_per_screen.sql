-- 0017_bot_keyboards_per_screen.sql — one keyboard per screen, not one in total.
--
-- 0015 gave the shop its main menu. Every other keyboard the bot draws — the
-- invoice, the service page, the renewal list, the admin's review screens —
-- was still a literal in `menu.ts`, so «✅ پرداخت کردم» could not be renamed
-- and «➕ حجم اضافه» could not be moved.
--
-- `bot_keyboard_buttons` had no column saying which keyboard a row belonged to,
-- because there was only one. Adding it is the whole change; everything else
-- follows from the primary key no longer being the action alone.
--
-- ## The existing rows are the main menu
--
-- A shop that customised its keyboard before this migration customised the main
-- menu, because that was the only one there was. So the default backfills them
-- to 'main' and their layout survives untouched.
--
-- The DEFAULT is then dropped. A row inserted afterwards must name its own
-- keyboard: without that, a bug that forgot the column would quietly write
-- buttons onto the main menu, which is the one screen every customer sees.
--
-- ## Still all-or-nothing, now per keyboard
--
-- A menu is either absent from this table — and the code's layout is used whole
-- — or present with every one of its buttons. That is why the uniqueness moves
-- to (menu, row_index, col_index) rather than being dropped: two buttons in one
-- cell of one keyboard still renders in an order the query plan decides.

BEGIN;

ALTER TABLE bot_keyboard_buttons ADD COLUMN menu text NOT NULL DEFAULT 'main';

ALTER TABLE bot_keyboard_buttons DROP CONSTRAINT bot_keyboard_buttons_pkey;
ALTER TABLE bot_keyboard_buttons ADD  PRIMARY KEY (menu, action);

ALTER TABLE bot_keyboard_buttons DROP CONSTRAINT bot_keyboard_buttons_row_index_col_index_key;
ALTER TABLE bot_keyboard_buttons ADD  UNIQUE (menu, row_index, col_index);

ALTER TABLE bot_keyboard_buttons ADD CONSTRAINT bot_keyboard_menu_not_blank
  CHECK (btrim(menu) <> '');

ALTER TABLE bot_keyboard_buttons ALTER COLUMN menu DROP DEFAULT;

COMMIT;
