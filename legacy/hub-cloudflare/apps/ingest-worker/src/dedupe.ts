/**
 * Idempotent dedupe key. SHA-256 over the canonical tuple:
 *
 *     deviceId | sender | sms_timestamp | sha256(normalized_body)
 *
 * The normalized-body hash is computed by the parser package, so the same
 * `deviceId + sender + timestamp` with whitespace-only differences is
 * treated as the SAME delivery. The app-provided checksum is stored
 * separately for forensics but does NOT participate in this key — the spec
 * is explicit that the app checksum is a duplicate-detection hint only and
 * may collide across different bodies.
 */

import { sha256Hex } from './auth.js';

export interface FingerprintInput {
  deviceId: string;
  sender: string;
  timestamp: string | number;
  normalizedBody: string;
}

export async function bodyFingerprint(input: FingerprintInput): Promise<string> {
  const ts = String(input.timestamp);
  const bodyHash = await sha256Hex(input.normalizedBody);
  const canonical = `${input.deviceId}|${input.sender}|${ts}|${bodyHash}`;
  return sha256Hex(canonical);
}

export async function bodyOnlyHash(normalizedBody: string): Promise<string> {
  return sha256Hex(normalizedBody);
}
