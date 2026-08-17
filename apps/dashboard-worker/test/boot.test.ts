/**
 * What the dashboard refuses to start with.
 *
 * Since Cloudflare Access came out of the path on 2026-08-17 this process is
 * the only wall in front of the panel, and four of its walls are decided by one
 * environment variable: the login bypass, the Origin requirement on writes, the
 * session cookie's `Secure` flag, and this refusal.
 *
 * That variable used to be `process.env.ENV_NAME ?? 'local'`, so `prod`,
 * `Production` and forgetting it entirely all read as a laptop. Every one of
 * those failures is fail-open and silent — nothing logs, nothing 500s, the
 * panel simply comes up with its guards off.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { buildEnv } from '../src/server.js';
import type { Env } from '../src/index.js';

/** `buildEnv` only stores the handle; nothing here reaches the database. */
const NO_DB = {} as Env['DB'];

const KEYS = ['ENV_NAME', 'TEST_ACCESS_USER'] as const;

const saved = new Map<string, string | undefined>();
function set(values: { [K in (typeof KEYS)[number]]?: string | undefined }): void {
  for (const key of KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe('which environment this is', () => {
  it('refuses to start with ENV_NAME unset', () => {
    set({});
    expect(() => buildEnv(NO_DB)).toThrow(/ENV_NAME is required/);
  });

  it('refuses a near miss instead of reading it as local', () => {
    for (const value of ['prod', 'Production', 'PRODUCTION', 'production-space']) {
      set({ ENV_NAME: value });
      expect(() => buildEnv(NO_DB)).toThrow(/is not one of/);
    }
  });

  it('accepts the four it knows', () => {
    for (const value of ['local', 'test', 'staging', 'production']) {
      set({ ENV_NAME: value });
      expect(buildEnv(NO_DB).ENV_NAME).toBe(value);
    }
  });

  it('trims, because a trailing space in a deploy panel is invisible', () => {
    set({ ENV_NAME: 'production ' });
    expect(buildEnv(NO_DB).ENV_NAME).toBe('production');
  });
});

describe('the login bypass', () => {
  it('is refused in production', () => {
    set({ ENV_NAME: 'production', TEST_ACCESS_USER: 'admin@example.com' });
    expect(() => buildEnv(NO_DB)).toThrow(/TEST_ACCESS_USER/);
  });

  it('is refused in staging too', () => {
    // The point of the whole change. `!== 'production'` let this through, and a
    // staging box reachable from the internet with the login skipped is open in
    // exactly the way the production refusal exists to prevent.
    set({ ENV_NAME: 'staging', TEST_ACCESS_USER: 'admin@example.com' });
    expect(() => buildEnv(NO_DB)).toThrow(/only allowed in local and test/);
  });

  it('is allowed in local and test, which is what it is for', () => {
    for (const value of ['local', 'test']) {
      set({ ENV_NAME: value, TEST_ACCESS_USER: 'dev@example.com' });
      expect(buildEnv(NO_DB).TEST_ACCESS_USER).toBe('dev@example.com');
    }
  });
});
