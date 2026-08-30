-- «هزینه‌ها» becomes a ledger that can say what a row IS, who changed it, and
-- when the money actually left.
--
-- WHAT WAS WRONG. `revenue_adjustments` (0005:146) is one signed amount and a
-- free-text note, and the sign was the only type it had. Measured on the
-- production dump, 219 rows, that made it a junk drawer holding three
-- different things:
--
--   103 rows  −35,845,000 T   fake receipt / no deposit / underpaid / duplicate
--    51 rows  +94,629,000 T   reseller sales an admin recorded by hand
--    65 rows −756,155,750 T   the actual spending
--
-- So «مجموع هزینه‌ها» on the panel read 792 million Toman, of which 35.8
-- million was fake receipts the shop never spent, and «برگشتی و اعتبار» was
-- labelled as returns while being entirely reseller income. Sam's words:
-- «تفکیک‌ها اصلا خوب نیست ... باعث misunderstanding نشه و حساب کتابها نریزه
-- بهم». He was right, and it was worse than the screen suggested.
--
-- THE ONE THING THIS FILE MUST NOT DO IS MOVE MONEY. `verify.ts` compares
-- `SUM(amount_irr)` here against `setting.revenue_adjustment` — the number the
-- legacy panel prints — with exact equality, and its comment says that check
-- exists to catch a sign flip. The three kinds are a PARTITION of the same
-- signed rows: every row gets a label, no row gets a new amount. `amount_irr`
-- appears in no SET list below, and the DO block at the end asserts the sum
-- and the row count are untouched, rolling the whole migration back if they
-- are not.
--
-- ORDER MATTERS BELOW. Categories and recurrences exist before the ALTER that
-- references them; the backfill runs before the NOT NULLs and the CHECKs, so a
-- classifier that mislabels a row fails the migration here rather than being
-- discovered on a screen six weeks later.

BEGIN;

-- The books as they stand, so the end of this file can prove it did not touch
-- them. A temp table rather than a variable: the DO block below is a separate
-- statement and cannot see one.
CREATE TEMP TABLE _books_before ON COMMIT DROP AS
  SELECT COALESCE(SUM(amount_irr), 0) AS total_irr, count(*) AS rows FROM revenue_adjustments;

-- ---------------------------------------------------------------------------
-- 1. Categories
-- ---------------------------------------------------------------------------
--
-- Shaped on `product_categories` (0002:58) with one deviation: no `legacy_id`.
-- There is no category in `revenue_adjustment_log` — the legacy carries only
-- `amount`, `type`, `note`, `created_by`, `created_at` — so a UNIQUE column
-- that would be NULL on every row for ever is a column the importer would be
-- expected to fill and never could.
--
-- The seven names are not invented. Each one is a cluster that already exists
-- in the production notes, and the two biggest — advertising and partner
-- settlements — are 92% of the money between them.

CREATE TABLE expense_categories (
  id         bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name       text    NOT NULL UNIQUE,
  active     boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0
);

INSERT INTO expense_categories (name, sort_order) VALUES
  ('تبلیغات',                  10),  -- 22 rows, −283M T: نیتروژن, استرنج, کربن, موویتو
  ('سهم شرکا و تسویه',         20),  -- 10 rows, −409M T: حسام, پویان, تسویه حساب
  ('سرور و زیرساخت',           30),  -- سرور, آروان, پرشین‌تک, دامنه, IP
  ('بهای تمام‌شده',             40),  -- خرید پنل, تلگرام پرمیوم — stock bought to resell
  ('ابزار و اشتراک',           50),  -- ChatGPT Plus, licences
  ('کارمزد و بانکی',           60),  -- SMS fees, transfer charges
  ('سایر',                     90);

-- ---------------------------------------------------------------------------
-- 2. Recurring expenses
-- ---------------------------------------------------------------------------
--
-- «هزینه یک ماهه سرور آلمان» — the case Sam named. A template, not a ledger
-- entry: `amount_irr` here is a positive magnitude and the row it posts is
-- negative, for the same reason the POST body takes a magnitude and a
-- direction. The sign is applied in exactly one place.
--
-- THERE IS NO CRON, AND THAT IS THE DESIGN. A job that posts silently writes a
-- line into the books nobody typed, at an amount that may have changed (a
-- server bill in EUR moves every month) on a date the money may not have left.
-- It would need a correction screen the first time it was wrong. Instead the
-- panel shows what is due and an admin presses a button; if nobody ever
-- presses it, nothing is posted and `next_due_on` sits in the past with the
-- screen counting up — a visible growing number rather than a silent book.

CREATE TABLE expense_recurrences (
  id          bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  label       text    NOT NULL,
  category_id bigint  REFERENCES expense_categories(id) ON DELETE RESTRICT,
  amount_irr  bigint  NOT NULL CHECK (amount_irr > 0),
  -- Gregorian on the wire; advanced by one JALALI month by the route, using
  -- `packages/contracts/src/jalali.ts` rather than +30 days. Jalali months are
  -- 29 to 31 days on a leap cycle that repeats every 33 years.
  next_due_on date    NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  note        text    NOT NULL DEFAULT '',
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 3. The columns
-- ---------------------------------------------------------------------------
--
-- `spent_on` is a date, not a timestamp: the question is «کدام روز پول رفت»,
-- never which second. It is separate from `created_at` because those are two
-- different facts — a server bill for last month, typed today, belongs in last
-- month's total. Backfilled from the Tehran day of `created_at`, which is not
-- a guess: it is the best-known spend date for a historical row, and it is
-- exactly the date the screen already prints for it.
--
-- NO `updated_at` / `updated_by`. `audit_logs` is the history and it is already
-- indexed for this lookup (`idx_audit_entity` on (entity_type, entity_id,
-- created_at DESC), 0004:290). Two records of the same fact is one that can
-- drift, and the one that would drift is the cached one.

ALTER TABLE revenue_adjustments
  ADD COLUMN kind          text,
  ADD COLUMN category_id   bigint REFERENCES expense_categories(id) ON DELETE RESTRICT,
  ADD COLUMN spent_on      date,
  ADD COLUMN recurrence_id bigint REFERENCES expense_recurrences(id) ON DELETE SET NULL,
  ADD COLUMN voided_at     timestamptz,
  ADD COLUMN voided_by     text,
  ADD COLUMN void_reason   text;

-- ---------------------------------------------------------------------------
-- 4. The classifier, in the database
-- ---------------------------------------------------------------------------
--
-- WHY HERE AND NOT IN TYPESCRIPT. Two callers need the same rule: this
-- migration, backfilling 219 rows, and `packages/migrate` when a fresh dump is
-- imported. A SQL migration cannot call TypeScript, so the alternatives were a
-- copy of the rule in each language — guaranteed to drift the first time a
-- keyword is added — or a backfill script outside `schema_migrations`, which
-- would leave every fresh database (CI, `pnpm sim:up`, a new laptop) with an
-- unclassified ledger and nothing saying so.
--
-- `insertBatch` already supports a SQL expression per column (`db.ts:196`,
-- used for timestamps at `migrate.ts:66`), so the importer calls these
-- functions and no TypeScript classifier exists at all.
--
-- NOT A TRIGGER. A trigger would also guess for the admin form, and a form
-- that silently reclassifies what an operator chose is worse than one that
-- refuses. These are called explicitly, by the two callers that want a guess.

-- What KIND of thing a legacy row is.
--
-- ORDER IS THE DESIGN, and it was settled by reading the rows rather than by
-- reasoning about them:
--
--   * The correction words come FIRST, before the sale words. «5960227227 |
--     Hamidreza_abbasi00 | buy تکراری» is a duplicate charge being returned,
--     not a purchase, and it carries both vocabularies.
--   * «Reseller MohammadReza» is English. A rule that matched only «ریسلر»
--     read two real reseller sales as corrections; both spellings are here
--     because both are in the dump.
--   * A positive row that names no sale falls to REVENUE_FIX, never to
--     MANUAL_INCOME. That is the conservative direction and it is deliberate:
--     a mislabelled correction is a filter that reads oddly, an invented sale
--     is a book that lies.
CREATE FUNCTION expense_kind_of(note text, amount_irr bigint) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN note ~* 'فیک|عدم واریز|کم واریز|اشتباه|تکراری|برگشت|پس دادن|پس گرفتن|اختلاف حساب|درست کردن حساب'
      THEN 'REVENUE_FIX'
    WHEN amount_irr > 0 AND note ~* 'ریسلر|reseller|فروش|تمدید|نامحدود|کاربر|یوزر'
      THEN 'MANUAL_INCOME'
    -- A negative row opening with a bare telegram id is a per-customer
    -- correction; 24 rows in the dump take this shape.
    WHEN amount_irr < 0 AND note ~ '^\s*[0-9]{6,}'
      THEN 'REVENUE_FIX'
    WHEN amount_irr > 0
      THEN 'REVENUE_FIX'
    ELSE 'EXPENSE'
  END
$$;

-- What an expense was FOR. Returns the category NAME, not an id, so the
-- function has no dependency on a generated sequence and behaves identically
-- against a fresh database; both callers join on the name.
--
-- THERE IS DELIBERATELY NO `Ton` RULE, and its absence is what makes the rest
-- correct. «خرید Ton» is a payment rail, not a purpose, and because it matches
-- nothing each row falls through to the noun that says what the money bought:
--
--   «هزینه سرور - خرید Ton»          → سرور و زیرساخت
--   «خرید ۲۰ عدد Ton جهت تبلیغات»   → تبلیغات
--   «حسام - خرید TON»                → سهم شرکا و تسویه
--   «خرید Ton» on its own            → NULL, and the screen shows it as
--                                      «دسته‌بندی‌نشده» for a human to decide
--
-- Partner names come before everything because a settlement can mention what
-- it was spent on; NULL is returned rather than «سایر» so that «I have not
-- looked at this yet» stays distinguishable from «I looked, and it is other».
CREATE FUNCTION expense_category_of(note text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN note ~* 'حسام|پویان|تسویه|سود'                        THEN 'سهم شرکا و تسویه'
    WHEN note ~* 'سرور|آروان|اروان|هاست|دامنه|پرشین|پیتیکو'    THEN 'سرور و زیرساخت'
    WHEN note ~* 'تبلیغ|پیج|اسپانسر'                            THEN 'تبلیغات'
    WHEN note ~* 'خرید پنل|خرید vpn|پرمیوم|premium'             THEN 'بهای تمام‌شده'
    WHEN note ~* 'chatgpt|پلاس|لایسنس|اشتراک'                   THEN 'ابزار و اشتراک'
    WHEN note ~* 'sms|پیامک|کارمزد'                             THEN 'کارمزد و بانکی'
    ELSE NULL
  END
$$;

-- ---------------------------------------------------------------------------
-- 5. Backfill
-- ---------------------------------------------------------------------------

UPDATE revenue_adjustments SET kind = expense_kind_of(note, amount_irr);

UPDATE revenue_adjustments ra
   SET category_id = ec.id
  FROM expense_categories ec
 WHERE ra.kind = 'EXPENSE'
   AND ec.name = expense_category_of(ra.note);

UPDATE revenue_adjustments SET spent_on = (created_at AT TIME ZONE 'Asia/Tehran')::date;

-- ---------------------------------------------------------------------------
-- 6. Now the constraints, and only now
-- ---------------------------------------------------------------------------

ALTER TABLE revenue_adjustments
  ALTER COLUMN kind SET NOT NULL,
  ALTER COLUMN spent_on SET NOT NULL,
  ADD CONSTRAINT revenue_adjustments_kind
    CHECK (kind IN ('EXPENSE', 'REVENUE_FIX', 'MANUAL_INCOME')),
  -- The sign each kind is allowed to carry. EXPENSE is money out and
  -- MANUAL_INCOME is money in, so both are pinned. REVENUE_FIX is free on
  -- purpose: a clawback is negative and a reversed over-deduction is positive,
  -- and both are corrections to the same figure.
  ADD CONSTRAINT revenue_adjustments_kind_sign CHECK (
    CASE kind
      WHEN 'EXPENSE'       THEN amount_irr < 0
      WHEN 'MANUAL_INCOME' THEN amount_irr > 0
      ELSE true
    END),
  -- Voided rows keep who and when together; a void with no author is a row
  -- that left the books with nobody's name on it.
  ADD CONSTRAINT revenue_adjustments_void_complete
    CHECK ((voided_at IS NULL) = (voided_by IS NULL));

CREATE INDEX idx_revenue_adj_spent    ON revenue_adjustments (spent_on DESC, id DESC);
CREATE INDEX idx_revenue_adj_kind_cat ON revenue_adjustments (kind, category_id);

-- ---------------------------------------------------------------------------
-- 7. The books, as the app must read them
-- ---------------------------------------------------------------------------
--
-- TWO NAMES BECAUSE THERE ARE TWO QUESTIONS.
--
--   the app asks   «what is in the books right now»   → reads this view
--   verify.ts asks «did the import land every Rial»   → reads the TABLE
--
-- ADDING `voided_at IS NULL` TO `verify.ts` WOULD BE THE BUG. A voided row
-- still came out of `revenue_adjustment_log` and still has to be counted
-- against the legacy total; hiding it there would make a correct import look
-- like a short one. This is the same shape as the trap `migrate.ts` documents
-- around `type`/`deduct` — the obvious tidy-up is the wrong one.
--
-- Voiding also fixes a bug nobody had noticed. `verify.ts` COUNT_PAIRS
-- compares `COUNT(*) FROM revenue_adjustment_log` to `COUNT(*) FROM
-- revenue_adjustments`, so the DELETE route this replaces meant one admin
-- removing one line made that check red for ever, with nothing saying why.
-- Nothing deletes from this table any more.
--
-- Columns listed rather than `SELECT *`: a view freezes its column list at
-- creation, and a star makes that invisible the first time somebody adds a
-- column and wonders why it never appears.
CREATE VIEW shop_books AS
  SELECT id, amount_irr, note, created_by, created_at, legacy_id,
         kind, category_id, spent_on, recurrence_id
    FROM revenue_adjustments
   WHERE voided_at IS NULL;

-- ---------------------------------------------------------------------------
-- 8. Prove it moved nothing
-- ---------------------------------------------------------------------------
--
-- Two guarantees, one structural and one asserted. The structural one is that
-- `amount_irr` is in no SET list above — grep-able, one line to check in
-- review. This is the other one, and it fails the migration rather than
-- reporting a difference nobody reads.

DO $$
DECLARE before_row record; after_row record;
BEGIN
  SELECT * INTO before_row FROM _books_before;
  SELECT COALESCE(SUM(amount_irr), 0) AS total_irr, count(*) AS rows
    INTO after_row FROM revenue_adjustments;

  IF before_row.total_irr <> after_row.total_irr OR before_row.rows <> after_row.rows THEN
    RAISE EXCEPTION
      'the expense backfill moved the books: % rows / % IRR became % rows / % IRR',
      before_row.rows, before_row.total_irr, after_row.rows, after_row.total_irr;
  END IF;

  -- And the partition is total: every row carries exactly one kind, so the
  -- three sums the screen shows add back to the one the shop's net is built
  -- from. Without this, a classifier that returned NULL for some shape would
  -- pass the check above and quietly drop rows out of all three columns.
  IF EXISTS (SELECT 1 FROM revenue_adjustments WHERE kind IS NULL) THEN
    RAISE EXCEPTION 'the classifier left rows unlabelled';
  END IF;
END $$;

COMMIT;
