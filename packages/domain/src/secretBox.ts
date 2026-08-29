/**
 * Sealing a panel credential so it can live in Postgres.
 *
 * Until now `provisioning_providers.secret_ref` named a secret and never held
 * one: the value came from `PANEL_<REF>` in the process environment. That kept
 * the table safe to dump — and it also meant the admin panel could not add a
 * panel at all, because a dashboard cannot write an environment variable onto
 * the bot's container. A panel added through the UI would have been a row with
 * no credential, and `marzban.ts:150` answers that with `retryable: false`,
 * which is a paid order failing and refunding in front of the customer.
 *
 * So the credential moves into the database, sealed. Two properties are kept
 * rather than traded away:
 *
 *   - `provisioning_providers` still holds no secret of any kind. The
 *     ciphertext lives in its own table, `provider_secrets`, so the promise in
 *     that table's schema comment — dumpable, loggable, safe to hand to a
 *     support agent — stays literally true.
 *   - The key is not in the database. Anyone holding a dump holds ciphertext
 *     and nothing else; `PANEL_SECRET_KEY` is set on the two services that
 *     provision, and on nothing else.
 *
 * AES-256-GCM: authenticated, so a ciphertext edited in the database fails to
 * open rather than decrypting to something the panel then receives as a
 * password. A fresh 12-byte nonce per seal, which is what GCM requires — the
 * same nonce twice under one key loses confidentiality outright.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** GCM's standard nonce width. Not a preference — 96 bits is what the mode is built around. */
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class SecretKeyMissing extends Error {
  constructor(detail: string) {
    // Named for the operator who has to fix it, and it names the variable. A
    // "decryption failed" here would send somebody hunting the data.
    super(`PANEL_SECRET_KEY ${detail}`);
    this.name = 'SecretKeyMissing';
  }
}

/**
 * The key, from the environment, decoded and length-checked.
 *
 * A hex string rather than a passphrase run through a KDF: there is no user
 * choosing this, it is generated once by `openssl rand -hex 32`, and a KDF here
 * would only add a second thing to get wrong. Checked on every call rather than
 * cached, so rotating the variable takes a restart and not a redeploy.
 */
export function panelSecretKey(
  env: { PANEL_SECRET_KEY?: string | undefined } = process.env,
): Buffer {
  const raw = env.PANEL_SECRET_KEY?.trim();
  if (raw === undefined || raw === '') {
    throw new SecretKeyMissing('is not set — generate one with `openssl rand -hex 32`');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    // Length is asserted on the DECODED bytes below too, but saying it here
    // catches the common shape error with a message that explains itself.
    throw new SecretKeyMissing(`must be 64 hex characters (32 bytes); got ${raw.length}`);
  }
  const key = Buffer.from(raw, 'hex');
  if (key.length !== KEY_BYTES) throw new SecretKeyMissing('did not decode to 32 bytes');
  return key;
}

/**
 * A stable name for a key, so a row can say which one sealed it.
 *
 * The key's own SHA-256, truncated. Never the key, and never reversible into
 * it. It lived in `panelRoutes.ts` while there was one caller; the bot token
 * is the second, and two copies of "how a key is named" is how a rotation
 * comes to believe it has re-sealed everything.
 */
export function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/**
 * Seals plaintext into `nonce || ciphertext || tag`, base64.
 *
 * One field rather than three columns: a nonce that can be updated
 * independently of the ciphertext it belongs to is a nonce that will eventually
 * be reused, and the row is written and read as a unit either way.
 */
export function seal(plaintext: string, key: Buffer): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64');
}

export class SecretUnreadable extends Error {
  /**
   * `what` names the thing, because the operator reading this is debugging one
   * specific broken thing and «stored panel credential» sent them hunting the
   * wrong one the first time a second caller appeared.
   */
  constructor(reason: string, what = 'stored panel credential') {
    super(`${what} could not be read: ${reason}`);
    this.name = 'SecretUnreadable';
  }
}

/** Opens what `seal` produced. Throws rather than returning null: a credential that will not open is not the same as no credential, and the two must not take the same path. */
export function open(sealed: string, key: Buffer, what?: string): string {
  let raw: Buffer;
  try {
    raw = Buffer.from(sealed, 'base64');
  } catch {
    throw new SecretUnreadable('not base64', what);
  }
  if (raw.length <= NONCE_BYTES + TAG_BYTES)
    throw new SecretUnreadable('too short to be sealed', what);
  const nonce = raw.subarray(0, NONCE_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const body = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    // GCM's own authentication failing. Deliberately not distinguished from a
    // wrong key: telling an attacker which of the two it was is the whole
    // reason authenticated modes do not answer that question.
    throw new SecretUnreadable('authentication failed — wrong key, or the row was altered', what);
  }
}

/**
 * `username:password`, the same shape `PANEL_<REF>` carried.
 *
 * Kept identical on purpose so the environment stays a working fallback for
 * panels wired before this existed, and so the two paths cannot disagree about
 * a password containing a colon: only the FIRST colon splits.
 */
export function splitCredential(raw: string): { username: string; password: string } | null {
  const at = raw.indexOf(':');
  if (at <= 0) return null;
  return { username: raw.slice(0, at), password: raw.slice(at + 1) };
}

/** Constant-time compare, for anything that checks a sealed value rather than using it. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
