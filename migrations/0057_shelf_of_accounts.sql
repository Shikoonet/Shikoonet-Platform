-- 0057 — the shelf learns to hold accounts, not just config links.
--
-- 0010 built the shelf for VPN configs: `subscription_url` was the whole
-- credential and NOT NULL said so. A bulk-bought account (ChatGPT, L2TP, …)
-- is a username and a password — there is no link to hand over.
--
-- So: a nullable `secret` beside the nullable link, and a CHECK that a row
-- carries at least one of them. A row with neither is nothing to deliver.
--
-- The secret is stored the way the link always was — plain, revealed only to
-- an ADMIN in the dashboard, never written to logs or audit payloads.

BEGIN;

ALTER TABLE provisioning_stock ADD COLUMN secret text;
ALTER TABLE provisioning_stock ALTER COLUMN subscription_url DROP NOT NULL;
ALTER TABLE provisioning_stock ADD CONSTRAINT stock_has_credential
  CHECK (subscription_url IS NOT NULL OR secret IS NOT NULL);

COMMIT;
