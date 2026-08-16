/**
 * TOTP, measured against RFC 6238 rather than against itself.
 *
 * This is the whole reason the file exists in this shape. An implementation
 * that is internally consistent — encode, decode, generate, verify, all
 * agreeing — proves nothing at all, because a phone running Google
 * Authenticator was never consulted. The published test vectors ARE that
 * phone: if these pass, an authenticator app will agree, and if they fail no
 * amount of self-consistency will help.
 *
 * Vectors from RFC 6238 Appendix B, the SHA-1 rows. The RFC prints eight
 * digits; truncation is `mod 10^n`, so the six-digit code is the last six of
 * the printed value, and both are asserted below so that claim is checked and
 * not merely believed.
 */

import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  codeForStep,
  generateSecret,
  otpauthUri,
  stepAt,
  verifyTotp,
  STEP_SECONDS,
} from '../src/totp.js';

/** RFC 6238 Appendix B: the ASCII string "12345678901234567890". */
const RFC_SECRET_ASCII = '12345678901234567890';
const RFC_SECRET = base32Encode(Buffer.from(RFC_SECRET_ASCII, 'ascii'));

/** Seconds since the epoch → the eight-digit code the RFC prints. */
const VECTORS: [seconds: number, eightDigits: string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('RFC 6238 test vectors', () => {
  it('encodes the RFC secret to the base32 every authenticator app expects', () => {
    // Published in countless implementations of this same test; if this line
    // is wrong every vector below is testing the wrong secret.
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(RFC_SECRET).toString('ascii')).toBe(RFC_SECRET_ASCII);
  });

  for (const [seconds, eightDigits] of VECTORS) {
    it(`T=${seconds} → ${eightDigits.slice(-6)}`, () => {
      const step = stepAt(seconds * 1000);
      expect(step).toBe(Math.floor(seconds / STEP_SECONDS));
      expect(codeForStep(RFC_SECRET, step)).toBe(eightDigits.slice(-6));
    });
  }

  it('accepts the RFC code at the moment the RFC says it is live', () => {
    for (const [seconds, eightDigits] of VECTORS) {
      const result = verifyTotp(RFC_SECRET, eightDigits.slice(-6), seconds * 1000);
      expect(result).toEqual({ ok: true, step: stepAt(seconds * 1000) });
    }
  });
});

describe('verifyTotp', () => {
  // Pinned, never `Date.now()`: a test whose expectation is tied to the wall
  // clock is a bomb with a thirty-second fuse.
  const NOW = 1_234_567_890_000;
  const CODE = codeForStep(RFC_SECRET, stepAt(NOW));

  it('forgives one step of drift in both directions', () => {
    const early = NOW - STEP_SECONDS * 1000;
    const late = NOW + STEP_SECONDS * 1000;
    expect(verifyTotp(RFC_SECRET, CODE, early).ok).toBe(true);
    expect(verifyTotp(RFC_SECRET, CODE, late).ok).toBe(true);
  });

  it('refuses two steps away, so the window is a window and not a door', () => {
    const far = NOW + 2 * STEP_SECONDS * 1000;
    expect(verifyTotp(RFC_SECRET, CODE, far).ok).toBe(false);
  });

  it('reports the step it matched, which is what lets the caller refuse a replay', () => {
    // The caller stores this and rejects anything not greater. Without it the
    // same six digits are spendable for the whole ninety-second window.
    const first = verifyTotp(RFC_SECRET, CODE, NOW);
    const second = verifyTotp(RFC_SECRET, CODE, NOW + 1000);
    expect(first).toEqual({ ok: true, step: stepAt(NOW) });
    expect(second).toEqual(first);
  });

  it('refuses anything that is not six digits', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56', '  ']) {
      expect(verifyTotp(RFC_SECRET, bad, NOW).ok).toBe(false);
    }
  });

  it('tolerates the spaces an authenticator app puts in the middle', () => {
    expect(verifyTotp(RFC_SECRET, `${CODE.slice(0, 3)} ${CODE.slice(3)}`, NOW).ok).toBe(true);
  });

  it('refuses a code built from a different secret', () => {
    const other = base32Encode(Buffer.from('09876543210987654321', 'ascii'));
    expect(verifyTotp(other, CODE, NOW).ok).toBe(false);
  });
});

describe('base32', () => {
  it('round-trips every byte length, which is where padding goes wrong', () => {
    for (let length = 1; length <= 32; length += 1) {
      const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 37 + 11) & 255));
      expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    }
  });

  it('reads back a secret typed with padding and spaces', () => {
    const bytes = Buffer.from('hello world!', 'ascii');
    const encoded = base32Encode(bytes);
    expect(base32Decode(`${encoded.slice(0, 4)} ${encoded.slice(4)}==`)).toEqual(bytes);
  });

  it('throws on something that is not base32 rather than decoding it wrong', () => {
    // A secret that quietly decodes to the wrong bytes fails every login and
    // looks like "TOTP is broken" instead of "this secret is malformed".
    expect(() => base32Decode('1')).toThrow();
    expect(() => base32Decode('')).toThrow();
  });
});

describe('generateSecret', () => {
  it('is 20 bytes, which is what RFC 4226 asks for', () => {
    expect(base32Decode(generateSecret())).toHaveLength(20);
  });

  it('is different every time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateSecret()));
    expect(seen.size).toBe(50);
  });
});

describe('otpauthUri', () => {
  it('names the issuer in both places apps look for it', () => {
    const uri = otpauthUri('GEZDGNBVGY3TQOJQ', 'sam@samsos.org');
    expect(uri.startsWith('otpauth://totp/Shikoo%3Asam%40samsos.org?')).toBe(true);
    expect(uri).toContain('issuer=Shikoo');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});
