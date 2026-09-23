-- 0095 — the profit is divided, and each partner has a running account.
--
-- Sam, 1 Mehr 1405: «آخر ماه پویان بیاد بگه این ماه ۴۰ میلیون می‌خوام تقسیم کنم
-- به عنوان برداشت سود و به شرکا پول بدم. چجوری ثبت کنیم که توی حساب همه شریکا
-- بشینه؟» — and before it: a partner may already have been paid 5 million in
-- the middle of the month, and the split has to know.
--
-- Two different events, so two different records:
--
--   * the DECISION — «۴۰ میلیون از سود مهر تقسیم شود» — one row here, and one
--     share per partner below. It moves no money. It is what each partner is
--     now owed.
--   * the PAYMENT — money leaving an account for a partner — is the ledger's
--     PARTNER_DRAW (0092), exactly as before, whenever it happens: mid-month
--     or the day after the split.
--
-- A partner's balance is every share he was allotted minus every draw he took.
-- Positive: the shop still owes him. Negative: he took ahead of the profit, and
-- the next split pays it back. It carries from month to month by construction
-- — it is a sum, not a monthly figure.
--
-- There is no total column. The total is the sum of the shares, so there is no
-- second number that could disagree with them.
--
-- Nothing is deleted. A split typed by mistake is voided and stays, with who
-- voided it and when, like a ledger row.
BEGIN;

CREATE TABLE profit_distributions (
  id          bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  -- The period whose profit this divides, both days inclusive — «مهر ۱۴۰۵».
  from_day    date   NOT NULL,
  to_day      date   NOT NULL,
  -- The profit the screen showed for that period when the decision was made.
  -- A record of what was known, not a constraint: a split may leave some of
  -- the profit in the business, and a cost typed later moves the profit.
  profit_irr  bigint,
  note        text   NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  created_by  text   NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  voided_at   timestamptz,
  voided_by   text,
  CONSTRAINT profit_distributions_days CHECK (to_day >= from_day),
  CONSTRAINT profit_distributions_void_is_whole CHECK ((voided_at IS NULL) = (voided_by IS NULL))
);

CREATE TABLE profit_distribution_shares (
  distribution_id bigint NOT NULL REFERENCES profit_distributions(id) ON DELETE RESTRICT,
  party_id        bigint NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  -- The partner's percent at the time, so a later change of percents does not
  -- rewrite why this share was this size.
  share_percent   numeric(5,2),
  amount_irr      bigint NOT NULL CHECK (amount_irr > 0),
  PRIMARY KEY (distribution_id, party_id)
);

CREATE INDEX profit_distribution_shares_party ON profit_distribution_shares (party_id);

COMMIT;
