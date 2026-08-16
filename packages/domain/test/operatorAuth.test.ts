/**
 * Operator passwords and session tokens.
 *
 * The properties that matter are the ones a wrong implementation still passes a
 * naive test for: that two hashes of the same password differ, that a hash from
 * one password never opens another, and that a malformed or absent stored hash
 * is a refusal rather than a crash — because the login route must not be able
 * to tell "no such operator" apart from "wrong password" in how it fails.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_FAILED_ATTEMPTS,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  hashSessionToken,
  newSessionToken,
  passwordProblem,
  verifyPassword,
} from '../src/operatorAuth.js';

const PASSWORD = 'correct horse battery staple';

describe('hashPassword / verifyPassword', () => {
  it('accepts the password it was given', async () => {
    expect(await verifyPassword(PASSWORD, await hashPassword(PASSWORD))).toBe(true);
  });

  it('refuses every near miss', async () => {
    const hash = await hashPassword(PASSWORD);
    for (const wrong of [
      'correct horse battery stapl',
      'correct horse battery staple ',
      'Correct horse battery staple',
      '',
      'x',
    ]) {
      expect(await verifyPassword(wrong, hash)).toBe(false);
    }
  });

  it('salts, so the same password never produces the same hash twice', async () => {
    const hashes = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);
    expect(hashes[0]).not.toBe(hashes[1]);
    // Both must still open it — a salt that is not stored correctly passes the
    // inequality above and fails here.
    expect(await verifyPassword(PASSWORD, hashes[0]!)).toBe(true);
    expect(await verifyPassword(PASSWORD, hashes[1]!)).toBe(true);
  });

  it('records the cost in the hash, so it can be raised later', async () => {
    const [scheme, n, r, p] = (await hashPassword(PASSWORD)).split('$');
    expect(scheme).toBe('scrypt');
    expect(Number(n)).toBeGreaterThanOrEqual(16384);
    expect(Number(r)).toBeGreaterThanOrEqual(8);
    expect(Number(p)).toBeGreaterThanOrEqual(1);
  });

  it('reads a hash written with different cost parameters', async () => {
    // The point of storing the cost. This is what an operator hashed before a
    // future bump looks like; if it stops verifying, raising N locks everyone out.
    const cheap = 'scrypt$16384$8$1$c2FsdHNhbHRzYWx0c2E=$';
    const { scrypt } = await import('node:crypto');
    const key = await new Promise<Buffer>((resolve, reject) =>
      scrypt(
        PASSWORD,
        Buffer.from('c2FsdHNhbHRzYWx0c2E=', 'base64'),
        32,
        { N: 16384, r: 8, p: 1, maxmem: 256 * 16384 * 8 * 2 },
        (err, derived) => (err ? reject(err) : resolve(derived as Buffer)),
      ),
    );
    expect(await verifyPassword(PASSWORD, cheap + key.toString('base64'))).toBe(true);
    expect(await verifyPassword('something else', cheap + key.toString('base64'))).toBe(false);
  });

  it('treats an operator with no password as a refusal, not an error', async () => {
    // access_users rows exist before anybody sets a password on them. The login
    // route must fail the same way here as for a wrong password, or the
    // difference tells an attacker which accounts are real.
    expect(await verifyPassword(PASSWORD, null)).toBe(false);
    expect(await verifyPassword(PASSWORD, '')).toBe(false);
  });

  it('refuses a malformed stored hash instead of throwing', async () => {
    for (const bad of [
      'not-a-hash',
      'scrypt$x$8$1$c2FsdA==$aGFzaA==',
      'scrypt$32768$8$1$$aGFzaA==',
      'scrypt$32768$8$1$c2FsdA==$',
      'bcrypt$32768$8$1$c2FsdA==$aGFzaA==',
      'scrypt$32768$8$1$c2FsdA==',
      '$$$$$',
    ]) {
      expect(await verifyPassword(PASSWORD, bad)).toBe(false);
    }
  });

  it('refuses a cost a hostile row could use to hang the process', async () => {
    // N beyond the cap is rejected before scrypt is ever called.
    const started = Date.now();
    expect(await verifyPassword(PASSWORD, 'scrypt$1073741824$8$1$c2FsdA==$aGFzaA==')).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('normalises unicode, so the same typed password works on any keyboard', async () => {
    // The same character composed two ways. Without NFKC an operator who set
    // their password on one device cannot log in from another.
    const composed = 'kaffeeéklatsch2026';
    const decomposed = 'kaffeeéklatsch2026';
    expect(composed).not.toBe(decomposed);
    expect(await verifyPassword(decomposed, await hashPassword(composed))).toBe(true);
  });
});

describe('session tokens', () => {
  it('never returns the same token twice', () => {
    const seen = new Set(Array.from({ length: 100 }, () => newSessionToken().token));
    expect(seen.size).toBe(100);
  });

  it('hands back a hash that matches the token, and does not contain it', () => {
    const { token, hash } = newSessionToken();
    expect(hashSessionToken(token)).toBe(hash);
    // What gets stored must be useless to whoever reads the table.
    expect(hash).not.toContain(token);
    expect(token).not.toContain(hash);
  });

  it('is url-safe, because it rides in a cookie', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(newSessionToken().token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('carries at least 256 bits', () => {
    // base64url of 32 bytes is 43 characters. Shorter means somebody trimmed
    // the entropy, which is the one thing standing between a guess and a session.
    expect(newSessionToken().token).toHaveLength(43);
  });
});

describe('passwordProblem', () => {
  it('accepts a reasonable password', () => {
    expect(passwordProblem(PASSWORD)).toBeNull();
  });

  it('refuses anything shorter than the minimum', () => {
    expect(passwordProblem('a'.repeat(MIN_PASSWORD_LENGTH - 1))).not.toBeNull();
    expect(MAX_FAILED_ATTEMPTS).toBeGreaterThan(0);
  });

  it('refuses a long password made of almost nothing', () => {
    // Clears any length rule and is worth nothing.
    expect(passwordProblem('aaaaaaaaaaaaaaaaaaaa')).not.toBeNull();
    expect(passwordProblem('ababababababababab')).not.toBeNull();
  });

  it('counts length after normalising, like the hash does', () => {
    // `e` + combining acute is two code units NFKC folds into one, so this is
    // 13 characters as typed and 12 once normalised — exactly the minimum.
    // The distinct characters are spelled out rather than repeated because the
    // "almost nothing" rule above would otherwise be what fails, and a test
    // that goes red for a different rule than the one it names is worse than
    // no test.
    const decomposed = 'ébcdefghijkl';
    expect(decomposed).toHaveLength(MIN_PASSWORD_LENGTH + 1);
    expect(decomposed.normalize('NFKC')).toHaveLength(MIN_PASSWORD_LENGTH);
    expect(passwordProblem(decomposed)).toBeNull();

    // One shorter falls below the minimum only after normalising — the case
    // a check counting raw code units would wrongly accept.
    const tooShort = 'ébcdefghijk';
    expect(tooShort).toHaveLength(MIN_PASSWORD_LENGTH);
    expect(passwordProblem(tooShort)).not.toBeNull();
  });
});
