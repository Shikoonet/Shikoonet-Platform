#!/usr/bin/env bash
# DEV card-assignment eligibility audit (Mirzabot it2). PRODUCTION NOT TOUCHED.
set -euo pipefail

echo "TARGET: DEV it2 (@bottestshikoonetbot)"
echo "PRODUCTION: NOT TOUCHED"
echo ""

ssh -o BatchMode=yes it2 'php -r "
require \"/var/www/html/mirzaprobotconfig/config.php\";
require \"/var/www/html/mirzaprobotconfig/integration/reconciliation/local.php\";
require \"/var/www/html/mirzaprobotconfig/integration/card-assignment/card_assignment.php\";
\$report = cardAssignmentBuildAuditReport();
echo json_encode([\"generated_at\" => time(), \"items\" => \$report], JSON_PRETTY_PRINT);
"'
