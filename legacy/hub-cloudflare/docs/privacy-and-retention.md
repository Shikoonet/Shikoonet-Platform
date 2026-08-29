# Privacy and Data Retention

What personal data the system stores, how long, and how to remove it.

## Data inventory

| Table                    | Fields with personal data                       | Retention                          |
| ------------------------ | ----------------------------------------------- | ---------------------------------- |
| `devices`                | `display_name`, `description` (operator labels) | Until device is deleted (admin)    |
| `device_credentials`     | `token_prefix` (4 chars of apiKey)              | Until credential is revoked        |
| `raw_sms_events`         | `sender`, `normalized_body`, `body_sha256`      | 90 days                            |
| `transaction_candidates` | `amount_irr`, `balance_irr`, `bank_timestamp`   | 7 years (financial record keeping) |
| `payment_claims`         | `external_order_id`, `customer_reference`       | 7 years                            |
| `access_users`           | `email`, `display_name`                         | Until user is deactivated          |
| `audit_logs`             | `actor_email`, action trail                     | 2 years                            |
| `comments`               | `author_email`, `body`                          | 2 years                            |

## Retention enforcement

A scheduled Worker (cron trigger) runs nightly:

```sql
DELETE FROM raw_sms_events
WHERE created_at < ?1  -- now - 90 days
  AND id NOT IN (SELECT raw_sms_event_id FROM transaction_candidates WHERE created_at > ?1);
```

For `transaction_candidates` and `payment_claims`, retention is the
business obligation (7 years under Iranian tax law). No automated deletion
runs on these tables.

## PII minimization

- **OTP bodies**: stored only as `'[redacted]'`. Plaintext is never
  persisted.
- **Promotional bodies**: same.
- **Account numbers**: only the last 4 digits stored. The full account
  number never reaches D1 — the SMS Relay app masks it before transmission
  (e.g. `*1234`), and the parser extracts the suffix.
- **apiKeys**: only SHA-256 hash + 4-char prefix. The full key never reaches
  D1.

## Subject access / erasure

The project is a single-tenant B2B tool — there is no per-customer
self-service dashboard. Erasure requests are processed by an admin:

1. Identify the device (`device_code`).
2. Run the erasure script:

   ```sql
   DELETE FROM raw_sms_events WHERE device_id = '<device.id>';
   DELETE FROM device_credentials WHERE device_id = '<device.id>';
   UPDATE devices SET active = 0, updated_at = ? WHERE id = '<device.id>';
   ```

3. Optionally delete the device record itself.

Erasure does not delete `transaction_candidates` or `payment_claims`
linked to those events — those are subject to the 7-year financial
retention. The customer's data within them is limited to amounts and
timestamps, not their full message bodies.

## Logging discipline

- **Never log apiKey** — not even in error paths.
- **Never log full OTP body** — log only the SHA-256 hash if a
  correlation id is needed.
- **Never log CF-Connecting-IP + email together** in plaintext.

## Data residency

The D1 database is created in the region selected during Cloudflare
account setup. Both Workers run in the same region by default.
There is no cross-region replication.
