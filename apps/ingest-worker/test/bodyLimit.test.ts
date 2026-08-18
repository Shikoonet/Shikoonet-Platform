/**
 * How much an unauthenticated caller may make this process read.
 *
 * Both public routes used to allocate first and measure afterwards:
 *
 *   - `POST /api/v1/sms` checked `Content-Length` **only when it was present**,
 *     so a chunked request skipped the check; then `c.req.json()` parsed
 *     whatever had arrived; then a second check ran on
 *     `JSON.stringify(body).length`, which counts UTF-16 code units. A Persian
 *     SMS is two UTF-8 bytes per character and one unit there, so the number
 *     compared against a limit named `_BYTES` was about half the bytes.
 *   - `POST /api/v1/integrations/mirzabot/claims` read the entire body with
 *     `c.req.text()` **before** authenticating — the HMAC is over the raw bytes,
 *     so they must exist first — with no cap and no rate limit at all.
 *
 * None of that needs a credential to reach. These assert against real bytes on
 * the wire, including the chunked path, which is the one that was open.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { fixedWindowRateLimit } from '@shikoo/domain';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app, type Env } from '../src/index.js';

beforeAll(applySchema);

/** A body of a known byte length, sent without `Content-Length`. */
function chunked(bytes: number): ReadableStream<Uint8Array> {
  const chunk = new TextEncoder().encode('x'.repeat(1024));
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= bytes) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      sent += chunk.length;
    },
  });
}

async function post(
  path: string,
  body: string | ReadableStream<Uint8Array>,
  env: Env = baseEnv,
): Promise<Response> {
  return app.fetch(
    new Request(`https://example.com${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      // Required by fetch when the body is a stream.
      ...({ duplex: 'half' } as RequestInit),
    }),
    env,
  );
}

describe('the SMS endpoint', () => {
  it('refuses a declared oversize body', async () => {
    // `Content-Length` is set by fetch itself from the string length.
    const res = await post('/api/v1/sms', 'x'.repeat(9 * 1024));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('refuses a chunked body, which used to skip the check entirely', async () => {
    // No `Content-Length` at all. The old code read the header, found nothing,
    // and went straight to `c.req.json()`.
    const res = await post('/api/v1/sms', chunked(64 * 1024));
    expect(res.status).toBe(413);
  });

  it('measures bytes, not characters', async () => {
    // 6,000 Persian characters is 6,000 UTF-16 units — under the old 8 KB
    // comparison — and 12,000 UTF-8 bytes, which is over it. The field itself
    // caps at 4,096 characters, so this can only be built as a whole-body
    // overrun, which is the honest shape of the bug anyway.
    const persian = 'پ'.repeat(6_000);
    expect(persian.length).toBeLessThan(8 * 1024);
    expect(new TextEncoder().encode(persian).length).toBeGreaterThan(8 * 1024);
    const res = await post('/api/v1/sms', JSON.stringify({ message: persian }));
    expect(res.status).toBe(413);
  });

  it('still accepts an ordinary body', async () => {
    // So "refuse the big ones" is not satisfied by refusing everything. This
    // one fails authentication, which is a later gate and a different answer.
    const res = await post(
      '/api/v1/sms',
      JSON.stringify({
        deviceId: 'body-limit-device',
        deviceName: 'phone',
        apiKey: 'not-a-real-key',
        sender: 'BANK',
        message: 'واریز ۱۰۰٬۰۰۰ ریال',
        timestamp: String(Date.now()),
      }),
    );
    expect(res.status).not.toBe(413);
  });

  it('refuses a body that declares ten bytes and then sends sixty-four kilobytes', async () => {
    // CVE-2025-59139, and the reason the Hono pin moved. A request carrying
    // BOTH `Content-Length` and `Transfer-Encoding: chunked` is chunked — the
    // HTTP spec says the length is then unknown and `Content-Length` must be
    // ignored. Hono before 4.9.7 believed the header instead, so ten bytes was
    // under the cap and the middleware waved the whole stream through.
    //
    // The header pair is written by hand because that is the whole attack: no
    // client library builds this, and `fetch` would otherwise set the length
    // itself from the body.
    const res = await app.fetch(
      new Request('https://example.com/api/v1/sms', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': '10',
          'transfer-encoding': 'chunked',
        },
        body: chunked(64 * 1024),
        ...({ duplex: 'half' } as RequestInit),
      }),
      baseEnv,
    );
    expect(res.status).toBe(413);
  });

  it('falls back to the built-in cap when the configured one is nonsense', async () => {
    // `Number.parseInt('8kb')` is NaN and `n > NaN` is false, so the old code
    // answered a typo by removing the limit rather than widening it. `server.ts`
    // now refuses to start on such a value; this covers everything that builds
    // the environment by hand.
    const env = { ...baseEnv, INGEST_MAX_BODY_BYTES: '8kb' } as Env;
    expect((await post('/api/v1/sms', 'x'.repeat(64 * 1024), env)).status).toBe(413);
  });
});

describe('the claims endpoint', () => {
  const enabled = { ...baseEnv, MIRZABOT_INTEGRATION_ENABLED: 'true' } as Env;

  it('refuses a large body before it authenticates it', async () => {
    // No signature is sent. A 401 here would mean the body was read and hashed
    // first, which is the work being refused.
    const res = await post('/api/v1/integrations/mirzabot/claims', 'x'.repeat(16 * 1024), enabled);
    expect(res.status).toBe(413);
  });

  it('refuses a chunked one too', async () => {
    const res = await post('/api/v1/integrations/mirzabot/claims', chunked(16 * 1024), enabled);
    expect(res.status).toBe(413);
  });

  it('rate limits an unauthenticated caller', async () => {
    // The route had no limit of any kind, so an attacker with no credential
    // could make this process read and HMAC a body as fast as they could send.
    const env = {
      ...enabled,
      TRUSTED_PROXY_IP_HEADER: 'x-real-ip',
      IP_LIMIT: fixedWindowRateLimit({ limit: 2, windowMs: 60_000 }),
    } as Env;
    const attempt = () =>
      app.fetch(
        new Request('https://example.com/api/v1/integrations/mirzabot/claims', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.30' },
          body: JSON.stringify({ eventId: 'e' }),
        }),
        env,
      );
    expect((await attempt()).status).not.toBe(429);
    expect((await attempt()).status).not.toBe(429);
    expect((await attempt()).status).toBe(429);
  });
});
