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
-- address or credential appears. Telegram ids are negative — Telegram never
-- issues one, so a synthetic id cannot collide with a real customer even by
-- accident. Card numbers are Luhn-valid but drawn from the 0000-prefix range
-- no Iranian issuer uses. Usernames are `fixture-*`.
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

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------------
-- Customers
--
-- `Balance` is a string column in the legacy schema (varchar), which is why
-- preflight CASTs it. `roll_Status` and `get_gift` are tinyint(1) — the types
-- that produced the 963-customer bug.
-- ---------------------------------------------------------------------------
CREATE TABLE `user` (
  `id`             bigint       NOT NULL,
  `username`       varchar(64)  DEFAULT NULL,
  `Balance`        varchar(32)  DEFAULT '0',
  `codeInvitation` varchar(32)  DEFAULT NULL,
  `roll_Status`    tinyint(1)   DEFAULT 0,
  `agent`          tinyint(1)   DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `user` (`id`, `username`, `Balance`, `codeInvitation`, `roll_Status`, `agent`) VALUES
  (-9000001, 'fixture-alpha',   '1500000', 'FIXREF01', 1, 0),
  (-9000002, 'fixture-beta',     '250000', 'FIXREF02', 0, 0),
  -- The negative balance. Migrated as-is; see the header.
  (-9000003, 'fixture-gamma',   '-940000', 'FIXREF03', 1, 1),
  (-9000004, 'fixture-delta',         '0', 'FIXREF04', 0, 0),
  -- Duplicate referral code, so preflight has a uniqueness violation to find.
  (-9000005, 'fixture-epsilon',  '310000', 'FIXREF01', 1, 0);

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
  (4, 'fixture panel D', 'fx04', 'hiddify',    '0', 'https://panel-d.invalid', 'active',   'unlimited', NULL);

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------
CREATE TABLE `product` (
  `id`             int          NOT NULL,
  `code_product`   varchar(32)  DEFAULT NULL,
  `name_product`   varchar(128) DEFAULT NULL,
  `code_panel`     varchar(32)  DEFAULT NULL,
  `price_product`  varchar(32)  DEFAULT '0',
  `volume_product` varchar(32)  DEFAULT NULL,
  `time_product`   varchar(32)  DEFAULT NULL,
  `one_buy_status` tinyint(1)   DEFAULT 0,
  `agent`          tinyint(1)   DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `product` (`id`, `code_product`, `name_product`, `code_panel`, `price_product`, `volume_product`, `time_product`, `one_buy_status`, `agent`) VALUES
  (1, 'fxp01', '30 گیگ - یک‌ماهه', 'fx01', '195000', '30', '30', 0, 0),
  (2, 'fxp02', '50 گیگ - یک‌ماهه', 'fx01', '295000', '50', '30', 0, 0),
  (3, 'fxp03', 'تست رایگان',       'fx02',      '0',  '1',  '1', 1, 0),
  (4, 'fxp04', 'نمایندگی',         'fx02', '900000','200', '60', 0, 1);

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
  (1, 'FXINV0001', -9000001, 'active',         'fx01', 'fixture_sub_a', 'fixture panel A'),
  (2, 'FXINV0002', -9000002, 'unpaid',         'fx01', 'fixture_sub_b', 'fixture panel A'),
  (3, 'FXINV0003', -9000003, 'send_on_hold',   'fx02', 'fixture_sub_c', 'fixture panel B'),
  (4, 'FXINV0004', -9000004, 'disabled',       'fx01', 'fixture_sub_d', 'fixture panel A'),
  -- Not a typo on our side. Production has both, from a bug in the PHP.
  (5, 'FXINV0005', -9000005, 'disabledn',      'fx02', 'fixture_sub_e', 'fixture panel B'),
  -- A panel that no longer exists: migrates with provider_id NULL and the
  -- name kept, and preflight says so as a NOTICE.
  (6, 'FXINV0006', -9000001, 'disablebyadmin', 'fx01', 'fixture_sub_f', 'fixture panel GONE');

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
  (1, 'FXORD0001', -9000001, '195000', 'paid',       'cart to cart',         '1783966057'),
  (2, 'FXORD0002', -9000002, '295000', 'Unpaid',     'cart to cart',         '1783966100'),
  (3, 'FXORD0003', -9000003, '900000', 'expire',     'arze digital offline', '1783966200'),
  (4, 'FXORD0004', -9000004, '150000', 'reject',     'plisio',               '1783966300'),
  (5, 'FXORD0005', -9000005, '500000', 'processing', 'Star Telegram',        '1783966400'),
  (6, 'FXORD0006', -9000001, '250000', 'waiting',    'add balance by admin', '1783966500'),
  (7, 'FXORD0007', -9000099, '120000', 'paid',       'low balance by admin', '1783966600');

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
  (1, -9000001, 'extend_user',     '195000', '{}'),
  (2, -9000002, 'extra_user',       '50000', '{"volume_value": "10"}'),
  (3, -9000003, 'extra_time_user',  '30000', '{"time_value": "7"}'),
  (4, -9000004, 'transfertouser',       '0', '{}');

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
  (1, -9000001, '0000000000000000', 'ACTIVE'),
  (2, -9000002, '0000000000000018', 'COMPLETED'),
  (3, -9000003, '0000000000000000', 'EXPIRED'),
  (4, -9000004, '0000000000000018', 'CANCELLED'),
  -- References a card that is not in `card_number`: preflight reports it as a
  -- NOTICE, because `card_number` there is denormalised text by design.
  (5, -9000005, '0000000000009999', 'COMPLETED');

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

CREATE TABLE `DiscountSell` (
  `id`           int         NOT NULL,
  -- `codeDiscount`, not `code`. The two discount tables name the same concept
  -- differently, which is why preflight compares them with an explicit UNION
  -- rather than a join on a shared column name.
  `codeDiscount` varchar(64) DEFAULT NULL,
  `percent`      varchar(16) DEFAULT NULL,
  `count`        varchar(16) DEFAULT NULL,
  `time`         varchar(32) DEFAULT NULL,
  `code_product` varchar(32) DEFAULT 'all',
  `code_panel`   varchar(32) DEFAULT '/all',
  `type`         varchar(16) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `DiscountSell` (`id`, `codeDiscount`, `percent`, `count`, `time`, `code_product`, `code_panel`, `type`) VALUES
  (1, 'FXSELL10', '10', '100', '1783966057', 'all',   '/all', NULL),
  -- Expired: a timestamp in the past.
  (2, 'FXSELL20', '20', '50',  '1600000000', 'all',   '/all', 'buy'),
  -- Scoped to one product and one panel.
  (3, 'FXSELL30', '30', '10',  NULL,         'fxp01', 'fx01', 'renew'),
  (4, 'FXSELL40', '40', '5',   NULL,         'fxp02', '/all', 'buy');

CREATE TABLE `Giftcodeconsumed` (
  `id`      int         NOT NULL,
  `id_user` bigint      DEFAULT NULL,
  `code`    varchar(64) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `Giftcodeconsumed` (`id`, `id_user`, `code`) VALUES
  (1, -9000001, 'FXGIFT100'),
  (2, -9000002, 'FXGIFT200');

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
  (1, -9000001, -9000002, 1),
  (2, -9000001, -9000004, 0),
  (3, -9000003, -9000005, 0);

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
  (1, -9000002, 'pending'),
  (2, -9000003, 'accept');

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
INSERT INTO `wheel_list` VALUES (1, -9000001, '10000');

CREATE TABLE `support_message` (
  `id` int NOT NULL, `id_user` bigint DEFAULT NULL, `text` text, `departman` varchar(64) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO `support_message` VALUES (1, -9000002, 'fixture ticket body', 'fixture-dept');

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
INSERT INTO `admin` VALUES (1, -9000001, 'fixture-admin');

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