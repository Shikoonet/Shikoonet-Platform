# Financial Hub Production Deploy — 2026-08-07

## Pre-deploy state
- Git HEAD: `da978368cd7778cfb3df6446fe2a27100e915e03` (uncommitted working tree)
- dashboard-worker (old): `598b0ea9-1bcb-47c9-a977-3e2482cc01f6`
- ingest-worker (unchanged): `40a66d7c-467c-4cf2-98aa-65da234caad4`

## D1 backup
- Database: `payment-hub-staging` (`ef773a7a-a163-4298-b256-43e093e8b781`)
- File: `.deploy-backups/payment-hub-staging-20260807T192219Z-pre-financial-hub.sql`
- SHA256: `86069f916fb15687fe771b4db0ba8bbb0ccb6d42adcbcb94b752ba4359b88758`

## Migration
- Applied remotely: `0013_resellers.sql` (resellers + reseller_transactions)

## Post-deploy
- dashboard-worker (new): `48fa839a-2e8c-495e-83f7-de0838bbb9f2`
- URL: https://dashboard-worker.samsos.workers.dev
- ingest-worker: NOT redeployed
- Mirzabot: NOT modified

## Test gates (pre-deploy)
- @hub/domain: 89 passed (incl. mirzabotMatch 41 tests — 4m59s/5m/5m01s window)
- dashboard-worker test/: 199 passed
- dashboard-web: 164 passed
- @hub/sms-parser: 139 passed
- dashboard-worker + dashboard-web typecheck: pass
