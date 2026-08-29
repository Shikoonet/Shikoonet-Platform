#!/usr/bin/env bash
# Rollback card-assignment on DEV Mirzabot (it2) ONLY.
#
# ROLLBACK PLAN
# =============
# Target: mirzatest.4g3.xyz / @bottestshikoonetbot / mirzaprobot DB
# Production is NEVER touched by this script.
#
# Level 0 — INSTANT (feature flag only, ~5 seconds)
#   Disables CARD_ASSIGNMENT_ENABLED in local.php.
#   Bot falls back to pickNextCardForPayment() (rotation) immediately.
#   No file restore. Leases remain in DB but are ignored.
#   Run: ./scripts/rollback-card-assignment-dev.sh --level 0
#
# Level 1 — FULL FILE RESTORE (default)
#   Restores index.php, function.php, local.php from latest backup
#   under /root/backups/mirzabot-card-assignment-*.
#   Optionally disables feature flag if backup predates assignment.
#   Run: ./scripts/rollback-card-assignment-dev.sh
#        ./scripts/rollback-card-assignment-dev.sh --backup /root/backups/mirzabot-card-assignment-YYYYMMDD-HHMMSS
#
# Level 2 — REMOVE MODULE
#   Level 1 + removes integration/card-assignment/ directory.
#   Run: ./scripts/rollback-card-assignment-dev.sh --level 2
#
# Database (optional, manual)
#   card_assignment_leases and Payment_report.assigned_card_* columns are additive.
#   Safe to leave in place. To clear stuck leases only:
#     UPDATE card_assignment_leases SET status='EXPIRED', released_at=UNIX_TIMESTAMP()
#       WHERE status='ACTIVE';
#   Do NOT drop tables unless you accept losing lease audit history.
#
# Verify after rollback
#   php -l /var/www/html/mirzaprobotconfig/index.php
#   Start a test payment → should use pickNextCardForPayment (rotation), not leases
#   tail error_log — no Fatal errors
#
set -euo pipefail

BOT=/var/www/html/mirzaprobotconfig
LEVEL=1
BACKUP=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --level) LEVEL="$2"; shift 2 ;;
    --backup) BACKUP="$2"; shift 2 ;;
    --plan) sed -n '1,45p' "$0"; exit 0 ;;
    -h|--help) sed -n '1,45p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "TARGET BOT: DEV / TEST"
echo "PRODUCTION: NOT TOUCHED"
echo "Rollback level: $LEVEL"

if [[ "$LEVEL" == "0" ]]; then
  ssh -o BatchMode=yes it2 "python3 <<'PY'
from pathlib import Path
p = Path('$BOT/integration/reconciliation/local.php')
text = p.read_text(encoding='utf-8')
lines = [ln for ln in text.splitlines() if 'CARD_ASSIGNMENT_ENABLED' not in ln]
if not any('CARD_ASSIGNMENT_ENABLED=false' in ln for ln in lines):
    lines.append(\"putenv('CARD_ASSIGNMENT_ENABLED=false');\")
p.write_text('\\n'.join(lines) + '\\n', encoding='utf-8')
print('Level 0: CARD_ASSIGNMENT_ENABLED=false')
PY"
  ssh -o BatchMode=yes it2 "php -l $BOT/index.php && php -r \"
require '$BOT/config.php';
require '$BOT/integration/reconciliation/local.php';
require '$BOT/integration/card-assignment/card_assignment.php';
echo cardAssignmentEnabled() ? 'WARN still enabled' : 'OK disabled';
echo PHP_EOL;
\""
  echo "Level 0 rollback complete."
  exit 0
fi

if [[ -z "$BACKUP" ]]; then
  BACKUP=$(ssh -o BatchMode=yes it2 "ls -dt /root/backups/mirzabot-card-assignment-* 2>/dev/null | head -1")
fi

if [[ -z "$BACKUP" ]]; then
  echo "ERROR: No backup found. Use --level 0 to disable via flag, or deploy first (creates backup)."
  exit 1
fi

echo "Restoring from: $BACKUP"

ssh -o BatchMode=yes it2 "set -e
BACKUP='$BACKUP'
BOT='$BOT'
for f in index.php function.php; do
  if [[ -f \"\$BACKUP/\$f.bak\" ]]; then
    cp \"\$BACKUP/\$f.bak\" \"\$BOT/\$f\"
    echo restored \$f
  fi
done
if [[ -f \"\$BACKUP/local.php.bak\" ]]; then
  cp \"\$BACKUP/local.php.bak\" \"\$BOT/integration/reconciliation/local.php\"
  echo restored local.php
fi
php -l \"\$BOT/index.php\"
php -l \"\$BOT/function.php\"
"

if [[ "$LEVEL" == "2" ]]; then
  ssh -o BatchMode=yes it2 "rm -rf $BOT/integration/card-assignment && echo 'Removed integration/card-assignment/'"
fi

echo "Level $LEVEL rollback complete. Test @bottestshikoonetbot with a card payment."
