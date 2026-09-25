/**
 * The support bot's door: what it refuses before it reads anything, and the
 * rules question. The trial and server questions have their own files.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RateLimit } from '@shikoo/domain';
import { app, type Env } from '../src/index.js';
import { env } from './helpers/env.js';

const TOKEN = 'support-test-token-that-is-long-enough-000';
const BASE = 'https://example.com/api/v1/integrations/support';

/** Written out so a test may pass an explicit `undefined` to unset one binding. */
type EnvPatch = { [K in keyof Env]?: Env[K] | undefined };

async function call(
  path: string,
  body: unknown,
  opts: { token?: string | null; env?: EnvPatch } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token !== null) headers['Authorization'] = `Bearer ${opts.token ?? TOKEN}`;
  return await app.fetch(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    {
      ...env,
      SUPPORT_INTEGRATION_ENABLED: 'true',
      SUPPORT_INTEGRATION_TOKEN: TOKEN,
      ...opts.env,
    } as Env,
  );
}

describe('the support door refuses before it reads anything', () => {
  it('does not exist while switched off', async () => {
    const res = await call('/rules', {}, { env: { SUPPORT_INTEGRATION_ENABLED: 'false' } });
    expect(res.status).toBe(404);
  });
  it('says it is not configured when on without a token', async () => {
    const res = await call('/rules', {}, { env: { SUPPORT_INTEGRATION_TOKEN: undefined } });
    expect(res.status).toBe(503);
  });
  it('refuses no header, a wrong token, and a token of another length', async () => {
    expect((await call('/rules', {}, { token: null })).status).toBe(401);
    expect((await call('/rules', {}, { token: TOKEN.replace(/0$/, '1') })).status).toBe(401);
    expect((await call('/rules', {}, { token: 'short' })).status).toBe(401);
  });
  it('refuses a body over two kilobytes', async () => {
    const res = await call('/rules', JSON.stringify({ pad: 'x'.repeat(3000) }));
    expect(res.status).toBe(413);
  });
  it('answers 429 when its limiter says no', async () => {
    const no: RateLimit = { limit: async () => ({ success: false }) };
    expect((await call('/rules', {}, { env: { SUPPORT_LIMIT: no } })).status).toBe(429);
  });
});

describe('«قوانین»', () => {
  let saved: { gate: string | null; text: string | null };
  beforeAll(async () => {
    const gate = await env.DB.prepare(
      `SELECT value #>> '{}' AS v FROM settings WHERE scope = 'bot' AND key = 'roll_Status'`,
    ).first<{ v: string | null }>();
    const text = await env.DB.prepare(`SELECT value FROM bot_texts WHERE key = 'GATE_RULES'`).first<{
      value: string;
    }>();
    saved = { gate: gate?.v ?? null, text: text?.value ?? null };
  });
  async function setGate(value: string | null): Promise<void> {
    await env.DB.prepare(`DELETE FROM settings WHERE scope = 'bot' AND key = 'roll_Status'`).run();
    if (value !== null) {
      await env.DB.prepare(
        `INSERT INTO settings (scope, key, value) VALUES ('bot', 'roll_Status', to_jsonb(?1::text))`,
      )
        .bind(value)
        .run();
    }
  }
  async function setText(value: string | null): Promise<void> {
    await env.DB.prepare(`DELETE FROM bot_texts WHERE key = 'GATE_RULES'`).run();
    if (value !== null) {
      await env.DB.prepare(`INSERT INTO bot_texts (key, value) VALUES ('GATE_RULES', ?1)`)
        .bind(value)
        .run();
    }
  }
  afterEach(async () => {
    await setGate(null);
    await setText(null);
  });
  afterAll(async () => {
    await setGate(saved.gate);
    await setText(saved.text);
  });

  it('is off with no text when nothing was set', async () => {
    const json = await (await call('/rules', {})).json();
    expect(json).toEqual({ ok: true, enabled: false, text: null });
  });
  it('returns the text an admin wrote, and says whether the gate is on', async () => {
    await setGate('rolleon');
    await setText('📜 قوانین فروشگاه\n\nفروش فقط از ربات.');
    const json = await (await call('/rules', {})).json();
    expect(json).toEqual({ ok: true, enabled: true, text: '📜 قوانین فروشگاه\n\nفروش فقط از ربات.' });
  });
  it('treats the code’s placeholder as «no rules written»', async () => {
    await setGate('rolleon');
    const json = await (await call('/rules', {})).json();
    expect(json).toEqual({ ok: true, enabled: true, text: null });
  });
});

describe.skip('who is asking', () => {
  it.each([
    [{ telegram_id: '123' }],
    [{ telegram_id: 1.5 }],
    [{ telegram_id: 0 }],
    [{ telegram_id: 5, extra: true }],
    ['not json'],
  ])('refuses %j before any lookup', async (body) => {
    const res = await call('/servers', body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_body' });
  });
});
