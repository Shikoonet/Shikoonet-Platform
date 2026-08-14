-- 0014_redact_gateway_credentials.sql — take the payment gateway keys back out.
--
-- `migrateSettings` used to copy every row of `PaySetting` into `settings`
-- verbatim. That table is not a table of switches: `apinowpayment`,
-- `apiiranpay`, `apiternado`, `merchant_zarinpal`, `merchant_id_aqayepardakht`,
-- `marchent_floypay`, `marchent_tronseller` and `walletaddress` are live payment
-- gateway keys and merchant identifiers, in plaintext, one SELECT away from any
-- screen that listed the table.
--
-- The importer no longer carries them (`isSettingSecret`), which is the root
-- fix and enough for a database migrated from today on. This exists for the
-- ones that already ran it: a developer machine, and the simulation. Without it
-- the guarantee would depend on when somebody happened to import.
--
-- DELETE rather than blanking the value: a row holding JSON null reads as
-- "configured, empty", and nothing on this platform speaks to a gateway yet, so
-- there is no reader to disappoint. When one is written its credential is named
-- by a reference into the secret store, the way
-- `provisioning_providers.secret_ref` already works — it is not a settings row.
--
-- `settings` is configuration, not a ledger: it has no append-only trigger and
-- deleting from it is ordinary. Contrast `audit_logs` and `wallet_entries`,
-- where a DELETE is refused by design.

BEGIN;

DELETE FROM settings
 WHERE scope IN ('pay', 'panel')
   AND key ~* '(api|token|secret|password|passwd|merchant|marchent|walletaddress|privkey|hmac)';

COMMIT;
