/**
 * TOTP — RFC 6238, on top of `node:crypto`.
 *
 * No dependency. The whole algorithm is an HMAC, a big-endian counter and a
 * truncation, and every authenticator app on a phone already implements the
 * other side.
 *
 * SHA-1 is not a mistake here. RFC 6238 allows SHA-256 and SHA-512, but every
 * mainstream authenticator app ignores the `algorithm` parameter and assumes
 * SHA-1, so a secret generated with anything else produces codes that never
 * match and an operator who cannot log in. The security argument does not
 * apply either: HMAC-SHA1 is unbroken, and the value it protects lives for
 * thirty seconds.
 *
 * The six-digit code is never stored, never logged and never rendered by us —
 * only `secret` is persisted, and the caller must treat it as a credential.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 6238's default, and what every authenticator app assumes. */
export const STEP_SECONDS = 30;
const DIGITS = 6;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, no padding — the encoding every authenticator app reads. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Decode a base32 secret, or throw.
 *
 * Throws rather than returning a partial buffer: a secret that decodes to the
 * wrong bytes produces codes that are wrong every single time, which reads to
 * whoever is looking as "TOTP is broken" rather than "this secret is not
 * base32". Padding and spaces are tolerated because people paste them.
 */
export function base32Decode(secret: string): Buffer {
  const clean = secret.replace(/[\s=]/g, '').toUpperCase();
  if (clean === '') throw new Error('empty base32 secret');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`not base32: ${JSON.stringify(char)}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh secret. 20 bytes is what RFC 4226 calls for and what apps expect. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The counter for a moment in time. Exported so callers can store the step they consumed. */
export function stepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/** The code for one counter value. RFC 4226 section 5.3. */
export function codeForStep(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  // Big-endian across all 64 bits. `writeBigUInt64BE` rather than writing the
  // low 32: the high half stays zero until the year 10 000, but a counter that
  // silently wraps is not the kind of bug that shows up in testing.
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Check a code, and say which step it belonged to.
 *
 * The step is the point. Returning only true/false leaves the caller no way to
 * refuse the same code twice, and a six-digit code is live for thirty seconds —
 * long enough for anyone who reads it over a shoulder or off a proxy log to
 * spend it a second time. The caller stores the returned step and rejects
 * anything not greater than it.
 *
 * `window` is one step either side, the tolerance RFC 6238 section 5.2
 * recommends: it forgives a phone whose clock has drifted and a person who
 * starts typing at second 29.
 */
export function verifyTotp(
  secret: string,
  code: string,
  nowMs: number,
  window = 1,
): { ok: true; step: number } | { ok: false } {
  const clean = code.replace(/\s/g, '');
  // Length is checked before comparing so `timingSafeEqual` cannot throw, and
  // a wrong-length code is not a timing signal about anything.
  if (!/^\d{6}$/.test(clean)) return { ok: false };
  const now = stepAt(nowMs);
  for (let offset = -window; offset <= window; offset += 1) {
    const step = now + offset;
    if (step < 0) continue;
    const expected = Buffer.from(codeForStep(secret, step));
    if (timingSafeEqual(expected, Buffer.from(clean))) return { ok: true, step };
  }
  return { ok: false };
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * `issuer` appears twice — once in the label prefix and once as a parameter —
 * because apps disagree about which one they read, and an entry that shows up
 * as a bare email address next to eleven others is how people lock themselves
 * out of the wrong account.
 */
export function otpauthUri(secret: string, account: string, issuer = 'Shikoo'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
