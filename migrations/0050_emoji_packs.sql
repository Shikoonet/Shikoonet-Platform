-- 0050 — the premium emoji an admin may choose from, as packs.
--
-- The feature shipped with one way to use it: type the markup by hand.
--
--     <tg-emoji emoji-id="5368324170671202286">🔥</tg-emoji>
--
-- That id is a 64-bit number nothing on the panel could tell you. Three of them
-- are hard-coded in `botTexts.ts` and every other one had to be found outside
-- this system entirely — which is why, months after the feature was built, the
-- shop uses exactly those three. Sam, 2026-09-03: «یه پکیج دیفالت بذار، بعداً
-- بتونیم پکیج‌های دیگر اضافه کنیم».
--
-- ## A pack is a Telegram sticker set, and nothing here invents one
--
-- `getStickerSet(name)` answers with the set's stickers, and a custom-emoji
-- sticker carries both halves the markup needs: `custom_emoji_id`, and the
-- `emoji` a client without Premium draws instead. So an admin pastes
-- `t.me/addemoji/<name>` and the panel fills these two tables from Telegram's
-- own answer. Nothing is typed twice, and nothing here can drift from what
-- Telegram will render.
--
-- ## What this is NOT
--
-- It is not a second way to store an emoji. The texts keep holding the same
-- `<tg-emoji>` markup they hold today, `checkCustomEmoji` keeps being the gate,
-- and `withEmojiFallback` keeps being the landing when a shop has no Premium.
-- These tables are a MENU: they exist so a picker has something to show. That
-- distinction is why this migration touches no existing column — a symbolic
-- reference like `{emoji:fire}` resolved at send time would have meant a second
-- render path and a new failure mode («that name is not in any pack») on the
-- one code path that must never fail to produce a message.
--
-- ## The counting sentence this repository's migrations usually carry
--
-- It is missing on purpose. Every migration here says what it counted in the
-- production dump before it ran; `legacy/mirzabot-php/db/` is an EMPTY
-- DIRECTORY on this machine, so nothing could be counted and saying otherwise
-- would be the exact failure rule 6 describes. What can be said: these are new
-- tables, nothing reads them yet, and no existing row changes shape.

BEGIN;

CREATE TABLE emoji_packs (
  id         bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  -- Telegram's own set name, the part after `t.me/addemoji/`. Unique because
  -- adding the same pack twice is a mistake with a silent cost: two identical
  -- menus, and a refresh that updates one of them.
  set_name   text        NOT NULL UNIQUE,
  -- The set's human title as Telegram reports it, or what the admin typed for
  -- the built-in pack, which belongs to no set.
  title      text        NOT NULL,
  -- Off hides the pack from the picker without dropping what it holds. An id
  -- already typed into a text keeps working — ids are Telegram's, not ours, and
  -- removing a pack was never going to un-send a message.
  active     boolean     NOT NULL DEFAULT true,
  added_at   timestamptz NOT NULL DEFAULT now(),
  -- When Telegram was last asked what is in this set. NULL for the built-in
  -- pack, which was never asked and never will be.
  synced_at  timestamptz
);

CREATE TABLE emoji_pack_items (
  pack_id         bigint NOT NULL REFERENCES emoji_packs(id) ON DELETE CASCADE,
  -- Kept as TEXT, deliberately. These are 64-bit ids and this file has already
  -- watched `numeric` round one in another table; a menu that hands out an id
  -- one digit off produces a message Telegram refuses, and the admin sees the
  -- emoji they picked simply not appear.
  custom_emoji_id text   NOT NULL,
  -- What a client without Premium shows, and what goes between the tags. It is
  -- Telegram's own `emoji` field on the sticker, not a guess.
  fallback_emoji  text   NOT NULL,
  sort_order      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (pack_id, custom_emoji_id)
);

CREATE INDEX idx_emoji_pack_items_order ON emoji_pack_items (pack_id, sort_order, custom_emoji_id);

-- The pack that is already in use, made visible.
--
-- These three ids are in `botTexts.ts` today, inside the shipped defaults for
-- PAID_RECORDED_TITLE and its siblings. Until now an admin editing a text could
-- see the markup and had no way to reuse the emoji anywhere else. Seeded rather
-- than fetched: they belong to no set we know the name of, and the whole point
-- is that a fresh install opens the picker to something rather than to nothing.
INSERT INTO emoji_packs (set_name, title, synced_at)
VALUES ('__builtin__', 'پیش‌فرض شیکو', NULL);

INSERT INTO emoji_pack_items (pack_id, custom_emoji_id, fallback_emoji, sort_order)
SELECT p.id, v.emoji_id, v.fallback, v.ord
  FROM emoji_packs p,
       (VALUES ('5467566950868082386', '⏰', 0),
               ('5368324170671202286', '👋', 1),
               ('5237699328843200968', '✅', 2)) AS v(emoji_id, fallback, ord)
 WHERE p.set_name = '__builtin__';

COMMIT;
