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
import { panelSecretKey, seal } from '@shikoo/domain';
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

async function del(path: string, email = ADMIN): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'DELETE',
      headers: { origin: 'http://localhost' },
    }),
    envAs(email),
  );
}

/**
 * Give a panel a credential that opens.
 *
 * Some checks only happen AFTER `panelContext` has a login to work with — the
 * host guard reads the panel's host listing before it decides anything — and a
 * panel without one stops at «این پنل هنوز رمزی ندارد» and never reaches them.
 * Sealed with the real key rather than written raw, because the route opens it
 * with the real `open()`.
 */
async function withCredential(panelId: number): Promise<void> {
  await baseEnv.DB.prepare(
    `INSERT INTO provider_secrets (provider_id, sealed, key_id, set_by)
     VALUES (?1, ?2, 'test', 'test')
     ON CONFLICT (provider_id) DO UPDATE SET sealed = EXCLUDED.sealed`,
  )
    .bind(panelId, seal('admin:hunter2', panelSecretKey()))
    .run();
}

/** A product and a plan on this panel, so a plan can hold its own group ids. */
async function planWithGroups(panelId: number, label: string, groups: number[]): Promise<void> {
  const product = await baseEnv.DB.prepare(
    `INSERT INTO products (provider_id, code, name, kind, status)
     VALUES (?1, ?2, 'محصول', 'vpn', 'ACTIVE') RETURNING id`,
  )
    .bind(panelId, `${PREFIX}${label}`)
    .first<{ id: number }>();
  await baseEnv.DB.prepare(
    `INSERT INTO product_plans (product_id, name, price_irr, status, attrs)
     VALUES (?1, ?2, 1000, 'ACTIVE', ?3::jsonb)`,
  )
    .bind(product!.id, `پلن ${label}`, JSON.stringify({ group_ids: groups }))
    .run();
}

/** A SERVICE on this panel that carries its own groups — «پلاتینیوم». */
async function productWithGroups(panelId: number, label: string, groups: number[]): Promise<void> {
  await baseEnv.DB.prepare(
    `INSERT INTO products (provider_id, code, name, kind, status, attrs)
     VALUES (?1, ?2, ?3, 'vpn', 'ACTIVE', ?4::jsonb)`,
  )
    .bind(panelId, `${PREFIX}${label}`, `سرویس ${label}`, JSON.stringify({ group_ids: groups }))
    .run();
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
  await baseEnv.DB.prepare(
    `DELETE FROM provider_secrets WHERE provider_id IN
       (SELECT id FROM provisioning_providers WHERE code LIKE ?1)`,
  )
    .bind(`${PREFIX}%`)
    .run();
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

/**
 * Making and unmaking a group on the panel.
 *
 * These routes reach a real panel, and `panel.invalid` can never resolve
 * (RFC 2606), so what is provable here without one is exactly the part that
 * matters most: the ORDER of the checks. The delete guard runs before anything
 * is sent, which is the whole of its value — a guard that only fires after the
 * panel has been asked is a guard that does nothing when the panel is up.
 */
describe('creating and deleting a group on the panel', () => {
  it('refuses to delete a group this panel still sells, before touching the panel', async () => {
    // The group-42 story with the arrow reversed. Deleting a group our own
    // config still sends turns the next purchase into `404 Group not found` →
    // non-retryable → the customer pays, waits, and is refunded with a «تماس
    // بگیرید». Preventable here rather than merely reportable, so prevented.
    //
    // 409 and not 400: this is a state conflict, and the caller can fix it by
    // unticking the group. The reply says so.
    const id = await migratedPanel('sells-2', { group_ids: [2, 7] });
    const res = await del(`/api/v1/admin/panels/${id}/panel-groups/2`);
    expect(res.status).toBe(409);
    const out = (await res.json()) as { error: string; detail: string };
    expect(out.error).toBe('group_in_use');
    expect(out.detail).toContain('تیک');
  });

  it('refuses when only a PLAN sends it, not the panel', async () => {
    // `pick()` reads the plan's `attrs.group_ids` before the panel's, so a plan
    // is not a lesser claim on a group — it is the stronger one. The legacy
    // shop sold every tier this way. A guard that checked only the panel's own
    // selection would wave through the delete that breaks the VIP plan and
    // leave the panel default untouched, which is the exact shape of a bug
    // nobody notices until a customer pays.
    const id = await migratedPanel('plan-only', { group_ids: [] });
    await planWithGroups(id, 'vip', [42]);
    const res = await del(`/api/v1/admin/panels/${id}/panel-groups/42`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('group_in_use');
  });

  it('refuses when a SERVICE sends it, with nothing on the panel or the plan', async () => {
    // The level this whole change added. «پلاتینیوم» is sold by pointing a
    // PRODUCT at group 6, and that is now the ordinary way a tier is set up —
    // so a guard reading only the panel's ticks and the plans' overrides would
    // wave through the delete of exactly the group the shop is selling, and the
    // next purchase of that service would come back `404 Group not found`.
    const id = await migratedPanel('service-only', { group_ids: [] });
    await productWithGroups(id, 'platinum', [6]);
    const res = await del(`/api/v1/admin/panels/${id}/panel-groups/6`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('group_in_use');
  });

  it('reads the legacy `inbounds` spelling when deciding what is in use', async () => {
    // Every migrated panel carries the old key. A guard that read only the
    // current spelling would be OFF for all five production panels — which is
    // the only way it could matter and the only way nobody would find out.
    const id = await migratedPanel('legacy-use', { inbounds: [42, 2] });
    expect((await del(`/api/v1/admin/panels/${id}/panel-groups/42`)).status).toBe(409);
  });

  it('lets an unused group through the guard, and then fails on the panel', async () => {
    // The other half of the same proof: the guard is a guard, not a wall. 9 is
    // in nothing, so the request reaches the adapter — and dies at
    // `panel.invalid`, which is 400 and NOT 409. Without this the first three
    // tests would also pass if the route refused everything.
    const id = await migratedPanel('unused', { group_ids: [2] });
    await planWithGroups(id, 'other', [7]);
    const res = await del(`/api/v1/admin/panels/${id}/panel-groups/9`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('panel_unavailable');
  }, 30_000);

  it('refuses a REVIEWER on all three writes', async () => {
    const id = await migratedPanel('rev-crud', { group_ids: [] });
    expect(
      (await post(`/api/v1/admin/panels/${id}/panel-groups`, { name: 'x', inboundTags: [] }, REVIEWER))
        .status,
    ).toBe(403);
    expect(
      (
        await post(
          `/api/v1/admin/panels/${id}/panel-groups/1`,
          { name: 'x', inboundTags: [] },
          REVIEWER,
        )
      ).status,
    ).toBe(403);
    expect((await del(`/api/v1/admin/panels/${id}/panel-groups/1`, REVIEWER)).status).toBe(403);
  });

  it('rejects a nameless group before it reaches the panel', async () => {
    // The panel would answer 422 «name Field required» anyway. Catching it here
    // is what turns that into a sentence about the field that is missing.
    const id = await migratedPanel('noname', { group_ids: [] });
    const res = await post(`/api/v1/admin/panels/${id}/panel-groups`, { inboundTags: [] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
  });

  it('says WHY a panel could not be reached, rather than 500', async () => {
    // An operator who is told «آدرس پنل وارد نشده است» opens the right field.
    // One who is told «500» opens a support ticket.
    const bare = await baseEnv.DB.prepare(
      `INSERT INTO provisioning_providers (code, name, kind, status, base_url, config)
       VALUES (?1, 'بدون آدرس', 'pasarguard', 'ACTIVE', NULL, '{}'::jsonb)
       RETURNING id`,
    )
      .bind(`${PREFIX}bare`)
      .first<{ id: number }>();
    const res = await post(`/api/v1/admin/panels/${bare!.id}/panel-groups`, {
      name: 'پلاتینیوم',
      inboundTags: [],
    });
    expect(res.status).toBe(400);
    const out = (await res.json()) as { error: string; detail: string };
    expect(out.error).toBe('panel_unavailable');
    expect(out.detail).toContain('آدرس');
  });

  it('answers `inbounds: null`, never an empty list, when the panel cannot be asked', async () => {
    // Same distinction the group listing makes. An empty list here would send
    // an operator to build a tier out of nothing.
    const id = await migratedPanel('inb', { group_ids: [] });
    const res = await get(`/api/v1/admin/panels/${id}/inbounds`);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { inbounds: unknown; reason?: string };
    expect(out.inbounds).toBeNull();
    expect(typeof out.reason).toBe('string');
  }, 30_000);

  it('lets a REVIEWER read the inbound list', async () => {
    // A read. The three writes above are ADMIN-only; this one is not, for the
    // same reason the group listing is not.
    const id = await migratedPanel('inb-rev', { group_ids: [] });
    expect((await get(`/api/v1/admin/panels/${id}/inbounds`, REVIEWER)).status).toBe(200);
  }, 30_000);
});

/**
 * Hosts — and the one delete that has to be refused.
 *
 * `panel.invalid` never resolves, so what is provable here is the order of the
 * checks, which is the part that matters: the host guard needs the panel's host
 * listing to know what a delete would strand, and a guard that gives up and
 * deletes anyway when it cannot read that listing is worse than no guard. It
 * refuses instead.
 */
describe('hosts on the panel', () => {
  it('refuses the delete when it cannot read what the delete would empty', async () => {
    // The listing is unreachable here. The wrong behaviour would be to shrug
    // and pass the delete through — every tier this host feeds would go quiet
    // and nothing would have said so.
    const id = await migratedPanel('host-blind', { group_ids: [2] });
    await withCredential(id);
    const res = await del(`/api/v1/admin/panels/${id}/hosts/1`);
    expect(res.status).toBe(400);
    const out = (await res.json()) as { error: string; detail: string };
    expect(out.error).toBe('panel_unavailable');
    expect(out.detail).toContain('نمی‌دانیم');
  }, 30_000);

  it('needs a name before it will ask the panel for anything', async () => {
    const id = await migratedPanel('host-noname', { group_ids: [] });
    const res = await post(`/api/v1/admin/panels/${id}/hosts`, {
      inboundTag: 'Shadowsocks TCP',
      addresses: [],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
  });

  it('takes an empty address list, because an empty one is a real answer', async () => {
    // A host with no address resolves to the panel's own — the single-server
    // case. It must get past the schema and fail at the PANEL, not before.
    const id = await migratedPanel('host-empty-addr', { group_ids: [] });
    await withCredential(id);
    const res = await post(`/api/v1/admin/panels/${id}/hosts`, {
      remark: 'آلمان-۱',
      inboundTag: 'Shadowsocks TCP',
      addresses: [],
    });
    // Past the schema and into the adapter, which is the whole claim: the
    // failure is the unreachable `panel.invalid`, NOT a rejected body.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('panel_refused');
  }, 30_000);

  it('refuses a REVIEWER on both writes', async () => {
    const id = await migratedPanel('host-rev', { group_ids: [] });
    expect(
      (
        await post(
          `/api/v1/admin/panels/${id}/hosts`,
          { remark: 'x', inboundTag: 'y', addresses: [] },
          REVIEWER,
        )
      ).status,
    ).toBe(403);
    expect((await del(`/api/v1/admin/panels/${id}/hosts/1`, REVIEWER)).status).toBe(403);
  });

  it('lets a REVIEWER read the host list, and answers null rather than empty', async () => {
    const id = await migratedPanel('host-read', { group_ids: [] });
    const res = await get(`/api/v1/admin/panels/${id}/hosts`, REVIEWER);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { hosts: unknown; reason?: string };
    // «could not ask» and «has none» are different sentences, and only one of
    // them should send an operator to add an address that already exists.
    expect(out.hosts).toBeNull();
    expect(typeof out.reason).toBe('string');
  }, 30_000);
});
