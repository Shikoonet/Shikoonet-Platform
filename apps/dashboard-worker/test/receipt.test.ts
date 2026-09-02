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
import { app } from '../src/index.js';

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
