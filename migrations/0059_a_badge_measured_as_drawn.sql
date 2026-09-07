-- 0059 — a premium emoji may sit on a plan button, and the cap stops lying.
--
-- ## The thing that was already true
--
-- Nothing in the bot needed changing for this. A premium emoji reaches a button
-- through `icon_custom_emoji_id`, which `keyboardFor` (`telegram.ts:548`) fills
-- from a `<tg-emoji>` tag at the FRONT of the label — for every inline keyboard
-- the bot sends, not just the menu. And `badged()` (`menu.ts:717`) puts the
-- admin's badge exactly there, in front, deliberately.
--
-- So the transport, the position and the shop-wide «custom emoji» switch were
-- all already right. The only thing standing between an operator and «🔥 ۵۰
-- گیگ — ۹۰,۰۰۰ تومان» was this constraint counting the wrong characters.
--
-- ## What was wrong with the count
--
-- 0033 wrote `length(badge) BETWEEN 1 AND 24` onto both catalogue tables. That
-- counts the MARKUP. One tag is
--
--     <tg-emoji emoji-id="5368324170671202286">🔥</tg-emoji>
--
-- which is 53 characters in Postgres and draws as one glyph. Every badge
-- carrying a premium emoji was refused by the database, with a constraint
-- violation rather than anything an operator could read.
--
-- ## Why this shape, and not a bigger number
--
-- Raising 24 to 80 would have taken the markup and also taken eighty characters
-- of plain text, which is a button label Telegram truncates. The cap is about
-- what is ON THE SCREEN, so it has to measure what is on the screen.
--
-- This is not a new idea in this schema. `0053_keyboard_label_measured_as_drawn`
-- hit exactly this on `bot_keyboard_buttons.label` and solved it with the same
-- `regexp_replace`. Two tables were left behind then; this is them. The pattern
-- is deliberately character-for-character identical to 0053's — one rule about
-- what a rendered label is, spelled once, so the three places that ask
-- (`renderedLabelLength`, 0053, and this) cannot drift.
--
-- ## Nothing here can reject a row that exists
--
-- The constraint is WIDENED, strictly. For any string with no `<tg-emoji>` in
-- it, `regexp_replace` is the identity and the test is the old test unchanged;
-- for any string with one, the new length is smaller. So every badge the old
-- CHECK accepted, this one accepts. The DO block at the end asserts it against
-- the live table rather than trusting that paragraph.

BEGIN;

ALTER TABLE product_categories DROP CONSTRAINT product_categories_badge_len;
ALTER TABLE product_categories ADD CONSTRAINT product_categories_badge_len
  CHECK (badge IS NULL
         OR (length(regexp_replace(badge, '<tg-emoji[^>]*>(.*?)</tg-emoji>', '\1', 'g'))
             BETWEEN 1 AND 24));

ALTER TABLE product_plans DROP CONSTRAINT product_plans_badge_len;
ALTER TABLE product_plans ADD CONSTRAINT product_plans_badge_len
  CHECK (badge IS NULL
         OR (length(regexp_replace(badge, '<tg-emoji[^>]*>(.*?)</tg-emoji>', '\1', 'g'))
             BETWEEN 1 AND 24));

-- ---------------------------------------------------------------------------
-- Prove the widening, on this database's own rows
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  bad int;
BEGIN
  -- A row that the NEW rule would refuse. There must be none — the constraints
  -- above have already been applied, so a non-zero count here is impossible
  -- unless the ALTER silently skipped, which is the thing worth catching.
  SELECT count(*) INTO bad FROM product_categories
   WHERE badge IS NOT NULL
     AND length(regexp_replace(badge, '<tg-emoji[^>]*>(.*?)</tg-emoji>', '\1', 'g')) NOT BETWEEN 1 AND 24;
  IF bad <> 0 THEN
    RAISE EXCEPTION '0059 left % category badges outside the new rule', bad;
  END IF;

  SELECT count(*) INTO bad FROM product_plans
   WHERE badge IS NOT NULL
     AND length(regexp_replace(badge, '<tg-emoji[^>]*>(.*?)</tg-emoji>', '\1', 'g')) NOT BETWEEN 1 AND 24;
  IF bad <> 0 THEN
    RAISE EXCEPTION '0059 left % plan badges outside the new rule', bad;
  END IF;

  -- And that the new rule is genuinely wider: a badge that is one premium emoji
  -- plus a word measures under the cap now and did not before.
  IF length(regexp_replace('<tg-emoji emoji-id="5368324170671202286">🔥</tg-emoji> آف',
                           '<tg-emoji[^>]*>(.*?)</tg-emoji>', '\1', 'g')) > 24 THEN
    RAISE EXCEPTION '0059 did not widen the rule it exists to widen';
  END IF;
END $$;

COMMIT;
