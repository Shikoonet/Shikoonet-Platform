# Limitations

Things the project does not yet do, or does deliberately poorly.

## Deliberate omissions

- **No per-tenant config.** Single tenant, single scoring profile. To add
  multi-tenancy, you'd need a `tenant_id` column on every table and a
  scoped query path.
- **No LLM-backed parser.** The parser is deterministic and rule-based.
  Adding an LLM fallback would require a model binding + a separate
  decision boundary.
- **No webhook delivery.** `webhook_deliveries` table exists; no outbox
  worker polls it yet.
- **No R2 upload.** `payment_claims.receipt_url_or_r2_key` is set to
  NULL by the dashboard; uploads are not implemented.
- **No scheduled cleanup Worker.** The 90-day SMS retention is documented
  in `docs/privacy-and-retention.md` but the cron worker that deletes
  expired rows is not built.
- **No replay from a queue.** Once an event is deduped-by-fingerprint,
  there's no way to re-ingest with a different fingerprint without
  rotating the device. Acceptable for a private deployment.

## Known weak spots

- **Single-factor auth.** Cloudflare Access supports OTP / SSO providers.
  We require an email allowlist only.
- **No device-side rate limiting.** The Cloudflare Edge rate-limit binding
  protects the ingest endpoint but not the per-device account from a
  legitimate but runaway device. `devices.last_seen_at` is the only signal.
- **No automatic credential rotation.** Rotation is admin-initiated via
  `POST /devices/{id}/rotate`. The grace window between `ROTATING` and
  `REVOKED` is configurable but defaults to 24 hours and is not yet
  enforced by a cron.
- **Parser depends on regex + heuristics.** New bank SMS formats require
  hand-tuning the regex sets. We don't have an automated regression
  suite for parser inputs.
- **No first-class CI.** Tests run locally; there's no GitHub Actions
  workflow that runs `pnpm -r test` on every PR.
- **No telemetry.** No structured logs beyond what Cloudflare Workers
  already emits. No Sentry, no DataDog.
- **D1 region pinning.** D1 is created in whatever region the
  Cloudflare account selects. Cross-region access is not free.

## Out-of-scope work

- **Compliance audit (SOC2, ISO 27001).** Not certified.
- **GDPR data-subject-access workflow.** Documented but no tooling.
- **Mobile app.** The Android app is the upstream `sms-relay` project —
  not modified here.

## How to add what's missing

Most omissions above are one small Worker + one small D1 table away. See
`docs/cloudflare-architecture.md` for the layout, then add a new package
or a new route handler. The tests follow the patterns in
`apps/ingest-worker/test/integration.test.ts`.
