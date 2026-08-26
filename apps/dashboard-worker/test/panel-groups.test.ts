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

import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
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
/** The one customer the delete guard needs, and the only one this file makes. */
const SUB_OWNER_TELEGRAM_ID = 920_000_001;

async function purge(): Promise<void> {
  // Subscriptions first, and by TELEGRAM ID rather than by provider: the FK is
  // `ON DELETE SET NULL`, so a leftover row from a failed run has already lost
  // the provider that would have identified it.
  await baseEnv.DB.prepare(
    `DELETE FROM subscriptions WHERE user_id IN
       (SELECT id FROM users WHERE telegram_id = ?1)`,
  )
    .bind(SUB_OWNER_TELEGRAM_ID)
    .run();
  await baseEnv.DB.prepare(`DELETE FROM users WHERE telegram_id = ?1`)
    .bind(SUB_OWNER_TELEGRAM_ID)
    .run();
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

afterEach(() => {
  vi.restoreAllMocks();
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

/*
 * «saving a panel's groups» was a describe block here, covering
 * `POST /panels/:id/groups`. Both are gone.
 *
 * The route wrote a panel-level default group list that nothing read: delivery
 * resolves the tier through `groupIdsFor`, which looks at the plan's attrs and
 * then the provider config and never at that column. The tests were real — they
 * proved the write deduplicated, removed the legacy `inbounds` spelling, and
 * audited itself — and every one of them proved a property of a value no
 * purchase consulted. That is the shape rule 6 warns about at its most
 * expensive: four green tests around a control whose effect was zero.
 *
 * Reading a panel's groups stays, and is covered above; it is what the
 * catalogue screen uses to tell an operator which service will fail.
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

  it('reports which services still ride the panel default', async () => {
    // The screen draws a tick column and a «فروخته می‌شود در» column side by
    // side. The tick is the panel's FALLBACK and reaches a customer only
    // through a service that has no level of its own — so without knowing which
    // services those are, the two columns describe different things under one
    // heading and contradict each other: on the live panel `normal` sat
    // unticked next to «سرویس معمولی».
    const id = await migratedPanel('inherit', { group_ids: [2] });
    await productWithGroups(id, 'has-level', [6]);
    await baseEnv.DB.prepare(
      `INSERT INTO products (provider_id, code, name, kind, status)
       VALUES (?1, ?2, 'بدون سطح', 'vpn', 'ACTIVE')`,
    )
      .bind(id, `${PREFIX}no-level`)
      .run();

    const res = await app.request(`/api/v1/admin/panels/${id}/groups`, {}, envAs(ADMIN));
    const out = (await res.json()) as {
      selected: number[];
      inherit: { name: string }[];
      plans: { name: string; level: string }[];
    };
    expect(out.selected).toEqual([2]);
    // Only the one with no level of its own. A service that chose is not
    // affected by the tick and must not be listed under it.
    expect(out.inherit.map((p) => p.name)).toEqual(['بدون سطح']);
    expect(out.plans.map((p) => p.name)).toContain('سرویس has-level');
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
    const out = (await res.json()) as { error: string; detail: string };
    expect(out.error).toBe('group_in_use');
    // The refusal has to name the level that actually fired. It used to say
    // «این پنل یا یکی از پلن‌هایش» — true before services existed, and after
    // them a sentence that sends the operator looking in the two places the
    // group is NOT.
    expect(out.detail).toContain('سرویس');
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

/**
 * Saving which groups a panel sells.
 *
 * The route this exercises was deleted on 2026-08-24 with a note saying nothing
 * read the column, and brought back on 2026-08-26 because that note
 * contradicted itself — the column IS the provider config, which `groupIdsFor`
 * reads after the plan's attrs. So these assertions are about the two things
 * that WERE wrong, not about whether a write lands:
 *
 *   - an empty selection must remove the key, never store `[]`. `[]` is not
 *     nullish, so it beat the panel underneath it and `provision` sent
 *     `group_ids: []` — an account in no group, with no inbounds, on a
 *     subscription link that resolves and returns nothing.
 *   - the legacy `inbounds` spelling must go with it, in BOTH branches. Leaving
 *     it behind would let it answer for a panel an operator had just cleared.
 */
describe('saving which groups a panel sells', () => {
  async function config(id: number): Promise<Record<string, unknown>> {
    const row = await baseEnv.DB.prepare(`SELECT config FROM provisioning_providers WHERE id = ?1`)
      .bind(id)
      .first<{ config: Record<string, unknown> }>();
    return row!.config;
  }

  it('stores the selection and drops the legacy spelling with it', async () => {
    const id = await migratedPanel('save-basic', { inbounds: [42, 2], proxies: { vless: {} } });

    const res = await post(`/api/v1/admin/panels/${id}/groups`, { groupIds: [7, 3, 7] });
    expect(res.status).toBe(200);

    const c = await config(id);
    // De-duplicated and sorted, so saving the same ticks twice is not recorded
    // as a change.
    expect(c['group_ids']).toEqual([3, 7]);
    expect(c).not.toHaveProperty('inbounds');
    // Everything else in the object survives — `proxies` carries a hysteria
    // shared secret provisioning has to send.
    expect(c['proxies']).toEqual({ vless: {} });
  });

  it('removes the key when nothing is ticked, rather than storing an empty list', async () => {
    const id = await migratedPanel('save-empty', { inbounds: [42], group_ids: [42] });

    expect((await post(`/api/v1/admin/panels/${id}/groups`, { groupIds: [] })).status).toBe(200);

    const c = await config(id);
    expect(c).not.toHaveProperty('group_ids');
    expect(c).not.toHaveProperty('inbounds');
    // The distinction this test exists for: absent is "the panel names no
    // default", `[]` is "put the account in no group", and only the first is
    // ever what an operator clearing the ticks means.
    expect(JSON.stringify(c)).not.toContain('[]');
  });

  it('records before and after in audit_logs', async () => {
    const id = await migratedPanel('save-audit', { inbounds: [42, 2] });
    await post(`/api/v1/admin/panels/${id}/groups`, { groupIds: [3] });

    const log = await baseEnv.DB.prepare(
      `SELECT before_json::text AS before, after_json::text AS after
         FROM audit_logs
        WHERE action = 'catalog.panel_groups_set' AND entity_id = ?1`,
    )
      .bind(String(id))
      .first<{ before: string; after: string }>();
    expect(log?.before).toContain('42');
    expect(log?.after).toContain('3');
  });

  it('is refused for a reviewer, and nothing moves', async () => {
    const id = await migratedPanel('save-reviewer', { group_ids: [1] });
    expect(
      (await post(`/api/v1/admin/panels/${id}/groups`, { groupIds: [9] }, REVIEWER)).status,
    ).toBe(403);
    expect((await config(id))['group_ids']).toEqual([1]);
  });

  it('refuses a body that is not a list of ids, and 404s on a panel that is gone', async () => {
    const id = await migratedPanel('save-bad', {});
    expect((await post(`/api/v1/admin/panels/${id}/groups`, { groupIds: ['x'] })).status).toBe(400);
    expect((await post(`/api/v1/admin/panels/${id}/groups`, { nope: [1] })).status).toBe(400);
    expect((await post(`/api/v1/admin/panels/2000000003/groups`, { groupIds: [1] })).status).toBe(
      404,
    );
  });
});

/**
 * Deleting a panel.
 *
 * The shop this screen is modelled on counts what points at the panel, deletes
 * anyway, and reports how many services it orphaned afterwards
 * (`legacy/faoxima/panel/panels.php:1219`). On our schema that is worse than it
 * sounds: `subscriptions.provider_id` is `ON DELETE SET NULL`, so Postgres does
 * not raise — it strips the panel off every live subscription and the delete
 * looks like it worked.
 *
 * So the guard is inside the DELETE, and these tests are about the refusal
 * being real rather than about the happy path.
 */
describe('deleting a panel', () => {
  async function exists(id: number): Promise<boolean> {
    const row = await baseEnv.DB.prepare(`SELECT 1 FROM provisioning_providers WHERE id = ?1`)
      .bind(id)
      .first();
    return row !== null;
  }

  it('removes a panel nothing points at, and its sealed credential with it', async () => {
    const id = await migratedPanel('del-empty', {});
    await withCredential(id);

    expect((await del(`/api/v1/admin/panels/${id}`)).status).toBe(200);
    expect(await exists(id)).toBe(false);

    const secret = await baseEnv.DB.prepare(`SELECT 1 FROM provider_secrets WHERE provider_id = ?1`)
      .bind(id)
      .first();
    expect(secret, 'the sealed credential outlived the panel').toBeNull();
  });

  it('refuses while a service still points at it, and names the count', async () => {
    const id = await migratedPanel('del-products', {});
    await productWithGroups(id, 'del-p', [3]);

    const res = await del(`/api/v1/admin/panels/${id}`);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string; detail: string; counts: unknown };
    expect(json.error).toBe('in_use');
    expect(json.counts).toMatchObject({ products: 1 });
    // The refusal has to say what to do instead, or it sends an operator
    // hunting for a button that will never work.
    expect(json.detail).toContain('غیرفعال');
    expect(await exists(id)).toBe(true);
  });

  /**
   * The one Postgres would NOT have caught.
   *
   * `products.provider_id` is `ON DELETE RESTRICT`, so the previous test would
   * fail loudly even without the guard. `subscriptions.provider_id` is
   * `ON DELETE SET NULL` — remove the `NOT EXISTS` for subscriptions and this
   * test goes red while every other one here stays green.
   */
  it('refuses while a live subscription still points at it', async () => {
    const id = await migratedPanel('del-subs', {});
    const user = await baseEnv.DB.prepare(
      `INSERT INTO users (telegram_id, registered_at, created_at, updated_at)
       VALUES (?1, now(), now(), now()) RETURNING id`,
    )
      .bind(SUB_OWNER_TELEGRAM_ID)
      .first<{ id: number }>();
    await baseEnv.DB.prepare(
      `INSERT INTO subscriptions
         (public_id, user_id, provider_id, plan_name_at_sale, price_irr, status, purchased_at)
       VALUES (?1, ?2, ?3, 'p', 1000, 'ACTIVE', now())`,
    )
      .bind(crypto.randomUUID(), Number(user!.id), id)
      .run();

    const res = await del(`/api/v1/admin/panels/${id}`);
    expect(res.status).toBe(409);
    expect((await res.json()) as { counts: unknown }).toMatchObject({
      counts: { subscriptions: 1 },
    });
    expect(await exists(id)).toBe(true);
  });

  it('is refused for a reviewer, and the panel stays', async () => {
    const id = await migratedPanel('del-reviewer', {});
    expect((await del(`/api/v1/admin/panels/${id}`, REVIEWER)).status).toBe(403);
    expect(await exists(id)).toBe(true);
  });

  it('404s on a panel that is already gone', async () => {
    expect((await del('/api/v1/admin/panels/2000000004')).status).toBe(404);
  });
});

/**
 * Retiring a tier: the move that belongs in front of the delete.
 *
 * `deleteGroup` on its own leaves the members' accounts alive and their
 * subscription links empty — a PasarGuard link is resolved when it is fetched,
 * so nothing breaks at the moment of deletion and every one of those customers
 * quietly stops receiving configs on their next refresh. The route under test
 * is the step that makes that avoidable, and the assertions here are about the
 * two ways it can be worse than doing nothing: moving people into a group that
 * is not there, and telling an operator «done» when it stopped halfway.
 */
describe('moving a group’s members before retiring it', () => {
  /** A panel that answers, with two groups and three accounts. */
  function panelAnswers(): void {
    const users = [
      { username: 'ali', group_ids: [3] },
      { username: 'sara', group_ids: [3, 6] },
      { username: 'reza', group_ids: [6] },
    ];
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        const method = init?.method ?? 'GET';
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          });

        if (url.endsWith('/api/admin/token')) return json({ access_token: 'tok' });
        if (url.includes('/api/groups')) {
          return json({
            groups: [
              { id: 3, name: 'خرید اولی‌ها', inbound_tags: ['Shadowsocks TCP'], total_users: 2 },
              { id: 6, name: 'طلایی', inbound_tags: ['Shadowsocks TCP'], total_users: 2 },
            ],
          });
        }
        if (url.includes('/api/hosts')) return json([]);
        // The whole list whatever the query string says, because the panel does.
        if (url.includes('/api/users')) return json({ users });
        const put = /\/api\/user\/([^/?]+)$/.exec(url);
        if (put && method === 'PUT') {
          const found = users.find((u) => u.username === decodeURIComponent(put[1]!));
          const spec = JSON.parse(String(init?.body ?? '{}')) as { group_ids?: number[] };
          if (found && Array.isArray(spec.group_ids)) found.group_ids = spec.group_ids;
          return json(found ?? {});
        }
        return new Response('', { status: 200 });
      },
    );
  }

  it('moves them, and says how many', async () => {
    panelAnswers();
    const id = await migratedPanel('retire', { group_ids: [6] });
    await withCredential(id);
    const res = await post(`/api/v1/admin/panels/${id}/panel-groups/3/move-members`, {
      toGroupId: 6,
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { moved: number; scanned: number };
    expect(out.moved).toBe(2);
    // The population it had to read to find them. Not the same number, and the
    // gap is the whole reason this walks the panel instead of asking it.
    expect(out.scanned).toBe(3);
  }, 30_000);

  it('refuses a destination the panel does not have, before moving anybody', async () => {
    // Group 42 again, pointed the other way. `PUT` would take some of the
    // members into a group that is not there and the operator would be told the
    // tier was migrated — then every one of those accounts delivers nothing.
    // Checked against the panel's OWN listing, because the screen's copy can be
    // a minute old and a minute is enough for somebody else to have deleted it.
    panelAnswers();
    const id = await migratedPanel('bad-target', { group_ids: [6] });
    await withCredential(id);
    const res = await post(`/api/v1/admin/panels/${id}/panel-groups/3/move-members`, {
      toGroupId: 42,
    });
    expect(res.status).toBe(400);
    const out = (await res.json()) as { error: string; detail: string };
    expect(out.error).toBe('target_missing');
    expect(out.detail).toContain('هیچ‌کس جابه‌جا نشد');
  }, 30_000);

  it('refuses moving a group into itself', async () => {
    panelAnswers();
    const id = await migratedPanel('same', { group_ids: [6] });
    await withCredential(id);
    const res = await post(`/api/v1/admin/panels/${id}/panel-groups/3/move-members`, {
      toGroupId: 3,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('same_group');
  }, 30_000);

  it('records the move in the audit log, with the count', async () => {
    // An append-only log that records only the successes cannot answer «who was
    // moved before it broke», which is the question a half-finished move leaves.
    panelAnswers();
    const id = await migratedPanel('audited', { group_ids: [6] });
    await withCredential(id);
    await post(`/api/v1/admin/panels/${id}/panel-groups/3/move-members`, { toGroupId: 6 });

    // `::text`, like the audit assertion two blocks up: the driver hands jsonb
    // back as a string here, and a `toMatchObject` against it passes for the
    // wrong reason on the day it starts arriving parsed.
    const row = await baseEnv.DB.prepare(
      `SELECT after_json::text AS after FROM audit_logs
        WHERE action = 'catalog.panel_group_members_moved' ORDER BY id DESC LIMIT 1`,
    ).first<{ after: string }>();
    expect(row, 'nothing was audited').not.toBeNull();
    expect(JSON.parse(row!.after)).toMatchObject({ from: 3, to: 6, moved: 2 });
  }, 30_000);

  it('refuses a REVIEWER', async () => {
    const id = await migratedPanel('rev-move', { group_ids: [6] });
    const res = await post(
      `/api/v1/admin/panels/${id}/panel-groups/3/move-members`,
      { toGroupId: 6 },
      REVIEWER,
    );
    expect(res.status).toBe(403);
  });

  it('rejects a body with anything else in it', async () => {
    // `.strict()`, like every other body in this app. A typo'd field silently
    // ignored is how a caller believes it asked for something it did not.
    const id = await migratedPanel('strict-move', { group_ids: [6] });
    const res = await post(`/api/v1/admin/panels/${id}/panel-groups/3/move-members`, {
      toGroupId: 6,
      alsoDelete: true,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
  });
});
