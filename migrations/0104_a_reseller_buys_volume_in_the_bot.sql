-- 0104 — a reseller buys volume, and a new panel, from the bot (#474).
--
-- Sam, 2026-09-26: a reseller opens «🏢 پنل نمایندگی» in the bot and buys
-- terabytes for their own PasarGuard admin account, priced by tier, paid
-- card-to-card into accounts kept for resellers alone. A reseller approved but
-- without a panel yet buys the first volume and the bot creates the admin under
-- the username the operator chose. `reseller_accounts` (0060) already is the
-- franchise; this is what lets it be sold to.
--
-- ## 1. The order kind, and the two columns it needs
--
-- `RESELLER_VOLUME` rather than `ADD_VOLUME` with a reseller id beside it.
-- `ADD_VOLUME` is gigabytes on a CUSTOMER's subscription: `deliver()` routes it
-- to `renew()` against `target_subscription_id`, the referral, the reports and
-- the claim's purchase type all read it that way, and a reseller order under
-- that name would be mis-filed by every one of them in silence.
--
-- `quantity` is terabytes and `unit_price_irr` the tier's price for one, so the
-- existing `total = unit × quantity − discount` check verifies the invoice.
--
-- `target_reseller_id` names the franchise; RESTRICT, because an order is
-- money and must keep saying whose volume it bought.
--
-- `reseller_target_limit_bytes` is the reseller's total after THIS order's
-- terabytes were added to our ledger (`reseller_accounts.data_limit_bytes`).
-- NULL until the delivery sweep applies it, and applied once: the sweep stamps
-- it in the same transaction that raises the ledger, guarded on the column
-- still being NULL. The panel is then told the ledger's CURRENT total, never
-- this number, so a retry — or an older order retried after a newer one
-- landed — can never lower the panel's limit. `fail()` gives the terabytes
-- back and clears the stamp in one transaction, so a retried failure applies
-- them afresh.
--
-- The shape CHECK is `orders_trial_is_free`'s idea (0045) for this kind: it
-- names its reseller and its panel, and it is not a plan and not a service.
--
-- ## 2. A reseller who does not have a panel yet
--
-- `PENDING`: the operator has chosen the username, the panel admin does not
-- exist, and the first paid order creates it. The meter reads only `ACTIVE`
-- rows (`resellerMeter.ts`), so a PENDING row is never «missing» from a panel
-- it was never on.
--
-- `idx_reseller_accounts_user`: the bot asks «does this person own a reseller
-- account» on every Telegram update, to draw the button, and 0060 gave the
-- table no index on `user_id`.
--
-- ## 3. Cards kept for resellers
--
-- `customer_visible` (0090) becomes the account's AUDIENCE:
--
--   0 — books only: ingest, matching and sums, and no invoice shows its cards
--   1 — customers: the shop's ordinary invoices
--   2 — resellers: reseller invoices, and nothing else
--
-- One column rather than a second switch beside it, and the reason is the
-- rollback. A `reseller_only` flag next to `customer_visible = 1` is invisible
-- to the picker that is running today (`payment.ts` asks `= 1`), so a revert
-- of the code would hand every reseller card to every customer. `2` is a value
-- that code has never matched. The income queue (`incomeEligibility.ts`) sets
-- aside `= 0` only, so a reseller's transfer still reaches «واریزی‌ها».
--
-- ## 4. The button
--
-- A shop that saved its main-menu layout does not get a new default button:
-- `readLayouts` replaces the shipped menu with the saved one rather than
-- merging (see the `tar` comment in `botKeyboard.ts`). So `rsp` is appended as
-- the saved layout's last row. It is drawn only for somebody who owns a
-- reseller account, and `buildMenu` closes the row up for everybody else, so
-- no customer's menu changes. A layout already at the row cap is left alone;
-- the editor's palette offers the button.
--
-- ## Undo
--
-- Additive except the three widened CHECKs. To reverse: delete the `rsp`
-- button row; `UPDATE financial_accounts SET customer_visible = 0 WHERE
-- customer_visible = 2` before narrowing its CHECK back to (0, 1); fail or
-- delete RESELLER_VOLUME orders and PENDING reseller rows before narrowing
-- theirs; drop the two columns, the shape CHECK and the two indexes.
BEGIN;

ALTER TABLE orders
  DROP CONSTRAINT orders_kind_check,
  ADD  CONSTRAINT orders_kind_check CHECK (kind IN (
    'NEW_PURCHASE','RENEWAL','ADD_VOLUME','ADD_TIME','WALLET_TOPUP','TRANSFER','TRIAL',
    'RESELLER_VOLUME'));

ALTER TABLE orders
  ADD COLUMN target_reseller_id bigint REFERENCES reseller_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN reseller_target_limit_bytes bigint CHECK (reseller_target_limit_bytes > 0);

ALTER TABLE orders
  ADD CONSTRAINT orders_reseller_volume_shape CHECK (
    (kind = 'RESELLER_VOLUME') = (target_reseller_id IS NOT NULL)
    AND (kind <> 'RESELLER_VOLUME'
         OR (provider_id IS NOT NULL AND plan_id IS NULL AND target_subscription_id IS NULL))
    AND (reseller_target_limit_bytes IS NULL OR kind = 'RESELLER_VOLUME'));

CREATE INDEX idx_orders_target_reseller
  ON orders (target_reseller_id) WHERE target_reseller_id IS NOT NULL;

COMMENT ON COLUMN orders.provider_id IS
  'The panel, when the order does not name one through a plan: set on TRIAL and on RESELLER_VOLUME (0104), NULL everywhere else.';
COMMENT ON COLUMN orders.target_reseller_id IS
  'RESELLER_VOLUME only: the franchise whose panel admin this order adds terabytes to (0104).';
COMMENT ON COLUMN orders.reseller_target_limit_bytes IS
  'RESELLER_VOLUME only: the reseller''s ledger total once this order''s terabytes were added. NULL until applied; cleared again if the order fails (0104).';

ALTER TABLE reseller_accounts
  DROP CONSTRAINT reseller_accounts_status_check,
  ADD  CONSTRAINT reseller_accounts_status_check
       CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSED'));

CREATE INDEX idx_reseller_accounts_user
  ON reseller_accounts (user_id) WHERE status <> 'CLOSED';

ALTER TABLE financial_accounts
  DROP CONSTRAINT financial_accounts_customer_visible_check,
  ADD  CONSTRAINT financial_accounts_customer_visible_check
       CHECK (customer_visible IN (0, 1, 2));
COMMENT ON COLUMN financial_accounts.customer_visible IS
  'Whose invoices show this account''s cards. 0: nobody — books only, ingest, matching and sums still run (0090). 1: customers. 2: resellers, and nobody else (0104).';

INSERT INTO bot_keyboard_buttons (menu, action, label, row_index, col_index, visible)
SELECT 'main', 'rsp', '🏢 پنل نمایندگی', MAX(row_index) + 1, 0, true
  FROM bot_keyboard_buttons
 WHERE menu = 'main'
HAVING count(*) > 0 AND MAX(row_index) < 19
ON CONFLICT (menu, action) DO NOTHING;

COMMIT;
