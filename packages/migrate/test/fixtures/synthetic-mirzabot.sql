-- A synthetic Mirzabot database, for CI.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THIS IS NOT
--
-- It is not the production dump, not a subset of it, and not a transform of
-- it. Nothing here was copied from `mirzabot-prod-20260811.sql`. Every row was
-- written by hand from the column shapes the migration reads and the closed
-- value sets `packages/migrate/src/transform.ts` declares.
--
-- No real name, phone number, Telegram id, card number, message, panel
-- address or credential appears. Telegram ids start at 9 000 000 000 000, far
-- above anything Telegram issues, so a synthetic id cannot collide with a real
-- customer even by accident. Card numbers are Luhn-valid but drawn from the
-- 0000-prefix range no Iranian issuer uses. Usernames are `fixture-*`.
--
-- They were NEGATIVE until 2026-09-05, for the same non-collision reason, and
-- that made this fixture unmigratable: `transform.ts` refuses a negative id as
-- «not a numeric Telegram id», which is correct and is why no test ever ran the
-- migration against this file. Issue #64 - a missing `category_id` that killed
-- every real import on the first product - lived through weeks of green CI in
-- that gap. A high positive id keeps the guarantee and lets the migration run.

--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY IT EXISTS
--
-- Ten `*.mysql.test.ts` files skipped at module load in CI because the dump
-- they need is git-ignored — correctly git-ignored: it is real customer money
-- and Telegram ids. A migration gate whose migration tests never run is not a
-- gate.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT IT CAN AND CANNOT PROVE, STATED PLAINLY
--
-- This fixture proves the migration TOOLING: that preflight connects, reads
-- every table it names, maps every closed set, finds the duplicates and the
-- Luhn failures it is supposed to find, and totals money correctly.
--
-- It does NOT replace the ten dump-gated tests, and those are deliberately
-- left as they are. They assert things like «31 expired discount codes» and
-- «963 customers who never accepted the rules» — statements about the ACTUAL
-- dataset that is going to be migrated. Rewriting `.toBe(31)` to `.toBe(2)`
-- so it would pass here would convert a data-migration acceptance check into
-- a test that asserts a fixture contains what the fixture contains.
--
-- So there are two gates, and they answer different questions:
--
--   this fixture      does the importer work?          runs in CI, every PR
--   the real dump     is THIS data safe to migrate?    runs on Sam's machine,
--                                                      before cutover
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE EDGE CASES, AND WHICH BUG EACH ONE IS FOR
--
--   tinyint(1) flags        mysql2 returns a NUMBER, not a string. `migrate.ts`
--                           once read `r.roll_Status !== '0'`, which is `true`
--                           for the number 0, so every customer who had not
--                           accepted the rules migrated in as having accepted
--                           them. Both values of both flags are present.
--
--   utf8mb4_bin enums       MySQL's default collation is case-insensitive, so
--                           a lowercase `active` hid among `ACTIVE` until
--                           preflight compared with `COLLATE utf8mb4_bin`.
--                           `card_assignment_leases` carries one of each.
--
--   a negative balance      Production holds one. `schema-design.md:64` says it
--                           migrates unchanged rather than being cleaned, so
--                           the fixture has one too — and the money total below
--                           is computed WITH it.
--
--   a Luhn-invalid card     Preflight must report it rather than import it.
--
--   a duplicate referral    `users.referral_code` is UNIQUE in the new schema.
--                           Two rows share one here so preflight has something
--                           to refuse.
--
--   a gift code worth 0     `Discount.price` of '' / '0' / NULL credits
--                           nothing; preflight warns per row.
--
--   an orphan payment       `Payment_report` row whose `id_user` has no `user`.
--                           Carried over with the telegram id preserved.
--
--   money, exactly          Toman in the source, ×10 into IRR. The totals are
--                           written at the bottom so a reader can check the
--                           arithmetic without running anything.
--
--   a Location with many    Issue #71. Seven `product` rows over three
--   prices                  Locations, all sharing ONE `inbounds`/`proxies`
--                           pair, is the real dump's shape: one delivery
--                           definition, many prices. The importer used to map
--                           each row to a service AND a plan, which flattened
--                           the middle layer away.
--
--   two gates on one        `fixture panel B` holds a free trial
--   Location                (`one_buy_status`) beside a resellers-only tier.
--                           `once_per_user` and `resellers_only` are columns
--                           of `products`, so those two rows cannot share one
--                           service without widening somebody's gate.
--
--   a discount scoped to    `FXSELL40` and `FXSELL50` name `code_product`s
--   a non-head row          that are not the first row of their Location.
--                           They must still reach their Location's service.

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------------
-- Customers
--
-- `Balance` is a string column in the legacy schema (varchar), which is why
-- preflight CASTs it. `roll_Status` and `get_gift` are tinyint(1) — the types
-- that produced the 963-customer bug.
-- ---------------------------------------------------------------------------
-- The sixteen columns `migrateUsers` claims, not the six `preflight` reads.
--
-- This table modelled only what the preflight report needed, because until
-- 2026-09-05 nothing ran the migration itself against this fixture. The rest
-- are here so it can: a missing column reaches `transform.ts` as `undefined`
-- and is refused by name, which is correct and is exactly how far the first
-- attempt got.
CREATE TABLE `user` (
  `id`                   bigint       NOT NULL,
  `username`             varchar(64)  DEFAULT NULL,
  `number`               varchar(32)  DEFAULT NULL,
  `verify`               varchar(4)   DEFAULT '0',
  `lang`                 varchar(4)   DEFAULT 'fa',
  `User_Status`          varchar(16)  DEFAULT 'active',
  `description_blocking` text,
  `Balance`              varchar(32)  DEFAULT '0',
  `codeInvitation`       varchar(32)  DEFAULT NULL,
  `register`             varchar(32)  DEFAULT NULL,
  `limit_usertest`       int          DEFAULT 0,
  `score`                int          DEFAULT 0,
  `pricediscount`        varchar(16)  DEFAULT NULL,
  `roll_Status`          tinyint(1)   DEFAULT 0,
  -- The reseller tier, and it is TEXT: `transform.ts` reads 'f', 'n' and 'n2'
  -- (index.php:299) and refuses anything else by name rather than defaulting.
  -- It was `tinyint(1)` here, which modelled a column this shop never had.
  `agent`                varchar(4)   DEFAULT 'f',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `user`
  (`id`, `username`, `number`, `verify`, `lang`, `User_Status`,
   `description_blocking`, `Balance`, `codeInvitation`, `register`,
   `limit_usertest`, `score`, `pricediscount`, `roll_Status`, `agent`) VALUES
  (9000000000001, 'fixture-alpha',   '09120000001', '1', 'fa', 'active',
   NULL, '1500000', 'FIXREF01', '1783966400', 0, 10, NULL, 1, 'f'),
  (9000000000002, 'fixture-beta',    NULL,          '0', 'en', 'active',
   NULL,  '250000', 'FIXREF02', '1783966400', 1,  0, NULL, 0, 'f'),
  -- The negative balance. Migrated as-is; see the header.
  (9000000000003, 'fixture-gamma',   '09120000003', '1', 'fa', 'active',
   NULL, '-940000', 'FIXREF03', '1783966400', 0,  0, '15', 1, 'n'),
  -- Blocked, with the reason the shop typed. `User_Status` is a closed set and
  -- an unmapped value is refused, so both members of it appear here.
  (9000000000004, 'fixture-delta',   NULL,          '0', 'fa', 'block',
   'fixture: blocked by hand', '0', 'FIXREF04', '1783966400', 0, 0, NULL, 0, 'f'),
  -- Duplicate referral code, so preflight has a uniqueness violation to find.
  (9000000000005, 'fixture-epsilon', NULL,          '0', 'fa', 'active',
   NULL,  '310000', 'FIXREF01', '1783966400', 0,  0, NULL, 1, 'n2');

-- SUM(Balance) = 1500000 + 250000 - 940000 + 0 + 310000 = 1,120,000 Toman
--              = 11,200,000 IRR

-- ---------------------------------------------------------------------------
-- Panels
--
-- `type` and `version_panel` are both closed sets. A value outside them must
-- stop the migration and name itself rather than become a `kind` that speaks
-- a different protocol.
-- ---------------------------------------------------------------------------
CREATE TABLE `marzban_panel` (
  `id`            int          NOT NULL,
  `name_panel`    varchar(64)  DEFAULT NULL,
  `code_panel`    varchar(32)  DEFAULT NULL,
  `type`          varchar(32)  DEFAULT 'marzban',
  `version_panel` varchar(8)   DEFAULT '0',
  `url_panel`     varchar(255) DEFAULT NULL,
  `status`        varchar(16)  DEFAULT 'active',
  `limit_panel`   varchar(16)  DEFAULT 'unlimited',
  `inbounds`      text,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `marzban_panel` (`id`, `name_panel`, `code_panel`, `type`, `version_panel`, `url_panel`, `status`, `limit_panel`, `inbounds`) VALUES
  (1, 'fixture panel A', 'fx01', 'marzban',    '0', 'https://panel-a.invalid', 'active',   'unlimited', '[1,2]'),
  -- version_panel '1' is PasarGuard, per transform.ts:269.
  (2, 'fixture panel B', 'fx02', 'marzban',    '1', 'https://panel-b.invalid', 'active',   '50',        '[3]'),
  (3, 'fixture panel C', 'fx03', 'marzneshin', '0', 'https://panel-c.invalid', 'disabled', 'unlimited', '[]'),
  (4, 'fixture panel D', 'fx04', 'hiddify',    '0', 'https://panel-d.invalid', 'active',   'unlimited', NULL),
  -- A panel whose name is Persian with emoji at both ends, which is what
  -- production's `name_panel` actually looks like. `product.Location` holds
  -- this string verbatim and it becomes a service NAME, so it is the fixture's
  -- only check that the text survives MySQL -> Node -> Postgres intact.
  (5, '🥇 لوکیشن طلایی 🎯', 'fx05', 'marzban', '0', 'https://panel-e.invalid', 'active', 'unlimited', '[4]');

-- ---------------------------------------------------------------------------
-- Catalogue
--
-- The columns are `legacy/faoxima/table.php`'s `CREATE TABLE product`, not a
-- guess: `Location`, `Service_time`, `Volume_constraint`, `note`, `inbounds`
-- and `proxies` are what `migrate.ts` reads, and until 2026-09-09 this fixture
-- declared `code_panel`, `volume_product` and `time_product` instead — three
-- columns the real table does not have. Every fixture product therefore
-- migrated with NO provider, NO duration and NO volume, and the file that
-- exists to prove the importer works could not see it.
--
-- `one_buy_status` is VARCHAR(20) there too, not `tinyint(1)`. That matters:
-- `migrate.ts` reads it as `=== '1'`, which a tinyint would silently answer
-- `false` for — the 963-customer bug of `roll_Status`, one column over.
--
-- WHAT THE ROWS ARE SHAPED TO PROVE (issue #71). On four real dumps
-- `SELECT COUNT(DISTINCT MD5(CONCAT(inbounds,'|',proxies))) FROM product` is
-- 1: every row shares one delivery definition while a Location carries several
-- prices. So `inbounds`/`proxies` are identical on every row below, and the
-- rows under a Location differ only in price, volume and duration.
-- ---------------------------------------------------------------------------
CREATE TABLE `product` (
  `id`                int          NOT NULL,
  `code_product`      varchar(200) DEFAULT NULL,
  `name_product`      varchar(2000) DEFAULT NULL,
  `price_product`     varchar(2000) DEFAULT '0',
  `Volume_constraint` varchar(2000) DEFAULT NULL,
  -- The panel NAME, not its code — `index.php:1507` binds it against
  -- `marzban_panel.name_panel`, and `migrate.ts` refuses a value that matches
  -- no panel rather than importing a product nothing can deliver.
  `Location`          varchar(200) DEFAULT NULL,
  `Service_time`      varchar(200) DEFAULT NULL,
  -- Text, like `user`.`agent` and for the same reason: the migration reads the
  -- closed set 'f', 'n', 'n2' and refuses anything else by name.
  `agent`             varchar(100) DEFAULT 'f',
  `note`              TEXT         NULL,
  `one_buy_status`    varchar(20)  NOT NULL DEFAULT '0',
  `inbounds`          TEXT         NULL,
  `proxies`           TEXT         NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `product` (`id`, `code_product`, `name_product`, `price_product`, `Volume_constraint`, `Location`, `Service_time`, `agent`, `note`, `one_buy_status`, `inbounds`, `proxies`) VALUES
  -- Two prices on one Location, the price typed into the name because legacy
  -- has `statusshowprice=offshowprice` and nowhere else to put it. These are
  -- one service with two plans, and were two services before issue #71.
  (1, 'fxp01', '30 گیگ - یک‌ماهه',  '195000',  '30', 'fixture panel A', '30', 'f', NULL,            '0', '{"vmess":["inb-1"]}', '{"vmess":{}}'),
  (2, 'fxp02', '50 گیگ - یک‌ماهه',  '295000',  '50', 'fixture panel A', '30', 'f', 'یادداشت پلن ۲', '0', '{"vmess":["inb-1"]}', '{"vmess":{}}'),
  -- One Location, two different PURCHASE GATES: a free trial that may be taken
  -- once ever, and a resellers-only tier. They cannot be one service, because
  -- `once_per_user` and `resellers_only` are columns of `products` and the bot
  -- asks both before selling any plan underneath.
  (3, 'fxp03', 'تست رایگان',             '0',   '1', 'fixture panel B',  '1', 'f', NULL,            '1', '{"vmess":["inb-1"]}', '{"vmess":{}}'),
  (4, 'fxp04', 'نمایندگی',          '900000', '200', 'fixture panel B', '60', 'n', NULL,            '0', '{"vmess":["inb-1"]}', '{"vmess":{}}'),
  -- Three prices on the Persian/emoji Location: the ordinary production shape.
  (5, 'fxp05', '1ماهه-20گیگ-119.000ت', '119000',  '20', '🥇 لوکیشن طلایی 🎯', '30', 'f', NULL, '0', '{"vmess":["inb-1"]}', '{"vmess":{}}'),
  (6, 'fxp06', '2ماهه-40گیگ-219.000ت', '219000',  '40', '🥇 لوکیشن طلایی 🎯', '60', 'f', NULL, '0', '{"vmess":["inb-1"]}', '{"vmess":{}}'),
  (7, 'fxp07', '3ماهه-60گیگ-299.000ت', '299000',  '60', '🥇 لوکیشن طلایی 🎯', '90', 'f', NULL, '0', '{"vmess":["inb-1"]}', '{"vmess":{}}');

-- ---------------------------------------------------------------------------
-- Subscriptions. `Status` is a closed set with TWO spellings of disabled,
-- both of which production really contains (transform.ts:221).
-- ---------------------------------------------------------------------------
CREATE TABLE `invoice` (
  `id`         int          NOT NULL,
  `id_invoice` varchar(64)  DEFAULT NULL,
  `id_user`    bigint       DEFAULT NULL,
  `Status`     varchar(32)  DEFAULT 'active',
  `code_panel` varchar(32)  DEFAULT NULL,
  `username`   varchar(128) DEFAULT NULL,
  -- The panel NAME, not its code. Preflight joins it against
  -- `marzban_panel.name_panel`; a value with no match is a subscription whose
  -- panel was deleted, which migrates with a NULL provider_id and the name
  -- preserved.
  `Service_location` varchar(64) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `invoice` (`id`, `id_invoice`, `id_user`, `Status`, `code_panel`, `username`, `Service_location`) VALUES
  (1, 'FXINV0001', 9000000000001, 'active',         'fx01', 'fixture_sub_a', 'fixture panel A'),
  (2, 'FXINV0002', 9000000000002, 'unpaid',         'fx01', 'fixture_sub_b', 'fixture panel A'),
  (3, 'FXINV0003', 9000000000003, 'send_on_hold',   'fx02', 'fixture_sub_c', 'fixture panel B'),
  (4, 'FXINV0004', 9000000000004, 'disabled',       'fx01', 'fixture_sub_d', 'fixture panel A'),
  -- Not a typo on our side. Production has both, from a bug in the PHP.
  (5, 'FXINV0005', 9000000000005, 'disabledn',      'fx02', 'fixture_sub_e', 'fixture panel B'),
  -- A panel that no longer exists: migrates with provider_id NULL and the
  -- name kept, and preflight says so as a NOTICE.
  (6, 'FXINV0006', 9000000000001, 'disablebyadmin', 'fx01', 'fixture_sub_f', 'fixture panel GONE');

-- ---------------------------------------------------------------------------
-- Payments. Every `payment_Status` and every `Payment_Method` in the closed
-- sets appears at least once, so a map that lost an entry fails here rather
-- than on the night of the cutover.
--
-- Row 7 is the ORPHAN: `id_user` names a customer with no `user` row.
-- ---------------------------------------------------------------------------
CREATE TABLE `Payment_report` (
  `id`             int          NOT NULL,
  `id_order`       varchar(64)  DEFAULT NULL,
  `id_user`        bigint       DEFAULT NULL,
  `price`          varchar(32)  DEFAULT '0',
  `payment_Status` varchar(32)  DEFAULT 'Unpaid',
  `Payment_Method` varchar(64)  DEFAULT 'cart to cart',
  `time_pay`       varchar(32)  DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `Payment_report` (`id`, `id_order`, `id_user`, `price`, `payment_Status`, `Payment_Method`, `time_pay`) VALUES
  (1, 'FXORD0001', 9000000000001, '195000', 'paid',       'cart to cart',         '1783966057'),
  (2, 'FXORD0002', 9000000000002, '295000', 'Unpaid',     'cart to cart',         '1783966100'),
  (3, 'FXORD0003', 9000000000003, '900000', 'expire',     'arze digital offline', '1783966200'),
  (4, 'FXORD0004', 9000000000004, '150000', 'reject',     'plisio',               '1783966300'),
  (5, 'FXORD0005', 9000000000005, '500000', 'processing', 'Star Telegram',        '1783966400'),
  (6, 'FXORD0006', 9000000000001, '250000', 'waiting',    'add balance by admin', '1783966500'),
  (7, 'FXORD0007', 9000000000099, '120000', 'paid',       'low balance by admin', '1783966600');

-- SUM(price) = 195000+295000+900000+150000+500000+250000+120000
--            = 2,410,000 Toman = 24,100,000 IRR
-- paid only  = 195000 + 120000 = 315,000 Toman = 3,150,000 IRR

-- ---------------------------------------------------------------------------
-- Add-on orders. `type` is a closed set.
-- ---------------------------------------------------------------------------
CREATE TABLE `service_other` (
  `id`         int         NOT NULL,
  `id_user`    bigint      DEFAULT NULL,
  `type`       varchar(32) DEFAULT NULL,
  `price`      varchar(32) DEFAULT '0',
  `data_extra` text,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `service_other` (`id`, `id_user`, `type`, `price`, `data_extra`) VALUES
  (1, 9000000000001, 'extend_user',     '195000', '{}'),
  (2, 9000000000002, 'extra_user',       '50000', '{"volume_value": "10"}'),
  (3, 9000000000003, 'extra_time_user',  '30000', '{"time_value": "7"}'),
  (4, 9000000000004, 'transfertouser',       '0', '{}');

-- ---------------------------------------------------------------------------
-- Cards. One is deliberately Luhn-INVALID so preflight has something to
-- refuse; the rest are valid but in a 0000 range no issuer uses.
-- ---------------------------------------------------------------------------
CREATE TABLE `card_number` (
  `id`         int          NOT NULL,
  `cardnumber` varchar(32)  DEFAULT NULL,
  `namecard`   varchar(128) DEFAULT NULL,
  `status`     varchar(16)  DEFAULT 'active',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `card_number` (`id`, `cardnumber`, `namecard`, `status`) VALUES
  (1, '0000000000000000', 'FIXTURE HOLDER ONE', 'active'),
  (2, '0000000000000018', 'FIXTURE HOLDER TWO', 'active'),
  -- Luhn-invalid on purpose. Preflight must name it.
  (3, '0000000000000001', 'FIXTURE HOLDER BAD', 'active');

-- ---------------------------------------------------------------------------
-- Card leases. `status` is compared with utf8mb4_bin, so the lowercase row is
-- the case the default collation used to hide.
-- ---------------------------------------------------------------------------
CREATE TABLE `card_assignment_leases` (
  `id`               int         NOT NULL,
  `telegram_user_id` bigint      DEFAULT NULL,
  `card_number`      varchar(32) DEFAULT NULL,
  `status`           varchar(16) DEFAULT 'ACTIVE',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `card_assignment_leases` (`id`, `telegram_user_id`, `card_number`, `status`) VALUES
  (1, 9000000000001, '0000000000000000', 'ACTIVE'),
  (2, 9000000000002, '0000000000000018', 'COMPLETED'),
  (3, 9000000000003, '0000000000000000', 'EXPIRED'),
  (4, 9000000000004, '0000000000000018', 'CANCELLED'),
  -- References a card that is not in `card_number`: preflight reports it as a
  -- NOTICE, because `card_number` there is denormalised text by design.
  (5, 9000000000005, '0000000000009999', 'COMPLETED');

-- ---------------------------------------------------------------------------
-- Discounts. `Discount` is gift codes, `DiscountSell` is sale codes.
-- Three rows credit nothing — NULL, empty and '0' — one of each.
-- ---------------------------------------------------------------------------
CREATE TABLE `Discount` (
  `id`    int          NOT NULL,
  `code`  varchar(64)  DEFAULT NULL,
  `price` varchar(32)  DEFAULT NULL,
  `count` varchar(16)  DEFAULT NULL,
  `time`  varchar(32)  DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `Discount` (`id`, `code`, `price`, `count`, `time`) VALUES
  (1, 'FXGIFT100', '100000', '5',  '1783966057'),
  (2, 'FXGIFT200', '200000', '10', NULL),
  (3, 'FXGIFTNUL', NULL,     '1',  NULL),
  (4, 'FXGIFTEMP', '',       '1',  NULL),
  (5, 'FXGIFTZER', '0',      '1',  NULL);

-- The columns are `legacy/faoxima/table.php`'s `CREATE TABLE DiscountSell`.
-- This declared `percent` and `count` until 2026-09-09, and the real table has
-- neither: the percentage lives in `price` (`index.php:1795` does
-- `(price / 100) * price_product`) and the cap in `limitDiscount`. With the
-- invented names every row read a percentage of `undefined`, so all four were
-- skipped as «percentage outside 0-100» and the scope mapping this file is
-- meant to exercise was never reached.
CREATE TABLE `DiscountSell` (
  `id`            int          NOT NULL,
  -- `codeDiscount`, not `code`. The two discount tables name the same concept
  -- differently, which is why preflight compares them with an explicit UNION
  -- rather than a join on a shared column name.
  `codeDiscount`  varchar(1000) DEFAULT NULL,
  -- The PERCENTAGE, despite the name it shares with `Discount.price` (Toman).
  `price`         varchar(200) DEFAULT NULL,
  `limitDiscount` varchar(500) DEFAULT NULL,
  `agent`         varchar(500) DEFAULT NULL,
  `usefirst`      varchar(100) DEFAULT NULL,
  `useuser`       varchar(100) DEFAULT NULL,
  `code_product`  varchar(100) DEFAULT 'all',
  `code_panel`    varchar(100) DEFAULT '/all',
  `time`          varchar(100) DEFAULT NULL,
  `type`          varchar(100) DEFAULT NULL,
  `usedDiscount`  varchar(500) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `DiscountSell` (`id`, `codeDiscount`, `price`, `limitDiscount`, `agent`, `usefirst`, `useuser`, `code_product`, `code_panel`, `time`, `type`, `usedDiscount`) VALUES
  -- `type` NULL matches neither the buy SELECT nor the renew one, so this code
  -- applies to nothing in the live bot and must not start applying to
  -- everything in ours: the importer drops it.
  (1, 'FXSELL10', '10', '100', 'f', '0', '0', 'all',   '/all', '1783966057', NULL,     '0'),
  -- Expired: a timestamp in the past. Imported, with the date kept.
  (2, 'FXSELL20', '20', '50',  'f', '1', '0', 'all',   '/all', '1600000000', 'buy',    '3'),
  -- Scoped to the row that HEADS its Location's group. Resolves the same way
  -- before and after issue #71, so on its own it proves nothing.
  (3, 'FXSELL30', '30', '10',  'n', '0', '0', 'fxp01', 'fx01', NULL,         'extend', '1'),
  -- Scoped to a row that does NOT head its group: `fxp02` and `fxp07` are the
  -- second and third rows of their Locations. `products.code` only ever holds
  -- the head's code, so a lookup on that alone drops both as «scoped to a
  -- product that is gone» — a live discount deleted by a catalogue reshape.
  -- Both must land on the SAME service as their group head.
  (4, 'FXSELL40', '40', '5',   'f', '0', '0', 'fxp02', '/all', NULL,         'buy',    '0'),
  (5, 'FXSELL50', '15', '25',  'f', '0', '0', 'fxp07', 'fx05', NULL,         'all',    '2');

CREATE TABLE `Giftcodeconsumed` (
  `id`      int         NOT NULL,
  `id_user` bigint      DEFAULT NULL,
  `code`    varchar(64) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `Giftcodeconsumed` (`id`, `id_user`, `code`) VALUES
  (1, 9000000000001, 'FXGIFT100'),
  (2, 9000000000002, 'FXGIFT200');

-- ---------------------------------------------------------------------------
-- Referrals. `get_gift` is the second tinyint(1) of the pair.
-- ---------------------------------------------------------------------------
CREATE TABLE `reagent_report` (
  `id`        int        NOT NULL,
  `id_user`   bigint     DEFAULT NULL,
  `id_friend` bigint     DEFAULT NULL,
  `get_gift`  tinyint(1) DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `reagent_report` (`id`, `id_user`, `id_friend`, `get_gift`) VALUES
  (1, 9000000000001, 9000000000002, 1),
  (2, 9000000000001, 9000000000004, 0),
  (3, 9000000000003, 9000000000005, 0);

-- ---------------------------------------------------------------------------
-- Reseller applications
-- ---------------------------------------------------------------------------
CREATE TABLE `Requestagent` (
  `id`      int         NOT NULL,
  `id_user` bigint      DEFAULT NULL,
  `status`  varchar(16) DEFAULT 'pending',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `Requestagent` (`id`, `id_user`, `status`) VALUES
  (1, 9000000000002, 'pending'),
  (2, 9000000000003, 'accept');

-- ---------------------------------------------------------------------------
-- Revenue adjustments. The legacy word is `deduct`, not `subtract` —
-- `revenue-adjustments.mysql.test.ts` exists because `subtract` was dead code.
-- ---------------------------------------------------------------------------
CREATE TABLE `revenue_adjustment_log` (
  `id`     int         NOT NULL,
  `amount` varchar(32) DEFAULT '0',
  `type`   varchar(16) DEFAULT 'add',
  `reason` text,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `revenue_adjustment_log` (`id`, `amount`, `type`, `reason`) VALUES
  (1, '50000', 'add',    'fixture: manual credit'),
  (2, '20000', 'deduct', 'fixture: correction');

-- SUM as applied = +50000 - 20000 = 30,000 Toman = 300,000 IRR

-- ---------------------------------------------------------------------------
-- Settings. `setting` is one row of many columns in the legacy schema.
-- `PaySetting` carries the ceilings AND the gateway credentials that the
-- importer must filter out — `settings.mysql.test.ts` is about that filter.
-- ---------------------------------------------------------------------------
CREATE TABLE `setting` (
  `id`                  int         NOT NULL,
  `Bot_Status`          varchar(16) DEFAULT 'onbot',
  `rolleon`             varchar(16) DEFAULT 'onrolle',
  `Channel_Report`      varchar(64) DEFAULT NULL,
  `revenue_adjustment`  varchar(32) DEFAULT '0',
  `affiliatespercent`   varchar(16) DEFAULT '10',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `setting` (`id`, `Bot_Status`, `rolleon`, `Channel_Report`, `revenue_adjustment`, `affiliatespercent`) VALUES
  (1, 'onbot', 'onrolle', '-1000000000001', '30000', '10');

CREATE TABLE `shopSetting` (
  `id`          int         NOT NULL,
  `offstatus`   varchar(16) DEFAULT 'offstatusoff',
  `offextra`    varchar(16) DEFAULT 'offextraoff',
  `offtimeextraa` varchar(16) DEFAULT 'offtimeextraaoff',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `shopSetting` (`id`, `offstatus`, `offextra`, `offtimeextraa`) VALUES
  (1, 'offstatuson', 'offextraoff', 'offtimeextraaoff');

CREATE TABLE `PaySetting` (
  `id`               int          NOT NULL,
  `maxbalancecart`   varchar(32)  DEFAULT NULL,
  `minbalancecart`   varchar(32)  DEFAULT NULL,
  -- Credential-shaped, and the importer must NOT carry it across. The value is
  -- obviously synthetic; the point is its SHAPE.
  `merchant_zarinpal` varchar(64) DEFAULT NULL,
  `apikey_plisio`     varchar(64) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `PaySetting` (`id`, `maxbalancecart`, `minbalancecart`, `merchant_zarinpal`, `apikey_plisio`) VALUES
  (1, '50000000', '10000', 'fixture-not-a-real-merchant-id', 'fixture-not-a-real-api-key');

-- ---------------------------------------------------------------------------
-- The remaining tables preflight counts. Small, but present — a table that is
-- missing and a table that is empty must not look the same to the inventory.
-- ---------------------------------------------------------------------------
CREATE TABLE `wheel_list` (
  `id` int NOT NULL, `id_user` bigint DEFAULT NULL, `prize` varchar(32) DEFAULT '0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO `wheel_list` VALUES (1, 9000000000001, '10000');

CREATE TABLE `support_message` (
  `id` int NOT NULL, `id_user` bigint DEFAULT NULL, `text` text, `departman` varchar(64) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO `support_message` VALUES (1, 9000000000002, 'fixture ticket body', 'fixture-dept');

CREATE TABLE `departman` (
  `id` int NOT NULL, `name` varchar(64) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO `departman` VALUES (1, 'fixture-dept');

CREATE TABLE `help` (
  `id` int NOT NULL, `name` varchar(64) DEFAULT NULL, `text` text,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO `help` VALUES (1, 'fixture help', 'fixture help body');

CREATE TABLE `app` (
  `id` int NOT NULL, `name` varchar(64) DEFAULT NULL, `link` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO `app` VALUES (1, 'fixture app', 'https://app.invalid');

CREATE TABLE `channels` (
  `id` int NOT NULL, `channel` varchar(64) DEFAULT NULL, `status` varchar(16) DEFAULT 'active',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO `channels` VALUES (1, '@fixture_channel', 'active');

CREATE TABLE `admin` (
  `id` int NOT NULL, `id_admin` bigint DEFAULT NULL, `username` varchar(64) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO `admin` VALUES (1, 9000000000001, 'fixture-admin');

SET FOREIGN_KEY_CHECKS = 1;

-- ═══════════════════════════════════════════════════════════════════════════
-- THE ARITHMETIC, written out so it can be checked without running anything
--
--   wallet balances     1,120,000 Toman  →  11,200,000 IRR
--   all payments        2,410,000 Toman  →  24,100,000 IRR
--   paid payments         315,000 Toman  →   3,150,000 IRR
--   revenue adjustment     30,000 Toman  →     300,000 IRR
--
-- `synthetic-migration.test.ts` asserts each of these against what preflight
-- reports, so a change to the ×10 conversion, to the CAST, or to which rows
-- count as paid fails there rather than on the night of the cutover.
-- ═══════════════════════════════════════════════════════════════════════════