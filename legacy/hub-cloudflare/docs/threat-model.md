# Threat Model

What the system protects against, and what it doesn't.

## Trust boundaries

```
        ┌─────────────────────────────────────┐
        │  Operator phone (untrusted client)  │
        └─────────────┬───────────────────────┘
                      │ HTTPS, bearer apiKey
                      ▼
        ┌─────────────────────────────────────┐
        │       Cloudflare Edge               │
        │  - TLS termination                  │
        │  - DDoS mitigation                  │
        │  - Workers Rate Limiting            │
        └─────────────┬───────────────────────┘
                      │ Cf-Access-Jwt-Assertion
                      ▼
        ┌─────────────────────────────────────┐
        │       ingest Worker                 │
        │  - Authenticates device             │
        │  - Normalizes + parses SMS          │
        │  - Persists to D1                   │
        └─────────────┬───────────────────────┘
                      │
                      ▼
        ┌─────────────────────────────────────┐
        │       D1 (SQLite)                   │
        │  - Append-only audit log            │
        │  - SHA-256 hash + prefix only       │
        └─────────────────────────────────────┘


        ┌─────────────────────────────────────┐
        │  Browser (admin/reviewer)           │
        └─────────────┬───────────────────────┘
                      │ HTTPS, Cf-Access JWT
                      ▼
        ┌─────────────────────────────────────┐
        │       Cloudflare Edge + Access      │
        └─────────────┬───────────────────────┘
                      │
                      ▼
        ┌─────────────────────────────────────┐
        │       dashboard Worker              │
        │  - JWT verified against JWKS        │
        │  - RBAC via access_users            │
        │  - Origin guard on state-changing   │
        └─────────────────────────────────────┘
```

## Threats

### T1 — Attacker steals `apiKey`

**Scenario**: Operator's phone is compromised; the SMS Relay app's local
config (with the apiKey) is exfiltrated.

**Impact**: Attacker can submit arbitrary SMS events. The parser will still
redact OTP/PROMO bodies, but attacker can spam bank-credit SMS, creating
fake reconciliation matches.

**Mitigations**:

- Per-device rate limit (600/min) caps spam.
- `audit_logs` records every auth success with device id and timestamp.
  Unusual bursts surface in the dashboard's device detail view.
- apiKey rotation (`POST /devices/{id}/rotate`) revokes the old key.
- The ingest Worker does NOT log the apiKey itself, only `token_prefix`
  (4 chars) — so log exfiltration doesn't reveal full keys.

**Detection**:

- `devices.last_auth_failure_at` rolling forward.
- `audit_logs.action='sms.received'` rate-of-change alerts.

### T2 — Attacker submits malformed / oversized SMS

**Scenario**: Attacker probes with random JSON to find bugs.

**Impact**: DoS via large payloads or parser side-effects.

**Mitigations**:

- 8 KB body cap (returns 413).
- Per-IP rate limit (1200/min).
- Zod strict schema — extra fields rejected.
- Parser is deterministic, no DB writes for unknown shapes.

### T3 — Attacker bypasses Cloudflare Access

**Scenario**: Attacker tries to call `/api/v1/match/approve` directly
without going through Access.

**Impact**: Could approve / reject matches.

**Mitigations**:

- The dashboard Worker requires `Cf-Access-Jwt-Assertion`. Without it, `401`.
- Cloudflare's edge strips incoming `Cf-Access-Jwt-Assertion` headers from
  untrusted clients and re-injects only after Access verifies the user.
  An attacker cannot forge it.
- Even if Access is bypassed, `access_users` row lookup fails closed (403).

### T4 — XSS via stored SMS body

**Scenario**: Attacker sends an SMS with `<script>alert(1)</script>` body.

**Impact**: Dashboard renders the body in a comment thread → XSS.

**Mitigations**:

- React escapes string content by default. `<script>` renders as text.
- The CSP header (`script-src 'self'`) blocks inline scripts even if a
  future vulnerability allows injection.
- `Content-Security-Policy: frame-ancestors 'none'` blocks clickjacking.

### T5 — CSRF on dashboard state changes

**Scenario**: Attacker hosts a page that auto-submits a POST to
`/api/v1/match/approve`.

**Impact**: Could approve / reject matches if the reviewer is logged in.

**Mitigations**:

- Cloudflare Access requires a JWT in a header, not a cookie. An
  attacker cannot read the JWT from another origin → browser cannot
  auto-attach it cross-origin.
- `originGuard` middleware rejects POST/PUT/DELETE with unknown `Origin`.
- `Content-Security-Policy: form-action 'self'` prevents form-submission
  to other origins.

### T6 — DB exfiltration

**Scenario**: Attacker gets read access to D1 (e.g. compromised Cloudflare
account).

**Impact**: Reads raw SMS bodies (including possibly PII), apiKey hashes,
reviewer emails.

**Mitigations**:

- OTP bodies are **never** stored in `normalized_body` — only
  `encrypted_or_protected_body = '[redacted]'`. The plaintext lives in the
  device's RAM for milliseconds before being discarded.
- apiKeys are SHA-256 hashed; the prefix alone (4 chars) does not enable
  auth.
- Reviewer emails are PII; treat any D1 access as a privacy incident.
- Audit log is append-only; suspicious reads show up in Cloudflare's
  D1 access logs.

### T7 — Supply chain

**Scenario**: Attacker compromises an npm dependency.

**Impact**: Could ship backdoors via Workers bundle.

**Mitigations**:

- `pnpm` with `package-lock.yaml` (and `--frozen-lockfile` in CI).
- `wrangler deploy` uploads the bundle to Cloudflare for review before
  promotion.
- The Worker runs in workerd — no `node:fs`, `node:child_process`, or other
  Node-only modules.

## Out of scope

- **Compromise of Cloudflare's edge.** Assumed not to happen.
- **Compromise of an operator's phone.** Out of our control; mitigated via
  rotation.
- **Spam from a real operator.** Treated as business-logic, not security.
- **Legal compliance.** The project does not claim GDPR/CCPA compliance out
  of the box; see `docs/privacy-and-retention.md` for the data inventory.
