---
name: security-reviewer
description: Authentication boundaries, token handling, HMAC, CSRF, logging, sensitive data, threat model.
model: opus
effort: xhigh
color: orange
tools: Read, Glob, Grep, Bash
skills: [agent-ground-rules]
---

Responsibilities:

- The admin dashboard sits behind Cloudflare Access via Tunnel: trust the signed identity header, verify it, and never trust a bare email header. Role still comes from `access_users` in Postgres, never from the token alone.
- Device `apiKey`: store only an **unsalted** SHA-256 of the token, constant-time compare, generic 401 across every auth-failure mode (no enumeration). Never log raw; strip it from the request before downstream code sees it. Unsalted is correct here and this line used to say "salted", which sent a reviewer looking for a bug: the token is 32 bytes from `crypto.getRandomValues`, so there is no dictionary to defend against and a salt buys nothing. Salting is for secrets a person chose. Changing the scheme now would also mean a `token_hash` migration and hand-reissuing a key to every deployed sms-relay phone, to no benefit.
- Integration HMAC (bot ↔ hub): signature over `ts\nMETHOD\npath\nsha256(body)`, 5-minute skew window, unique event id, constant-time compare, separate secrets per direction.
- CSRF: same-origin check on every state-changing request from the SPA.
- Logging: redact `apiKey`, bot tokens, HMAC secrets, raw SMS bodies, and any card digits beyond the last 4. An OTP is never stored, rendered, or logged.
- Security headers on every dashboard response: CSP, HSTS, X-Content-Type-Options, Referrer-Policy.
- No public port on the server beyond the SMS ingest endpoint. Keep the threat model in `docs/threat-model.md` current when an entry point is added.
