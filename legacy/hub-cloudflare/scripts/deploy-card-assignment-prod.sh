#!/usr/bin/env bash
# Deploy card-assignment to PRODUCTION Mirzabot (mirza) with pre-deploy backup.
# Rollback: ./scripts/rollback-card-assignment-prod.sh [--level 0|1|2]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/../mirzabot"
HOST=mirza
BOT=/var/www/html/mirzaprobotconfig
TS=$(date +%Y%m%d-%H%M%S)
BACKUP="/root/backups/mirzabot-card-assignment-prod-${TS}"

echo "========================================"
echo "TARGET BOT: PRODUCTION"
echo "  Host: fmirza.shikoonet.xyz (mirza)"
echo "  Bot:  @shikoonet_bot"
echo "  DB:   mirzaprobot"
echo "DEV (it2): NOT MODIFIED BY THIS SCRIPT"
echo "========================================"
echo ""
echo "Rollback plan: ./scripts/rollback-card-assignment-prod.sh --plan"
echo "Backup dir:    $BACKUP"
echo ""
if [[ "${DEPLOY_CONFIRM:-}" != "yes" ]]; then
  read -r -p "Deploy card assignment to PRODUCTION? [yes/N] " CONFIRM
  if [[ "${CONFIRM,,}" != "yes" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

# --- 1. Backup ---
echo "==> 1/6 Backup production files"
ssh -o BatchMode=yes "$HOST" "sudo mkdir -p '$BACKUP' && \
  sudo cp '$BOT/index.php' '$BACKUP/index.php.bak' && \
  sudo cp '$BOT/function.php' '$BACKUP/function.php.bak' && \
  sudo cp '$BOT/integration/reconciliation/local.php' '$BACKUP/local.php.bak' && \
  sudo tar -czf '$BACKUP/card-assignment-dir.tgz' -C '$BOT/integration' card-assignment 2>/dev/null || true && \
  echo '$TS' | sudo tee '$BACKUP/deployed_at.txt' >/dev/null && \
  echo backup ok: $BACKUP"

# --- 2. Upload module ---
echo "==> 2/6 Upload card-assignment module"
ssh -o BatchMode=yes "$HOST" "sudo mkdir -p $BOT/integration/card-assignment/tests $BOT/integration/card-assignment/data"
TMP="/tmp/card-assignment-upload-${TS}"
mkdir -p "$TMP/tests"
cp "$SRC/integration/card-assignment/config.php" \
   "$SRC/integration/card-assignment/hub_eligibility.php" \
   "$SRC/integration/card-assignment/schema.php" \
   "$SRC/integration/card-assignment/card_assignment.php" \
   "$TMP/"
cp "$SRC/integration/card-assignment/tests/card_assignment_test.php" "$TMP/tests/"
scp -o BatchMode=yes -r "$TMP"/* "$HOST:/tmp/card-assignment-upload-${TS}/"
ssh -o BatchMode=yes "$HOST" "sudo cp -r /tmp/card-assignment-upload-${TS}/* $BOT/integration/card-assignment/ && \
  sudo cp /tmp/card-assignment-upload-${TS}/tests/card_assignment_test.php $BOT/integration/card-assignment/tests/ 2>/dev/null || true && \
  sudo chown -R www-data:www-data $BOT/integration/card-assignment && \
  rm -rf /tmp/card-assignment-upload-${TS}"

# --- 3. Patch index.php ---
echo "==> 3/6 Patch index.php"
scp -o BatchMode=yes "$ROOT/scripts/prod-cart-to-offline-block.php" "$HOST:/tmp/prod-cart-to-offline-block.php"

ssh -o BatchMode=yes "$HOST" "sudo python3 <<'PY'
from pathlib import Path

bot = Path('$BOT')
index_path = bot / 'index.php'
index = index_path.read_text(encoding='utf-8')
fixed = Path('/tmp/prod-cart-to-offline-block.php').read_text(encoding='utf-8')

bootstrap = '''if (is_file(__DIR__ . '/integration/card-assignment/card_assignment.php')) {
    require_once __DIR__ . '/integration/card-assignment/card_assignment.php';
    cardAssignmentEnsureSchema();
}'''

if 'cardAssignmentEnsureSchema' not in index:
    needle = \"require_once 'panels.php';\"
    if needle not in index:
        raise SystemExit('panels.php require not found')
    index = index.replace(needle, needle + '\\n' + bootstrap, 1)

start = index.find('    if (\$datain == \"cart_to_offline\") {')
end = index.find('    } elseif (\$datain == \"aqayepardakht\") {')
if start < 0 or end < 0:
    raise SystemExit(f'cart_to_offline block not found start={start} end={end}')
index = index[:start] + fixed + '    } elseif (\$datain == \"aqayepardakht\") {' + index[end + len('    } elseif (\$datain == \"aqayepardakht\") {'):]

index_path.write_text(index, encoding='utf-8')
print('index.php patched')
PY"

# --- 4. Patch function.php ---
echo "==> 4/6 Patch function.php"
ssh -o BatchMode=yes "$HOST" "sudo python3 <<'PY'
from pathlib import Path
p = Path('$BOT/function.php')
t = p.read_text(encoding='utf-8')
if 'completeCardLeaseForOrder' not in t:
    old = \"function DirectPayment(\$order_id, \$image = 'images.jpg')\\n{\\n    global \$pdo\"
    new = \"function DirectPayment(\$order_id, \$image = 'images.jpg')\\n{\\n    if (function_exists('completeCardLeaseForOrder')) {\\n        completeCardLeaseForOrder(\$order_id);\\n    }\\n    global \$pdo\"
    if old not in t:
        raise SystemExit('DirectPayment pattern not found')
    p.write_text(t.replace(old, new, 1), encoding='utf-8')
    print('function.php patched')
else:
    print('function.php already has lease hook')
PY"

# --- 5. Enable flag + hub cache ---
echo "==> 5/6 Enable CARD_ASSIGNMENT + hub-eligible cache"
cat > "/tmp/sync-hub-eligible-prod.php" <<'PHPEOF'
<?php
require '/var/www/html/mirzaprobotconfig/config.php';
require '/var/www/html/mirzaprobotconfig/integration/reconciliation/local.php';
require '/var/www/html/mirzaprobotconfig/integration/card-assignment/card_assignment.php';
cardAssignmentEnsureSchema();
$rows = $pdo->query("SELECT cardnumber FROM card_number WHERE status = 'active'")->fetchAll(PDO::FETCH_COLUMN);
$cards = [];
foreach ($rows as $c) {
    $d = preg_replace('/\D/', '', $c);
    if (strlen($d) !== 16) continue;
    $cards[] = ['card_digits' => $d, 'financial_account_id' => 'bot-active', 'account_status' => 'ACTIVE'];
}
$path = '/var/www/html/mirzaprobotconfig/integration/card-assignment/data/hub-eligible-cards.json';
file_put_contents($path, json_encode(['synced_at' => time(), 'integration_id' => 'mirzabot-prod', 'cards' => $cards], JSON_PRETTY_PRINT) . "\n");
echo 'eligible cards: ' . count($cards) . PHP_EOL;
PHPEOF
scp -o BatchMode=yes "/tmp/sync-hub-eligible-prod.php" "$HOST:/tmp/sync-hub-eligible-prod.php"

ssh -o BatchMode=yes "$HOST" "sudo python3 <<'PY'
from pathlib import Path
p = Path('$BOT/integration/reconciliation/local.php')
lines = [ln for ln in p.read_text(encoding='utf-8').splitlines() if 'CARD_ASSIGNMENT_ENABLED' not in ln]
lines.append(\"putenv('CARD_ASSIGNMENT_ENABLED=true');\")
p.write_text('\\n'.join(lines) + '\\n', encoding='utf-8')
print('CARD_ASSIGNMENT_ENABLED=true')
PY"

ssh -o BatchMode=yes "$HOST" "sudo php /tmp/sync-hub-eligible-prod.php && sudo rm /tmp/sync-hub-eligible-prod.php"

# --- 6. Verify ---
echo "==> 6/6 Verify"
ssh -o BatchMode=yes "$HOST" "sudo php -l $BOT/index.php && \
  sudo php -l $BOT/function.php && \
  sudo php -l $BOT/integration/card-assignment/card_assignment.php && \
  sudo php -r \"
    require '$BOT/config.php';
    require '$BOT/integration/reconciliation/payment_hub.php';
    require '$BOT/integration/reconciliation/local.php';
    require '$BOT/integration/card-assignment/card_assignment.php';
    echo 'integration=' . paymentHubIntegrationId() . PHP_EOL;
    echo 'enabled=' . (cardAssignmentEnabled()?'yes':'no') . PHP_EOL;
  \" && \
  sudo php $BOT/integration/card-assignment/tests/card_assignment_test.php"

rm -rf "/tmp/card-assignment-upload-${TS}" "/tmp/sync-hub-eligible-prod.php"

echo ""
echo "PRODUCTION deploy complete."
echo "Backup:  $BACKUP"
echo "Rollback: ./scripts/rollback-card-assignment-prod.sh --level 0   # instant"
echo "          ./scripts/rollback-card-assignment-prod.sh --backup $BACKUP"
