-- 0068_card_name_is_the_holder_name.sql — 2026-09-16.
--
-- A card had two names and the operator could only see one of them.
--
-- `label` came from the Cloudflare hub, where it was an admin's nickname for
-- a card. `holder_name` came from Mirzabot's `card_number.namecard`, which is
-- what the PHP bot printed on the invoice as «به نام». The new dashboard grew
-- one field, «نام دلخواه», and it wrote `label`; the new bot's invoice reads
-- `holder_name`, which nothing but the one-time import ever wrote. So every
-- card added since the cutover went to customers without a name — Sam typed
-- «پویان بهمن» into all three and the bot printed none of them.
--
-- One column from here on: `holder_name`, which is what the customer sees.
-- What the operator typed is carried across first, and `label` goes, so the
-- next screen cannot pick the wrong one.

BEGIN;

-- Blank counts as empty on both sides: the PATCH route accepts '' for
-- holder_name, and a card whose only real name is in label must not lose it
-- to an empty string that was never a name.
UPDATE payment_cards
   SET holder_name = label
 WHERE NULLIF(btrim(holder_name), '') IS NULL
   AND NULLIF(btrim(label), '') IS NOT NULL;

ALTER TABLE payment_cards DROP COLUMN label;

COMMIT;
