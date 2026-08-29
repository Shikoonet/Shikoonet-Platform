# Cloudflare Access

How the dashboard Worker uses Cloudflare Access to authenticate reviewers.

## Topology

```
Browser ─▶ dashboard.pages.dev ─▶ Cloudflare Access ─▶ dashboard Worker
                                          │
                                          └─ adds Cf-Access-Jwt-Assertion header
```

## Configuration

1. In the Cloudflare Zero Trust dashboard, create an **Application** of type
   _Self-hosted_ with the dashboard host as the application domain.
2. Set the **Application Audience (AUD)** tag. Copy the value into the
   `ACCESS_AUD` Wrangler secret.
3. Set the **issuer URL** (e.g. `https://<team>.cloudflareaccess.com`) into
   the `ACCESS_ISSUER` Wrangler secret.
4. Define an **Access policy**: `Allow` if `Emails` matches
   `<admin-or-reviewer-email>`.
5. Add the dashboard Worker's secrets:

   ```bash
   wrangler secret put ACCESS_AUD       # the AUD tag from step 2
   wrangler secret put ACCESS_ISSUER    # the issuer URL from step 3
   ```

## Verification

The dashboard Worker (`apps/dashboard-worker/src/access.ts`) verifies the JWT:

1. Reads `Cf-Access-Jwt-Assertion` from the incoming request.
2. Fetches the JWKS from `${ISSUER}/cdn-cgi/access/certs`.
3. Calls `jose.jwtVerify(jwt, jwks, { audience: ACCESS_AUD, issuer: ACCESS_ISSUER })`.
4. Extracts `email` from the payload.

If any step fails, the request is rejected with `401 unauthorized`.

## Local development

Set `TEST_ACCESS_USER = "you@example.com"` in `wrangler.toml`'s `[vars]` to
bypass JWT verification and pin an identity. **Production must leave this
unset.** The bypass is gated by `if (env.TEST_ACCESS_USER)` so an empty
string disables it (falsy).

## RBAC

After verifying the email, the Worker looks up `access_users` for the email:

| Role        | Read | Approve | Reject | Manage devices | Manage accounts |
| ----------- | ---- | ------- | ------ | -------------- | --------------- |
| `READ_ONLY` | ✓    | ✗       | ✗      | ✗              | ✗               |
| `REVIEWER`  | ✓    | ✓       | ✓      | ✗              | ✗               |
| `ADMIN`     | ✓    | ✓       | ✓      | ✓              | ✓               |

A missing `access_users` row returns `403 forbidden`. Adding a reviewer:

```sql
INSERT INTO access_users (id, email, role, active, created_at, updated_at)
VALUES ('uuid', 'reviewer@example.com', 'REVIEWER', 1, 1735689600000, 1735689600000);
```

## Security

- The Worker **never** trusts an `X-Auth-Email` or `Cf-Access-Authenticated-User-Email`
  header directly. Only the JWT is authoritative.
- The `email` from the JWT is matched against `access_users` (case-sensitive).
  An attacker who steals a JWT for a non-allowlisted email cannot escalate.
- The `Cf-Access-Jwt-Assertion` header is set by Cloudflare's edge and cannot
  be set by an end user.
- All non-GET requests go through the `originGuard` middleware (see
  `apps/dashboard-worker/src/security.ts`) which rejects cross-origin POSTs
  from unknown `Origin` headers.

## Logging

Successful auth is logged via `audit_logs` with `action='access.allowed'`.
Failed auth is logged as `access.denied` with the reason. No JWT contents
are logged (only the email claim).
