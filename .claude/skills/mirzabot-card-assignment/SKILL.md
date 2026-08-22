---
name: mirzabot-card-assignment
description: Temporary card leases, load balancing, and order card snapshots on Mirzabot. Use before changing integration/card-assignment/, cart_to_offline in index.php, or CARD_ASSIGNMENT_ENABLED / hub-eligible-cards.json.
---

# Mirzabot card assignment (leases + balancing)

**Separate from Payment Hub matching.** Do not change `mirzabotMatch.ts`, claim
semantics, or auto-verify rules when working on card assignment.

## What this owns

When a customer starts card-to-card payment, the bot must:

1. Assign one **temporary lease** (10 min TTL) per user.
2. **Reuse the same card** if the same user retries before expiry (TTL does not extend).
3. **Release immediately** when payment completes (`DirectPayment` path).
4. **Balance** successful completions today across eligible cards (Tehran day).
5. **Preserve** the card shown on each order (`assigned_card_*` + `savePaymentCardForOrder`).

## Code locations

| Area             | Path                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Module           | `mirzabot/integration/card-assignment/`                                                                                   |
| Config           | `config.php` — `CARD_LEASE_TTL_SECONDS = 600` (single source)                                                             |
| Gate             | `cardAssignmentEnabled()` — requires `CARD_ASSIGNMENT_ENABLED=true` and integration id `mirzabot-test` or `mirzabot-prod` |
| Selection        | `getOrAssignCard()`, `completeCardLeaseForOrder()`                                                                        |
| Hook (payment)   | `function.php` → `DirectPayment()` calls `completeCardLeaseForOrder($order_id)`                                           |
| Hook (start pay) | `index.php` → `cart_to_offline`                                                                                           |
| Hub card state   | `payment_hub.php` + existing `getPaymentCardTempPath()` in `index.php` — **never redeclare** that function                |

## Database (additive)

- `card_assignment_leases` — statuses: ACTIVE, COMPLETED, EXPIRED, CANCELLED
- Unique active slot per user and per card (generated columns on MySQL 8+)
- `Payment_report.assigned_card_number`, `assigned_card_name`

## Eligibility

Card must be: `card_number.status = active`, listed in
`integration/card-assignment/data/hub-eligible-cards.json` (Hub ACTIVE account).
Regenerate cache:

```bash
node scripts/sync-hub-eligible-cards.mjs   # needs wrangler D1 auth
# or deploy scripts run a bot-active fallback on server
```

## Deploy / rollback scripts (smsverfication repo)

| Env                                 | Deploy                                   | Rollback                                   |
| ----------------------------------- | ---------------------------------------- | ------------------------------------------ |
| DEV (`it2`, `@bottestshikoonetbot`) | `scripts/deploy-card-assignment-dev.sh`  | `scripts/rollback-card-assignment-dev.sh`  |
| PROD (`mirza`, `@shikoonet_bot`)    | `scripts/deploy-card-assignment-prod.sh` | `scripts/rollback-card-assignment-prod.sh` |

**Level 0 rollback** (instant): set `CARD_ASSIGNMENT_ENABLED=false` → falls back to `pickNextCardForPayment()`.

Backups: `/root/backups/mirzabot-card-assignment-{dev|prod}-TIMESTAMP/` on each host.

## Balancing SQL (successful today)

```sql
SELECT COUNT(*) FROM card_assignment_leases
WHERE card_number = ? AND status = 'COMPLETED'
  AND completed_at >= :tehran_day_start AND completed_at < :tehran_day_end
```

Pick order: `successful_today ASC`, `successful_7d ASC`, `successful_lifetime ASC`,
`assignments_today ASC`, `last_assigned_at ASC`, `cardnumber ASC`.

## Tests

- `mirzabot/integration/card-assignment/tests/card_assignment_test.php` — unit + optional DB via `CARD_ASSIGNMENT_TEST_DSN`
- Do not count expired/failed payments toward balancing.

## Environments

| Env  | SSH     | Bot                    | Integration id  |
| ---- | ------- | ---------------------- | --------------- |
| TEST | `it2`   | `@bottestshikoonetbot` | `mirzabot-test` |
| PROD | `mirza` | `@shikoonet_bot`       | `mirzabot-prod` |

Active runtime is always root `index.php`, not `vpnbot/update/` or `vpnbot/Default/`.
