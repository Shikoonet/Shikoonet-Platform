-- Put back the seven expense categories that `seed:sim` has been deleting.
--
-- `0040` inserts them; `packages/seed`'s `wipe()` truncates every table not
-- named in its `KEEP` set, and `expense_categories` was not named. So every
-- simulation database seeded since `0040` landed has an expenses screen with no
-- categories at all: no picker on the form, an empty «تفکیک», and every
-- imported row's `category_id` set to NULL by the CASCADE.
--
-- The leak is closed in `packages/seed/src/run.ts` — the table is reference data
-- that migrations own and admins edit, exactly like `bank_card_prefixes`. This
-- file is the other half: KEEP stops the next wipe, and nothing else puts back
-- the one that already happened.
--
-- INERT WHERE NOTHING IS WRONG. `ON CONFLICT (name) DO NOTHING` means a healthy
-- database — production, CI, a laptop that never ran the seed — is untouched,
-- and an admin's own additions and renames survive. The duplicated list is the
-- price of a repair: `0040` remains the definition, and this is a statement
-- about databases that lost it.
--
-- `sort_order` matches `0040` so a restored list comes back in the same order it
-- was in. `active` takes its default: a category deactivated before the wipe
-- comes back active, which is visible and correctable, unlike the alternative.

BEGIN;

INSERT INTO expense_categories (name, sort_order) VALUES
  ('تبلیغات',          10),
  ('سهم شرکا و تسویه', 20),
  ('سرور و زیرساخت',   30),
  ('بهای تمام‌شده',     40),
  ('ابزار و اشتراک',   50),
  ('کارمزد و بانکی',   60),
  ('سایر',             90)
ON CONFLICT (name) DO NOTHING;

-- The screen is unusable without at least one, and a repair that quietly
-- repaired nothing is the failure worth catching here rather than on a form.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM expense_categories;
  IF n = 0 THEN
    RAISE EXCEPTION 'expense_categories is still empty after the repair';
  END IF;
END $$;

COMMIT;
