/**
 * «کدام سرورها؟» through the support door: the customer's own services, and a
 * company sample account per panel for someone who has none. Names only —
 * the response must never carry anything that would let another person use
 * a link.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, type Env } from '../src/index.js';
import { clearSubscriptionCache } from '../src/integrations/subscriptionNames.js';
import { env } from './helpers/env.js';

const TOKEN = 'support-test-token-that-is-long-enough-000';
const TG = 8_810_000_000;
const TG_END = TG + 999_999;
const enc = encodeURIComponent;
const bodyFor = (names: string[]) => names.map((n) => `trojan://s@h.example:443#${enc(n)}`).join('\n');
const PANEL_BODIES: Record<string, string> = {
  'https://sub.example/own/links': bodyFor(['🔄 V3.7.8.1', '🇩🇪 Germany']),
  'https://sub.example/sample/links': bodyFor(['🔄 V3.7.8.1', '🇫🇮 Finland', '🇹🇷 Turkey']),
};
const fakeFetch = (async (input: string | URL | Request) => {
  const body = PANEL_BODIES[String(input)];
  return body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 });
}) as unknown as typeof fetch;

async function call(body: unknown, extra: Partial<Env> = {}): Promise<Response> {
  return await app.fetch(
    new Request('https://example.com/api/v1/integrations/support/servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    }),
    {
      ...env,
      SUPPORT_INTEGRATION_ENABLED: 'true',
      SUPPORT_INTEGRATION_TOKEN: TOKEN,
      SUBSCRIPTION_FETCH: fakeFetch,
      ...extra,
    } as Env,
  );
}

beforeAll(async () => {
  await cleanUp();
  const p = await env.DB.prepare(
    `INSERT INTO provisioning_providers (code, name, kind, status, base_url, secret_ref, config)
     VALUES ('support-test-servers', 'الماس', 'pasarguard', 'ACTIVE', 'https://panel.test', 'X',
             '{"support_sample_subscription_url":"https://sub.example/sample"}'::jsonb)
     RETURNING id`,
  ).first<{ id: number }>();
  const u = await env.DB.prepare(
    `INSERT INTO users (telegram_id, registered_at) VALUES (?1, now()) RETURNING id`,
  )
    .bind(TG + 1)
    .first<{ id: number }>();
  await env.DB.prepare(
    `INSERT INTO subscriptions (public_id, user_id, provider_id, plan_name_at_sale, price_irr,
                                remote_username, subscription_url, status, purchased_at)
     VALUES ('supsrv0001', ?1, ?2, 'تیتانیوم ۱ماهه ۵۰ گیگ', 0, 'u_test',
             'https://sub.example/own', 'ACTIVE', now())`,
  )
    .bind(u!.id, p!.id)
    .run();
});
beforeEach(() => clearSubscriptionCache());

/** Everything this file writes, whatever a failed test left behind. */
async function cleanUp(): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM subscriptions
      WHERE user_id IN (SELECT id FROM users WHERE telegram_id BETWEEN ?1 AND ?2)`,
  )
    .bind(TG, TG_END)
    .run();
  await env.DB.prepare(`DELETE FROM users WHERE telegram_id BETWEEN ?1 AND ?2`)
    .bind(TG, TG_END)
    .run();
  await env.DB.prepare(`DELETE FROM provisioning_providers WHERE code = 'support-test-servers'`).run();
}
afterAll(cleanUp);

describe('which servers', () => {
  it('reads the customer’s own service and the sample list, names only', async () => {
    const text = await (await call({ telegram_id: TG + 1 })).text();
    const json = JSON.parse(text) as { own: unknown[]; catalog: unknown[] };
    expect(json.own).toEqual([
      { service: 'تیتانیوم ۱ماهه ۵۰ گیگ', version: 'V3.7.8.1', servers: ['🇩🇪 Germany'] },
    ]);
    expect(json.catalog).toContainEqual({
      service: 'الماس',
      version: 'V3.7.8.1',
      servers: ['🇫🇮 Finland', '🇹🇷 Turkey'],
    });
    // Nothing that would let anyone else use a link.
    expect(text).not.toContain('sub.example');
    expect(text).not.toContain('trojan://');
  });

  it('gives a stranger the sample lists only', async () => {
    const json = (await (await call({ telegram_id: TG_END })).json()) as {
      own: unknown[];
      catalog: unknown[];
    };
    expect(json.own).toEqual([]);
    expect(json.catalog.length).toBeGreaterThan(0);
  });
});

describe('a slow or dead panel does not hold the support bot', () => {
  it('answers within its budget, with whatever finished', async () => {
    // Final review, 2026-09-26: each read had a timeout but the request did
    // not, so several dead panels held n8n for 10–50 seconds.
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const quit = () => reject(new Error('aborted'));
        init?.signal?.addEventListener('abort', quit);
        setTimeout(quit, 800);
      })) as unknown as typeof fetch;
    const started = Date.now();
    const json = (await (
      await call({ telegram_id: TG + 1 }, { SUBSCRIPTION_FETCH: hang, SUPPORT_SERVERS_BUDGET_MS: 150 })
    ).json()) as { ok: boolean; own: unknown[]; catalog: unknown[] };
    expect(Date.now() - started).toBeLessThan(700);
    expect(json).toEqual({ ok: true, own: [], catalog: [] });
  });

  it('reads at most the customer’s five newest services', async () => {
    const u = await env.DB.prepare(
      `INSERT INTO users (telegram_id, registered_at) VALUES (?1, now()) RETURNING id`,
    )
      .bind(TG + 2)
      .first<{ id: number }>();
    for (let i = 1; i <= 7; i += 1) {
      await env.DB.prepare(
        `INSERT INTO subscriptions (public_id, user_id, plan_name_at_sale, price_irr,
                                    subscription_url, status, purchased_at)
         VALUES (?1, ?2, ?3, 0, ?4, 'ACTIVE', now())`,
      )
        .bind(`supmany${i}`, u!.id, `many ${i}`, `https://sub.example/many-${i}`)
        .run();
    }
    const many = (async (input: string | URL | Request) => {
      const m = /many-(\d+)\/links$/.exec(String(input));
      return m
        ? new Response(bodyFor(['🔄 V3.7.8.1', `🇩🇪 S${m[1]}`]), { status: 200 })
        : new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    const json = (await (await call({ telegram_id: TG + 2 }, { SUBSCRIPTION_FETCH: many })).json()) as {
      own: { servers: string[] }[];
    };
    expect(json.own.map((o) => o.servers[0])).toEqual([
      '🇩🇪 S7',
      '🇩🇪 S6',
      '🇩🇪 S5',
      '🇩🇪 S4',
      '🇩🇪 S3',
    ]);
  });
});
