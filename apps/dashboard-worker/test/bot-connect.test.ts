/**
 * `GET /api/v1/admin/bot` and `POST /api/v1/admin/bot/token`.
 *
 * Most of what is asserted here is what must NOT happen. This route accepts the
 * one credential that decides who answers every customer of the shop, so:
 *
 *   - nothing Telegram has not confirmed is ever written
 *   - the token never comes back out, in any response, in any shape
 *   - the row holds ciphertext, not the token
 *   - a REVIEWER and a READ_ONLY cannot write it
 *
 * Against the real schema, because the other half — that the row can be written
 * and read back at all — is a Postgres fact and a fake database would only
 * prove the code agrees with itself.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';
import { open, panelSecretKey } from '@shikoo/domain';

const ADMIN = 'admin@example.com';
const REVIEWER = 'reviewer-bot@example.com';
const READER = 'reader-bot@example.com';

const KEY_HEX = 'c'.repeat(64);
const TOKEN = '7712345678:AAH9fakeTokenForTestsOnly_not_a_real_one';
const OTHER_TOKEN = '8899001122:AAsecondFakeTokenForTestsOnly_xxxxx';

/** What Telegram answers for a token it recognises. */
function getMeOk(botId: number, username: string) {
  return new Response(
    JSON.stringify({ ok: true, result: { id: botId, is_bot: true, username, first_name: 'Shikoo' } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function envAs(email = ADMIN) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

async function connect(token: string, email = ADMIN) {
  return app.request(
    '/api/v1/admin/bot/token',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) },
    envAs(email),
  );
}

async function read(email = ADMIN) {
  return app.request('/api/v1/admin/bot', {}, envAs(email));
}

beforeAll(async () => {
  await applySchema();
  // Before anything captures a baseline. `access_users` is truncated by other
  // files in this package and a row that only survived from a previous run is
  // how a test passes alone and dies in the full suite.
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
    [REVIEWER, 'REVIEWER'],
    [READER, 'READ_ONLY'],
  ] as const) {
    await baseEnv.DB.prepare(
      `INSERT INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)
       ON CONFLICT (email) DO UPDATE SET role = excluded.role, active = 1`,
    )
      .bind(crypto.randomUUID(), email, role, Date.now())
      .run();
  }
});

beforeEach(async () => {
  process.env['PANEL_SECRET_KEY'] = KEY_HEX;
  await baseEnv.DB.prepare(`DELETE FROM bot_credentials`).run();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['PANEL_SECRET_KEY'];
});

describe('connecting a bot', () => {
  it('asks Telegram, then stores the answer', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(getMeOk(7712345678, 'shikoo_bot'));

    const r = await connect(TOKEN);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      ok: true,
      connected: { botId: 7712345678, username: 'shikoo_bot' },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('stores ciphertext — the row does not contain the token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(getMeOk(7712345678, 'shikoo_bot'));
    await connect(TOKEN);

    const row = await baseEnv.DB.prepare(
      `SELECT sealed, key_id, env_name, bot_id, set_by FROM bot_credentials WHERE id = 1`,
    ).first<{ sealed: string; key_id: string; env_name: string; bot_id: number; set_by: string }>();

    expect(row).not.toBeNull();
    expect(row!.sealed).not.toContain(TOKEN);
    // And it is the token, not something that merely looks unlike it: opening
    // it with the key gives back exactly what was sent.
    expect(open(row!.sealed, panelSecretKey())).toBe(TOKEN);
    expect(row!.env_name).toBe(baseEnv.ENV_NAME);
    expect(row!.set_by).toBe(ADMIN);
  });

  it('never sends the token back, on the write or on the read', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(getMeOk(7712345678, 'shikoo_bot'));
    const wrote = await (await connect(TOKEN)).text();
    const got = await (await read()).text();
    for (const body of [wrote, got]) {
      expect(body).not.toContain(TOKEN);
      // Not even the half of it that is not the bot id.
      expect(body).not.toContain('AAH9fakeTokenForTestsOnly');
    }
  });

  it('refuses a token Telegram does not recognise, and writes nothing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 }),
    );
    const r = await connect(TOKEN);
    expect(r.status).toBe(422);
    expect((await r.json() as { error: string }).error).toBe('rejected_by_telegram');
    expect(await baseEnv.DB.prepare(`SELECT 1 FROM bot_credentials`).first()).toBe(null);
  });

  it('refuses the wrong shape without asking Telegram at all', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await connect('7712345678-AAH9fakeTokenForTestsOnlyxxxx');
    expect(r.status).toBe(422);
    expect((await r.json() as { error: string }).error).toBe('bad_shape');
    // The point of checking the shape first: a malformed string never reaches
    // a URL.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('says so and writes nothing when Telegram cannot be reached', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
    const r = await connect(TOKEN);
    expect(r.status).toBe(502);
    expect((await r.json() as { error: string }).error).toBe('telegram_unreachable');
    expect(await baseEnv.DB.prepare(`SELECT 1 FROM bot_credentials`).first()).toBe(null);
  });

  it('refuses an answer whose bot id is not the one in the token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(getMeOk(999, 'someone_else'));
    const r = await connect(TOKEN);
    expect(r.status).toBe(502);
    expect((await r.json() as { error: string }).error).toBe('identity_mismatch');
    expect(await baseEnv.DB.prepare(`SELECT 1 FROM bot_credentials`).first()).toBe(null);
  });

  it('refuses to store anything when the server has no encryption key', async () => {
    delete process.env['PANEL_SECRET_KEY'];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await connect(TOKEN);
    expect(r.status).toBe(503);
    expect((await r.json() as { error: string }).error).toBe('secret_key_missing');
    // Checked BEFORE the network call, so a token is never sent anywhere for
    // an answer that was going to be thrown away.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('replaces rather than accumulates — one bot, one row', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(getMeOk(7712345678, 'shikoo_bot'))
      .mockResolvedValueOnce(getMeOk(8899001122, 'shikoo_test_bot'));
    await connect(TOKEN);
    await connect(OTHER_TOKEN);
    const rows = await baseEnv.DB.prepare(
      `SELECT count(*)::int AS n, max(bot_id) AS bot FROM bot_credentials`,
    ).first<{ n: number; bot: number }>();
    expect(rows?.n).toBe(1);
    expect(Number(rows?.bot)).toBe(8899001122);
  });

  it('records the change in audit_logs without the token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(getMeOk(7712345678, 'shikoo_bot'));
    await connect(TOKEN);
    const row = await baseEnv.DB.prepare(
      `SELECT after_json::text AS after, actor_email FROM audit_logs
        WHERE action = 'bot.token_set' ORDER BY created_at DESC LIMIT 1`,
    ).first<{ after: string; actor_email: string }>();
    expect(row?.actor_email).toBe(ADMIN);
    expect(row?.after).toContain('7712345678');
    expect(row?.after).not.toContain('AAH9fakeTokenForTestsOnly');
  });

  /**
   * The field name, not the sentence.
   *
   * These three refusals each carry a Persian sentence, and for one run they
   * carried it as `message` — which `ApiError` in the SPA does not read. The
   * screen showed the bare code `telegram_unreachable` to an operator who had
   * just pasted a token. Caught in a browser, not in the code: the route was
   * answering correctly and the client was drawing the wrong half of it.
   */
  it('puts its Persian sentence in the field the panel actually reads', async () => {
    const cases: Array<[() => void, string, number]> = [
      [() => {}, '7712345678-not-a-token-shape-at-all', 422],
      [
        () => void vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET')),
        TOKEN,
        502,
      ],
      [
        () =>
          void vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(new Response(JSON.stringify({ ok: false }), { status: 401 })),
        TOKEN,
        422,
      ],
    ];
    for (const [arrange, token, status] of cases) {
      vi.restoreAllMocks();
      arrange();
      const r = await connect(token);
      expect(r.status).toBe(status);
      const body = (await r.json()) as { detail?: string };
      expect(body.detail, `no detail for status ${status}`).toBeTruthy();
      // Persian, so it is the operator's sentence rather than a code echoed
      // into the field.
      expect(body.detail).toMatch(/[؀-ۿ]/);
    }
  });
});

describe('who may do it', () => {
  for (const email of [REVIEWER, READER]) {
    it(`refuses ${email}`, async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const r = await connect(TOKEN, email);
      expect(r.status).toBe(403);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await baseEnv.DB.prepare(`SELECT 1 FROM bot_credentials`).first()).toBe(null);
    });
  }

  it('lets a reader see which bot is connected', async () => {
    const r = await read(READER);
    expect(r.status).toBe(200);
  });
});

describe('what the screen is told', () => {
  it('says nothing is connected when nothing is', async () => {
    const body = (await (await read()).json()) as { source: string; connected: unknown };
    // `baseEnv` carries no TELEGRAM_BOT_TOKEN, so this is genuinely a shop
    // with no bot rather than one running on its variable.
    expect(body.source).toBe('none');
    expect(body.connected).toBe(null);
  });

  it('says `environment` when only the variable is set', async () => {
    const r = await app.request('/api/v1/admin/bot', {}, { ...envAs(), TELEGRAM_BOT_TOKEN: TOKEN });
    expect(((await r.json()) as { source: string }).source).toBe('environment');
  });

  it('says `dashboard` once a bot has been connected here', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(getMeOk(7712345678, 'shikoo_bot'));
    await connect(TOKEN);
    const body = (await (await read()).json()) as {
      source: string;
      connected: { username: string };
    };
    expect(body.source).toBe('dashboard');
    expect(body.connected.username).toBe('shikoo_bot');
  });

  /**
   * The row written for another environment is invisible here for the same
   * reason `resolveBotToken` refuses it: a copied database must not present
   * somebody else's bot as this shop's.
   */
  it('hides a row that belongs to another environment', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(getMeOk(7712345678, 'shikoo_bot'));
    await connect(TOKEN);
    await baseEnv.DB.prepare(`UPDATE bot_credentials SET env_name = 'production' WHERE id = 1`).run();
    const body = (await (await read()).json()) as { source: string; connected: unknown };
    expect(body.connected).toBe(null);
    expect(body.source).toBe('none');
  });
});
