#!/usr/bin/env bash
# Deploy card-assignment to DEV Mirzabot (it2) with pre-deploy backup.
# Rollback: ./scripts/rollback-card-assignment-dev.sh [--level 0|1|2]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/../mirzabot"
BOT=/var/www/html/mirzaprobotconfig
TS=$(date +%Y%m%d-%H%M%S)
BACKUP="/root/backups/mirzabot-card-assignment-${TS}"

echo "========================================"
echo "TARGET BOT: DEV / TEST"
echo "  Host: mirzatest.4g3.xyz (it2)"
echo "  Bot:  @bottestshikoonetbot"
echo "  DB:   mirzaprobot"
echo "PRODUCTION: NOT TOUCHED"
echo "========================================"
echo ""
echo "Rollback plan: ./scripts/rollback-card-assignment-dev.sh --plan"
echo "Backup dir:    $BACKUP"
echo ""

# --- Step 1: Pre-deploy backup on it2 ---
echo "==> 1/5 Backup current DEV files"
ssh -o BatchMode=yes it2 "mkdir -p '$BACKUP' && \
  cp '$BOT/index.php' '$BACKUP/index.php.bak' && \
  cp '$BOT/function.php' '$BACKUP/function.php.bak' && \
  cp '$BOT/integration/reconciliation/local.php' '$BACKUP/local.php.bak' 2>/dev/null || true && \
  tar -czf '$BACKUP/card-assignment-dir.tgz' -C '$BOT/integration' card-assignment 2>/dev/null || true && \
  echo '$TS' > '$BACKUP/deployed_at.txt' && \
  echo 'backup ok: $BACKUP'"

# --- Step 2: Upload module ---
echo "==> 2/5 Upload card-assignment module"
ssh -o BatchMode=yes it2 "mkdir -p $BOT/integration/card-assignment/tests $BOT/integration/card-assignment/data"
scp -o BatchMode=yes \
  "$SRC/integration/card-assignment/config.php" \
  "$SRC/integration/card-assignment/hub_eligibility.php" \
  "$SRC/integration/card-assignment/schema.php" \
  "$SRC/integration/card-assignment/card_assignment.php" \
  it2:"$BOT/integration/card-assignment/"
scp -o BatchMode=yes \
  "$SRC/integration/card-assignment/tests/card_assignment_test.php" \
  it2:"$BOT/integration/card-assignment/tests/"

# --- Step 3: Patch index.php (bootstrap + cart_to_offline) ---
echo "==> 3/5 Patch index.php"
scp -o BatchMode=yes "$ROOT/scripts/dev-cart-to-offline-block.php" it2:/tmp/dev-cart-to-offline-block.php

ssh -o BatchMode=yes it2 "python3 <<'PY'
from pathlib import Path

bot = Path('$BOT')
index_path = bot / 'index.php'
index = index_path.read_text(encoding='utf-8')
fixed = Path('/tmp/dev-cart-to-offline-block.php').read_text(encoding='utf-8')

bootstrap = '''if (is_file(__DIR__ . '/integration/card-assignment/card_assignment.php')) {
    require_once __DIR__ . '/integration/reconciliation/payment_hub.php';
    require_once __DIR__ . '/integration/card-assignment/card_assignment.php';
    cardAssignmentEnsureSchema();
}'''

if 'cardAssignmentEnsureSchema' not in index:
    needle = \"require_once 'panels.php';\"
    if needle not in index:
        raise SystemExit('panels.php require not found')
    index = index.replace(needle, needle + '\\n' + bootstrap, 1)

# Remove duplicate payment_hub require if present
index = index.replace(
    \"require_once __DIR__ . '/integration/reconciliation/payment_hub.php';\\n\\nfunction normalizePaymentCardDigits\",
    \"function normalizePaymentCardDigits\",
    1,
)

start = index.find('    if (\$datain == \"cart_to_offline\") {')
end = index.find('    } elseif (\$datain == \"aqayepardakht\") {')
if start < 0 or end < 0:
    raise SystemExit(f'cart_to_offline block not found start={start} end={end}')
index = index[:start] + fixed + '    } elseif (\$datain == \"aqayepardakht\") {' + index[end + len('    } elseif (\$datain == \"aqayepardakht\") {'):]

index_path.write_text(index, encoding='utf-8')
print('index.php patched')
PY"

# --- Step 4: Patch function.php + enable flag + hub cache ---
echo "==> 4/5 Patch function.php, local.php, hub-eligible cache"
ssh -o BatchMode=yes it2 "python3 <<'PY'
from pathlib import Path
p = Path('$BOT/function.php')
t = p.read_text(encoding='utf-8')
if 'completeCardLeaseForOrder' not in t:
    old = \"function DirectPayment(\$order_id, \$image = 'images.jpg')\\n{\\n    global \$pdo\"
    new = \"function DirectPayment(\$order_id, \$image = 'images.jpg')\\n{\\n    if (function_exists('completeCardLeaseForOrder')) {\\n        completeCardLeaseForOrder(\$order_id);\\n    }\\n    global \$pdo\"
    if old not in t:
        raise SystemExit('DirectPayment pattern not found in function.php')
    p.write_text(t.replace(old, new, 1), encoding='utf-8')
    print('function.php patched')
else:
    print('function.php already has lease hook')
PY"

ssh -o BatchMode=yes it2 "python3 <<'PY'
from pathlib import Path
p = Path('$BOT/integration/reconciliation/local.php')
lines = [ln for ln in p.read_text(encoding='utf-8').splitlines() if 'CARD_ASSIGNMENT_ENABLED' not in ln]
lines.append(\"putenv('CARD_ASSIGNMENT_ENABLED=true');\")
p.write_text('\\n'.join(lines) + '\\n', encoding='utf-8')
print('CARD_ASSIGNMENT_ENABLED=true')
PY"

cat > /tmp/sync-hub-eligible-dev.php <<'PHPEOF'
<?php
require '/var/www/html/mirzaprobotconfig/config.php';
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
file_put_contents($path, json_encode(['synced_at' => time(), 'integration_id' => 'mirzabot-test', 'cards' => $cards], JSON_PRETTY_PRINT) . "\n");
echo 'eligible cards: ' . count($cards) . PHP_EOL;
PHPEOF
scp -o BatchMode=yes /tmp/sync-hub-eligible-dev.php it2:/tmp/sync-hub-eligible-dev.php
ssh -o BatchMode=yes it2 "php /tmp/sync-hub-eligible-dev.php && rm /tmp/sync-hub-eligible-dev.php"

# --- Step 5: Verify ---
echo "==> 5/5 Verify"
ssh -o BatchMode=yes it2 "
  php -l $BOT/index.php &&
  php -l $BOT/function.php &&
  php -l $BOT/integration/card-assignment/card_assignment.php &&
  php -r \"
    \\\$_SERVER['REMOTE_ADDR']='149.154.167.220';
    require '$BOT/config.php';
    require '$BOT/function.php';
    require '$BOT/integration/reconciliation/local.php';
    require '$BOT/integration/card-assignment/card_assignment.php';
    echo 'enabled=' . (cardAssignmentEnabled()?'yes':'no') . PHP_EOL;
  \" &&
  php $BOT/integration/card-assignment/tests/card_assignment_test.php
"

echo ""
echo "DEV deploy complete."
echo "Backup:  $BACKUP"
echo "Rollback: ./scripts/rollback-card-assignment-dev.sh"
echo "          ./scripts/rollback-card-assignment-dev.sh --level 0   # instant disable"
echo "          ./scripts/rollback-card-assignment-dev.sh --backup $BACKUP"
