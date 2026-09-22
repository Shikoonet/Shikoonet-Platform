-- 0092_people_and_services_in_the_books.sql — Sam, 2026-09-22.
--
-- Two questions the books could not answer:
--
--   «سرویس الماس چقدر فروخته، چقدر برایش خرج کردیم، چقدر سود ساخته؟»
--   «سه نفریم و ماهیانه سود برمی‌داریم — معلوم است من چقدر گرفتم؟ شریکام چقدر؟»
--
-- And one request: «بخشی بزار که بشه اشخاص رو معرفی کرد و در سیستم حسابداری
-- ازشون استفاده کرد» — «حسام، خودم، پویان».
--
-- Three things, and none of them moves money:
--
--   1. `parties` — a person or a business the books deal with: a partner, a
--      supplier, a contractor, an agent. One table, one row per name, a list of
--      roles, because one person is often two of them.
--
--   2. `PARTNER_DRAW` — a fourth kind. A partner taking their share of the
--      profit is NOT an expense: the profit was already made and is being
--      divided. On 2026-09-22, 680,104,000 Toman of «هزینه» — 60% of all
--      spending on production — sat in «سهم شرکا و تسویه», so every «سود» the
--      panel could have printed was wrong by up to that much. A kind of its
--      own means every sum that already says `kind = 'EXPENSE'` stops counting
--      draws the moment a row is relabelled, with no reader to change.
--
--   3. An expense can say which part of the catalogue it was for: a category
--      («V2ray»), a service («الماس») or a panel (the server it runs on). At
--      most one; none means the whole shop. The profit report spreads a
--      category's or a panel's cost over its services by their sales.
--
-- What this file does NOT decide: which of the 17 partner rows were a profit
-- draw, which a wage, which a settlement. Sam knows, the notes do not. The
-- rows get their PERSON here, because the name is in the note; their kind is
-- changed by hand on «هزینه‌ها», one edit each, with the history kept.

BEGIN;

CREATE TEMP TABLE _books_before_0092 ON COMMIT DROP AS
  SELECT COALESCE(SUM(amount_irr), 0) AS total_irr, count(*) AS rows FROM revenue_adjustments;

-- ---------------------------------------------------------------------------
-- 1. People
-- ---------------------------------------------------------------------------
--
-- Roles are a closed list and an array: «حسام» is a partner and may also be
-- paid as a contractor, and two rows for one person would split his account
-- in two. `share_percent` is his cut of the profit, and only a partner has
-- one. No DELETE route exists; `active = false` archives, the way expense
-- categories do, so a row paid to someone can always say who.
CREATE TABLE parties (
  id            bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name          text    NOT NULL UNIQUE CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  roles         text[]  NOT NULL DEFAULT '{}'
                  CHECK (roles <@ ARRAY['PARTNER','SUPPLIER','CONTRACTOR','AGENT','OTHER']::text[]),
  share_percent numeric(5,2) CHECK (share_percent > 0 AND share_percent <= 100),
  active        boolean NOT NULL DEFAULT true,
  note          text    NOT NULL DEFAULT '',
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT parties_share_is_a_partners
    CHECK (share_percent IS NULL OR 'PARTNER' = ANY(roles))
);

-- ---------------------------------------------------------------------------
-- 2. The ledger learns who, and what for
-- ---------------------------------------------------------------------------
--
-- SET NULL on the three catalogue links, RESTRICT on the person. A service
-- that is deleted takes nothing with it: its cost falls back to «همهٔ
-- فروشگاه», still in every total. A person cannot be deleted at all.
ALTER TABLE revenue_adjustments
  ADD COLUMN party_id            bigint REFERENCES parties(id) ON DELETE RESTRICT,
  ADD COLUMN product_category_id bigint REFERENCES product_categories(id) ON DELETE SET NULL,
  ADD COLUMN product_id          bigint REFERENCES products(id) ON DELETE SET NULL,
  ADD COLUMN provider_id         bigint REFERENCES provisioning_providers(id) ON DELETE SET NULL,
  -- One level or none. A cost «for V2ray and also for الماس» has no answer to
  -- «how much of it was الماس's», and the report would have to guess.
  ADD CONSTRAINT revenue_adjustments_one_scope
    CHECK (num_nonnulls(product_category_id, product_id, provider_id) <= 1),
  -- Only spending is for something. A fake receipt is not «for» a service.
  ADD CONSTRAINT revenue_adjustments_scope_is_spending
    CHECK (kind = 'EXPENSE' OR num_nonnulls(product_category_id, product_id, provider_id) = 0);

-- The fourth kind, and its sign. A CHECK cannot be edited in place.
ALTER TABLE revenue_adjustments DROP CONSTRAINT revenue_adjustments_kind;
ALTER TABLE revenue_adjustments ADD CONSTRAINT revenue_adjustments_kind
  CHECK (kind IN ('EXPENSE', 'REVENUE_FIX', 'MANUAL_INCOME', 'PARTNER_DRAW'));
ALTER TABLE revenue_adjustments DROP CONSTRAINT revenue_adjustments_kind_sign;
ALTER TABLE revenue_adjustments ADD CONSTRAINT revenue_adjustments_kind_sign CHECK (
  CASE kind
    WHEN 'EXPENSE'       THEN amount_irr < 0
    WHEN 'PARTNER_DRAW'  THEN amount_irr < 0
    WHEN 'MANUAL_INCOME' THEN amount_irr > 0
    ELSE true
  END);
-- A draw with nobody's name on it is exactly the row this file exists to end.
ALTER TABLE revenue_adjustments ADD CONSTRAINT revenue_adjustments_draw_has_a_person
  CHECK (kind <> 'PARTNER_DRAW' OR party_id IS NOT NULL);

CREATE INDEX idx_revenue_adjustments_party
  ON revenue_adjustments (party_id, spent_on) WHERE party_id IS NOT NULL AND voided_at IS NULL;

-- A recurring cost remembers the same two things, so «سرور آلمان» is posted to
-- its panel every month without being asked again.
ALTER TABLE expense_recurrences
  ADD COLUMN party_id            bigint REFERENCES parties(id) ON DELETE RESTRICT,
  ADD COLUMN product_category_id bigint REFERENCES product_categories(id) ON DELETE SET NULL,
  ADD COLUMN product_id          bigint REFERENCES products(id) ON DELETE SET NULL,
  ADD COLUMN provider_id         bigint REFERENCES provisioning_providers(id) ON DELETE SET NULL,
  ADD CONSTRAINT expense_recurrences_one_scope
    CHECK (num_nonnulls(product_category_id, product_id, provider_id) <= 1);

-- The view freezes its column list (0040's warning); re-created so the new
-- columns land at the end.
DROP VIEW shop_books;
CREATE VIEW shop_books AS
  SELECT id, amount_irr, note, created_by, created_at, legacy_id,
         kind, category_id, spent_on, recurrence_id,
         currency, original_amount, fx_rate_irr,
         financial_account_id, fee_irr, transaction_candidate_id,
         party_id, product_category_id, product_id, provider_id
    FROM revenue_adjustments
   WHERE voided_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. The two partners the notes already name
-- ---------------------------------------------------------------------------
--
-- Only where the rows exist, so a fresh database (CI, a new laptop) gets no
-- people it never had. Only in «سهم شرکا و تسویه», so a server bill that
-- mentions a name in passing is not handed to him. Only when the note names
-- exactly one of them — a row naming both is left for a human.
INSERT INTO parties (name, roles, created_by)
SELECT v.name, ARRAY['PARTNER'], 'migration:0092'
  FROM (VALUES ('حسام'), ('پویان')) AS v(name)
 WHERE EXISTS (
   SELECT 1 FROM revenue_adjustments ra
     JOIN expense_categories ec ON ec.id = ra.category_id
    WHERE ec.name = 'سهم شرکا و تسویه' AND strpos(ra.note, v.name) > 0);

UPDATE revenue_adjustments ra
   SET party_id = p.id
  FROM parties p, expense_categories ec
 WHERE ec.id = ra.category_id
   AND ec.name = 'سهم شرکا و تسویه'
   AND strpos(ra.note, p.name) > 0
   AND (SELECT count(*) FROM parties q WHERE strpos(ra.note, q.name) > 0) = 1;

-- ---------------------------------------------------------------------------
-- 4. Prove it moved nothing
-- ---------------------------------------------------------------------------
DO $$
DECLARE before_row record; after_row record;
BEGIN
  SELECT * INTO before_row FROM _books_before_0092;
  SELECT COALESCE(SUM(amount_irr), 0) AS total_irr, count(*) AS rows
    INTO after_row FROM revenue_adjustments;
  IF before_row.total_irr <> after_row.total_irr OR before_row.rows <> after_row.rows THEN
    RAISE EXCEPTION 'naming people moved the books: % rows / % IRR became % rows / % IRR',
      before_row.rows, before_row.total_irr, after_row.rows, after_row.total_irr;
  END IF;
END $$;

COMMIT;
