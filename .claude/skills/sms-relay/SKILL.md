---
name: sms-relay
description: Integrate with sms-relay (automagen-ab/sms-relay), an Android app that POSTs every incoming SMS to a user-configured HTTP endpoint ("Remote"). Use when building or modifying the receiver side of this project.
---

# sms-relay

Android app. Listens for incoming SMS on the device, forwards each one to a user-configured HTTP endpoint. Source: https://github.com/automagen-ab/sms-relay. GPL-3.0.

This skill covers the **receiving end** — what to build server-side. The Android side is not modified from here.

## Protocol (default Remote)

Each incoming SMS triggers one HTTP request. Default Remote is `POST application/json`:

```json
{ "message": "<sms_body>", "sender": "<addr>", "timestamp": "<epoch_ms>" }
```

Headers: `Content-Type: application/json; charset=utf-8`, `Accept: application/json`.

## Placeholders

`SmsWorker.kt` substitutes these into the URL, query string, body, and form fields:

- `{sms_body}` — full message body (multipart SMS concatenated client-side)
- `{sms_sender}` — originating address (e.g. phone number)
- `{sms_timestamp}` — `SmsMessage.timestampMillis` as a string (epoch ms)
- `{sms_checksum}` — lowercase MD5 hex of the body bytes (`SmsReceiver.kt`)

## Per-Remote variants

Each Remote is independently configured. The user picks one of:

| `method` | `useFormData` | Body / Content-Type |
|----------|---------------|---------------------|
| `POST`   | `false`       | JSON — template from `postJsonBody` (`application/json; charset=utf-8`) |
| `POST`   | `true`        | URL-encoded — `formDataParameters` list (`application/x-www-form-urlencoded; charset=utf-8`) |
| `GET`    | n/a           | Query string from `formDataParameters` |

Defaults (`RemoteConfig.kt`): `POST`, `useFormData = true`, keys `message` / `sender` / `timestamp`.

## Filtering

Each Remote has a `regexFilter` matched against `sender` only. Non-matching → no request sent (no error, just skipped).

## Delivery semantics

- Transport: `WorkManager` → `SmsWorker` (`CoroutineWorker`) → `HttpURLConnection`.
- Retries on non-2xx: up to 3 attempts (`runAttemptCount`), then marked `FAILED` in the app's local log.
- Timeouts: `connectTimeout=15s`, `readTimeout=10s`.
- No built-in auth header. Users inject one via a placeholder field if at all (e.g. add `Authorization` to `formDataParameters` or a custom JSON field).
- **Security:** `SmsWorker` installs a permissive `X509TrustManager` that accepts all certificates — treat the transport as unauthenticated and require an app-level auth token.

## Receiver must

- Return 2xx **fast**. Slow handlers → WorkManager retry storms.
- Be idempotent on `(sender, checksum)` — multipart concatenation is already done on-device.
- Persist before responding if delivery matters; the worker only marks `SUCCESS` on 2xx.
