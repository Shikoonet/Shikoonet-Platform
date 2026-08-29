#!/usr/bin/env bash
# Rollback card-assignment on PRODUCTION Mirzabot (mirza) ONLY.
#
# ROLLBACK PLAN — PRODUCTION
# ==========================
# Target: fmirza.shikoonet.xyz / @shikoonet_bot / mirzaprobot DB
# Host:   mirza (193.181.213.145)
#
# Level 0 — INSTANT (~5 seconds, no file restore)
#   Sets CARD_ASSIGNMENT_ENABLED=false in local.php.
#   Bot immediately falls back to pickNextCardForPayment() (rotation).
#   Active leases remain in DB but are ignored.
#   ./scripts/rollback-card-assignment-prod.sh --level 0
#
# Level 1 — FULL FILE RESTORE (default)
#   Restores index.php, function.php, local.php from backup under
#   /root/backups/mirzabot-card-assignment-prod-* on mirza.
#   ./scripts/rollback-card-assignment-prod.sh
#   ./scripts/rollback-card-assignment-prod.sh --backup /root/backups/mirzabot-card-assignment-prod-YYYYMMDD-HHMMSS
#
# Level 2 — REMOVE MODULE
#   Level 1 + removes integration/card-assignment/
#   ./scripts/rollback-card-assignment-prod.sh --level 2
#
# Database (optional)
#   card_assignment_leases is additive — safe to leave.
#   Clear stuck leases only:
#     UPDATE card_assignment_leases SET status='EXPIRED', released_at=UNIX_TIMESTAMP() WHERE status='ACTIVE';
#
# Verify after rollback
#   ssh mirza "sudo php -l /var/www/html/mirzaprobotconfig/index.php"
#   Start a card payment → rotation behavior, not leases
#   tail error_log — no Fatal errors
#
set -euo pipefail

HOST=mirza
BOT=/var/www/html/mirzaprobotconfig
LEVEL=1
BACKUP=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --level) LEVEL="$2"; shift 2 ;;
    --backup) BACKUP="$2"; shift 2 ;;
    --plan) sed -n '1,50p' "$0"; exit 0 ;;
    -h|--help) sed -n '1,50p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "TARGET BOT: PRODUCTION (@shikoonet_bot / fmirza.shikoonet.xyz)"
echo "Rollback level: $LEVEL"

if [[ "$LEVEL" == "0" ]]; then
  ssh -o BatchMode=yes "$HOST" "sudo python3 <<'PY'
from pathlib import Path
p = Path('$BOT/integration/reconciliation/local.php')
text = p.read_text(encoding='utf-8')
lines = [ln for ln in text.splitlines() if 'CARD_ASSIGNMENT_ENABLED' not in ln]
lines.append(\"putenv('CARD_ASSIGNMENT_ENABLED=false');\")
p.write_text('\\n'.join(lines) + '\\n', encoding='utf-8')
print('Level 0: CARD_ASSIGNMENT_ENABLED=false')
PY"
  ssh -o BatchMode=yes "$HOST" "sudo php -r \"
require '$BOT/config.php';
require '$BOT/integration/reconciliation/local.php';
require '$BOT/integration/card-assignment/card_assignment.php';
echo cardAssignmentEnabled() ? 'WARN still enabled' : 'OK disabled';
echo PHP_EOL;
\""
  echo "Production level 0 rollback complete."
  exit 0
fi

if [[ -z "$BACKUP" ]]; then
  BACKUP=$(ssh -o BatchMode=yes "$HOST" "sudo ls -dt /root/backups/mirzabot-card-assignment-prod-* 2>/dev/null | head -1")
fi

if [[ -z "$BACKUP" ]]; then
  echo "ERROR: No production backup found. Use --level 0 or deploy first."
  exit 1
fi

echo "Restoring from: $BACKUP"

ssh -o BatchMode=yes "$HOST" "sudo bash -c '
set -e
BACKUP=\"$BACKUP\"
BOT=\"$BOT\"
for f in index.php function.php; do
  if [[ -f \"\$BACKUP/\$f.bak\" ]]; then
    cp \"\$BACKUP/\$f.bak\" \"\$BOT/\$f\"
    chown www-data:www-data \"\$BOT/\$f\"
    echo restored \$f
  fi
done
if [[ -f \"\$BACKUP/local.php.bak\" ]]; then
  cp \"\$BACKUP/local.php.bak\" \"\$BOT/integration/reconciliation/local.php\"
  chown www-data:www-data \"\$BOT/integration/reconciliation/local.php\"
  chmod 640 \"\$BOT/integration/reconciliation/local.php\"
  echo restored local.php
fi
php -l \"\$BOT/index.php\"
php -l \"\$BOT/function.php\"
'"

if [[ "$LEVEL" == "2" ]]; then
  ssh -o BatchMode=yes "$HOST" "sudo rm -rf $BOT/integration/card-assignment && echo 'Removed integration/card-assignment/'"
fi

echo "Production level $LEVEL rollback complete."
