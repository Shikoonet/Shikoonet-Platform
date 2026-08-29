# Device Registration

Devices must be registered before they can submit SMS events.

## Registration flow

1. **Admin** generates a device record in the dashboard (POST
   `/api/v1/devices`). The response includes:
   - `id` — internal UUID
   - `device_code` — the operator-facing identifier (e.g. `phone-a`)
   - `apiKey` — 40-character base64url secret. **Shown once.**
2. **Operator** configures the Android SMS Relay app with `device_code` and
   `apiKey`.
3. **App** posts the first SMS to `/api/v1/sms`. The ingest Worker:
   - Looks up the device by `device_code`.
   - Hashes the presented `apiKey` with SHA-256.
   - Compares to the stored hash with constant-time compare.
   - On match: stores the raw SMS event and returns `200 OK { ok: true, eventId }`.
   - On mismatch: returns generic `401 { ok: false, error: "unauthorized" }`.
4. **Dashboard** shows the first event on the **Today** tab within a few
   seconds.

## API

### Create a device

```http
POST /api/v1/devices
Authorization: Bearer <admin access token>
Content-Type: application/json

{
  "device_code": "phone-a",
  "display_name": "Test Phone 1",
  "description": "Operator's primary phone" // optional
}
```

```json
// 201 Created
{
  "ok": true,
  "device": {
    "id": "uuid",
    "device_code": "phone-a",
    "display_name": "Test Phone 1",
    "active": 1
  },
  "apiKey": "abcd...40chars"
}
```

### List devices

```http
GET /api/v1/devices
```

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

### Disable a device

```http
POST /api/v1/devices/{id}/disable
```

`active` is set to 0. Existing credentials stop authenticating.

### Re-enable

```http
POST /api/v1/devices/{id}/enable
```

`active` is set to 1.

## Idempotency

`device_code` is `UNIQUE` in D1. Re-creating with the same code returns the
existing device's `id` rather than 409.

## Failure modes

| Symptom               | Cause                                                                   | Fix                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401 on every request  | Wrong apiKey, wrong device_code, revoked credential, or disabled device | Check `audit_logs.action='auth.failed'` (no — we don't log auth failures for enumeration safety). Use the dashboard **Devices** tab to inspect `last_auth_failure_at`. |
| 413 PAYLOAD_TOO_LARGE | Body exceeds 8 KB                                                       | The SMS Relay app enforces its own limit; check app-side config.                                                                                                       |
| 429 RATE_LIMITED      | Per-device limit (600/min) or per-IP limit (1200/min) tripped           | Back off; the dashboard surfaces the rate-limit window.                                                                                                                |
