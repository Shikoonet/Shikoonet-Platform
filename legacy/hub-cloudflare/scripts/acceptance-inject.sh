#!/usr/bin/env bash
# Acceptance driver for the Mirzabot TEST bot (staging only).
#
# Reads the newest TEST order from it2 (card + paid_clicked_at), resolves the
# card to its staging financial account, and injects a bank SMS at an exact
# offset from paid_clicked_at so time-window boundaries can be tested precisely.
#
#   scripts/acceptance-inject.sh <delta_seconds> <amount_toman>
#
# Run it after the tester presses "I paid" and BEFORE they send the receipt:
# matching runs when the claim arrives, so the transaction must already exist.
set -euo pipefail

DELTA_S="${1:?usage: acceptance-inject.sh <delta_seconds> <amount_toman>}"
AMOUNT_TOMAN="${2:?usage: acceptance-inject.sh <delta_seconds> <amount_toman>}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

state=$(ssh -o BatchMode=yes it2 'f=$(ls -t /var/www/html/mirzaprobotconfig/data/*/payment-card-*.json | head -1); cat "$f"')
order=$(node -e "console.log(JSON.parse(process.argv[1]).order_id)" "$state")
card=$(node -e "console.log(String(JSON.parse(process.argv[1]).card_number))" "$state")
clicked=$(node -e "console.log(JSON.parse(process.argv[1]).paid_clicked_at)" "$state")
receipt=$(node -e "console.log(JSON.parse(process.argv[1]).receipt_submitted_at ?? 'none')" "$state")

hint=$(cd apps/dashboard-worker && pnpm exec wrangler d1 execute DB --remote --json \
  --command "SELECT a.account_hint AS h FROM payment_cards c JOIN financial_accounts a ON a.id=c.financial_account_id WHERE c.card_digits='$card'" 2>/dev/null \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=s.match(/\"h\": \"([^\"]+)\"/);if(!m){console.error('card '+process.argv[1]+' is not mapped to an account');process.exit(1);}console.log(m[1]);})" "$card")

bank_ts=$(( clicked + DELTA_S * 1000 ))

echo "order            : $order"
echo "card             : ****${card: -4}"
echo "account_hint     : $hint"
echo "paid_clicked_at  : $clicked"
echo "receipt_submitted: $receipt"
echo "delta            : ${DELTA_S}s  ->  bank_timestamp $bank_ts"
echo

# shellcheck disable=SC1091
source .staging-test.env
pnpm inject:staging-sms -- \
  --amount-toman "$AMOUNT_TOMAN" \
  --account-hint "$hint" \
  --bank-timestamp-ms "$bank_ts"
