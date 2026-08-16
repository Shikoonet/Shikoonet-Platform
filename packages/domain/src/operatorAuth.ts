/**
 * Operator passwords and session tokens.
 *
 * Pure: no database handle, no environment, no clock of its own. The same rule
 * `mirzabotMatch.ts` follows, for the same reason — everything here is worth
 * testing exhaustively and nothing here should need a Postgres to test.
 *
 * `scrypt` from `node:crypto` rather than argon2 or bcrypt. Both are better in
 * theory; both are native modules, and this repository builds one Docker image
 * that runs three services, so a native build is a whole class of deployment
 * failure bought for a difference that does not matter at the size of this
 * problem. scrypt is memory-hard, it is in the standard library, and the thing
 * it protects is a handful of operator accounts behind a lockout.
 */

import {
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

/**
 * Hand-wrapped rather than `promisify(scrypt)`.
 *
 * The reason is typing, not behaviour: `promisify` forwards every argument at
 * runtime, but its types resolve `scrypt` to the three-argument overload, so
 * the call with `options` does not compile. Writing the wrapper keeps the cost
 * parameters type-checked at the one place they are passed, which is the place
 * where getting them wrong is silent — a hash with Node's defaults verifies
 * perfectly well and is simply cheaper than this file claims.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/**
 * Cost parameters, stored in the hash so they can be raised without
 * invalidating anybody's password.
 *
 * N=2^15 with r=8 needs about 32 MB and roughly 100 ms on the deployment
 * server. `maxmem` has to be raised explicitly because Node's default is 32 MB
 * exactly, which this sits right on top of — leave it out and the first login
 * after a bump fails with an error about memory rather than about the password.
 */
const N = 32768;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const SALT_BYTES = 16;

function maxmem(n: number, r: number): number {
  return 256 * n * r * 2;
}

/** `scrypt$N$r$p$<salt base64>$<hash base64>` */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: maxmem(N, R),
  });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/**
 * Check a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed or absent hash. An operator
 * row with `password_hash` NULL is one nobody has given a password to yet, and
 * that is a refusal, not an error — the caller must not have to tell the two
 * apart at the login route, where telling them apart is exactly what leaks
 * which accounts exist.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // A hostile row could otherwise name a cost that hangs the process. These are
  // generous next to the current parameters and still bounded.
  if (n < 2 || n > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  try {
    const salt = Buffer.from(parts[4]!, 'base64');
    const want = Buffer.from(parts[5]!, 'base64');
    if (salt.length === 0 || want.length === 0) return false;
    // The length comes from the stored hash, not from KEY_LENGTH, so raising
    // the constant later does not lock out everybody hashed before the change.
    const key = await scrypt(password.normalize('NFKC'), salt, want.length, {
      N: n,
      r,
      p,
      maxmem: maxmem(n, r),
    });
    return timingSafeEqual(key, want);
  } catch {
    return false;
  }
}

/**
 * A new session token, and the hash to store for it.
 *
 * The caller sends `token` to the browser and writes `hash` to
 * `operator_sessions.token_hash`. The plain token is never persisted, so the
 * table is useless to anyone who reads it.
 *
 * SHA-256 with no salt and no stretching is right here and wrong for passwords.
 * A password is short, guessable and reused; this is 32 bytes from a CSPRNG,
 * so there is no dictionary to run and nothing a slow hash would buy — while a
 * slow hash on every single request would be paid on every single request.
 */
export function newSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashSessionToken(token) };
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('base64');
}

/**
 * How many failures before the door closes, and for how long.
 *
 * Five is enough that a person mistyping their own password twice and then
 * trying an old one still gets in; fifteen minutes is long enough that guessing
 * is hopeless and short enough that the operator does not phone anybody. The
 * counting itself belongs in the UPDATE that records the failure, never in a
 * SELECT followed by an UPDATE — two simultaneous wrong guesses would each read
 * the same count and each write the same number back.
 */
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;

/**
 * The minimum a password must clear.
 *
 * Length only. Composition rules (an uppercase, a digit, a symbol) push people
 * towards `Password1!` and are worth less than four more characters; the real
 * defences here are the lockout and TOTP. Twelve rather than eight because
 * there is no reason to be generous with a handful of operator accounts.
 */
export const MIN_PASSWORD_LENGTH = 12;

export function passwordProblem(password: string): string | null {
  const normalized = password.normalize('NFKC');
  if (normalized.length < MIN_PASSWORD_LENGTH) {
    return `رمز باید دست‌کم ${MIN_PASSWORD_LENGTH} کاراکتر باشد`;
  }
  // A password made of one repeated character clears any length rule.
  if (new Set(normalized).size < 4) {
    return 'رمز باید دست‌کم چهار کاراکتر متفاوت داشته باشد';
  }
  return null;
}
