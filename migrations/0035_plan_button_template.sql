-- «۱ ماهه | ۱۰۰ گیگ | ۲۰۰,۰۰۰ تومان» — a plans screen written the shop's way.
--
-- The label on a plan button has always been the admin-typed `name` with the
-- price appended. A shop that wants the parts separated has had no way to ask
-- for it except by retyping every name, and the parts it wants — duration,
-- volume, users — are already columns on this table.
--
-- WHY A SETTINGS ROW AND NOT A COLUMN.
--
-- It is one sentence for the whole shop, not a property of a plan. A column on
-- `product_plans` would be the same string copied onto every row, and the day
-- somebody edited one of them the screen would draw two different layouts.
--
-- WHY THE ROW IS INSERTED EMPTY RATHER THAN LEFT ABSENT.
--
-- `POST /api/v1/admin/settings` refuses a key it has never seen — "the bot
-- reads a fixed set of keys and a new one would be a row nothing reads"
-- (settingsRoutes.ts:163). So a key with no row cannot be edited from the
-- panel at all. Inserting it empty is what makes it appear in the settings
-- list and what makes it editable, and empty means «not configured».
--
-- WHY EMPTY AND NOT A DEFAULT TEMPLATE.
--
-- Every product migrated from the PHP bot has its price typed into its name —
-- `money.ts:55` — so a default of «{name} — {price}» would put the number on
-- the button twice for all of them the moment this was applied. Empty renders
-- through the path that has always drawn these buttons. A shop opts in, or
-- nothing about its screens changes.
--
-- The allowed slots and the validation are in `packages/contracts/planLabel.ts`,
-- which the panel and the bot both read, so a template that saves is a template
-- that draws.

BEGIN;

INSERT INTO settings (scope, key, value)
     VALUES ('shop', 'plan_button_template', '""'::jsonb)
ON CONFLICT (scope, key) DO NOTHING;

COMMIT;
