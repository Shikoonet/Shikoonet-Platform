-- 0053 — a button label is measured as DRAWN, not as written.
--
-- `bot_keyboard_label_length` counted the raw string, and on 2026-09-03 that
-- turned into a refusal of a feature the rest of the system had just gained.
--
-- ## The three places that have to agree
--
-- A premium emoji on a button is not markup in the label — a button's `text` is
-- plain in the Bot API. It is a FIELD, `icon_custom_emoji_id`, and the bot fills
-- it from a `<tg-emoji>` tag at the front of the label (`keyboardFor`). So a
-- stored label carries about fifty-two characters that draw as one glyph.
--
-- Three things measure that label, and until this migration they disagreed:
--
--   * the send path   — strips the tag and sets the icon field. Always did.
--   * `checkLayout`   — refused ANY tag outright, then (same day) allowed a
--                       leading one and measured the stripped length.
--   * this CHECK      — counted every character, so «🔥 خرید اشتراک» was 65 and
--                       the write failed with a constraint violation.
--
-- The failure mode is the worst kind of disagreement: each layer is defensible
-- alone. The panel says yes, the bot says yes, and Postgres says no — from a
-- screen whose message is a constraint name.
--
-- ## Why a regexp and not a bigger number
--
-- Raising the cap to 128 would have been one word. It would also have raised it
-- for labels with no markup at all, and the 64 is not arbitrary: it is what fits
-- on one line of a phone. Measuring what is drawn keeps that promise exactly and
-- refuses a genuinely long label whether or not it carries an emoji.
--
-- The pattern is the same one `stripCustomEmoji` implements, in Postgres's own
-- syntax. Verified against a real label before this was written: the 65-character
-- «<tg-emoji …>🔥</tg-emoji> خرید اشتراک» measures 13.
--
-- ## What was counted
--
-- Nothing, and it is worth saying rather than implying. No production dump is
-- reachable from the machine this was written on; the sim's table holds only
-- what its own tests write. What can be said instead: this constraint is being
-- WIDENED — every label it accepted before, it still accepts — so there is no
-- row it can newly reject.

BEGIN;

ALTER TABLE bot_keyboard_buttons DROP CONSTRAINT bot_keyboard_label_length;

ALTER TABLE bot_keyboard_buttons
  ADD CONSTRAINT bot_keyboard_label_length
  CHECK (length(regexp_replace(label, '<tg-emoji[^>]*>(.*?)</tg-emoji>', '\1', 'g')) <= 64);

COMMIT;
