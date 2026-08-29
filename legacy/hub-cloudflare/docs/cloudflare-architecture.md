# Cloudflare Architecture

Two independently deployable Workers, one D1 database. No always-on Node process, no Docker, no separate VPS.

```
┌─────────────────────────┐         ┌──────────────────────────────┐
│  5–6 Android phones      │         │  Cloudflare Access (browser) │
│  (unchanged SMS Relay)   │         │  dashboard.example.com       │
└───────────┬─────────────┘         └──────────────┬───────────────�
            │ POST /api/v1/sms                     │ Cf-Access-Jwt-Assertion
            │ (apiKey in body)                     │
            ▼                                      ▼
┌─────────────────────────┐         ┌──────────────────────────────┐
│  ingest.example.com     │         │  dashboard.example.com       │
│  apps/ingest-worker     │         │  apps/dashboard-worker       │
│  - Zod validate         │         │  - JWT verify (jose)         │
│  - body size limit      │         │  - RBAC lookup               │
│  - device token check   │         │  - React/Vite (static assets)│
│  - rate limit (binding) │         │  - Hono API under /api/v1    │
│  - dedupe (sha256)      │         └──────────────┬───────────────┘
│  - parse                │                        │
│  - suggest match        │                        │
│  - audit                │                        │
└───────────┬─────────────┘                        │
            │                                       │
            └─────────────► D1 (one DB) ◄───────────┘
                              - audit_logs
                              - raw_sms_events
                              - transaction_candidates
                              - payment_claims
                              - reconciliation_matches
                              - devices, device_credentials
                              - financial_accounts
                              - access_users
                              - comments
```

## Why two Workers

- Ingest is public (Android phones cannot do Cloudflare Access browser auth). It must validate a bearer token in the body.
- Dashboard is browser-facing. Access JWT is the only auth path.
- Different trust boundaries ⇒ different hosts ⇒ different Workers.

## Bindings

| Worker    | Binding                                | Purpose                                              |
| --------- | -------------------------------------- | ---------------------------------------------------- |
| ingest    | `D1` (`DB`)                            | Primary store.                                       |
| ingest    | `RATE_LIMITER` (Workers Rate Limiting) | Per-device + per-IP throttle.                        |
| ingest    | `KV` or none                           | (optional) small lookup caches; not used in MVP.     |
| dashboard | `D1` (`DB`)                            | Read mostly; writes for comments, decisions, audit.  |
| dashboard | env vars                               | `ACCESS_AUD`, `ACCESS_ISSUER`, `ACCESS_TEAM_DOMAIN`. |
| dashboard | static assets                          | React build under `dist/`.                           |

Secrets live in `wrangler secret put` (production) and `.dev.vars` (local). `.dev.vars` is gitignored.

## Ingestion flow

1. Worker receives `POST /api/v1/sms`.
2. Reject if `Content-Length > N` (default 8 KB) before reading the body.
3. Parse JSON with Zod; reject unknown fields.
4. Rate-limit check (per `deviceId` and per client IP).
5. Look up device by `deviceId`; verify `apiKey` via constant-time hash compare against active credential.
6. Compute server fingerprint: SHA-256(`deviceId|sender|timestamp|normalized(body)`). INSERT OR IGNORE on `raw_sms_events.body_sha256` (per device) — duplicate returns the original row.
7. Classify (OTP / promo / unknown / credit / debit / balance). For OTP, store metadata only (sender, timestamp, classification), redact body.
8. Run parser registry. Insert `transaction_candidate` row if matched.
9. Run reconciliation scorer. Insert `reconciliation_matches` rows (status `MATCH_SUGGESTED` or `NEEDS_REVIEW`).
10. Insert `audit_logs` row.
11. Return `{ok:true, eventId, duplicate, status}` in ≤200 ms.

## Dashboard flow

1. Browser hits `dashboard.example.com`.
2. Cloudflare Access sits in front; only authenticated sessions reach the Worker.
3. Worker reads `Cf-Access-Jwt-Assertion`, verifies with `jose` against `ACCESS_ISSUER/.well-known/jwks.json`, checks `aud == ACCESS_AUD` and `iss == ACCESS_TEAM_DOMAIN`.
4. Look up `access_users.email` → role. Reject if missing/inactive.
5. RBAC gates API routes. WRITE routes require `ADMIN` or `REVIEWER`.
6. React SPA loads from static assets; calls API under `/api/v1/...`.

## Schema highlights

- `raw_sms_events.body_sha256` UNIQUE per device (server-side fingerprint).
- `device_credentials.token_hash` UNIQUE.
- `reconciliation_matches.transaction_candidate_id` + `payment_claim_id` UNIQUE.
- `transaction_candidates.status` and `payment_claims.status` carry CHECK constraints restricting transitions at the DB layer where practical. The application layer is the source of truth.

## Build / deploy

```bash
pnpm install
pnpm -r typecheck
pnpm -r test
pnpm --filter @hub/ingest-worker db:migrate
pnpm --filter @hub/dashboard-worker db:migrate
pnpm --filter @hub/dashboard-worker build
pnpm --filter @hub/ingest-worker deploy --dry-run
pnpm --filter @hub/dashboard-worker deploy --dry-run
```

## Out of scope (MVP)

- Webhook delivery to VPN system — interface defined, not implemented.
- R2 receipt storage — column exists, no upload path.
- Playwright E2E — written after the vertical slice passes unit + integration.
- Full bulk-action UI — defined, minimal version first.
