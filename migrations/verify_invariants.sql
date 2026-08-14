-- verify_invariants.sql — proves the guarantees the schema claims to make.
--
-- Run against a database with 0001-0005 applied and no data:
--   docker exec -i shikoo-sim-postgres-1 psql -U shikoo -d shikoo \
--     -v ON_ERROR_STOP=1 -q < migrations/verify_invariants.sql
--
-- Everything happens inside one transaction that is rolled back, so it is safe
-- to run against any environment, populated or empty. Any failure raises and
-- aborts.
--
-- Fixture ids are prefixed `__inv-` for exactly that reason: an earlier version
-- used 'dev-1', which collided with a row the adapter tests leave behind and
-- made the whole script abort before its first assertion.
--
-- These assertions are the reason for Postgres. If one of them stops holding,
-- the platform has lost a guarantee that no amount of application code
-- reliably replaces.

\pset tuples_only on
\pset format unaligned

BEGIN;

CREATE FUNCTION assert_rejects(sql text, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE sql;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'PASS  %', what;
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL  %  — the database ACCEPTED it', what;
END $$;

CREATE FUNCTION assert_eq(got numeric, want numeric, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF got IS DISTINCT FROM want THEN
    RAISE EXCEPTION 'FAIL  %  — got %, want %', what, got, want;
  END IF;
  RAISE NOTICE 'PASS  %  (= %)', what, got;
END $$;

-- --------------------------------------------------------------------------
-- fixtures
-- --------------------------------------------------------------------------
INSERT INTO users (telegram_id, username, registered_at)
     VALUES (900000001, '__inv-alice', now()), (900000002, '__inv-bob', now());

INSERT INTO devices (id, device_code, display_name, created_at, updated_at)
     VALUES ('__inv-dev', '__INV-D1', 'phone', 0, 0);
INSERT INTO financial_accounts (id, bank_name, display_name, account_type, created_at, updated_at)
     VALUES ('__inv-acct', 'melli', 'Melli', 'CARD', 0, 0);
INSERT INTO raw_sms_events (id, device_id, sender, body_sha256, app_checksum,
                            sms_timestamp, received_at, classification, parser_status, created_at)
     VALUES ('__inv-sms-1', '__inv-dev', '710', '__inv-h1', '__inv-c1', 1786000000000, 1786000000000,
             'BANK_CREDIT', 'OK', 0);
INSERT INTO transaction_candidates (id, raw_sms_event_id, direction, amount_irr, bank_timestamp,
                                    confidence, parser_id, parser_version, status, created_at, updated_at)
     VALUES ('__inv-tx-1', '__inv-sms-1', 'CREDIT', 1000000, 1786000000000, 1.0, 'p', 'v1', 'PARSED', 0, 0);
INSERT INTO payment_claims (id, external_order_id, expected_amount_irr, submitted_at,
                            source_system, status, created_at, updated_at)
     VALUES ('__inv-claim-1', '__inv-order-1', 1000000, 1786000000000, 'bot', 'PENDING', 0, 0),
            ('__inv-claim-2', '__inv-order-2', 1000000, 1786000000000, 'bot', 'PENDING', 0, 0);

-- ==========================================================================
-- 1. THE MONEY INVARIANT
-- ==========================================================================
INSERT INTO reconciliation_matches (id, transaction_candidate_id, payment_claim_id,
                                    score, status, created_at, updated_at)
     VALUES ('__inv-m-1', '__inv-tx-1', '__inv-claim-1', 1.0, 'CONFIRMED', 0, 0);

-- One bank transaction must not settle a second claim.
SELECT assert_rejects($$
  INSERT INTO reconciliation_matches (id, transaction_candidate_id, payment_claim_id,
                                      score, status, created_at, updated_at)
       VALUES ('__inv-m-2', '__inv-tx-1', '__inv-claim-2', 1.0, 'CONFIRMED', 0, 0)
$$, 'one transaction cannot verify a second claim');

-- ...not even under the other settling status.
SELECT assert_rejects($$
  INSERT INTO reconciliation_matches (id, transaction_candidate_id, payment_claim_id,
                                      score, status, created_at, updated_at)
       VALUES ('__inv-m-3', '__inv-tx-1', '__inv-claim-2', 1.0, 'AUTO_VERIFIED', 0, 0)
$$, 'CONFIRMED and AUTO_VERIFIED share one slot per transaction');

-- A claim must not be settled twice by two different transactions.
INSERT INTO raw_sms_events (id, device_id, sender, body_sha256, app_checksum,
                            sms_timestamp, received_at, classification, parser_status, created_at)
     VALUES ('__inv-sms-2', '__inv-dev', '710', '__inv-h2', '__inv-c1', 1786000000000, 1786000000000,
             'BANK_CREDIT', 'OK', 0);
INSERT INTO transaction_candidates (id, raw_sms_event_id, direction, amount_irr, bank_timestamp,
                                    confidence, parser_id, parser_version, status, created_at, updated_at)
     VALUES ('__inv-tx-2', '__inv-sms-2', 'CREDIT', 1000000, 1786000000000, 1.0, 'p', 'v1', 'PARSED', 0, 0);
SELECT assert_rejects($$
  INSERT INTO reconciliation_matches (id, transaction_candidate_id, payment_claim_id,
                                      score, status, created_at, updated_at)
       VALUES ('__inv-m-4', '__inv-tx-2', '__inv-claim-1', 1.0, 'CONFIRMED', 0, 0)
$$, 'one claim cannot be settled twice');

-- A rejected match does not consume the slot — a wrong guess must be retryable.
INSERT INTO reconciliation_matches (id, transaction_candidate_id, payment_claim_id,
                                    score, status, created_at, updated_at)
     VALUES ('__inv-m-5', '__inv-tx-2', '__inv-claim-2', 0.4, 'REJECTED', 0, 0);
-- Scoped to the fixtures: production data contains REJECTED matches too, and
-- this script must give the same answer on an empty and a populated database.
SELECT assert_eq((SELECT count(*) FROM reconciliation_matches
                   WHERE status = 'REJECTED' AND id LIKE '__inv-%'),
                 1, 'a REJECTED match does not occupy the settled slot');

-- ==========================================================================
-- 2. CARD LEASES — the guarantee MySQL had to fake with generated columns
-- ==========================================================================
INSERT INTO card_leases (telegram_user_id, order_public_id, card_number, assigned_at, expires_at)
     VALUES (900000001, '__inv-o-1', '9990000000000001', now(), now() + interval '30 min');

SELECT assert_rejects($$
  INSERT INTO card_leases (telegram_user_id, order_public_id, card_number, assigned_at, expires_at)
       VALUES (900000001, '__inv-o-2', '9990000000000002', now(), now() + interval '30 min')
$$, 'a user cannot hold two active card leases');

SELECT assert_rejects($$
  INSERT INTO card_leases (telegram_user_id, order_public_id, card_number, assigned_at, expires_at)
       VALUES (900000002, '__inv-o-3', '9990000000000001', now(), now() + interval '30 min')
$$, 'a card cannot be leased to two users at once');

-- Once released, both the user and the card are free again.
UPDATE card_leases SET status = 'COMPLETED', completed_at = now() WHERE order_public_id = '__inv-o-1';
INSERT INTO card_leases (telegram_user_id, order_public_id, card_number, assigned_at, expires_at)
     VALUES (900000002, '__inv-o-4', '9990000000000001', now(), now() + interval '30 min');
SELECT assert_eq((SELECT count(*) FROM card_leases WHERE order_public_id LIKE '__inv-%'), 2,
                 'a completed lease frees both the user and the card');

-- ==========================================================================
-- 3. WALLET — the balance is derived, never assigned
-- ==========================================================================
INSERT INTO wallet_entries (user_id, amount_irr, kind, idempotency_key)
     VALUES ((SELECT id FROM users WHERE telegram_id = 900000001),  5000000, 'TOPUP',    '__inv-k1'),
            ((SELECT id FROM users WHERE telegram_id = 900000001), -1500000, 'PURCHASE', '__inv-k2');

SELECT assert_eq((SELECT balance_irr FROM wallets w JOIN users u ON u.id = w.user_id
                   WHERE u.telegram_id = 900000001),
                 3500000, 'wallet balance follows its entries');

SELECT assert_eq((SELECT sum(amount_irr) FROM wallet_entries we JOIN users u ON u.id = we.user_id
                   WHERE u.telegram_id = 900000001),
                 (SELECT balance_irr FROM wallets w JOIN users u ON u.id = w.user_id
                   WHERE u.telegram_id = 900000001),
                 'balance equals the sum of entries');

-- A replayed webhook or a double-tapped button cannot credit twice.
SELECT assert_rejects($$
  INSERT INTO wallet_entries (user_id, amount_irr, kind, idempotency_key)
       VALUES ((SELECT id FROM users WHERE telegram_id = 900000001), 5000000, 'TOPUP', '__inv-k1')
$$, 'a replayed wallet entry is rejected by its idempotency key');

-- A zero-amount entry is a bug, not a no-op.
SELECT assert_rejects($$
  INSERT INTO wallet_entries (user_id, amount_irr, kind)
       VALUES ((SELECT id FROM users WHERE telegram_id = 900000001), 0, 'TOPUP')
$$, 'a zero-amount wallet entry is rejected');

-- A negative balance must be storable. Production has one (user 314985971, at
-- -5,940,000 Toman) with no history explaining it. Migration reproduces the
-- number exactly; a schema that refused it would force the migration to alter
-- money, which is the one thing it must never do. Correcting the balance is a
-- later, deliberate ledger entry with a named author.
INSERT INTO wallet_entries (user_id, amount_irr, kind, note)
     VALUES ((SELECT id FROM users WHERE telegram_id = 900000002), -59400000, 'OPENING',
             'legacy balance carried over as-is');
SELECT assert_eq((SELECT balance_irr FROM wallets w JOIN users u ON u.id = w.user_id
                   WHERE u.telegram_id = 900000002),
                 -59400000, 'a negative legacy balance survives migration unchanged');

-- ==========================================================================
-- 4. APPEND-ONLY LEDGERS
-- ==========================================================================
SELECT assert_rejects($$UPDATE wallet_entries SET amount_irr = 999 WHERE idempotency_key = '__inv-k1'$$,
                      'wallet history cannot be edited');
SELECT assert_rejects($$DELETE FROM wallet_entries WHERE idempotency_key = '__inv-k1'$$,
                      'wallet history cannot be deleted');

INSERT INTO audit_logs (id, actor_role, action, entity_type, entity_id, created_at)
     VALUES ('__inv-a-1', 'ADMIN', 'TEST', 'CLAIM', '__inv-claim-1', 0);
SELECT assert_rejects($$DELETE FROM audit_logs WHERE id = '__inv-a-1'$$,
                      'audit_logs cannot be deleted');

INSERT INTO activity_log (actor_type, action, entity_type, entity_id)
     VALUES ('SYSTEM', 'TEST', 'ORDER', '1');
SELECT assert_rejects($$UPDATE activity_log SET action = 'X'$$,
                      'activity_log cannot be rewritten');

-- ==========================================================================
-- 5. ORDER ARITHMETIC — the total cannot disagree with its parts
-- ==========================================================================
SELECT assert_rejects($$
  INSERT INTO orders (public_id, user_id, kind, quantity, unit_price_irr, discount_irr, total_irr)
       VALUES ('__inv-bad-1', (SELECT id FROM users WHERE telegram_id = 900000001),
               'NEW_PURCHASE', 2, 1000000, 0, 1000000)
$$, 'an order total that disagrees with quantity x price is rejected');

INSERT INTO orders (public_id, user_id, kind, quantity, unit_price_irr, discount_irr, total_irr)
     VALUES ('__inv-ok-1', (SELECT id FROM users WHERE telegram_id = 900000001),
             'NEW_PURCHASE', 2, 1000000, 200000, 1800000);
SELECT assert_eq((SELECT total_irr FROM orders WHERE public_id = '__inv-ok-1'), 1800000,
                 'a consistent order total is accepted');

-- ==========================================================================
-- 6. GIFT CODES — one redemption per user, enforced where it cannot be raced
-- ==========================================================================
INSERT INTO discount_codes (code, kind, amount_irr) VALUES ('__INV-GIFT10', 'GIFT_BALANCE', 100000);
INSERT INTO discount_redemptions (code_id, user_id)
     VALUES ((SELECT id FROM discount_codes WHERE code = '__INV-GIFT10'),
             (SELECT id FROM users WHERE telegram_id = 900000001));
SELECT assert_rejects($$
  INSERT INTO discount_redemptions (code_id, user_id)
       VALUES ((SELECT id FROM discount_codes WHERE code = '__INV-GIFT10'),
               (SELECT id FROM users WHERE telegram_id = 900000001))
$$, 'the same gift code cannot be redeemed twice by one user');

-- ==========================================================================
-- 7. THE CONFIG SHELF — one config to one order, and only once
-- ==========================================================================
-- The migrations create the catalog tables but put nothing in them, so this
-- section brings its own plan and provider. It used to reach for whatever
-- `ORDER BY id LIMIT 1` returned, which is a row that exists on a seeded
-- database and nowhere else.
INSERT INTO products (code, name, kind)
     VALUES ('__inv-product', 'invariant fixture', 'vpn');
INSERT INTO product_plans (product_id, name, price_irr)
     VALUES ((SELECT id FROM products WHERE code = '__inv-product'), '__inv-plan', 1800000);
INSERT INTO provisioning_providers (code, name, kind)
     VALUES ('__inv-provider', 'invariant fixture', 'pasarguard');

INSERT INTO provisioning_stock (plan_id, provider_id, remote_username, subscription_url)
     VALUES ((SELECT id FROM product_plans WHERE name = '__inv-plan'),
             (SELECT id FROM provisioning_providers WHERE code = '__inv-provider'),
             '__inv-stock-a', 'https://example.invalid/sub/a');
INSERT INTO provisioning_stock (plan_id, provider_id, remote_username, subscription_url)
     VALUES ((SELECT id FROM product_plans WHERE name = '__inv-plan'),
             (SELECT id FROM provisioning_providers WHERE code = '__inv-provider'),
             '__inv-stock-b', 'https://example.invalid/sub/b');

UPDATE provisioning_stock SET status = 'USED', order_id = (SELECT id FROM orders WHERE public_id = '__inv-ok-1')
 WHERE remote_username = '__inv-stock-a';

SELECT assert_rejects($$
  UPDATE provisioning_stock SET status = 'USED', order_id = (SELECT id FROM orders WHERE public_id = '__inv-ok-1')
   WHERE remote_username = '__inv-stock-b'
$$, 'one order cannot take a second config from the shelf');

SELECT assert_rejects($$
  UPDATE provisioning_stock SET status = 'USED' WHERE remote_username = '__inv-stock-b'
$$, 'a config cannot be marked sold without naming the order that took it');

SELECT assert_rejects($$
  INSERT INTO provisioning_stock (plan_id, provider_id, remote_username, subscription_url)
       VALUES ((SELECT id FROM product_plans WHERE name = '__inv-plan'),
               (SELECT id FROM provisioning_providers WHERE code = '__inv-provider'),
               '__inv-stock-a', 'https://example.invalid/sub/again')
$$, 'the same panel account cannot be shelved twice');

-- ---------------------------------------------------------------------------
-- reseller applications — one open at a time, per person (0012)
-- ---------------------------------------------------------------------------

INSERT INTO reseller_requests (user_id, description, status, created_at)
     VALUES ((SELECT id FROM users WHERE telegram_id = 900000001), 'first', 'PENDING', now());

SELECT assert_rejects($$
  INSERT INTO reseller_requests (user_id, description, status, created_at)
       VALUES ((SELECT id FROM users WHERE telegram_id = 900000001), 'again', 'PENDING', now())
$$, 'one person cannot have two open reseller applications');

-- And the deliberate opening: a turned-down application does not block a new one.
UPDATE reseller_requests SET status = 'REJECTED'
 WHERE user_id = (SELECT id FROM users WHERE telegram_id = 900000001);
INSERT INTO reseller_requests (user_id, description, status, created_at)
     VALUES ((SELECT id FROM users WHERE telegram_id = 900000001), 'after a no', 'PENDING', now());
SELECT assert_eq(
  (SELECT count(*) FROM reseller_requests
    WHERE user_id = (SELECT id FROM users WHERE telegram_id = 900000001)),
  2, 'a rejected applicant may apply again');

-- ---------------------------------------------------------------------------
-- payments — an order is paid once (0016)
-- ---------------------------------------------------------------------------
--
-- The bot used to carry this alone, with an `ON CONFLICT (public_id)` whose
-- conflict could never fire because `public_id` is minted fresh each time. It
-- held only because the poll loop is serial — a fact about the caller, not
-- about the data.

INSERT INTO orders (public_id, user_id, kind, quantity, unit_price_irr, total_irr, status)
     VALUES ('__inv-ord-1', (SELECT id FROM users WHERE telegram_id = 900000001),
             'WALLET_TOPUP', 1, 500000, 500000, 'AWAITING_PAYMENT');

INSERT INTO payments (public_id, user_id, order_id, amount_irr, method, status, created_at)
     VALUES ('__inv-pay-1', (SELECT id FROM users WHERE telegram_id = 900000001),
             (SELECT id FROM orders WHERE public_id = '__inv-ord-1'),
             500000, 'WALLET', 'PAID', now());

SELECT assert_rejects($$
  INSERT INTO payments (public_id, user_id, order_id, amount_irr, method, status, created_at)
       VALUES ('__inv-pay-2', (SELECT id FROM users WHERE telegram_id = 900000001),
               (SELECT id FROM orders WHERE public_id = '__inv-ord-1'),
               500000, 'WALLET', 'PAID', now())
$$, 'one order cannot be paid twice');

-- And the deliberate opening: a customer shown a card and then paying from
-- their balance leaves two payment rows for one order. Only one may be PAID,
-- which is why the index is scoped to that status and not to order_id alone.
INSERT INTO payments (public_id, user_id, order_id, amount_irr, method, status, created_at)
     VALUES ('__inv-pay-3', (SELECT id FROM users WHERE telegram_id = 900000001),
             (SELECT id FROM orders WHERE public_id = '__inv-ord-1'),
             500000, 'CARD_TO_CARD', 'PENDING', now());
SELECT assert_eq(
  (SELECT count(*) FROM payments
    WHERE order_id = (SELECT id FROM orders WHERE public_id = '__inv-ord-1')),
  2, 'an unpaid card row may sit beside the paid one');

\echo ''
\echo '  All invariants hold.'
\echo ''

ROLLBACK;
