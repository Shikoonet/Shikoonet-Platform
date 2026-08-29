/**
 * Shared device token utilities used by both dashboard-worker (issuance)
 * and ingest-worker (validation).
 *
 * Token shape: a 32-byte random secret (256 bits) encoded as 64
 * lowercase hex characters.  Constant-time comparison is enforced by
 * ingest-worker; this module produces the bytes and the SHA-256 hash.
 *
 * INVARIANTS:
 *   - The plaintext token is shown to the user EXACTLY ONCE — at the
 *     endpoint that issues or rotates it.  Never logged.  Never persisted.
 *   - Only the SHA-256 hash + a 4-char non-secret prefix are stored.
 *   - Tokens are generated via `crypto.getRandomValues` in a 32-byte
 *     buffer.  `Math.random()` is NEVER used.
 *   - The first 4 hex chars of the token are also the prefix, so the
 *     ingest auth lookup only needs to scan `token_prefix` rows.
 */

/** Random 32-byte buffer → 64 lowercase hex chars.  Used as the API key. */
export function generateApiToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}

/** Public, non-secret prefix used to look up credentials. */
export function tokenPrefix(apiKey: string): string {
  return apiKey.slice(0, 4);
}

/** SHA-256 hex digest of the token.  Stored in `device_credentials.token_hash`. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string equality.  Both must be the same length. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Build the SMS Relay configuration blob the user pastes into the Android
 * app.  Exact placeholders must match the Android app's expectations
 * (see `IncomingSmsBody` in `@hub/contracts`).
 */
export interface SmsRelayConfig {
  method: 'POST';
  url: string;
  contentType: 'application/json';
  jsonBody: {
    apiKey: string;
    deviceId: string;
    deviceName: string;
    message: string;
    sender: string;
    timestamp: string;
    checksum: string;
  };
}

export function buildSmsRelayConfig(
  apiKey: string,
  deviceCode: string,
  displayName: string,
  ingestUrl: string,
): SmsRelayConfig {
  return {
    method: 'POST',
    url: ingestUrl,
    contentType: 'application/json',
    jsonBody: {
      apiKey,
      deviceId: deviceCode,
      deviceName: displayName,
      message: '{sms_body}',
      sender: '{sms_sender}',
      timestamp: '{sms_timestamp}',
      checksum: '{sms_checksum}',
    },
  };
}
