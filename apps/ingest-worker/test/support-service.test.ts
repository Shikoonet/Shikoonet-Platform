/**
 * `SERVICE=support`: the support bot's door in a container of its own (Sam,
 * 2026-09-26: not inside the SMS service). It answers the door and its own
 * health and version, and nothing of the SMS service it was split from.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/index.js';
import { buildSupportEnv, supportApp } from '../src/supportServer.js';
import { env } from './helpers/env.js';

const TOKEN = 'support-test-token-that-is-long-enough-000';
const E = {
  ...env,
  SUPPORT_INTEGRATION_ENABLED: 'true',
  SUPPORT_INTEGRATION_TOKEN: TOKEN,
  APP_VERSION: 'abc1234',
  ENV_NAME: 'staging',
} as Env;

async function hit(path: string, init: RequestInit = {}): Promise<Response> {
  return await supportApp.fetch(new Request(`https://support.example${path}`, init), E);
}

describe('the support service', () => {
  it('answers the support door', async () => {
    const res = await hit('/api/v1/integrations/support/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('answers its own health and version, which the deploy checks', async () => {
    expect((await hit('/health')).status).toBe(200);
    expect(await (await hit('/version')).json()).toEqual({
      ok: true,
      version: 'abc1234',
      env: 'staging',
    });
  });

  it('carries nothing of the SMS service', async () => {
    const sms = await hit('/api/v1/sms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(sms.status).toBe(404);
    expect((await hit('/api/v1/integrations/mirzabot/claims', { method: 'POST' })).status).toBe(404);
  });
});

describe('what the support service refuses to start without', () => {
  const KEYS = ['ENV_NAME', 'SUPPORT_INTEGRATION_ENABLED', 'SUPPORT_INTEGRATION_TOKEN'] as const;
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
  const NO_DB = {} as Env['DB'];

  it('refuses to run with the door off — it would serve nothing but 404s', () => {
    set({ ENV_NAME: 'production' });
    expect(() => buildSupportEnv(NO_DB)).toThrow(/SUPPORT_INTEGRATION_ENABLED/);
  });

  it('refuses a short token, as the SMS service does', () => {
    set({ ENV_NAME: 'production', SUPPORT_INTEGRATION_ENABLED: 'true', SUPPORT_INTEGRATION_TOKEN: 'short' });
    expect(() => buildSupportEnv(NO_DB)).toThrow(/at least 32 characters/);
  });

  it('starts with the door on and a long token, and does not ask for the SMS switches', () => {
    set({ ENV_NAME: 'production', SUPPORT_INTEGRATION_ENABLED: 'true', SUPPORT_INTEGRATION_TOKEN: TOKEN });
    const built = buildSupportEnv(NO_DB);
    expect(built.SUPPORT_INTEGRATION_ENABLED).toBe('true');
    expect(built.SUPPORT_LIMIT).toBeDefined();
    expect(built.IP_LIMIT).toBeDefined();
  });
});
