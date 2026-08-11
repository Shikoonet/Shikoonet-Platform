-- verify_invariants.sql — proves the guarantees the schema claims to make.
--
-- Run against a database with 0001-0005 applied and no data:
--   docker exec -i shikoo-sim-postgres-1 psql -U shikoo -d shikoo \
--     -v ON_ERROR_STOP=1 -q < migrations/verify_invariants.sql
--
-- Everything happens inside one transaction that is rolled back, so it is safe
-- to run against any environment. Any failure raises and aborts.
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
     VALUES (1001, 'alice', now()), (1002, 'bob', now());

INSERT INTO devices (id, device_code, display_name, created_at, updated_at)
     VALUES ('dev-1', 'D1', 'phone', 0, 0);
INSERT INTO financial_accounts (id, bank_name, display_name, account_type, created_at, updated_at)
     VALUES ('acct-1', 'melli', 'Melli', 'CARD', 0, 0);
INSERT INTO raw_sms_events (id, device_id, sender, body_sha256, app_checksum,
                            sms_timestamp, received_at, classification, parser_status, created_at)
     VALUES ('sms-1', 'dev-1', '710', 'h1', 'c1', 1786000000000, 1786000000000,
             'BANK_CREDIT', 'OK', 0);
INSERT INTO transaction_candidates (id, raw_sms_event_id, direction, amount_irr, bank_timestamp,
                                    confidence, parser_id, parser_version, status, created_at, updated_at)
     VALUES ('tx-1', 'sms-1', 'CREDIT', 1000000, 1786000000000, 1.0, 'p', 'v1', 'PARSED', 0, 0);
INSERT INTO payment_claims (id, external_order_id, expected_amount_irr, submitted_at,
                            source_system, status, created_at, updated_at)
     VALUES ('claim-1', 'order-1', 1000000, 1786000000000, 'bot', 'PENDING', 0, 0),
            ('claim-2', 'order-2', 1000000, 1786000000000, 'bot', 'PENDING', 0, 0);

-- ==========================================================================
-- 1. THE MONEY INVARIANT
-- ==========================================================================
INSERT INTO reconciliation_matches (id, transaction_candidate_id, payment_claim_id,
                                    score, status, created_at, updated_at)
     VALUES ('m-1', 'tx-1', 'claim-1', 1.0, 'CONFIRMED', 0, 0);

-- One bank transaction must not settle a second claim.
SELECT assert_rejects($$
  INSERT INTO reconciliation_matches (id, transaction_candidate_id, payment_claim_id,
                                      score, status, created_at, updated_at)
       VALUES ('m-2', 'tx-1', 'claim-2', 1.0, 'CONFIRMED', 0, 0)
$$, 'one transaction cannot verify a second claim');

-- ...not even under the other settling status.
SELECT assert_rejects($$
  INSERT INTO reconciliation_matches (id, transaction_candidate_id, payment_claim_id,
                                      score, status, created_at, updated_at)
       VALUES ('m-3', 'tx-1', 'claim-2', 1.0, 'AUTO_VERIFIED', 0, 0)
$$, 'CONFIRMED and AUTO_VERIFIED share one slot per transaction');

-- A claim must not be settled twice by two different transactions.
INSERT INTO raw_sms_events (id, device_id, sender, body_sha256, app_checksum,
                            sms_timestamp, received_at, classification, parser_status, created_at)
     VALUES ('sms-2', 'dev-1', '710', 'h2', 'c1', 1786000000000, 1786000000000,
             'BANK_CREDIT', 'OK', 0);
INSERT INTO transaction_candidates (id, raw_sms_event_id, direction, amount_irr, bank_timestamp,
                                    confidence, parser_id, parser_version, status, created_at, updated_at)
     VALUES ('tx-2', 'sms-2', 'CREDIT', 1000000, 1786000000000, 1.0, 'p', 'v1', 'PARSED', 0, 0);
SELECT assert_rejects($$
  INSERT INTO reconciliation_matches (id, transaction_candidate_id, payment_claim_id,
                                      score, status, created_at, updated_at)
       VALUES ('m-4', 'tx-2', 'claim-1', 1.0, 'CONFIRMED', 0, 0)
$$, 'one claim cannot be settled twice');

-- A rejected match does not consume the slot — a wrong guess must be retryable.
INSERT INTO reconciliation_matches (id, transaction_candidate_id, payment_claim_id,
                                    score, status, created_at, updated_at)
     VALUES ('m-5', 'tx-2', 'claim-2', 0.4, 'REJECTED', 0, 0);
SELECT assert_eq((SELECT count(*) FROM reconciliation_matches WHERE status = 'REJECTED'),
                 1, 'a REJECTED match does not occupy the settled slot');

-- ==========================================================================
-- 2. CARD LEASES — the guarantee MySQL had to fake with generated columns
-- ==========================================================================
INSERT INTO card_leases (telegram_user_id, order_public_id, card_number, assigned_at, expires_at)
     VALUES (1001, 'o-1', '6037000000000001', now(), now() + interval '30 min');

SELECT assert_rejects($$
  INSERT INTO card_leases (telegram_user_id, order_public_id, card_number, assigned_at, expires_at)
       VALUES (1001, 'o-2', '6037000000000002', now(), now() + interval '30 min')
$$, 'a user cannot hold two active card leases');

SELECT assert_rejects($$
  INSERT INTO card_leases (telegram_user_id, order_public_id, card_number, assigned_at, expires_at)
       VALUES (1002, 'o-3', '6037000000000001', now(), now() + interval '30 min')
$$, 'a card cannot be leased to two users at once');

-- Once released, both the user and the card are free again.
UPDATE card_leases SET status = 'COMPLETED', completed_at = now() WHERE order_public_id = 'o-1';
INSERT INTO card_leases (telegram_user_id, order_public_id, card_number, assigned_at, expires_at)
     VALUES (1002, 'o-4', '6037000000000001', now(), now() + interval '30 min');
SELECT assert_eq((SELECT count(*) FROM card_leases), 2,
                 'a completed lease frees both the user and the card');

-- ==========================================================================
-- 3. WALLET — the balance is derived, never assigned
-- ==========================================================================
INSERT INTO wallet_entries (user_id, amount_irr, kind, idempotency_key)
     VALUES ((SELECT id FROM users WHERE telegram_id = 1001),  5000000, 'TOPUP',    'k1'),
            ((SELECT id FROM users WHERE telegram_id = 1001), -1500000, 'PURCHASE', 'k2');

SELECT assert_eq((SELECT balance_irr FROM wallets w JOIN users u ON u.id = w.user_id
                   WHERE u.telegram_id = 1001),
                 3500000, 'wallet balance follows its entries');

SELECT assert_eq((SELECT sum(amount_irr) FROM wallet_entries we JOIN users u ON u.id = we.user_id
                   WHERE u.telegram_id = 1001),
                 (SELECT balance_irr FROM wallets w JOIN users u ON u.id = w.user_id
                   WHERE u.telegram_id = 1001),
                 'balance equals the sum of entries');

-- A replayed webhook or a double-tapped button cannot credit twice.
SELECT assert_rejects($$
  INSERT INTO wallet_entries (user_id, amount_irr, kind, idempotency_key)
       VALUES ((SELECT id FROM users WHERE telegram_id = 1001), 5000000, 'TOPUP', 'k1')
$$, 'a replayed wallet entry is rejected by its idempotency key');

-- A zero-amount entry is a bug, not a no-op.
SELECT assert_rejects($$
  INSERT INTO wallet_entries (user_id, amount_irr, kind)
       VALUES ((SELECT id FROM users WHERE telegram_id = 1001), 0, 'TOPUP')
$$, 'a zero-amount wallet entry is rejected');

-- ==========================================================================
-- 4. APPEND-ONLY LEDGERS
-- ==========================================================================
SELECT assert_rejects($$UPDATE wallet_entries SET amount_irr = 999 WHERE idempotency_key = 'k1'$$,
                      'wallet history cannot be edited');
SELECT assert_rejects($$DELETE FROM wallet_entries WHERE idempotency_key = 'k1'$$,
                      'wallet history cannot be deleted');

INSERT INTO audit_logs (id, actor_role, action, entity_type, entity_id, created_at)
     VALUES ('a-1', 'ADMIN', 'TEST', 'CLAIM', 'claim-1', 0);
SELECT assert_rejects($$DELETE FROM audit_logs WHERE id = 'a-1'$$,
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
       VALUES ('bad-1', (SELECT id FROM users WHERE telegram_id = 1001),
               'NEW_PURCHASE', 2, 1000000, 0, 1000000)
$$, 'an order total that disagrees with quantity x price is rejected');

INSERT INTO orders (public_id, user_id, kind, quantity, unit_price_irr, discount_irr, total_irr)
     VALUES ('ok-1', (SELECT id FROM users WHERE telegram_id = 1001),
             'NEW_PURCHASE', 2, 1000000, 200000, 1800000);
SELECT assert_eq((SELECT total_irr FROM orders WHERE public_id = 'ok-1'), 1800000,
                 'a consistent order total is accepted');

-- ==========================================================================
-- 6. GIFT CODES — one redemption per user, enforced where it cannot be raced
-- ==========================================================================
INSERT INTO discount_codes (code, kind, amount_irr) VALUES ('GIFT10', 'GIFT_BALANCE', 100000);
INSERT INTO discount_redemptions (code_id, user_id)
     VALUES ((SELECT id FROM discount_codes WHERE code = 'GIFT10'),
             (SELECT id FROM users WHERE telegram_id = 1001));
SELECT assert_rejects($$
  INSERT INTO discount_redemptions (code_id, user_id)
       VALUES ((SELECT id FROM discount_codes WHERE code = 'GIFT10'),
               (SELECT id FROM users WHERE telegram_id = 1001))
$$, 'the same gift code cannot be redeemed twice by one user');

\echo ''
\echo '  All invariants hold.'
\echo ''

ROLLBACK;
