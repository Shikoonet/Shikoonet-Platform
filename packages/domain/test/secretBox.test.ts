/**
 * The seal, measured against the properties it is chosen for.
 *
 * Not "encrypt then decrypt and get the same string back" — that passes for a
 * Caesar cipher. What matters here is the three things GCM is being used FOR:
 * a fresh nonce every time, a ciphertext that refuses to open after being
 * edited, and a wrong key that fails rather than producing plausible bytes the
 * bot would then send to a panel as a password.
 */

import { describe, expect, it } from 'vitest';
import {
  SecretKeyMissing,
  SecretUnreadable,
  open,
  panelSecretKey,
  seal,
  splitCredential,
} from '../src/secretBox.js';

const KEY = Buffer.alloc(32, 7);
const OTHER = Buffer.alloc(32, 9);

describe('sealing a panel credential', () => {
  it('opens back to exactly what went in, colons and all', () => {
    const secret = 'admin:p@ss:with:colons';
    expect(open(seal(secret, KEY), KEY)).toBe(secret);
  });

  it('never produces the same ciphertext twice for the same input', () => {
    // The nonce assertion, made where it can actually fail. A fixed nonce would
    // pass every round-trip test above and lose confidentiality outright.
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) seen.add(seal('admin:same', KEY));
    expect(seen.size).toBe(50);
  });

  it('refuses a ciphertext that was edited in the database', () => {
    const sealed = seal('admin:secret', KEY);
    const raw = Buffer.from(sealed, 'base64');
    // Flip one bit in the body — the shape a careless UPDATE or a corrupted
    // restore would produce.
    raw[20] = (raw[20] ?? 0) ^ 0x01;
    expect(() => open(raw.toString('base64'), KEY)).toThrow(SecretUnreadable);
  });

  it('refuses the wrong key rather than returning bytes', () => {
    // The failure that matters: a silent wrong answer here is a password the
    // bot sends to a real panel.
    expect(() => open(seal('admin:secret', KEY), OTHER)).toThrow(SecretUnreadable);
  });

  it('refuses anything too short to be a sealed value', () => {
    expect(() => open('AAAA', KEY)).toThrow(SecretUnreadable);
  });
});

describe('the key, from the environment', () => {
  it('accepts 64 hex characters', () => {
    expect(panelSecretKey({ PANEL_SECRET_KEY: 'ab'.repeat(32) })).toHaveLength(32);
  });

  it('names itself and says how to make one when unset', () => {
    // An operator reading this message must not have to find this file.
    expect(() => panelSecretKey({})).toThrow(SecretKeyMissing);
    expect(() => panelSecretKey({})).toThrow(/openssl rand -hex 32/);
  });

  it('rejects a key of the wrong length instead of padding it', () => {
    expect(() => panelSecretKey({ PANEL_SECRET_KEY: 'ab'.repeat(16) })).toThrow(SecretKeyMissing);
    expect(() => panelSecretKey({ PANEL_SECRET_KEY: '   ' })).toThrow(SecretKeyMissing);
  });

  it('rejects a non-hex key, which is what a pasted passphrase looks like', () => {
    expect(() => panelSecretKey({ PANEL_SECRET_KEY: 'z'.repeat(64) })).toThrow(SecretKeyMissing);
  });
});

describe('splitting `username:password`', () => {
  it('splits on the first colon only, so a password may contain one', () => {
    expect(splitCredential('admin:a:b')).toEqual({ username: 'admin', password: 'a:b' });
  });

  it('refuses a value with no colon or an empty username', () => {
    // Matches `credentialsFor`'s `at <= 0`, so the database path and the
    // environment path cannot disagree about what a malformed value is.
    expect(splitCredential('nocolon')).toBeNull();
    expect(splitCredential(':onlypassword')).toBeNull();
  });
});
