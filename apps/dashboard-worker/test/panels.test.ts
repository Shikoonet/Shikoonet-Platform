/**
 * The panels screen, and the one thing it must never do.
 *
 * `provisioning_providers` is panel-operator material: `secret_ref` names a
 * runtime secret, and `config` still carries a hysteria shared secret that
 * cannot be dropped because provisioning has to send it. So the assertion that
 * matters is not "the response has the right fields" — it is that a secret
 * planted in the row does not appear anywhere in the serialized response, by
 * any key, at any depth. A field-by-field check would pass while a future
 * `SELECT *` leaked the lot.
 */

import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';
import { renewAllowed, renewModeFor } from '@shikoo/domain';

const ADMIN = 'admin@example.com';
const REVIEWER = 'reviewer-panels@example.com';
const PREFIX = 'zz-panel-test-';

/** Distinctive enough that finding it in a response cannot be a coincidence. */
const SECRET_REF = 'shikoo/panel/zz-canary-secret-ref';
const CONFIG_SECRET = 'zz-canary-hysteria-shared-secret';

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

async function makePanel(
  label: string,
  opts: { status?: string; capacity?: number | null; withSecret?: boolean } = {},
): Promise<number> {
  const row = await baseEnv.DB.prepare(
    `INSERT INTO provisioning_providers (code, name, kind, status, base_url, secret_ref, config, capacity)
     VALUES (?1, ?2, 'marzban', ?3, 'https://panel.invalid', ?4, ?5::jsonb, ?6) RETURNING id`,
  )
    .bind(
      `${PREFIX}${label}`,
      `پنل ${label}`,
      opts.status ?? 'ACTIVE',
      opts.withSecret === false ? null : SECRET_REF,
      JSON.stringify({ proxies: { hysteria: { password: CONFIG_SECRET } }, inbounds: [42, 2] }),
      opts.capacity === undefined ? 100 : opts.capacity,
    )
    .first<{ id: number }>();
  return Number(row!.id);
}

async function panelRow(id: number) {
  return baseEnv.DB.prepare(
    `SELECT name, status, capacity, sort_order, base_url, secret_ref, config::text AS config
       FROM provisioning_providers WHERE id = ?1`,
  )
    .bind(id)
    .first<{
      name: string;
      status: string;
      capacity: number | null;
      sort_order: number;
      base_url: string | null;
      secret_ref: string | null;
      config: string;
    }>();
}

/**
 * In dependency order, because the schema refuses any other one:
 * `products.provider_id` is ON DELETE RESTRICT, so a provider cannot go while
 * a product points at it, and `subscriptions.user_id` is RESTRICT too. The
 * first version of this helper deleted providers first and was refused — which
 * is the constraint working, not an obstacle to route around.
 */
async function purge(): Promise<void> {
  await baseEnv.DB.prepare(
    `DELETE FROM subscriptions WHERE provider_id IN
       (SELECT id FROM provisioning_providers WHERE code LIKE ?1)`,
  )
    .bind(`${PREFIX}%`)
    .run();
  await baseEnv.DB.prepare(`DELETE FROM products WHERE code LIKE ?1`).bind(`${PREFIX}%`).run();
  await baseEnv.DB.prepare(`DELETE FROM provisioning_providers WHERE code LIKE ?1`)
    .bind(`${PREFIX}%`)
    .run();
  await baseEnv.DB.prepare(`DELETE FROM users WHERE username LIKE ?1`).bind(`${PREFIX}%`).run();
}

beforeAll(async () => {
  await applySchema();
  const now = Date.now();
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
    [REVIEWER, 'REVIEWER'],
  ] as const) {
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
    )
      .bind(crypto.randomUUID(), email, role, now)
      .run();
  }
});

beforeEach(async () => {
  await purge();
  await baseEnv.DB.prepare(`TRUNCATE audit_logs CASCADE`).run();
});

afterAll(purge);

describe('GET /api/v1/admin/panels', () => {
  it('never puts the credential or the adapter config on the wire', async () => {
    const id = await makePanel('canary');

    const res = await app.request('/api/v1/admin/panels', {}, envAs(ADMIN));
    expect(res.status).toBe(200);
    const raw = await res.text();

    // Both secrets are genuinely in the row this response was built from —
    // otherwise this test would pass against an empty database.
    const stored = await panelRow(id);
    expect(stored!.secret_ref).toBe(SECRET_REF);
    expect(stored!.config).toContain(CONFIG_SECRET);

    // And neither is anywhere in what the browser receives.
    expect(raw).not.toContain(SECRET_REF);
    expect(raw).not.toContain(CONFIG_SECRET);
    expect(raw).not.toContain('secret_ref');
    expect(raw).not.toContain('config');

    // What it does say is whether a credential exists at all.
    const body = JSON.parse(raw) as { items: Array<{ id: number; hasSecretRef: boolean }> };
    expect(body.items.find((p) => p.id === id)!.hasSecretRef).toBe(true);
  });

  it('reports a panel with no credential as unconfigured', async () => {
    const id = await makePanel('nocred', { withSecret: false });
    const res = await app.request('/api/v1/admin/panels', {}, envAs(ADMIN));
    const body = (await res.json()) as { items: Array<{ id: number; hasSecretRef: boolean }> };
    expect(body.items.find((p) => p.id === id)!.hasSecretRef).toBe(false);
  });

  it('counts the products, plans and live subscriptions sitting on a panel', async () => {
    const id = await makePanel('counted');
    const product = await baseEnv.DB.prepare(
      `INSERT INTO products (code, name, kind, provider_id, category_id)
       VALUES (?1, 'p', 'vpn', ?2, (SELECT id FROM product_categories WHERE name = '__fixture')) RETURNING id`,
    )
      .bind(`${PREFIX}counted-product`, id)
      .first<{ id: number }>();
    for (const n of ['a', 'b']) {
      await baseEnv.DB.prepare(
        `INSERT INTO product_plans (product_id, name, price_irr) VALUES (?1, ?2, 1000)`,
      )
        .bind(Number(product!.id), n)
        .run();
    }

    const user = await baseEnv.DB.prepare(
      `INSERT INTO users (telegram_id, username, registered_at) VALUES (?1, ?2, now()) RETURNING id`,
    )
      .bind(970_000_001, `${PREFIX}sub-owner`)
      .first<{ id: number }>();
    // The six statuses the schema allows are ACTIVE, PENDING_PAYMENT, ON_HOLD,
    // DISABLED, REMOVED and FAILED — an earlier draft of this test invented
    // 'EXPIRED' and the CHECK constraint refused it.
    for (const status of ['ACTIVE', 'ON_HOLD', 'DISABLED', 'PENDING_PAYMENT']) {
      await baseEnv.DB.prepare(
        `INSERT INTO subscriptions
           (public_id, user_id, provider_id, plan_name_at_sale, price_irr, status, purchased_at)
         VALUES (?1, ?2, ?3, 'p', 1000, ?4, now())`,
      )
        .bind(crypto.randomUUID(), Number(user!.id), id, status)
        .run();
    }

    const res = await app.request('/api/v1/admin/panels', {}, envAs(ADMIN));
    const body = (await res.json()) as {
      items: Array<{
        id: number;
        productCount: number;
        planCount: number;
        liveSubscriptions: number;
      }>;
    };
    const row = body.items.find((p) => p.id === id)!;
    expect(row.productCount).toBe(1);
    expect(row.planCount).toBe(2);
    // ACTIVE and ON_HOLD are owed a working panel; DISABLED and
    // PENDING_PAYMENT are not. Four rows in, two counted.
    expect(row.liveSubscriptions).toBe(2);

    await baseEnv.DB.prepare(`DELETE FROM subscriptions WHERE provider_id = ?1`).bind(id).run();
    await baseEnv.DB.prepare(`DELETE FROM users WHERE username = ?1`)
      .bind(`${PREFIX}sub-owner`)
      .run();
  });

  it('is readable by a reviewer', async () => {
    await makePanel('reviewer-read');
    expect((await app.request('/api/v1/admin/panels', {}, envAs(REVIEWER))).status).toBe(200);
  });
});

describe('POST /api/v1/admin/panels/:id', () => {
  async function patch(id: number, body: unknown, email = ADMIN) {
    return app.request(
      `/api/v1/admin/panels/${id}`,
      { method: 'POST', body: JSON.stringify(body) },
      envAs(email),
    );
  }

  it('disables a panel and records it, leaving the credential untouched', async () => {
    const id = await makePanel('disable-me');

    const res = await patch(id, { status: 'DISABLED' });
    expect(res.status).toBe(200);

    const row = (await panelRow(id))!;
    expect(row.status).toBe('DISABLED');
    // Disabling must not disturb what provisioning needs to come back.
    expect(row.secret_ref).toBe(SECRET_REF);
    expect(row.config).toContain(CONFIG_SECRET);

    const logs = await baseEnv.DB.prepare(
      `SELECT action, actor_email, before_json, after_json FROM audit_logs
        WHERE entity_type = 'PROVIDER' AND entity_id = ?1`,
    )
      .bind(String(id))
      .all<{ action: string; actor_email: string; before_json: string; after_json: string }>();
    expect(logs.results).toHaveLength(1);
    expect(logs.results![0]!.action).toBe('panel.updated');
    expect(JSON.parse(logs.results![0]!.before_json).status).toBe('ACTIVE');
    expect(JSON.parse(logs.results![0]!.after_json).status).toBe('DISABLED');
  });

  it('reports how many live subscriptions the panel still carries', async () => {
    const id = await makePanel('still-busy');
    const user = await baseEnv.DB.prepare(
      `INSERT INTO users (telegram_id, username, registered_at) VALUES (?1, ?2, now()) RETURNING id`,
    )
      .bind(970_000_002, `${PREFIX}busy-owner`)
      .first<{ id: number }>();
    await baseEnv.DB.prepare(
      `INSERT INTO subscriptions
         (public_id, user_id, provider_id, plan_name_at_sale, price_irr, status, purchased_at)
       VALUES (?1, ?2, ?3, 'p', 1000, 'ACTIVE', now())`,
    )
      .bind(crypto.randomUUID(), Number(user!.id), id)
      .run();

    const res = await patch(id, { status: 'DISABLED' });
    expect(((await res.json()) as { liveSubscriptions: number }).liveSubscriptions).toBe(1);

    await baseEnv.DB.prepare(`DELETE FROM subscriptions WHERE provider_id = ?1`).bind(id).run();
    await baseEnv.DB.prepare(`DELETE FROM users WHERE username = ?1`)
      .bind(`${PREFIX}busy-owner`)
      .run();
  });

  it('accepts an unlimited capacity as null, not as zero', async () => {
    const id = await makePanel('uncapped', { capacity: 100 });
    await patch(id, { capacity: null });
    expect((await panelRow(id))!.capacity).toBeNull();

    const other = await makePanel('capped-zero', { capacity: 100 });
    await patch(other, { capacity: 0 });
    expect((await panelRow(other))!.capacity).toBe(0);
  });

  it('offers no way to write a credential', async () => {
    const id = await makePanel('no-creds');
    // `.strict()` — an unknown key is refused rather than ignored, so a client
    // that tries to set one gets an error instead of a silent no-op.
    expect((await patch(id, { secretRef: 'attacker-controlled' })).status).toBe(400);
    expect((await patch(id, { config: { proxies: {} } })).status).toBe(400);
    expect((await panelRow(id))!.secret_ref).toBe(SECRET_REF);
  });

  /**
   * The address IS writable, since 2026-08-26, and this test used to assert the
   * opposite.
   *
   * It was create-only, so a panel that moved host could not be repaired — only
   * deleted and rebuilt, which loses the id every sold subscription points at.
   * The two things that must NOT come with it are still refused above:
   * `secretRef` and `config`.
   *
   * Normalised through the same helper as create, because the connection test
   * normalises too, and an address stored differently from the one that was
   * tested is a green tick followed by a 404 an hour later.
   */
  it('lets the address be repaired, normalised, without touching the credential', async () => {
    const id = await makePanel('moved-host');
    expect((await patch(id, { baseUrl: 'https://elsewhere.invalid:443/dashboard/' })).status).toBe(
      200,
    );
    const row = await panelRow(id);
    expect(row!.base_url).toBe('https://elsewhere.invalid');
    expect(row!.secret_ref).toBe(SECRET_REF);

    expect((await patch(id, { baseUrl: 'elsewhere.invalid' })).status).toBe(400);
    expect((await panelRow(id))!.base_url).toBe('https://elsewhere.invalid');
  });

  /**
   * The two renewal keys, read back through the same functions the BOT reads
   * them with — not by looking at the JSON we just wrote.
   *
   * `renewModeFor` prefers `renew_mode` and falls back to a Persian phrase in
   * `Methodextend`; this asserts the value that actually reaches a renewal.
   */
  it('writes the renewal settings into config without disturbing what is there', async () => {
    const id = await makePanel('renewal');
    await baseEnv.DB.prepare(
      `UPDATE provisioning_providers
          SET config = '{"proxies":{"vless":{}},"group_ids":[3]}'::jsonb WHERE id = ?1`,
    )
      .bind(id)
      .run();

    expect((await patch(id, { renewMode: 'ADD', renewEnabled: false })).status).toBe(200);

    const row = await baseEnv.DB.prepare(
      `SELECT config FROM provisioning_providers WHERE id = ?1`,
    )
      .bind(id)
      .first<{ config: Record<string, unknown> }>();
    expect(renewModeFor(row!.config)).toBe('ADD');
    expect(renewAllowed(row!.config)).toBe(false);
    // A wholesale config write would have taken these with it.
    expect(row!.config['group_ids']).toEqual([3]);
    expect(row!.config['proxies']).toEqual({ vless: {} });
  });

  it('refuses a status the schema does not allow', async () => {
    const id = await makePanel('bad-status');
    expect((await patch(id, { status: 'HIDDEN' })).status).toBe(400);
    expect((await panelRow(id))!.status).toBe('ACTIVE');
  });

  it('refuses an empty patch', async () => {
    const id = await makePanel('empty');
    expect((await patch(id, {})).status).toBe(400);
  });

  it('is refused for a reviewer, and nothing moves', async () => {
    const id = await makePanel('reviewer-write');
    expect((await patch(id, { status: 'DISABLED' }, REVIEWER)).status).toBe(403);
    expect((await panelRow(id))!.status).toBe('ACTIVE');
  });

  it('404s on a panel that does not exist', async () => {
    expect((await patch(2_000_000_002, { status: 'DISABLED' })).status).toBe(404);
  });
});
