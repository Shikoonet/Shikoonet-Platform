/**
 * Credit-only product — verification helper.
 *
 * Prints the exact curl / wrangler commands the operator must run
 * themselves to verify the credit-only rollout end-to-end. This script
 * NEVER holds tokens, cookies, or API keys. It is purely a recipe book.
 *
 * Run with:
 *   pnpm tsx scripts/verify-credit-only.ts
 */

const DASHBOARD_BASE = process.env.DASHBOARD_BASE ?? 'https://dashboard-worker.samsos.workers.dev';
const INGEST_BASE = process.env.INGEST_BASE ?? 'https://ingest-worker.samsos.workers.dev';

console.log(`
============================================================
Credit-only product — verification recipe
============================================================

This script does NOT make HTTP calls and does NOT print any secrets.
The operator runs each command in their own terminal.

1. Apply the migration locally + remotely
------------------------------------------
  # Local:
  wrangler d1 migrations apply payment-hub-staging --local
  # Remote (run on demand — this is the production database that both
  # dashboard-worker and ingest-worker bind to):
  wrangler d1 migrations apply payment-hub-staging --remote

  # Idempotent fallback if the remote is in a partially-applied state
  # (the column exists but the backfill/index didn't complete):
  pnpm tsx scripts/apply-0009-if-missing.ts

The 0009_credit_only.sql migration:
  - adds processing_disposition column (default ACTIONABLE)
  - backfills any direction <> 'CREDIT' rows to OUTGOING_IGNORED
  - creates partial index idx_tx_actionable

2. Send a real CREDIT SMS (deposit)
-----------------------------------
The device's app posts to ${INGEST_BASE}/api/v1/sms with body:
  {
    "deviceId": "<code>",
    "apiKey":   "<key>",
    "sender":   "BANK",
    "message":  "واریز +1,500,000\nمانده:78,159,809\n05/14-12:30",
    "timestamp": "1715000000000",
    "checksum": "<sha256 of normalized body>"
  }

Expected ingest response:
  { "ok": true, "accepted": true, "actionable": true,
    "status": "received", "eventId": "..." }

Verify on dashboard:
  GET ${DASHBOARD_BASE}/api/v1/today        → the deposit is listed
  GET ${DASHBOARD_BASE}/api/v1/notifications/counts → new > 0

3. Send a real DEBIT SMS (withdrawal)
-------------------------------------
Same endpoint, body:
  {
    ...
    "message": "برداشت -200,000\nمانده:78,000,000\n05/14-12:31",
    ...
  }

Expected ingest response:
  { "ok": true, "accepted": true, "actionable": false,
    "status": "outgoing_ignored", "reason": "OUTGOING_TRANSACTION_IGNORED",
    "eventId": "..." }

Verify on dashboard:
  - Today does NOT include the withdrawal.
  - Notification counts unchanged.
  - Direct assign POST on the missing tx → 404 (no row to assign).
  - raw_sms_events table DOES contain the event (audit preserved).

4. Cleanup tool — dry-run then apply
------------------------------------
  curl -X POST '${DASHBOARD_BASE}/api/v1/admin/cleanup-debits/dry-run' \\
       -H 'cf-access-token: <your-token>' | jq .

Re-run apply (idempotent — second call applies 0):
  curl -X POST '${DASHBOARD_BASE}/api/v1/admin/cleanup-debits/apply' \\
       -H 'cf-access-token: <your-token>' \\
       -H 'content-type: application/json' \\
       --data '{"dryRunReport": <paste dry-run output>, "confirm": true}'

Expected:
  - First apply: { ok: true, applied: N, conflicts: M, auditLogIds: [...] }
  - Second apply: { ok: true, applied: 0, conflicts: 0, auditLogIds: [...] }

5. Direct user action on DEBIT tx → 409
---------------------------------------
After step 2, if you somehow produce a DEBIT tx row (manual SQL
insert for testing), call:
  POST ${DASHBOARD_BASE}/api/v1/transactions/<id>/assign-account
  body: { "accountId": "<any>", "saveIdentifierToAccount": false }

Expected: 409
  { "ok": false, "error": "outgoing_transaction_not_actionable" }
`);
