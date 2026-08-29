# SMS Relay Configuration

How to point the existing Android [sms-relay](https://github.com/automagen-ab/sms-relay) app at this project. The app is **not modified** — only its outbound config changes.

## Outbound contract (per `SmsWorker.kt`)

```
POST {host}/sms
Content-Type: application/json
Authorization: Bearer {api_key}

{
  "deviceId":   "<string>",
  "deviceName": "<string>",
  "message":    "<string>",
  "sender":     "<string>",
  "timestamp":  "<epoch_ms_string>",
  "checksum":   "<32-char_hex>"
}
```

This project mounts the same handler at `POST /api/v1/sms` so an Android device
configured for either path will work after DNS / path adjustment.

## Configuring the device

1. Install the SMS Relay app from the Play Store / F-Droid.
2. Open the app → **Settings → Outbound**.
3. Set:
   - **Server URL**: `https://<ingest-worker-host>/api/v1/sms`
   - **API Key**: the value the admin dashboard generated for the device
     (shown once at creation; only the SHA-256 hash + 4-char prefix are stored
     in D1).
   - **Device Code**: human-friendly identifier, e.g. `phone-a` (must be unique
     and pre-registered via the admin `devices` API).
4. Whitelist SMS senders per device (comma-separated list of phone numbers or
   sender labels) to limit the SMS that the app forwards.

## Registering a device

The admin calls:

```bash
curl -X POST https://<dashboard-host>/api/v1/devices \
  -H "Authorization: Bearer <admin access token>" \
  -H "Content-Type: application/json" \
  -d '{
    "device_code": "phone-a",
    "display_name": "Test Phone 1"
  }'
```

The response contains a freshly generated `apiKey`. **Copy it now** — it is
never retrievable again. Hand it to the device operator over a trusted channel
(Signal, in person). The dashboard stores only the SHA-256 hash.

## Verifying connectivity

Send a test SMS to the device from a whitelisted sender. The dashboard's
**Today** tab should show the parsed transaction within a few seconds. If not,
check:

1. **Wrangler tail** on the ingest Worker — failed auth returns 401 with
   `error: "unauthorized"`. No body, no log line.
2. **D1 audit log** — `audit_logs.action='sms.received'` rows indicate
   successful ingestion.
3. **App's request log** — the SMS Relay app's own `RemoteConfig.kt` shows
   the last attempted URL + status code.

## Rotating a credential

The dashboard exposes `POST /api/v1/devices/{id}/rotate` which:

1. Inserts a new `device_credentials` row with status `ACTIVE` and the
   previous one in `ROTATING` (still valid for a grace window).
2. Returns the new `apiKey` (one-time).
3. After the grace window expires, the dashboard flips the old credential to
   `REVOKED` via a cron Worker — see `docs/cloudflare-architecture.md` §
   "Credential rotation".

## Revoking a credential

```bash
curl -X POST https://<dashboard-host>/api/v1/devices/{id}/revoke \
  -H "Authorization: Bearer <admin access token>" \
  -d '{ "credentialId": "<id>", "reason": "device_lost" }'
```

The credential flips to `REVOKED` and all subsequent requests from the device
return generic 401.
