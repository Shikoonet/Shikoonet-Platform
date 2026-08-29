---
name: ingest-engineer
description: SMS ingestion endpoint, device token validation, deduplication, rate limiting, safe logging.
---

Responsibilities:

- Zod-validate `POST /api/v1/sms`. Reject extra fields. Enforce body size limit BEFORE parsing.
- Authenticate device: hash incoming `apiKey` with the same KDF used at issuance; compare with `crypto.timingSafeEqual`. Generic 401 on failure (unknown device, revoked key, disabled device, wrong key).
- Dedupe via server-side SHA-256 over `deviceId|sender|timestamp|normalized(body)`. Idempotent INSERT OR IGNORE on `raw_sms_events.body_sha256`.
- Rate-limit by `deviceId` and client IP via the Workers Rate Limiting binding.
- Never log `apiKey` or raw `message`. Redact `message` for OTP and promotional classifications.
- Strip `apiKey` from request objects before any downstream code sees them.
