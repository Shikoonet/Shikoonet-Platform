/**
 * The groups a panel sends, and the one failure they exist to prevent.
 *
 * The legacy shop kept five `marzban_panel` rows on one PasarGuard, differing
 * only in `inbounds` — `[42,2]` for VIP, `[83]` for the unlimited line, `[2]`
 * for the rest. Buying VIP put the account in groups 42 and 2 because that row
 * said so. The migration carried it into `provisioning_providers.config`, and
 * no screen showed it: `group_ids` appeared zero times in `apps/admin-web` and
 * zero times in this app until 2026-08-23.
 *
 * The failure: group 42 was deleted from the live panel some time after the
 * 2026-08-11 dump. PasarGuard answers a create with `404 Group not found`,
 * which the adapter classifies as non-retryable, so on cutover day every VIP
 * order would have gone FAILED and refunded in front of the customer.
 *
 * So the assertions here are not "the route returns a list". They are that the
 * route can tell three states apart, because conflating any two of them is the
 * bug:
 *
 *   asked, and the panel has the group     → fine
 *   asked, and the panel does NOT have it  → the armed failure, must be visible
 *   could not ask                          → NOT "has no groups"
 */

import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin@example.com';
const REVIEWER = 'reviewer-groups@example.com';
const PREFIX = 'zz-groups-';
const KEY = 'ab'.repeat(32);

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

async function get(path: string, email = ADMIN): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`), envAs(email));
}

async function post(path: string, body: unknown, email = ADMIN): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify(body),
    }),
    envAs(email),
  );
}

/**
 * A panel carrying the legacy spelling, exactly as the importer wrote it.
 *
 * `inbounds`, not `group_ids`: reading only the current spelling would show
 * every migrated panel as sending nothing, which is the quiet way this screen
 * could lie about production data on day one.
 */
async function migratedPanel(label: string, config: unknown): Promise<number> {
  const row = await baseEnv.DB.prepare(
    `INSERT INTO provisioning_providers (code, name, kind, status, base_url, config)
     VALUES (?1, ?2, 'pasarguard', 'ACTIVE', 'https://panel.invalid', ?3::jsonb)
     RETURNING id`,
  )
    .bind(`${PREFIX}${label}`, `پنل ${label}`, JSON.stringify(config))
    .first<{ id: number }>();
  return row!.id;
}

/**
 * Panels, and everything hanging off them.
 *
 * In that order: `products.provider_id` has a foreign key to the panel, so
 * deleting panels first fails on the second test — which is how this was found.
 */
async function purge(): Promise<void> {
  await baseEnv.DB.prepare(
    `DELETE FROM product_plans WHERE product_id IN
       (SELECT id FROM products WHERE code LIKE ?1)`,
  )
    .bind(`${PREFIX}%`)
    .run();
  await baseEnv.DB.prepare(`DELETE FROM products WHERE code LIKE ?1`).bind(`${PREFIX}%`).run();
  await baseEnv.DB.prepare(`DELETE FROM provisioning_providers WHERE code LIKE ?1`)
    .bind(`${PREFIX}%`)
    .run();
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
  process.env['PANEL_SECRET_KEY'] = KEY;
  await purge();
  await baseEnv.DB.prepare(`TRUNCATE audit_logs CASCADE`).run();
});

afterAll(async () => {
  delete process.env['PANEL_SECRET_KEY'];
  await purge();
});

describe('reading a panel’s groups', () => {
  it('reads the legacy `inbounds` spelling the importer wrote', async () => {
    // The VIP row, verbatim from `marzban_panel`.
    const id = await migratedPanel('vip', { inbounds: [42, 2], proxies: { vless: {} } });
    const res = await get(`/api/v1/admin/panels/${id}/groups`);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { selected: number[] };
    expect(out.selected, 'a migrated panel must not read as sending nothing').toEqual([42, 2]);
  });

  it('prefers the current spelling when both are present', async () => {
    // `pick()` in marzban.ts reads `group_ids` first, so this screen must too —
    // showing the stale one would describe a panel that behaves differently.
    const id = await migratedPanel('both', { inbounds: [42], group_ids: [7] });
    const out = (await (await get(`/api/v1/admin/panels/${id}/groups`)).json()) as {
      selected: number[];
    };
    expect(out.selected).toEqual([7]);
  });

  it('answers `available: null`, never an empty list, when the panel cannot be asked', async () => {
    // `panel.invalid` can never resolve (RFC 2606). A panel that is down is not
    // a panel with no groups, and an empty list here would invite an operator
    // to delete a selection that was correct.
    const id = await migratedPanel('down', { inbounds: [42, 2] });
    const out = (await (await get(`/api/v1/admin/panels/${id}/groups`)).json()) as {
      available: unknown;
      selected: number[];
    };
    expect(out.available).toBeNull();
    expect(out.selected, 'what we send must still be reported').toEqual([42, 2]);
  }, 30_000);

  it('names the plans that override the panel, because saving here misses them', async () => {
    const id = await migratedPanel('overridden', { inbounds: [2] });
    const product = await baseEnv.DB.prepare(
      `INSERT INTO products (provider_id, code, name, kind, status)
       VALUES (?1, ?2, 'محصول', 'vpn', 'ACTIVE') RETURNING id`,
    )
      .bind(id, `${PREFIX}prod`)
      .first<{ id: number }>();
    await baseEnv.DB.prepare(
      `INSERT INTO product_plans (product_id, name, price_irr, status, attrs)
       VALUES (?1, 'پلن با گروه خودش', 1000, 'ACTIVE', ?2::jsonb)`,
    )
      .bind(product!.id, JSON.stringify({ group_ids: [99] }))
      .run();

    const out = (await (await get(`/api/v1/admin/panels/${id}/groups`)).json()) as {
      plans: Array<{ name: string }>;
    };
    expect(out.plans.map((p) => p.name)).toContain('پلن با گروه خودش');
  }, 30_000);
});

describe('saving a panel’s groups', () => {
  it('writes `group_ids` and removes the legacy key in the same write', async () => {
    // Two spellings of one fact in one row is a trap: `pick()` reads
    // `group_ids` first, so a leftover `inbounds` would sit there looking
    // authoritative and doing nothing.
    const id = await migratedPanel('save', { inbounds: [42, 2], proxies: { vless: {} } });
    expect((await post(`/api/v1/admin/panels/${id}/groups`, { groupIds: [2, 83] })).status).toBe(
      200,
    );

    const row = await baseEnv.DB.prepare(
      `SELECT config::text AS config FROM provisioning_providers WHERE id = ?1`,
    )
      .bind(id)
      .first<{ config: string }>();
    const config = JSON.parse(row!.config) as Record<string, unknown>;
    expect(config['group_ids']).toEqual([2, 83]);
    expect(config, 'the legacy key must be gone, not left beside it').not.toHaveProperty(
      'inbounds',
    );
    // Everything else survives: `proxies` carries a hysteria shared secret that
    // provisioning has to send.
    expect(config['proxies']).toEqual({ vless: {} });
  });

  it('deduplicates and sorts, so one meaning is one row', async () => {
    const id = await migratedPanel('dedupe', {});
    await post(`/api/v1/admin/panels/${id}/groups`, { groupIds: [9, 2, 9, 2, 7] });
    const row = await baseEnv.DB.prepare(
      `SELECT config->'group_ids' AS g FROM provisioning_providers WHERE id = ?1`,
    )
      .bind(id)
      .first<{ g: unknown }>();
    expect(row!.g).toEqual([2, 7, 9]);
  });

  it('records the before and after in audit_logs', async () => {
    const id = await migratedPanel('audited', { inbounds: [42, 2] });
    await post(`/api/v1/admin/panels/${id}/groups`, { groupIds: [2] });
    const log = await baseEnv.DB.prepare(
      `SELECT action, before_json::text AS b, after_json::text AS a
         FROM audit_logs WHERE entity_type = 'PROVISIONING_PROVIDER' AND entity_id = ?1`,
    )
      .bind(String(id))
      .first<{ action: string; b: string; a: string }>();
    expect(log?.action).toBe('catalog.panel_groups_set');
    // The change a person needs during an incident: what it used to send.
    expect(log?.b).toContain('42');
    expect(log?.a).toContain('2');
  });

  it('refuses a REVIEWER, and changes nothing', async () => {
    const id = await migratedPanel('rev', { inbounds: [42] });
    expect(
      (await post(`/api/v1/admin/panels/${id}/groups`, { groupIds: [1] }, REVIEWER)).status,
    ).toBe(403);
    const out = (await (await get(`/api/v1/admin/panels/${id}/groups`)).json()) as {
      selected: number[];
    };
    expect(out.selected).toEqual([42]);
  }, 30_000);
});
