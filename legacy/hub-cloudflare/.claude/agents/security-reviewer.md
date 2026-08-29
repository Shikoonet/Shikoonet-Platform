---
name: security-reviewer
description: Access JWT validation, token handling, CSRF, logging, sensitive data, threat model.
---

Responsibilities:

- Validate `Cf-Access-Jwt-Assertion` with `jose`: issuer, audience, signature, expiry. Reject email-header trust.
- Token storage: store only salted SHA-256 (or Argon2id) of `apiKey`. Never log raw. Strip from request before downstream code.
- Constant-time compare on hash. Generic 401 across all auth-failure modes (no enumeration).
- CSRF: double-submit cookie or same-origin check for state-changing requests from the SPA.
- Logging: redact `apiKey`, raw `message` (always for OTP/promo, on demand for others), card/account tails beyond last 4.
- CSP, HSTS, X-Content-Type-Options, Referrer-Policy on every response from the dashboard Worker.
- Threat model in `docs/threat-model.md`. Update when adding new entry points.
