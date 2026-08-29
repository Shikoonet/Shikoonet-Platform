# API Contract

Stable wire types live in `packages/contracts/src/index.ts` and are imported
by both Workers and the SPA. They are the source of truth for every endpoint
below.

## Conventions

- All responses use `Content-Type: application/json`.
- Successful responses include `"ok": true`; errors include `"ok": false`,
  an `error` string, and an HTTP status.
- All timestamps are epoch milliseconds (INTEGER).
- All money is IRR (INTEGER). The SPA formats with `Intl.NumberFormat`.

## ingest Worker — public, API-key auth

### `POST /api/v1/sms`

Submit a single SMS event from a device. Authentication is the bearer
`apiKey`. Every other field is part of the device's identity envelope.

**Request**

```json
{
  "apiKey": "<40-char secret>",
  "deviceId": "<device_code>",
  "deviceName": "<operator label>",
  "message": "<raw SMS body>",
  "sender": "<sender phone or label>",
  "timestamp": "<epoch ms, 10–16 digits>",
  "checksum": "<32-char hex sha-1 of the device's app build>"
}
```

**200 OK** — first time or duplicate:

```json
{
  "ok": true,
  "eventId": "uuid",
  "duplicate": false,
  "status": "received"
}
```

- `duplicate: true` + `status: "already_received"` if the same `(deviceId,
sender, timestamp, normalized_body)` tuple was already seen. The original
  `eventId` is returned.

**401 Unauthorized** — any auth failure (unknown device, bad apiKey, revoked
credential, disabled device). Body is the same generic shape:

```json
{ "ok": false, "error": "unauthorized", "code": "UNAUTHORIZED" }
```

**413 Payload Too Large** — body > 8 KB.

**429 Too Many Requests** — per-device (600/min) or per-IP (1200/min) limit.

**400 Bad Request** — body is not JSON, missing required field, or
`timestamp` is not numeric.

### `GET /health`

```json
{ "ok": true }
```

## dashboard Worker — Cloudflare Access protected

All endpoints require a valid `Cf-Access-Jwt-Assertion` header. The Access
app is configured for the dashboard's hostname only.

### `GET /api/v1/health`

```json
{ "ok": true }
```

### `GET /api/v1/today`

Returns transactions whose `bank_timestamp` falls in the current UTC day.
Admin / Reviewer / Read-Only all allowed.

```json
{
  "ok": true,
  "count": 12,
  "items": [
    {
      "id": "uuid",
      "direction": "CREDIT",
      "amount_irr": 1500000,
      "balance_irr": 12345000,
      "status": "PARSED",
      "bank_timestamp": 1735689600000,
      "financial_account_id": "uuid"
    }
  ]
}
```

### `GET /api/v1/matches`

Joins matches with transactions, claims, and accounts. Returns the open
review queue.

### `GET /api/v1/devices`

```json
{
  "ok": true,
  "items": [
    {
      "id": "uuid",
      "device_code": "phone-a",
      "display_name": "Test Phone 1",
      "active": 1,
      "last_seen_at": 1735689600000
    }
  ]
}
```

### `GET /api/v1/accounts`

```json
{
  "ok": true,
  "items": [
    {
      "id": "uuid",
      "display_name": "Melli Test Phone 1",
      "bank_name": "Melli",
      "card_last_four": "1234",
      "account_last_four": "5678"
    }
  ]
}
```

### `GET /api/v1/comments?type=MATCH&id={matchId}`

Returns comments for an entity.

### `POST /api/v1/comment`

```json
{ "entityType": "MATCH", "entityId": "uuid", "body": "Reviewed by E2E" }
```

`READ_ONLY` → 403.

### `POST /api/v1/match/approve`

```json
{ "transactionCandidateId": "uuid", "matchId": "uuid", "comment": "looks good" }
```

- `READ_ONLY` → 403.
- Missing fields → 400.
- Tx / match not found → 404.
- Status transition invalid → 409.

### `POST /api/v1/match/reject`

```json
{ "matchId": "uuid", "reason": "FAKE_RECEIPT", "comment": "fake receipt" }
```

`reason` ∈ `FAKE_RECEIPT`, `NO_BANK_TRANSACTION`, `DUPLICATE`, `WRONG_AMOUNT`,
`WRONG_ACCOUNT`, `EXPIRED`, `REFUNDED`, `TEST_PAYMENT`, `OTHER`.

`READ_ONLY` → 403.

## Versioning

- Wire types are versioned in `packages/contracts/src/version.ts` (a single
  exported `WIRE_VERSION = "1"`).
- Breaking changes require bumping the wire version AND adding the new path
  under `/api/v2/...`. The old version stays live for one release cycle.

## Error envelope

All error responses use:

```ts
{ ok: false; error: string; code?: string }
```

`code` is a programmatic identifier (`UNAUTHORIZED`, `RATE_LIMITED`,
`PAYLOAD_TOO_LARGE`, `BAD_REQUEST`, `NOT_FOUND`, `CONFLICT`, etc.). Clients
should branch on `code`, not `error`, because `error` is a human-readable
string and may change.
