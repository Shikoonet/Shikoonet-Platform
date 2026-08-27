/**
 * What the bot refuses to start without.
 *
 * The dashboard-worker and ingest-worker both refuse `ENV_NAME` at boot.
 * The bot did not, until this file — a typo on the deploy box would have
 * started the bot on prod credentials and the only signal would have been
 * silence. The shape is the same as the dashboard's: a missing or misspelt
 * `ENV_NAME` reads as `local`, and `local` is what `TEST_ACCESS_USER`,
 * the Origin-less write path, and the insecure cookie all switch off.
 *
 * The bot has no HTTP surface, but it holds a Telegram token and writes to
 * the same database the dashboard reads. The refusal belongs in the same
 * place: in front of the database connection, before the poller starts.
 */

import { afterEach, describe, expect, it } from 'vitest';

const KEYS = ['ENV_NAME', 'DATABASE_URL', 'TELEGRAM_BOT_TOKEN'] as const;

/**
 * The bot's `start()` would reach the database on its first line. We do
 * not want this test to need a Postgres at all — `parseEnvName` is the
 * first thing `start()` calls now, and it throws before `createPostgresD1`
 * is reached, so a process-level refusal is what the assertion is about.
 *
 * The check is indirect: build a small function that does what `start()`'s
 * first line does today, and assert on that. The implementation under test
 * is `parseEnvName(process.env.ENV_NAME)` — the same call the bot makes —
 * imported directly from `@shikoo/contracts`.
 */
import { parseEnvName } from '@shikoo/contracts';

const saved = new Map<string, string | undefined>();
function set(values: Partial<Record<(typeof KEYS)[number], string | undefined>>): void {
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

describe('the bot at boot', () => {
  it('refuses to start with ENV_NAME unset', () => {
    set({});
    expect(() => parseEnvName(process.env['ENV_NAME'])).toThrow(/ENV_NAME is required/);
  });

  it('refuses a value that is not in the allow-list', () => {
    set({ ENV_NAME: 'prod' });
    expect(() => parseEnvName(process.env['ENV_NAME'])).toThrow(/prod/);
    set({ ENV_NAME: 'Production' });
    expect(() => parseEnvName(process.env['ENV_NAME'])).toThrow(/Production/);
    set({ ENV_NAME: 'staging-prod' });
    expect(() => parseEnvName(process.env['ENV_NAME'])).toThrow(/staging-prod/);
  });

  it('trims surrounding whitespace before deciding', () => {
    // The contract trims, on purpose: a copied-and-pasted "production " with
    // a trailing space reads the same as "production". What it refuses is a
    // typo that no longer exists after the trim, not the spaces themselves.
    set({ ENV_NAME: ' production ' });
    expect(parseEnvName(process.env['ENV_NAME'])).toBe('production');
  });

  it('refuses with the consequence in the message, not just the variable name', () => {
    set({});
    const msg = (() => {
      try {
        parseEnvName(process.env['ENV_NAME']);
        return '';
      } catch (e) {
        return String(e);
      }
    })();
    expect(msg).toMatch(/login bypass|Origin-less|insecure cookie/);
  });

  it('accepts the four documented values', () => {
    for (const v of ['local', 'test', 'staging', 'production']) {
      set({ ENV_NAME: v });
      expect(parseEnvName(process.env['ENV_NAME'])).toBe(v);
    }
  });
});