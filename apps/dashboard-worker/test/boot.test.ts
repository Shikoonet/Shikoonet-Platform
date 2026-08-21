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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEnv } from '../src/server.js';
import type { Env } from '../src/index.js';

/** `buildEnv` only stores the handle; nothing here reaches the database. */
const NO_DB = {} as Env['DB'];

const KEYS = [
  'ENV_NAME',
  'TEST_ACCESS_USER',
  'TRUSTED_PROXY_IP_HEADER',
  'APP_VERSION',
  'SOURCE_COMMIT',
] as const;

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

/**
 * The guard that is allowed to be off, but not allowed to be off in silence.
 *
 * Without `TRUSTED_PROXY_IP_HEADER`, `clientIp` returns null and
 * `operatorSession.ts` skips the whole per-IP branch — so the login wall keeps
 * only its shop-wide limit, on a panel that has been directly on the internet
 * since Access left the path. Session rows also record no address at all.
 *
 * `deploy/README.md` promises the process says so at boot. It said so for
 * ingest and for nothing else, so the one signal an operator has after a deploy
 * did not exist for the one door that matters most.
 */
describe('what the log says about a guard that is off', () => {
  it('warns when the trusted proxy header is not configured', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    set({ ENV_NAME: 'production' });

    buildEnv(NO_DB);

    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    warn.mockRestore();
    // Named, so an operator can search for it — and it says what is off rather
    // than that something is.
    expect(said).toContain('TRUSTED_PROXY_IP_HEADER');
    expect(said).toContain('/api/v1/auth/login');
    expect(said).toContain('OFF');
  });

  it('says nothing when it is configured', () => {
    // Or the warning becomes noise on every boot and stops being read.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    set({ ENV_NAME: 'production', TRUSTED_PROXY_IP_HEADER: 'X-Real-IP' });

    buildEnv(NO_DB);

    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    warn.mockRestore();
    expect(said).not.toContain('TRUSTED_PROXY_IP_HEADER');
  });
});

describe('which build this is', () => {
  // Deliberately not the sha the ingest test uses, so a copied expectation
  // cannot pass in the wrong package.
  const SHA = '33a29b0f1c5e4a7d9b2e6c8a0d4f3b17e59c2a86';

  it('reports the commit Coolify deployed', () => {
    // `/api/v1/version` answered the literal string `dev` on the production box
    // for months: `APP_VERSION` was fed by the retired Cloudflare release
    // script and by nothing after it. `SOURCE_COMMIT` is read out of every
    // Coolify container — checked on the server 2026-08-22 against the image
    // tag it had built — so this is the value that was already there.
    set({ ENV_NAME: 'production', SOURCE_COMMIT: SHA });
    expect(buildEnv(NO_DB).APP_VERSION).toBe(SHA);
  });

  it('lets an explicit release name win, and ignores an empty one', () => {
    set({ ENV_NAME: 'production', APP_VERSION: 'v2.3.0', SOURCE_COMMIT: SHA });
    expect(buildEnv(NO_DB).APP_VERSION).toBe('v2.3.0');
    // A variable defined as whitespace is one somebody meant to fill in, not a
    // release named "  ". `??` would have answered with it.
    set({ ENV_NAME: 'production', APP_VERSION: '  ', SOURCE_COMMIT: SHA });
    expect(buildEnv(NO_DB).APP_VERSION).toBe(SHA);
  });

  it('says dev when neither is set, rather than inventing one', () => {
    set({ ENV_NAME: 'local' });
    expect(buildEnv(NO_DB).APP_VERSION).toBe('dev');
  });
});
