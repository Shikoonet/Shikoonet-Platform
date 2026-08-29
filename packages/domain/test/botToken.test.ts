/**
 * Where the bot's token comes from.
 *
 * The interesting cases are all about a token that is present and WRONG to use,
 * not about one that is missing:
 *
 *   - a row belonging to another environment, which is a copied database and
 *     must not be allowed to answer the real shop's customers
 *   - a row that will not open, which is a misconfigured key and must NOT
 *     quietly fall back to running a different bot
 *
 * Everything here runs against a fake database rather than Postgres: the
 * decision under test is precedence, and a real table would only prove that
 * `SELECT` works. The one Postgres-shaped fact — that the row can be written
 * and read back at all — is proved by `bot-connect.test.ts` in the dashboard,
 * against the real schema.
 */

import { describe, expect, it, vi } from 'vitest';
import { resolveBotToken, readBotCredential, BOT_TOKEN_SHAPE, botIdFromToken } from '../src/index.js';
import { seal, keyId, SecretUnreadable } from '../src/secretBox.js';
import type { D1Database } from '@shikoo/database';

const KEY_HEX = 'a'.repeat(64);
const OTHER_KEY_HEX = 'b'.repeat(64);
const KEY = Buffer.from(KEY_HEX, 'hex');
const TOKEN = '7712345678:AAH9fakeTokenForTestsOnly_not_a_real_one';
const ENV_TOKEN = '1111111111:BBenvironmentTokenForTestsOnly_xxxxx';

/** A database that answers the one SELECT this module makes. */
function dbWith(row: Record<string, unknown> | null, onQuery?: () => void): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return this;
        },
        first() {
          onQuery?.();
          return Promise.resolve(row);
        },
      };
    },
  } as unknown as D1Database;
}

function storedRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    env_name: 'production',
    sealed: seal(TOKEN, KEY),
    key_id: keyId(KEY),
    bot_id: 7712345678,
    username: 'shikoo_bot',
    first_name: 'Shikoo',
    set_by: 'sam@example.com',
    updated_at: '2026-08-29 12:00:00+00',
    ...over,
  };
}

const withKey = { PANEL_SECRET_KEY: KEY_HEX, TELEGRAM_BOT_TOKEN: ENV_TOKEN };

describe('BOT_TOKEN_SHAPE', () => {
  it('accepts what BotFather hands out', () => {
    expect(BOT_TOKEN_SHAPE.test(TOKEN)).toBe(true);
    expect(botIdFromToken(TOKEN)).toBe(7712345678);
  });

  it('refuses the shapes a paste actually produces', () => {
    // A bare id, the token with the colon lost, a leading zero (no bot has
    // one), and the whole thing with a stray space in the middle.
    expect(BOT_TOKEN_SHAPE.test('7712345678')).toBe(false);
    expect(BOT_TOKEN_SHAPE.test('7712345678AAH9fakeTokenForTestsOnly')).toBe(false);
    expect(BOT_TOKEN_SHAPE.test('0712345678:AAH9fakeTokenForTestsOnlyxxxx')).toBe(false);
    expect(BOT_TOKEN_SHAPE.test('7712345678:AAH9 fakeTokenForTestsOnlyxx')).toBe(false);
  });
});

describe('resolveBotToken', () => {
  it('prefers the stored row over the environment', async () => {
    const r = await resolveBotToken(dbWith(storedRow()), 'production', withKey);
    expect(r?.token).toBe(TOKEN);
    expect(r?.source).toBe('dashboard');
    expect(r?.identity?.username).toBe('shikoo_bot');
  });

  it('falls back to the environment when nothing is stored', async () => {
    const r = await resolveBotToken(dbWith(null), 'production', withKey);
    expect(r?.token).toBe(ENV_TOKEN);
    expect(r?.source).toBe('environment');
    expect(r?.identity).toBeNull();
  });

  it('answers null when neither has one', async () => {
    expect(await resolveBotToken(dbWith(null), 'production', { PANEL_SECRET_KEY: KEY_HEX })).toBe(
      null,
    );
  });

  /**
   * The guarantee `migrations/0038` is written for.
   *
   * A production row read by a staging process must not be used. Asserted on
   * the TOKEN rather than on the source, because the failure this prevents is
   * "staging polls the real bot and answers real customers" — and the only
   * evidence of that is which token comes back.
   */
  it('refuses a row that belongs to another environment', async () => {
    const r = await resolveBotToken(dbWith(storedRow({ env_name: 'production' })), 'dev', withKey);
    expect(r?.token).toBe(ENV_TOKEN);
    expect(r?.source).toBe('environment');
  });

  it('and answers null rather than the foreign row when there is no fallback', async () => {
    const r = await resolveBotToken(dbWith(storedRow({ env_name: 'production' })), 'dev', {
      PANEL_SECRET_KEY: KEY_HEX,
    });
    expect(r).toBe(null);
  });

  /**
   * NOT a fallback. A row this process is entitled to use and cannot open is a
   * wrong key, and running the environment's bot instead would silently answer
   * customers as a different shop from the one the operator chose.
   */
  it('throws rather than falling back when the stored row will not open', async () => {
    await expect(
      resolveBotToken(dbWith(storedRow()), 'production', {
        ...withKey,
        PANEL_SECRET_KEY: OTHER_KEY_HEX,
      }),
    ).rejects.toBeInstanceOf(SecretUnreadable);
  });

  it('names the bot token in that error, not a panel credential', async () => {
    await expect(
      resolveBotToken(dbWith(storedRow()), 'production', {
        ...withKey,
        PANEL_SECRET_KEY: OTHER_KEY_HEX,
      }),
    ).rejects.toThrow(/stored bot token/);
  });

  it('uses the environment when the database cannot be asked', async () => {
    const broken = {
      prepare() {
        return {
          bind() {
            return this;
          },
          first() {
            return Promise.reject(new Error('connection reset'));
          },
        };
      },
    } as unknown as D1Database;
    const warn = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const r = await resolveBotToken(broken, 'production', withKey);
      expect(r?.token).toBe(ENV_TOKEN);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('readBotCredential', () => {
  it('never returns anything that could be the token', async () => {
    const row = await readBotCredential(dbWith(storedRow()), 'production');
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    // Not even the ciphertext: it is useless without the key, and a screen has
    // no reason to hold it.
    expect(JSON.stringify(row)).not.toContain(seal(TOKEN, KEY).slice(0, 12));
    expect(row?.username).toBe('shikoo_bot');
  });

  it('hides a row that belongs to another environment', async () => {
    expect(await readBotCredential(dbWith(storedRow({ env_name: 'production' })), 'dev')).toBe(null);
  });
});
