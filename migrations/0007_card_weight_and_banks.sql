-- 0007_card_weight_and_banks.sql — three things the head admin asked for on
-- 2026-08-13, all of them about banks.
--
-- 1. A newly added card must be shown MORE than the others until its
--    transaction count catches up — but never exclusively.
--
--    Today it is shown exclusively. `rotateCard` orders by
--    `last_assigned_at NULLS FIRST`, and a fresh row has NULL, so a new card
--    wins every single checkout until it has been used more recently than
--    every other card. That is the bug the admin described, already live.
--
--    The fix is a virtual clock. Each card carries a cursor; rotation takes
--    the smallest cursor and advances it by STEP/weight. A card with weight 3
--    advances a third as far per pick, so it is picked three times as often —
--    exactly the ratio, and never all of it, because the cursor of the card
--    just picked strictly increases and must eventually pass every other card.
--
-- 2. Which bank a card number belongs to, from its prefix, editable later.
--
-- 3. Which bank an SMS came from, when the built-in parser no longer
--    recognises it because the bank changed its wording.

BEGIN;

-- ---------------------------------------------------------------------------
-- payment_cards — display weight and rotation cursor
-- ---------------------------------------------------------------------------
-- The weight ceiling is 20 rather than unbounded so integer division keeps
-- resolution: STEP is 1,000,000, so the smallest step is 50,000. It is also
-- the honest range — a card that needs to be shown more than 20x as often as
-- its peers is not a weighting problem, it is the only card that should be
-- active.
ALTER TABLE payment_cards
  ADD COLUMN display_weight  int    NOT NULL DEFAULT 1
    CHECK (display_weight BETWEEN 1 AND 20),
  ADD COLUMN rotation_cursor bigint NOT NULL DEFAULT 0;

-- Every existing card starts level. This deliberately does NOT seed the cursor
-- from `last_assigned_at`: that column is a wall-clock timestamp in a different
-- unit and ordering by it once more would just replay the current imbalance.
-- A card ADDED from here on is seeded to MAX(rotation_cursor) by the create
-- route — without that, it starts at 0 among peers sitting at millions and
-- takes every checkout until it catches up, which is the bug above.
DROP INDEX idx_payment_cards_rotation;
CREATE INDEX idx_payment_cards_rotation
  ON payment_cards(status, rotation_cursor) WHERE status = 'ACTIVE';

-- `last_assigned_at` stays. It no longer drives rotation, but it is the only
-- record of when a card was last handed out, and the card analytics screen
-- reads it.

-- ---------------------------------------------------------------------------
-- bank_card_prefixes — which bank issued a card number
-- ---------------------------------------------------------------------------
-- The first 6 digits of an Iranian card are its IIN and name the issuer.
-- Nothing in this codebase knew that until now: `financial_accounts.bank_name`
-- is free text a human types, and the only other source of a bank name is the
-- header of an SMS.
--
-- Longest matching prefix wins, so a bank that splits a range later needs only
-- a longer row added — no code change, which is the point of the table.
--
-- `bank_name` uses the same uppercase slugs the SMS parsers already emit in
-- `evidence.bank` (SAMAN, MELLI, SHAHR, GARDESHGARI, PARSIAN). Two systems
-- naming the same bank two ways is how the 4 unmerged card rows in 0004
-- happened.
CREATE TABLE bank_card_prefixes (
  prefix     text PRIMARY KEY CHECK (prefix ~ '^[0-9]{4,8}$'),
  bank_name  text   NOT NULL CHECK (length(bank_name) BETWEEN 1 AND 64),
  updated_at bigint NOT NULL,
  updated_by text
);

-- Starting list. It is a starting list on purpose — the dashboard is the
-- authority from here on, which is exactly what the admin asked for. Anchor
-- for the test that proves this is real data and not a self-consistent
-- fixture: 505416 is GARDESHGARI, and the healthy Gardeshgari cards in
-- production all read 5054161706… (see BUGS-FOR-ADMIN.md item 4).
INSERT INTO bank_card_prefixes (prefix, bank_name, updated_at, updated_by) VALUES
  ('603799', 'MELLI',            0, 'migration:0007'),
  ('589210', 'SEPAH',            0, 'migration:0007'),
  ('627648', 'TOSEE_SADERAT',    0, 'migration:0007'),
  ('207177', 'TOSEE_SADERAT',    0, 'migration:0007'),
  ('627961', 'SANAT_MADAN',      0, 'migration:0007'),
  ('603770', 'KESHAVARZI',       0, 'migration:0007'),
  ('639217', 'KESHAVARZI',       0, 'migration:0007'),
  ('628023', 'MASKAN',           0, 'migration:0007'),
  ('627760', 'POST_BANK',        0, 'migration:0007'),
  ('502908', 'TOSEE_TAAVON',     0, 'migration:0007'),
  ('627412', 'EGHTESAD_NOVIN',   0, 'migration:0007'),
  ('622106', 'PARSIAN',          0, 'migration:0007'),
  ('639194', 'PARSIAN',          0, 'migration:0007'),
  ('627884', 'PARSIAN',          0, 'migration:0007'),
  ('502229', 'PASARGAD',         0, 'migration:0007'),
  ('639347', 'PASARGAD',         0, 'migration:0007'),
  ('627488', 'KARAFARIN',        0, 'migration:0007'),
  ('502910', 'KARAFARIN',        0, 'migration:0007'),
  ('621986', 'SAMAN',            0, 'migration:0007'),
  ('639346', 'SINA',             0, 'migration:0007'),
  ('639607', 'SARMAYEH',         0, 'migration:0007'),
  ('502806', 'SHAHR',            0, 'migration:0007'),
  ('504706', 'SHAHR',            0, 'migration:0007'),
  ('502938', 'DEY',              0, 'migration:0007'),
  ('603769', 'SADERAT',          0, 'migration:0007'),
  ('610433', 'MELLAT',           0, 'migration:0007'),
  ('991975', 'MELLAT',           0, 'migration:0007'),
  ('627353', 'TEJARAT',          0, 'migration:0007'),
  ('585983', 'TEJARAT',          0, 'migration:0007'),
  ('589463', 'REFAH',            0, 'migration:0007'),
  ('627381', 'ANSAR',            0, 'migration:0007'),
  ('639370', 'MEHR_EGHTESAD',    0, 'migration:0007'),
  ('505801', 'KOSAR',            0, 'migration:0007'),
  ('606373', 'MEHR_IRAN',        0, 'migration:0007'),
  ('628157', 'TOSEE',            0, 'migration:0007'),
  ('606256', 'MELAL',            0, 'migration:0007'),
  ('504172', 'RESALAT',          0, 'migration:0007'),
  ('505416', 'GARDESHGARI',      0, 'migration:0007'),
  ('636214', 'AYANDEH',          0, 'migration:0007'),
  ('636949', 'HEKMAT_IRANIAN',   0, 'migration:0007'),
  ('505785', 'IRAN_ZAMIN',       0, 'migration:0007'),
  ('507677', 'NOOR',             0, 'migration:0007'),
  ('636795', 'MARKAZI',          0, 'migration:0007'),
  ('639599', 'GHAVAMIN',         0, 'migration:0007');

-- ---------------------------------------------------------------------------
-- bank_sms_patterns — operator-editable bank detection, fallback only
-- ---------------------------------------------------------------------------
-- The parser registry is an ORDERED chain of 14 hand-written parsers with 135
-- tests and documented precedence between them. Letting an operator's regex
-- into that order would put every one of those green paths at the mercy of a
-- text box.
--
-- So a row here can only run where the built-in chain produced NO bank —
-- `evidence.bank` absent or 'UNKNOWN'. That is precisely the failure the admin
-- described: a bank changes its wording, the named parser's `supports()` stops
-- matching, the SMS falls through to a generic parser, and the bank identity is
-- lost. A row here restores it, and cannot take anything away, because it never
-- sees an SMS a named parser already claimed.
--
-- ponytail: fallback only, no override. Overriding a built-in safely needs a
-- shadow run against real bodies before enabling, and raw SMS bodies are not
-- stored. If a built-in itself goes wrong, that is a code change — which is
-- the right answer for something carrying 135 tests.
--
-- No date/time column. The bank timestamp falls back to the SMS timestamp with
-- a warning, same as every built-in parser does when its date line fails.
-- Jalali parsing driven by an operator-supplied regex is not worth the surface.
CREATE TABLE bank_sms_patterns (
  id          text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  bank_name   text    NOT NULL CHECK (length(bank_name) BETWEEN 1 AND 64),
  enabled     boolean NOT NULL DEFAULT false,
  priority    int     NOT NULL DEFAULT 100,

  -- Claims the SMS. Tested against the whole normalized body.
  detect_re   text NOT NULL CHECK (length(detect_re) BETWEEN 1 AND 500),
  -- Capture group 1 is the amount digits, fed to the same parseIrr() every
  -- built-in parser uses.
  amount_re   text NOT NULL CHECK (length(amount_re) BETWEEN 1 AND 500),
  -- Money is integer IRR everywhere in this system. A bank that reports Toman
  -- must say so here, or its transactions land at a tenth of their value and
  -- never match a claim.
  amount_unit text NOT NULL DEFAULT 'IRR' CHECK (amount_unit IN ('IRR', 'TOMAN')),
  direction   text NOT NULL DEFAULT 'CREDIT' CHECK (direction IN ('CREDIT', 'DEBIT')),

  balance_re  text CHECK (balance_re IS NULL OR length(balance_re) BETWEEN 1 AND 500),
  account_re  text CHECK (account_re IS NULL OR length(account_re) BETWEEN 1 AND 500),

  notes       text,
  updated_at  bigint NOT NULL,
  updated_by  text
);

-- The compiled set is rebuilt from the enabled rows; nothing reads a disabled
-- row at runtime.
CREATE INDEX idx_bank_sms_patterns_enabled
  ON bank_sms_patterns(priority, id) WHERE enabled;

COMMIT;
