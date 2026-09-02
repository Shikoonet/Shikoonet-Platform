/**
 * `GET /api/v1/payment-claims/:claimId/receipt`.
 *
 * The bot has been storing these since it was written and nothing could read
 * them back: `receiptFor()` existed with zero callers and the column was not
 * even in the `SELECT` behind «پرداخت‌ها». A customer sent a picture of their
 * transfer, the bot said «رسید شما دریافت شد», and no operator could ever look
 * at it.
 *
 * What is asserted here is mostly about what must NOT happen, because this is
 * the one route in the panel that holds the bot's token and talks to a third
 * party with it:
 *
 *   - the handle is re-validated BEFORE any network call, not after
 *   - the content type comes from our allow-list, never from Telegram
 *   - no log line and no response body ever carries the token or the file_id
 *
 * The last one is the reason the whole file exists in this shape. A receipt
 * handle is a bearer capability for anyone holding the bot token: leaking one
 * into a log is leaking the document.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { keyId, panelSecretKey, seal } from '@shikoo/domain';
import { app } from '../src/index.js';
import { buildEnv } from '../src/server.js';

const EMAIL = 'admin@example.com';
const READER = 'reader-receipt@example.com';
const TOKEN = '1234567890:AAsecret-bot-token-value';
const GOOD_HANDLE = 'AgACAgQAAxkBAAIBY2receipt01';

/**
 * The worker's bindings, with or without the bot token.
 *
 * Omitted rather than set to `undefined`: `exactOptionalPropertyTypes` is on in
 * this repo, and the two are not the same thing — which is the point, because
 * the route's own question is whether the key is there at all.
 */
function envWith(withToken = true) {
  return withToken ? { ...baseEnv, TELEGRAM_BOT_TOKEN: TOKEN } : { ...baseEnv };
}

async function get(claimId: string, withToken = true) {
  return app.request(`/api/v1/payment-claims/${claimId}/receipt`, {}, envWith(withToken));
}

beforeAll(async () => {
  await applySchema();
  // Every case in the first describe below takes the ENVIRONMENT path, which
  // `resolveBotToken` only reaches when no row is stored. A row left behind by
  // another suite turns nine passing tests into nine 503s that read as a broken
  // route — so the precondition is asserted here rather than assumed.
  await baseEnv.DB.prepare(`DELETE FROM bot_credentials WHERE id = 1`).run();
  const now = Date.now();
  for (const [email, role] of [
    [EMAIL, 'ADMIN'],
    [READER, 'READ_ONLY'],
  ] as const) {
    await baseEnv.DB.prepare(
      `INSERT INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)
       ON CONFLICT (email) DO UPDATE SET role = excluded.role, active = 1`,
    )
      .bind(crypto.randomUUID(), email, role, now)
      .run();
  }
});

async function seedClaim(id: string, handle: string | null) {
  const now = Date.now();
  await baseEnv.DB.prepare(`DELETE FROM payment_claims WHERE id = ?1`).bind(id).run();
  await baseEnv.DB.prepare(
    `INSERT INTO payment_claims
       (id, external_order_id, expected_amount_irr, submitted_at, source_system,
        metadata_json, status, paid_clicked_at, receipt_url_or_r2_key, created_at, updated_at)
     VALUES (?1, ?2, 100000, ?3, 'MIRZABOT', '{}', 'PENDING', ?3, ?4, ?3, ?3)`,
  )
    .bind(id, `mirzabot:receipt:${id}`, now, handle)
    .run();
}

/** Every string this route could possibly have written anywhere. */
const logged: string[] = [];

beforeEach(() => {
  logged.length = 0;
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('serving a receipt', () => {
  it('answers 404 for a claim that never had one', async () => {
    await seedClaim('r-none', null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await get('r-none');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('no_receipt');
    // A claim without a receipt is the ordinary case — the customer pressed
    // «پرداخت کردم» and sent nothing. Telegram must not be asked about it.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers 404 for a claim that does not exist', async () => {
    const res = await get('r-missing-entirely');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('not_found');
  });

  it('refuses a malformed handle before it reaches the network', async () => {
    // The row was written by a handler reading an untrusted Telegram update.
    // This value is about to be interpolated into a request to a third party,
    // so the shape is checked again here — and the ORDER is the assertion: a
    // check that happens after the call has already leaked the call.
    await seedClaim('r-bad', 'not a file id at all');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await get('r-bad');
    expect(res.status).toBe(422);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('says so plainly when the worker has no bot token', async () => {
    await seedClaim('r-notoken', GOOD_HANDLE);
    const res = await get('r-notoken', false);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('no_bot_token');
    // A deployment that has not been given the token yet is a configuration
    // problem, and an operator staring at a broken image deserves to be told
    // that rather than left to suspect the claim.
    expect(body.message).toContain('TELEGRAM_BOT_TOKEN');
  });

  it('streams the image back with a type of our own choosing', async () => {
    await seedClaim('r-ok', GOOD_HANDLE);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('/getFile')) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/f_1.jpg' } }), {
          status: 200,
        });
      }
      return new Response('JPEGBYTES', { status: 200 });
    });

    const res = await get('r-ok');
    expect(res.status).toBe(200);
    // From the extension, via the allow-list — never from Telegram's own
    // `Content-Type`, and never from the file's claim about itself. This is
    // served inside our origin to an authenticated operator; if a customer
    // could make the shop answer `text/html` here, a bank receipt would be a
    // stored-XSS delivery mechanism.
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    // A customer's bank receipt behind an operator's session. A shared cache
    // holding it would outlive the session that was allowed to see it.
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    // The route's OWN policy, not the app-wide one — and this is asserted on
    // the served response rather than at the point it is set, because that is
    // exactly where it was lost. `securityHeaders` used to `set` the app-wide
    // CSP after the handler returned and overwrite this. Nothing was red; the
    // header simply was not what this file says it is, which is how a browser
    // ended up free to render an `application/pdf` receipt as a document.
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(await res.text()).toBe('JPEGBYTES');
  });

  it('refuses a file type that is not on the list', async () => {
    await seedClaim('r-html', GOOD_HANDLE);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { file_path: 'docs/evil.html' } }), {
          status: 200,
        }),
    );

    const res = await get('r-html');
    expect(res.status).toBe(415);
  });

  it('never writes the token or the handle anywhere it can be read', async () => {
    // Both failure paths, because both log — and a log line is exactly where a
    // capability like this ends up by accident.
    await seedClaim('r-bad2', 'still not a file id');
    await get('r-bad2');

    await seedClaim('r-refused', GOOD_HANDLE);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify({ ok: false }), { status: 200 }),
    );
    const refused = await get('r-refused');
    const body = await refused.text();

    const everything = [...logged, body].join('\n');
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('AAsecret');
    expect(everything).not.toContain(GOOD_HANDLE);
  });

  it('refuses a signed-out request, before it ever reaches the claim', async () => {
    // The gate is one `app.use('*')` and «the one door» in admin-surface.test.ts
    // already proves it for two other paths, so this is not re-testing the
    // middleware — it pins THIS path to it. The route is the only one in the
    // panel that holds the bot token and streams a customer's bank document,
    // and the day somebody registers it above the gate, or moves the gate, the
    // generic tests stay green and this one does not.
    const { TEST_ACCESS_USER: _drop, ...rest } = envWith();
    await seedClaim('r-signedout', GOOD_HANDLE);

    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      calls.push(String(input));
      return new Response('{}', { status: 200 });
    });

    const res = await app.request(
      '/api/v1/payment-claims/r-signedout/receipt',
      {},
      { ...rest, ENV_NAME: 'production' } as typeof baseEnv,
    );

    expect(res.status).toBe(401);
    // 401 and nothing else: no getFile, so an unauthenticated caller cannot use
    // this route to make the shop spend its token on a handle they guessed.
    expect(calls).toEqual([]);
  });

  it('lets a READ_ONLY operator look at the evidence', async () => {
    // Looking at the document is reading. A reviewer who may be told a payment
    // is suspected of being forged, and may not see the thing it turns on, is
    // being asked to take somebody's word for it.
    await seedClaim('r-reader', null);
    const res = await app.request(
      '/api/v1/payment-claims/r-reader/receipt',
      {},
      { ...envWith(), TEST_ACCESS_USER: READER },
    );
    // 404 for having no receipt — NOT 403 for being a reader.
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('no_receipt');
  });
});

/**
 * The bot connected from «پیکربندی › ربات تلگرام», rather than from a variable.
 *
 * Everything above this line passes with the token in the environment, and the
 * environment is the path `resolveBotToken` takes when `bot_credentials` is
 * empty — so every case above stops short of `panelSecretKey` and none of them
 * could see what staging saw. The panel sealed a token happily and then
 * answered `{"ok":false,"error":"bot_token_unreadable"}` for every receipt,
 * because `server.ts` builds `c.env` from a PASSTHROUGH list that did not carry
 * `PANEL_SECRET_KEY` — the variable was set on the service the whole time.
 *
 * That is why these tests go through `buildEnv` instead of hand-writing the
 * bindings. A fixture that sets `PANEL_SECRET_KEY` on the object it passes in
 * is a fixture that asserts the route works when handed a key, which was never
 * in question; the deployment's own question is whether it IS handed one.
 * Rule 6, on the one screen where money is decided.
 */
describe('a bot connected from the dashboard', () => {
  /** Never a real key. Sixty-four hex characters is all `panelSecretKey` asks. */
  const KEY = 'a'.repeat(64);
  const OTHER_KEY = 'b'.repeat(64);
  /** @shikoodevbot — the dedicated staging bot, and the only one this may be. */
  const STAGING_BOT_ID = 8902884911;
  const STAGING_TOKEN = `${STAGING_BOT_ID}:AAstaging-only-not-a-real-token`;
  /** Production's bot. Named here so the refusal below can name it too. */
  const PRODUCTION_BOT_ID = 8856185613;
  const PRODUCTION_TOKEN = `${PRODUCTION_BOT_ID}:AAproduction-never-in-staging`;

  const SAVED = { ...process.env };

  async function storeCredential(
    envName: string,
    token: string,
    botId: number,
    keyHex = KEY,
  ): Promise<void> {
    const key = panelSecretKey({ PANEL_SECRET_KEY: keyHex });
    await baseEnv.DB.prepare(`DELETE FROM bot_credentials WHERE id = 1`).run();
    await baseEnv.DB.prepare(
      `INSERT INTO bot_credentials
         (id, env_name, sealed, key_id, bot_id, username, first_name, set_by)
       VALUES (1, ?1, ?2, ?3, ?4, 'shikoodevbot', 'Shikoo Dev', 'admin@example.com')`,
    )
      .bind(envName, seal(token, key), keyId(key), botId)
      .run();
  }

  /** The bindings the deployed process actually builds, from the environment. */
  function deployedEnv(over: Record<string, string | undefined> = {}) {
    for (const [k, v] of Object.entries({
      ENV_NAME: 'test',
      TEST_ACCESS_USER: EMAIL,
      PANEL_SECRET_KEY: KEY,
      TELEGRAM_BOT_TOKEN: undefined,
      ...over,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return buildEnv(baseEnv.DB);
  }

  /** Telegram, answering whatever this test needs it to. Records every URL. */
  function telegram(
    getFile: () => Response,
    download: () => Response = () => new Response('JPEGBYTES', { status: 200 }),
  ): string[] {
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      seen.push(url);
      return url.includes('/getFile') ? getFile() : download();
    });
    return seen;
  }

  const okFile = () =>
    new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/f_9.jpg' } }), {
      status: 200,
    });

  afterEach(async () => {
    for (const k of ['ENV_NAME', 'TEST_ACCESS_USER', 'PANEL_SECRET_KEY', 'TELEGRAM_BOT_TOKEN']) {
      if (SAVED[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED[k];
    }
    await baseEnv.DB.prepare(`DELETE FROM bot_credentials WHERE id = 1`).run();
  });

  it('serves the image with the STORED token, through the bindings server.ts builds', async () => {
    await seedClaim('r-stored-ok', GOOD_HANDLE);
    await storeCredential('test', STAGING_TOKEN, STAGING_BOT_ID);
    const seen = telegram(okFile);

    const res = await app.request(
      '/api/v1/payment-claims/r-stored-ok/receipt',
      {},
      deployedEnv(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(await res.text()).toBe('JPEGBYTES');
    // The stored token, not the environment's — the whole reason the row wins.
    expect(seen.every((u) => u.includes(STAGING_TOKEN))).toBe(true);
  });

  it('names the missing KEY rather than blaming the token', async () => {
    await seedClaim('r-nokey', GOOD_HANDLE);
    await storeCredential('test', STAGING_TOKEN, STAGING_BOT_ID);
    const seen = telegram(okFile);

    const res = await app.request(
      '/api/v1/payment-claims/r-nokey/receipt',
      {},
      deployedEnv({ PANEL_SECRET_KEY: undefined }),
    );

    expect(res.status).toBe(503);
    // `secret_key_missing`, the same word `POST /admin/bot/token` uses when it
    // refuses to STORE one. A service with no key and a key that no longer
    // matches are different repairs and must not share a name.
    expect(((await res.json()) as { error: string }).error).toBe('secret_key_missing');
    expect(seen).toEqual([]);
  });

  it('says the key no longer opens the row when it has been rotated', async () => {
    await seedClaim('r-wrongkey', GOOD_HANDLE);
    await storeCredential('test', STAGING_TOKEN, STAGING_BOT_ID, OTHER_KEY);
    const seen = telegram(okFile);

    const res = await app.request(
      '/api/v1/payment-claims/r-wrongkey/receipt',
      {},
      deployedEnv(),
    );

    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('bot_token_unreadable');
    expect(seen).toEqual([]);
  });

  it('refuses a production bot row when this process is not production', async () => {
    // The loud half of migration 0038, asserted from the route rather than from
    // the unit that implements it. A staging box seeded from a production dump
    // must not answer real customers, and must not spend the production token
    // on a staging operator's click either.
    await seedClaim('r-foreign', GOOD_HANDLE);
    await storeCredential('production', PRODUCTION_TOKEN, PRODUCTION_BOT_ID);
    const seen = telegram(okFile);

    const res = await app.request(
      '/api/v1/payment-claims/r-foreign/receipt',
      {},
      deployedEnv(),
    );

    // No environment token either, so there is nothing left to use — and the
    // answer is «no bot», never the production one.
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('no_bot_token');
    expect(seen).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain(String(PRODUCTION_BOT_ID));
  });

  it('tells an operator that Telegram refused the token, not that the receipt is gone', async () => {
    await seedClaim('r-401', GOOD_HANDLE);
    await storeCredential('test', STAGING_TOKEN, STAGING_BOT_ID);
    telegram(
      () =>
        new Response(
          // `description` carries the request URL in some Telegram errors, and
          // that URL contains the token. Nothing here may reach the operator.
          JSON.stringify({ ok: false, error_code: 401, description: `Unauthorized ${STAGING_TOKEN}` }),
          { status: 401 },
        ),
    );

    const res = await app.request('/api/v1/payment-claims/r-401/receipt', {}, deployedEnv());
    const body = await res.text();

    expect(res.status).toBe(502);
    expect(JSON.parse(body).error).toBe('telegram_unauthorized');
    expect(body).not.toContain(STAGING_TOKEN);
    expect(body).not.toContain('Unauthorized');
  });

  it('keeps «the file is gone» and «Telegram is down» apart', async () => {
    await seedClaim('r-gone', GOOD_HANDLE);
    await storeCredential('test', STAGING_TOKEN, STAGING_BOT_ID);

    telegram(() => new Response(JSON.stringify({ ok: false, error_code: 400 }), { status: 400 }));
    const gone = await app.request('/api/v1/payment-claims/r-gone/receipt', {}, deployedEnv());
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { error: string }).error).toBe('receipt_unavailable');

    vi.restoreAllMocks();
    telegram(() => new Response(JSON.stringify({ ok: false, error_code: 502 }), { status: 502 }));
    const down = await app.request('/api/v1/payment-claims/r-gone/receipt', {}, deployedEnv());
    expect(down.status).toBe(502);
    expect(((await down.json()) as { error: string }).error).toBe('receipt_unreachable');
  });

  it('answers 502 rather than throwing when the download itself drops', async () => {
    // `getFile` succeeded and the second call did not. This path was unguarded:
    // the route threw, and the panel got a 500 with nothing in it.
    await seedClaim('r-drop', GOOD_HANDLE);
    await storeCredential('test', STAGING_TOKEN, STAGING_BOT_ID);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/getFile')) return okFile();
      throw new Error('socket hang up');
    });

    const res = await app.request('/api/v1/payment-claims/r-drop/receipt', {}, deployedEnv());
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe('receipt_unreachable');
  });

  it('will not fetch a file_id the caller supplied instead of the claim’s own', async () => {
    // The route takes no file handle from anywhere but the row. Asserted on the
    // OUTBOUND request rather than on the response, because a 200 proves only
    // that something was served — the question is which document.
    await seedClaim('r-own', GOOD_HANDLE);
    await storeCredential('test', STAGING_TOKEN, STAGING_BOT_ID);
    const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).includes('/getFile')) {
        bodies.push(String(init?.body ?? ''));
        return okFile();
      }
      return new Response('JPEGBYTES', { status: 200 });
    });

    const res = await app.request(
      // Every shape an authenticated operator could try: a query string, and a
      // body on a route that reads neither.
      '/api/v1/payment-claims/r-own/receipt?file_id=AgACAgQAAxkBAAsomeoneelses1',
      {},
      deployedEnv(),
    );

    expect(res.status).toBe(200);
    expect(bodies).toEqual([JSON.stringify({ file_id: GOOD_HANDLE })]);
    expect(bodies.join()).not.toContain('someoneelses');
  });

  it('writes neither token nor handle to any log, on any of these paths', async () => {
    await seedClaim('r-quiet', GOOD_HANDLE);
    await storeCredential('test', STAGING_TOKEN, STAGING_BOT_ID, OTHER_KEY);
    await app.request('/api/v1/payment-claims/r-quiet/receipt', {}, deployedEnv());

    await storeCredential('test', STAGING_TOKEN, STAGING_BOT_ID);
    telegram(() => new Response(JSON.stringify({ ok: false, error_code: 401 }), { status: 401 }));
    const res = await app.request('/api/v1/payment-claims/r-quiet/receipt', {}, deployedEnv());

    const everything = [...logged, await res.text()].join('\n');
    expect(everything).not.toContain(STAGING_TOKEN);
    expect(everything).not.toContain('AAstaging-only');
    expect(everything).not.toContain(GOOD_HANDLE);
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain(OTHER_KEY);
  });
});
