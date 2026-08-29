#!/usr/bin/env bash
# (Re)deploy Mirzabot → Payment Hub TEST integration to staging.
# Generates fresh secrets in .staging-test.env (gitignored).
# Safe to re-run: rotates SMS injector device credential.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

HMAC_SECRET=$(openssl rand -hex 32)
SMS_API_KEY=$(openssl rand -hex 20)
TOKEN_HASH=$(node -e "const c=require('crypto');console.log(c.createHash('sha256').update(process.argv[1]).digest('hex'))" "$SMS_API_KEY")
TOKEN_PREFIX=${SMS_API_KEY:0:4}
NOW=$(date +%s%3N)
WEBHOOK_URL="https://mirzatest.4g3.xyz/integration/reconciliation/webhook.php"
DEVICE_ID="device-mirzabot-test-sms"
CRED_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
ACCOUNT_ID="account-2bcc59ea-9b52-432f-97af-5ef28c2dcfb5"
CARD_DIGITS="5047061674560137"

cat > .staging-test.env <<EOF
# TEST staging only — generated $(date -Iseconds). Do NOT commit.
export STAGING_SMS_API_KEY="$SMS_API_KEY"
export STAGING_SMS_DEVICE_CODE="mirzabot-test-sms"
export STAGING_INGEST_URL="https://ingest-worker.samsos.workers.dev/api/v1/sms"
export PAYMENT_HUB_HMAC_SECRET="$HMAC_SECRET"
export MIRZABOT_TEST_CARD="$CARD_DIGITS"
export MIRZABOT_TEST_ACCOUNT_HINT="30101883751600"
EOF
chmod 600 .staging-test.env

echo "==> Staging D1: test device + payment card mapping"
cd apps/ingest-worker
pnpm exec wrangler d1 execute DB --remote --command "
INSERT OR IGNORE INTO devices (id, device_code, display_name, description, active, created_at, updated_at)
VALUES ('$DEVICE_ID', 'mirzabot-test-sms', 'Mirzabot TEST SMS Injector', 'Synthetic SMS for Mirzabot E2E', 1, $NOW, $NOW);
DELETE FROM device_credentials WHERE device_id='$DEVICE_ID';
INSERT INTO device_credentials (id, device_id, token_hash, token_prefix, status, created_at, activated_at, revoked_at)
VALUES ('$CRED_ID', '$DEVICE_ID', '$TOKEN_HASH', '$TOKEN_PREFIX', 'ACTIVE', $NOW, $NOW, NULL);
INSERT OR IGNORE INTO payment_cards (id, financial_account_id, card_digits, label, created_at)
VALUES ('pc-mirzabot-test-5047', '$ACCOUNT_ID', '$CARD_DIGITS', 'Mirzabot TEST card (5047…)', $NOW);
"

echo "==> Wrangler secrets + deploy ingest-worker"
printf '%s' "$HMAC_SECRET" | pnpm exec wrangler secret put MIRZABOT_INTEGRATION_HMAC_SECRET
printf '%s' "$WEBHOOK_URL" | pnpm exec wrangler secret put MIRZABOT_WEBHOOK_URL
pnpm exec wrangler deploy

echo "==> Deploy dashboard-worker"
cd ../dashboard-worker
pnpm --filter @hub/dashboard-web build
pnpm exec wrangler deploy

echo "==> Mirzabot TEST (it2) local.php"
scp -o BatchMode=yes "$ROOT/../mirzabot/integration/reconciliation/payment_hub.php" \
  it2:/var/www/html/mirzaprobotconfig/integration/reconciliation/payment_hub.php
scp -o BatchMode=yes -r \
  "$ROOT/../mirzabot/integration/card-assignment/" \
  it2:/var/www/html/mirzaprobotconfig/integration/
ssh -o BatchMode=yes it2 "cat > /var/www/html/mirzaprobotconfig/integration/reconciliation/local.php <<EOF
<?php
putenv('MIRZABOT_INTEGRATION_ENABLED=true');
putenv('PAYMENT_HUB_HMAC_SECRET=$HMAC_SECRET');
putenv('PAYMENT_HUB_INTEGRATION_ID=mirzabot-test');
putenv('PAYMENT_HUB_CLAIMS_URL=https://ingest-worker.samsos.workers.dev/api/v1/integrations/mirzabot/claims');
putenv('CARD_ASSIGNMENT_ENABLED=true');
EOF
chown www-data:www-data /var/www/html/mirzaprobotconfig/integration/reconciliation/local.php
chmod 640 /var/www/html/mirzaprobotconfig/integration/reconciliation/local.php"

echo "Done. Secrets in $ROOT/.staging-test.env"
echo "Inject test SMS: source .staging-test.env && pnpm inject:staging-sms -- --amount-toman 195000"
