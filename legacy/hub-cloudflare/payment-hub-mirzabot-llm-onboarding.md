# Payment Reconciliation Hub + Mirzabot
## LLM Onboarding and Implementation Handoff

**Prepared:** 2026-08-06  
**Primary local repository:** `/home/sam/Documents/mydev/smsverfication`  
**Mirzabot upstream:** `https://github.com/mahdiMGF2/mirzabot`

---

# 1. Purpose

This file is a complete handoff for another LLM or coding agent. It explains the current Payment Reconciliation Hub, what is already working, the Android SMS flow, the parser and account-management work, the current Mirzabot payment flow, and the requested Mirzabot-to-Hub integration.

The next agent should read this file before changing code.

---

# 2. Product goal

The system verifies Iranian card-to-card payments by matching expected customer payments against real bank SMS transactions.

Target flow:

```text
Customer starts purchase in Mirzabot
→ Mirzabot assigns an exact card and creates a payment claim
→ Customer transfers money and uploads a receipt
→ Bank SMS reaches Android phone
→ SMS Relay forwards it to Cloudflare ingest-worker
→ SMS becomes a transaction candidate
→ Hub matches transaction to the Mirzabot claim
→ Admin approves, rejects, or reviews a suspect
→ Hub sends a signed webhook to Mirzabot
→ Mirzabot fulfills the order exactly once
```

The bank transaction is the primary verification source. The receipt is supporting evidence.

---

# 3. Current deployed system

## Local project

```text
/home/sam/Documents/mydev/smsverfication
```

## Ingest Worker

```text
https://ingest-worker.samsos.workers.dev
POST https://ingest-worker.samsos.workers.dev/api/v1/sms
```

## Dashboard Worker

```text
https://dashboard-worker.samsos.workers.dev
```

## Cloudflare Access

```text
https://samsalpak.cloudflareaccess.com
```

Current Dashboard login email:

```text
ircod3r@gmail.com
```

## D1

```text
Database: payment-hub-staging
Database ID: ef773a7a-a163-4298-b256-43e093e8b781
```

## Security warning

A prior Android API key was exposed in chat and in a QR code. It must be considered compromised. Do not repeat or reuse it. Rotate it before production use and never commit device secrets.

---

# 4. Current architecture

```text
Android phone
  └── SMS Relay
        └── POST /api/v1/sms
              └── ingest-worker
                    ├── raw_sms_events
                    ├── parser registry
                    ├── transaction_candidates
                    ├── financial_accounts
                    └── reconciliation/matching

Dashboard Worker
  ├── Cloudflare Access
  ├── Today
  ├── Matches
  ├── Accounts
  ├── Approve/Reject
  ├── Reports
  └── audit logs
```

Known D1 tables:

```text
access_users
audit_logs
comments
device_credentials
devices
financial_accounts
integration_tokens
payment_claims
raw_sms_events
reconciliation_matches
transaction_candidates
webhook_deliveries
```

---

# 5. Android SMS Relay configuration

App repository:

```text
https://github.com/automagen-ab/sms-relay
```

Remote configuration:

```text
Name: Payment Hub
Method: POST
URL: https://ingest-worker.samsos.workers.dev/api/v1/sms
Body type: JSON
Filter: blank during testing
```

JSON body:

```json
{
  "apiKey": "ROTATED_SECRET_HERE",
  "deviceId": "phone-sam-01",
  "deviceName": "Sam Android Phone",
  "message": "{sms_body}",
  "sender": "{sms_sender}",
  "timestamp": "{sms_timestamp}",
  "checksum": "{sms_checksum}"
}
```

The app replaces the placeholders automatically. A real test usually requires an incoming SMS from another phone/SIM/service.

Verification chain:

```text
SMS Relay SUCCESS → server returned 2xx
raw_sms_events row → Hub received the SMS
transaction_candidates row → parser produced a transaction
reconciliation match → a corresponding payment claim existed
```

---

# 6. Current transaction schema and query notes

`transaction_candidates` contains:

```text
id
raw_sms_event_id
financial_account_id
direction
amount_irr
balance_irr
transaction_reference
bank_timestamp
confidence
parser_id
parser_version
parser_evidence_json
status
created_at
updated_at
processing_disposition
```

There is no direct `account_hint` or `metadata_json` column.

The account hint is stored in:

```text
parser_evidence_json.accountHint
```

Useful query:

```sql
SELECT
  id,
  direction,
  amount_irr,
  balance_irr,
  json_extract(parser_evidence_json, '$.accountHint') AS account_hint,
  json_extract(parser_evidence_json, '$.bank') AS bank,
  financial_account_id,
  parser_id,
  confidence,
  status,
  processing_disposition,
  bank_timestamp,
  created_at
FROM transaction_candidates
ORDER BY created_at DESC
LIMIT 20;
```

---

# 7. Current reconciliation status

Observed/used statuses:

## payment_claims

```text
PENDING
MATCH_SUGGESTED
VERIFIED
REJECTED
FAKE_RECEIPT
EXPIRED
```

## reconciliation_matches

```text
SUGGESTED
CONFIRMED
REJECTED
AUTO_VERIFIED
```

## transaction_candidates

Relevant states include:

```text
PARSED
MATCH_SUGGESTED
MATCHED
APPROVED
REJECTED
NEEDS_REVIEW
IGNORED
```

The tested approval path is:

```text
transaction MATCHED → APPROVED
claim MATCH_SUGGESTED → VERIFIED
match SUGGESTED → CONFIRMED
```

A manual end-to-end approval has already succeeded.

---

# 8. Important fixes already completed

- Cloudflare Access protects the Dashboard Worker, not the ingest endpoint.
- Dashboard query fields were corrected:
  - `p.expected_at` → `p.submitted_at`
  - `p.financial_account_id` → `p.target_financial_account_id`
- Match filtering includes `SUGGESTED` and `AUTO_VERIFIED`.
- Same-origin handling was fixed; Approve/Reject no longer fails with `403 cross_origin_forbidden`.
- Approval was confirmed to require the transaction to be `MATCHED` before moving to `APPROVED`.

---

# 9. Iranian bank SMS parser work

Phase 5 was implemented locally.

Added:

```text
packages/sms-parser/src/parsers/internet-transfer.ts
packages/sms-parser/src/parsers/saman.ts
packages/sms-parser/test/parsers-banks.test.ts
```

Modified:

```text
packages/sms-parser/src/parsers/melli.ts
packages/sms-parser/src/parsers/registry.ts
apps/ingest-worker/test/banks-integration.test.ts
```

Supported formats:

## Internet transfer

```text
انتقال اینترنت:+550,000
حساب:310057795083
مانده:83,341,067
0515-10:06
```

Parser:

```text
internet-transfer-signed-v1
```

## Bank Melli

```text
بانك ملي ايران
انتقال:1,950,000+
حساب:06006
مانده:9,379,136
0515-20:46
```

Parser:

```text
melli-transfer-v1
```

The leading zero in `06006` must remain intact.

## Bank Saman

```text
بانك سامان
واريز مبلغ  1,000,000ريال
به  901-777-2938283-1
مانده 12,814,704
1405/5/15
20:48
```

Parser:

```text
saman-credit-v1
```

Hyphens must remain intact.

## Compact format

```text
300422286226
1,000,000+
1405/5/15-12:06
مانده:720,919,100
```

Parser:

```text
compact-signed-v1
```

Reported verification:

```text
sms-parser: 139/139
 ingest-worker: 45/45
 domain: 32/32
 dashboard-worker: 144/144
 dashboard-web: 135/135
 typecheck: clean across all 8 packages
```

`compact-signed-v1` is confirmed in the remote D1 data.

Known issue: some `generic-credit` records have impossible balances such as `15`, `21`, or `48`, likely because date/time fragments are being mistaken for balance values. Fix separately.

---

# 10. Account review and muting model

The requested account states are:

```text
PENDING
ACTIVE
MUTED
DECLINED
```

## PENDING

- Newly discovered or manually added.
- Visible in Accounts review only.
- Not eligible for matching, Today, Reports, Exports, totals, or charts.
- Can be Accepted or Declined.

## ACTIVE

- Included in matching, Dashboard, Reports, Exports, totals, and charts.

## MUTED

- Valid but temporarily excluded.
- SMS and transactions remain stored.
- Hidden from operational views and matching.
- Can be Unmuted back to ACTIVE.

## DECLINED

- Irrelevant or invalid for this installation.
- Data remains for audit.
- Hidden operationally.
- Can be restored to PENDING.

This must be enforced in backend/domain queries, not only in the frontend.

Only ACTIVE accounts should participate in matching and reports.

Existing accounts must remain ACTIVE during migration. Newly discovered accounts should begin PENDING.


---

# 11. Mirzabot repository findings

Repository:

```text
https://github.com/mahdiMGF2/mirzabot
```

The public project is PHP/MySQL-based.

Relevant inspected paths:

```text
vpnbot/update/index.php
vpnbot/update/admin.php
vpnbot/update/func.php
vpnbot/Default/index.php
vpnbot/Default/admin.php
vpnbot/Default/func.php
table.php
function.php
keyboard.php
api/payment.php
api/utils.php
lang/fa.php
```

Before editing, determine whether the real deployment uses:

```text
vpnbot/update
or
vpnbot/Default
```

Also check for a private/local fork with production-specific changes.

---

# 12. Current Mirzabot card-to-card behavior

The public code currently does approximately this:

1. User selects card-to-card payment.
2. Mirzabot creates a `Payment_report` row.
3. The row contains fields such as:
   - `id_user`
   - `id_order`
   - `time`
   - `price`
   - `payment_Status`
   - `Payment_Method`
   - `id_invoice`
   - `bottype`
4. Initial payment status is `Unpaid`.
5. Payment method is `cart to cart`.
6. The bot sends `setting['cart_info']`.
7. The user enters the `getresidcart` step and submits a receipt.
8. Admin receives user ID, order ID, username, amount, receipt/description, and Confirm/Reject buttons.
9. Confirm calls `DirectPaymentbot()`.
10. `DirectPaymentbot()` marks the payment paid and credits the user wallet.

Current data gap:

- The exact card shown to the customer is not persisted per order.
- The admin receipt message does not show the assigned destination card.
- `Payment_report` has no dedicated reconciliation fields.
- The `card_number` table only has `cardnumber` and `namecard`.
- `cart_info` behaves like static text.

---

# 13. User's requested product changes

## Requirement 1 — Show the assigned card in the receipt notification

When Mirzabot gives a card to the user, it must store exactly which card was assigned.

The admin receipt message must display:

```text
assigned card
card holder
expected amount
order ID
user
receipt
reconciliation state
```

## Requirement 2 — Connect Mirzabot and the Payment Hub

Mirzabot should create an expected payment claim in the Hub when a card is shown.

The Hub should match incoming bank SMS transactions using:

```text
target account/card
expected amount
time window
order ID
user
receipt metadata
```

The Dashboard should approve or reject the payment, then send the result to Mirzabot.

Mirzabot must fulfill the order exactly once.

## Requirement 3 — Add Suspects / Needs Review

Claims with a receipt but no reliable bank match should appear in a dedicated review queue.

Examples:

```text
no bank transaction found
amount mismatch
ambiguous same-amount payments
duplicate receipt
wrong target account
possible parser failure
late bank SMS
```

Do not automatically classify a receipt as fake merely because no SMS was found.

Only explicit admin action may set `FAKE_RECEIPT`.

---

# 14. Target architecture

```text
Mirzabot
  |
  | 1. payment claim: order + amount + assigned card + user
  v
Payment Reconciliation Hub
  ^
  | 2. bank SMS transaction: SMS Relay → ingest-worker
  |
  | 3. receipt metadata/image
  |
  +-- exact unique match --------> ready to approve
  +-- high-confidence unique ----> optional auto-verify later
  +-- no/ambiguous match --------> Suspects / Needs Review
                                        |
                                        | admin decision
                                        v
Mirzabot signed webhook
  |
  +-- fulfill exactly once
      +-- credit wallet / provision service
      +-- notify user
```

Ownership:

```text
Mirzabot owns:
- user
- order
- assigned card
- wallet/service fulfillment
- Telegram messages

Payment Hub owns:
- bank SMS
- transaction candidate
- matching
- verification decision
- suspect reasons
- audit trail
```

---

# 15. Phase A — Persist and display the assigned card

This is the safest first implementation slice.

Do not connect the Hub yet.

## Card assignment algorithm

When payment begins:

1. Load eligible cards.
2. Exclude disabled, muted, pending, declined, or over-capacity cards.
3. Prefer the card with the fewest open payments.
4. Break ties using the oldest `last_assigned_at`.
5. Persist the assignment before showing it.
6. Always reuse the saved assignment for that order.

Do not select a different card when the user reopens the payment page.

## Recommended additive table

Using a new table minimizes conflict with upstream Mirzabot updates:

```sql
CREATE TABLE payment_reconciliation (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    id_order VARCHAR(200) NOT NULL,
    bot_instance_id VARCHAR(300) NOT NULL,

    assigned_card_id VARCHAR(100) NOT NULL,
    assigned_card_number VARCHAR(32) NOT NULL,
    assigned_card_name VARCHAR(255) NULL,
    assigned_card_masked VARCHAR(32) NOT NULL,

    hub_financial_account_id VARCHAR(100) NULL,
    hub_claim_id VARCHAR(100) NULL,

    receipt_file_id TEXT NULL,
    receipt_file_unique_id VARCHAR(255) NULL,
    receipt_r2_key TEXT NULL,
    receipt_submitted_at BIGINT NULL,

    reconciliation_status VARCHAR(50) NOT NULL DEFAULT 'CREATED',
    hub_match_id VARCHAR(100) NULL,
    hub_transaction_id VARCHAR(100) NULL,
    verified_at BIGINT NULL,
    fulfilled_at BIGINT NULL,
    last_sync_error TEXT NULL,

    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,

    UNIQUE KEY uniq_payment_order (bot_instance_id, id_order)
);
```

Global external order ID:

```text
mirzabot:{bot_instance_id}:{id_order}
```

## Card template

Replace one static `cart_info` with a template supporting:

```text
{card_number}
{card_holder}
{amount_toman}
{order_id}
{card_last4}
```

Example:

```text
لطفاً مبلغ {amount_toman} تومان را دقیقاً به کارت زیر واریز کنید:

💳 شماره کارت:
{card_number}

👤 به نام:
{card_holder}

🛒 کد پیگیری:
{order_id}

بعد از پرداخت، روی «پرداخت کردم» بزنید و رسید را ارسال کنید.
```

## Admin receipt message

Example:

```text
⭕️ یک پرداخت جدید ثبت شده است

👤 کاربر: @username
🆔 شناسه: 123456789
🛒 کد سفارش: a12b34c56d

💸 مبلغ مورد انتظار: 195,000 تومان
💳 کارت مقصد: 6037-xxxx-xxxx-1234
👤 صاحب کارت: Card Holder
🏦 حساب متصل: Bank Melli — ****6006

🧾 رسید دریافت شده: بله
🔎 وضعیت بانکی: در انتظار بررسی

[مشاهده در Dashboard]
[تأیید دستی]
[رد پرداخت]
```

Telegram Confirm/Reject may remain temporarily as a fallback.

---

# 16. Phase B — Shadow integration

In shadow mode, the Hub receives claims and receipts but does not fulfill orders.

## Create claim when card is shown

Suggested endpoint:

```text
POST /api/v1/integrations/mirzabot/payment-claims
```

Example payload:

```json
{
  "eventId": "evt_01...",
  "externalOrderId": "mirzabot:bot-01:a12b34c56d",
  "mirzabotOrderId": "a12b34c56d",
  "botInstanceId": "bot-01",

  "telegramUserId": "123456789",
  "telegramUsername": "username",

  "amountToman": 195000,
  "expectedAmountIrr": 1950000,

  "assignedCard": {
    "externalCardId": "card-42",
    "maskedNumber": "6037-****-****-1234",
    "holderName": "Card Holder"
  },

  "targetFinancialAccountId": "account-uuid-in-hub",
  "cardShownAt": 1786050000000,
  "sourceSystem": "MIRZABOT",

  "metadata": {
    "invoiceId": "optional",
    "serviceName": "30 days / 50GB"
  }
}
```

## Currency rule

Mirzabot uses toman. The Hub uses rial/IRR.

Always send both values:

```text
expectedAmountIrr = amountToman * 10
```

Use one tested conversion helper. Do not perform silent conversion in several places.

## Receipt event

Suggested endpoint:

```text
POST /api/v1/integrations/mirzabot/payment-claims/{externalOrderId}/receipt
```

Example:

```json
{
  "eventId": "evt_receipt_01...",
  "submittedAt": 1786050300000,
  "telegramFileId": "AgACAgQAA...",
  "telegramFileUniqueId": "AQADx...",
  "mimeType": "image/jpeg",
  "caption": "optional",
  "r2Key": "receipts/mirzabot/bot-01/a12b34c56d.jpg"
}
```

Store receipt fingerprints:

```text
telegram_file_unique_id
sha256(receipt_bytes)
```

In shadow mode:

- Hub creates matches and suspects.
- Telegram remains the final approval source.
- Telegram decisions sync back to the Hub.
- Compare Hub recommendations with actual admin decisions.
- Do not auto-fulfill.

---

# 17. Phase C — Dashboard approval and fulfillment

Add `Approve & fulfill` to the Dashboard.

After approval, the Hub sends a signed webhook to Mirzabot.

Verified event example:

```json
{
  "eventId": "evt_verified_01...",
  "type": "payment.verified",
  "externalOrderId": "mirzabot:bot-01:a12b34c56d",
  "mirzabotOrderId": "a12b34c56d",
  "claimId": "claim-uuid",
  "matchId": "match-uuid",
  "transactionId": "transaction-uuid",
  "expectedAmountIrr": 1950000,
  "matchedAmountIrr": 1950000,
  "verificationMode": "ADMIN_APPROVED",
  "verifiedAt": 1786050700000
}
```

Rejected event example:

```json
{
  "eventId": "evt_rejected_01...",
  "type": "payment.rejected",
  "externalOrderId": "mirzabot:bot-01:a12b34c56d",
  "reasonCode": "NO_BANK_TRANSACTION",
  "reason": "No corresponding bank credit was found"
}
```

Dashboard should show separate states:

```text
Bank verified
Mirzabot fulfilled
Webhook sync status
```

Verification success and fulfillment success are not the same state.

---

# 18. Phase D — Limited auto-verification

Do not enable this initially.

Auto-verification is allowed only when:

```text
exact target account
exact amount
one eligible claim
one eligible transaction
short time window
no duplicate receipt
account ACTIVE
no parser/ingestion warning
```

Everything else remains manual.


---

# 19. Matching and verification algorithm

Primary candidate filter:

```text
direction = CREDIT
financial_account_id = claim.target_financial_account_id
amount_irr = claim.expected_amount_irr
transaction not consumed by another claim
financial account status = ACTIVE
```

Suggested operational window:

```text
from 10 minutes before cardShownAt
until 2 hours after receiptSubmittedAt
```

Longer windows may be used for manual review, but not auto-verification.

Suggested scoring:

```text
Exact target account                         mandatory
Exact amount                                 mandatory for auto verify
0-10 minutes from claim                      +0.35
10-30 minutes                                +0.25
30-60 minutes                                +0.15
Receipt submitted                            +0.05
Exactly one eligible claim                   +0.15
Exactly one eligible transaction             +0.15
Duplicate receipt                            block auto verify
Multiple same-amount claims                  block auto verify
```

Ambiguity rule:

If multiple users have the same amount, target card, and overlapping time windows, do not auto-verify. Send all candidates to review.

---

# 20. Suspects / Needs Review

Recommended reason codes:

```text
NO_BANK_TRANSACTION
AMOUNT_MISMATCH
AMBIGUOUS_MATCH
DUPLICATE_RECEIPT
WRONG_TARGET_ACCOUNT
POSSIBLE_PARSER_FAILURE
LATE_BANK_SMS
ACCOUNT_MUTED
ACCOUNT_UNRESOLVED
WEBHOOK_SYNC_FAILED
```

Example UI:

```text
Order: a12b34c56d
User: @username

Expected: 195,000 toman
Target card: ****1234
Receipt: View

Reason:
No corresponding bank transaction found after 47 minutes

Nearby events:
- 190,000 toman — same account — 4 min later
- Unparsed SMS — same sender — 2 min later

[Link transaction]
[Verify manually]
[Reject receipt]
[Ask user to resend]
```

Never set `FAKE_RECEIPT` automatically. Use intermediate states such as:

```text
PENDING_REVIEW
NO_MATCH
AMBIGUOUS
```

Only explicit admin action should mark a receipt fake.

---

# 21. Receipt storage

Recommended flow:

1. Mirzabot receives the Telegram receipt.
2. Mirzabot downloads the file from Telegram.
3. Mirzabot uploads it to the Hub.
4. Hub stores it in Cloudflare R2.
5. Dashboard displays it from R2.
6. Telegram bot token remains outside Cloudflare Workers.

Store:

```text
Telegram file_id
Telegram file_unique_id
SHA-256
R2 object key
MIME type
size
submitted timestamp
```

Do not expose the Telegram bot token to the Hub.

---

# 22. Integration security

Do not reuse Mirzabot's existing generic API authentication unchanged.

The public Mirzabot API uses a `Token` header and logs request headers. A new integration secret must not be written to generic API logs.

Use separate HMAC secrets for each direction.

Suggested headers:

```text
X-Integration-Id: mirzabot-prod
X-Event-Id: evt_...
X-Timestamp: 1786050700
X-Signature: sha256=<hmac>
```

Signature input:

```text
timestamp + "\n" +
method + "\n" +
path + "\n" +
sha256(raw_body)
```

Rules:

```text
maximum timestamp skew: 5 minutes
eventId must be unique
constant-time signature comparison
separate inbound/outbound secrets
secret rotation support
never log secrets or raw signing input
```

Store Cloudflare credentials as Worker Secrets. Do not commit secrets to Git, `wrangler.toml`, PHP source, database logs, or Telegram messages.

---

# 23. Idempotency and double-credit prevention

This is critical.

An order may be approved by:

```text
Telegram admin button
Dashboard action
webhook retry
concurrent requests
```

Mirzabot must settle the order exactly once.

Refactor conceptually:

```php
settlePaymentOrder($orderId, $source, $actor, $eventId);
renderTelegramPaymentConfirmation(...);
```

Recommended settlement table:

```sql
CREATE TABLE payment_settlements (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    id_order VARCHAR(200) NOT NULL,
    event_id VARCHAR(200) NOT NULL,
    source VARCHAR(50) NOT NULL,
    status VARCHAR(30) NOT NULL,
    created_at BIGINT NOT NULL,
    completed_at BIGINT NULL,

    UNIQUE KEY uniq_settlement_order (id_order),
    UNIQUE KEY uniq_settlement_event (event_id)
);
```

Only the process that creates the settlement record may credit the wallet or provision the service.

Later calls return:

```json
{
  "status": "already_fulfilled"
}
```

Use a database transaction where possible. Do not rely only on reading `payment_Status` before writing it.

---

# 24. Card/account status synchronization

The Hub account status must influence Mirzabot card assignment.

If a connected Hub account is:

```text
MUTED
PENDING
DECLINED
```

Mirzabot must stop assigning its card to new customers.

Suggested event:

```json
{
  "type": "payment_account.status_changed",
  "externalCardId": "card-42",
  "status": "MUTED"
}
```

Open orders retain their original assigned-card snapshot.

---

# 25. Recommended module layout

Keep integration code isolated to reduce upgrade conflicts:

```text
integration/reconciliation/
  client.php
  config.php
  signature.php
  claims.php
  receipts.php
  webhook.php
  settlement.php
  card-assignment.php
  migrations.php
```

---

# 26. Implementation backlog

## Payment Hub

```text
/home/sam/Documents/mydev/smsverfication
```

Tasks:

1. Finalize account states and central eligibility policy.
2. Exclude non-ACTIVE accounts from matching and operational reporting.
3. Add Mirzabot integration credentials.
4. Add claim-create endpoint.
5. Add receipt upload endpoint and R2 storage.
6. Add source-system/external-order metadata.
7. Add suspect reason codes and review APIs/UI.
8. Add approval-to-webhook flow.
9. Add webhook retry and delivery status.
10. Add inbound event idempotency.
11. Add audit logs.
12. Sync account status changes to Mirzabot.
13. Tighten `generic-credit` balance parsing.
14. Add end-to-end tests.

## Mirzabot

```text
https://github.com/mahdiMGF2/mirzabot
```

Tasks:

1. Determine the deployed runtime path and local fork.
2. Add stable card identity and status.
3. Persist card assignment per order.
4. Template the card message.
5. Show assigned card in admin receipt notification.
6. Create Hub claims when a card is shown.
7. Send receipt metadata/image to the Hub.
8. Receive and verify signed Hub webhooks.
9. Make settlement idempotent.
10. Sync Telegram decisions to the Hub.
11. Exclude muted/inactive cards from assignment.
12. Add retry queue for outbound requests.
13. Add structured logs without secrets.
14. Add migrations, tests, and rollback notes.

---

# 27. Minimum test matrix

1. Correct payment, exact amount, exact card.
2. Two users with the same amount on the same card.
3. Payment to the wrong card.
4. Receipt with no bank transaction.
5. Same receipt reused for two orders.
6. SMS arrives after the claim enters Suspects.
7. Raw SMS exists but parser fails.
8. Telegram and Dashboard approve simultaneously.
9. Webhook timeout and retry.
10. Repeated webhook with the same `eventId`.
11. Different event IDs for the same fulfilled order.
12. Exact toman-to-rial conversion.
13. Account muted after card display but before payment.
14. Card edited/deleted after order creation.
15. Bank verified but wallet/service fulfillment fails.
16. Fulfillment succeeds but the Hub misses the response.
17. Legacy orders without integration metadata.
18. Existing Hub accounts remain ACTIVE after migration.
19. New unknown accounts begin PENDING.
20. Muted transactions remain stored but hidden operationally.
21. Existing confirmed matches survive account mute.
22. Generic parser cannot treat date fragments as balances.

---

# 28. Rollout plan

## Phase A — Assigned card visibility

Ship only:

```text
card assignment
assignment snapshot
card template
card shown in admin receipt message
```

## Phase B — Shadow mode

Ship:

```text
claim creation
receipt upload
Hub matching
Suspects
Telegram remains final approval source
```

Measure real accuracy.

## Phase C — Dashboard fulfillment

Ship:

```text
Approve & fulfill
signed webhook
idempotent settlement
retry handling
```

## Phase D — Narrow auto-verification

Enable only for exact, unique, low-risk matches.

---

# 29. Open questions

Resolve these before production work:

1. Which Mirzabot path is actually deployed: `update` or `Default`?
2. Is there a private/local fork with production changes?
3. Is every payment a wallet top-up, or can an order be fulfilled directly?
4. How are cards currently selected in the production fork?
5. What is the production MySQL version/schema?
6. Which Mirzabot card maps to which Hub `financial_account_id`?
7. Must one installation support multiple bot tokens/brands?
8. How long should receipt files be retained?
9. When should unmatched claims expire?
10. Should Telegram Confirm remain enabled after Dashboard approval goes live?
11. Who may manually override a suspect?
12. What happens for a correct amount paid to the wrong active card?
13. What happens for split payments?
14. What happens for overpayment or underpayment?

Do not silently assume answers.

---

# 30. Rules for the next LLM

1. Inspect code before changing it.
2. Do not hardcode policy in frontend components.
3. Keep source-of-truth rules in backend/domain code.
4. Preserve raw SMS and transaction history.
5. Missing SMS is not proof of fraud.
6. Never auto-verify ambiguous payments.
7. Never settle the same order twice.
8. Never expose API keys, bot tokens, HMAC secrets, or full card numbers in logs.
9. Do not deploy without explicit user approval.
10. Do not commit without explicit user approval.
11. Add migrations instead of manually editing production tables.
12. Keep Mirzabot integration isolated from upstream code where possible.
13. Use explicit currency names: `amountToman`, `expectedAmountIrr`.
14. Use idempotency keys for every cross-system event.
15. Add tests before rollout.
16. Report exact files changed, commands run, and test results.
17. State assumptions and unresolved questions clearly.

---

# 31. Ready-to-use prompt for another coding LLM

```text
You are taking over a Payment Reconciliation Hub and Mirzabot integration project.

Read the entire onboarding document before making changes.

Primary local repository:
  /home/sam/Documents/mydev/smsverfication

Mirzabot upstream:
  https://github.com/mahdiMGF2/mirzabot

Do not implement the entire integration in one step.

First:

1. Inspect the Payment Hub architecture, migrations, account model, matching, Dashboard APIs, webhook deliveries, and tests.
2. Inspect Mirzabot and determine the actual deployed runtime path and whether a local production fork exists.
3. Produce a concrete Phase A implementation plan to:
   - persist the exact card assigned to each order,
   - reuse that assignment for the order,
   - render the card from the saved snapshot,
   - show the assigned card in the admin receipt message,
   - preserve existing payment behavior,
   - minimize upstream merge conflicts.
4. Produce a Phase B plan to:
   - create Hub payment claims,
   - upload receipt metadata/image,
   - run shadow matching,
   - create Suspects / Needs Review,
   - keep Telegram as the final approval source.
5. Identify exact schema and code changes in both repositories.
6. Define API contracts, state transitions, security, retry, and idempotency.
7. Identify open questions that cannot be answered from the code.

Business rules:

- Bank transaction is the primary verification source.
- Receipt is supporting evidence.
- Missing SMS is not automatic fraud.
- Only explicit admin action may set FAKE_RECEIPT.
- Account states: PENDING, ACTIVE, MUTED, DECLINED.
- Only ACTIVE accounts participate in matching and reports.
- Muted accounts keep ingesting data but are hidden operationally.
- Every payment order stores an immutable assigned-card snapshot.
- Hub and Mirzabot use signed, idempotent events.
- Mirzabot fulfills every order exactly once.
- Mirzabot amounts are toman; Hub amounts are rial/IRR.
- expectedAmountIrr = amountToman * 10.
- Do not expose secrets or full sensitive card data in logs.
- Do not deploy.
- Do not commit.

Before finishing, report:

- exact files inspected,
- exact files proposed for change,
- migrations proposed,
- API contracts,
- state transitions,
- retry/idempotency design,
- test plan,
- assumptions,
- unresolved questions.
```

---

# 32. Recommended immediate next step

Implement Mirzabot Phase A first:

```text
persist the assigned card per id_order
→ template the card message
→ show the assigned card in the admin receipt notification
→ add tests
→ do not connect the Hub yet
```

After this works reliably, start the Hub connection in shadow mode.
