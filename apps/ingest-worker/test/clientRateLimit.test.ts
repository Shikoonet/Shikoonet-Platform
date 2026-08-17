/**
 * The per-IP limit on the only publicly reachable endpoint in the platform.
 *
 * `POST /api/v1/sms` used to key its limit on `c.req.header('cf-connecting-ip')
 * ?? 'unknown'`. Cloudflare left the request path on 2026-08-17, which broke
 * that in both directions at once:
 *
 *   - the header is never sent by our own edge, so every phone in the fleet
 *     shared the literal bucket `unknown` and one busy device could 429 all of
 *     them;
 *   - nothing strips the header any more, so a client that *does* send it picks
 *     its own bucket and rotates it per request.
 *
 * These go through `app.fetch` with a real limiter rather than calling the
 * helper, because the helper agreeing with itself is not the question.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { fixedWindowRateLimit } from '@shikoo/domain';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app, type Env } from '../src/index.js';

beforeAll(applySchema);

/** A body that fails authentication — the limit is charged before that. */
const BODY = JSON.stringify({
  deviceId: 'rl-device',
  apiKey: 'not-a-real-key',
  sender: 'BANK',
  message: 'test',
  timestamp: String(Date.now()),
});

async function post(env: Env, headers: Record<string, string>): Promise<Response> {
  return app.fetch(
    new Request('https://example.com/api/v1/sms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: BODY,
    }),
    env,
  );
}

/** A fresh limiter per test: a shared one would carry counts between them. */
function envWith(over: Partial<Env>): Env {
  return {
    ...baseEnv,
    IP_LIMIT: fixedWindowRateLimit({ limit: 2, windowMs: 60_000 }),
    ...over,
  } as Env;
}

describe('the per-IP limit', () => {
  it('counts one address and lets another through', async () => {
    const env = envWith({ TRUSTED_PROXY_IP_HEADER: 'x-real-ip' });
    expect((await post(env, { 'x-real-ip': '203.0.113.1' })).status).not.toBe(429);
    expect((await post(env, { 'x-real-ip': '203.0.113.1' })).status).not.toBe(429);
    expect((await post(env, { 'x-real-ip': '203.0.113.1' })).status).toBe(429);
    // The other half. Under `?? 'unknown'` this phone was in the same bucket as
    // the one above and would have been refused for somebody else's traffic.
    expect((await post(env, { 'x-real-ip': '198.51.100.1' })).status).not.toBe(429);
  });

  it('is not bypassed by rotating a header nobody vouched for', async () => {
    const env = envWith({ TRUSTED_PROXY_IP_HEADER: 'x-real-ip' });
    const attacker = (i: number) => ({
      'x-real-ip': '198.51.100.9',
      'cf-connecting-ip': `10.0.0.${i}`,
      'x-forwarded-for': `10.1.0.${i}`,
    });
    expect((await post(env, attacker(1))).status).not.toBe(429);
    expect((await post(env, attacker(2))).status).not.toBe(429);
    expect((await post(env, attacker(3))).status).toBe(429);
  });

  it('skips the limit rather than sharing one bucket when no header is trusted', async () => {
    // No `TRUSTED_PROXY_IP_HEADER`: nothing here can say who the client is, and
    // answering that question with a constant is what caused the fleet-wide
    // lockout. The device credential and the per-device limit still stand.
    const env = envWith({});
    for (let i = 0; i < 5; i++) {
      expect((await post(env, { 'cf-connecting-ip': '10.0.0.1' })).status).not.toBe(429);
    }
  });
});
