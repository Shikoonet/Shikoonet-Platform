/**
 * «اینباند اکانت غیرفعال» — moving an ended service onto the panel's spare group.
 *
 * The panel is faked, but the SQL is not: the rows are real, the sweep's filter
 * runs in Postgres, and the request body is asserted field by field. The body is
 * the behaviour — `group_ids` on the wrong key, or a `status` field smuggled in
 * beside it, is a live customer's account changed in a way nobody asked for.
 *
 * The failure this file exists to keep out is the legacy one. Its
 * `active_inbound_expire` has no expiry check of its own; the only filter is the
 * cron's invoice query, and that query includes `Status = 'active'`. So on a
 * panel with the feature on it fires against services that have not ended. The
 * first test here is that exact case.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { downgradeExpired } from '../src/downgrade.js';
import { db } from './helpers/env.js';
import { makeCustomer } from './helpers/shop.js';

const CUSTOMER = 952_000_001;
const PANEL_CODE = 'sim-downgrade-fixture';
const SECRET_REF = 'DOWNGRADEFIXTURE';

let userId = 0;
let panelId = 0;

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/**
 * A panel that answers the two calls this path makes: the login, and the user.
 *
 * `groups` is what `GET /api/user/{u}` reports the account is currently on —
 * the thing the sweep has to capture before it overwrites it.
 */
function fakePanel(options: { groups?: number[]; refuse?: boolean } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    let body: unknown = init?.body;
    if (typeof body === 'string' && body.startsWith('{')) body = JSON.parse(body);
    calls.push({ url, method, body });

    if (url.includes('/api/admin/token') || url.includes('/api/admins/token')) {
      return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    }
    if (method === 'PUT') {
      if (options.refuse) return new Response('nope', { status: 500 });
      return new Response(JSON.stringify({ username: 'acct', status: 'active' }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        username: 'acct',
        status: 'active',
        group_ids: options.groups ?? [7, 8],
      }),
      { status: 200 },
    );
  }) as typeof globalThis.fetch;

  return { calls, fetchImpl };
}

beforeAll(async () => {
  process.env[`PANEL_${SECRET_REF}`] = 'admin:secret';
  userId = await makeCustomer(CUSTOMER);
  const made = await db
    .prepare(
      `INSERT INTO provisioning_providers (code, name, kind, status, base_url, secret_ref, config)
       VALUES (?1, 'پنل تنزل', 'pasarguard', 'ACTIVE', 'https://downgrade.invalid', ?2, '{}'::jsonb)
       ON CONFLICT (code) DO UPDATE SET status = 'ACTIVE'
       RETURNING id`,
    )
    .bind(PANEL_CODE, SECRET_REF)
    .first<{ id: number }>();
  panelId = made!.id;
});

afterEach(async () => {
  await db.prepare('DELETE FROM subscriptions WHERE provider_id = ?1').bind(panelId).run();
});

afterAll(async () => {
  await db.prepare('DELETE FROM provisioning_providers WHERE id = ?1').bind(panelId).run();
  delete process.env[`PANEL_${SECRET_REF}`];
});

async function setGroups(ids: number[] | null): Promise<void> {
  await db
    .prepare(
      `UPDATE provisioning_providers
          SET config = COALESCE(config, '{}'::jsonb) || ?2::jsonb
        WHERE id = ?1`,
    )
    .bind(panelId, JSON.stringify({ downgrade_group_ids: ids ?? [] }))
    .run();
}

/** One service on the fixture panel. `hoursFromNow` may be negative — ended. */
async function giveService(publicId: string, hoursFromNow: number): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO subscriptions
         (public_id, user_id, provider_id, plan_name_at_sale, price_irr,
          remote_username, status, purchased_at, expires_at)
       VALUES (?1, ?2, ?3, 'سرویس تست تنزل', 1000, 'acct', 'ACTIVE', now(),
               now() + make_interval(secs => ?4))
       RETURNING id`,
    )
    .bind(publicId, userId, panelId, hoursFromNow * 3600)
    .first<{ id: number }>();
  return row!.id;
}

async function readMarker(id: number) {
  return db
    .prepare('SELECT downgraded_at, groups_before_downgrade FROM subscriptions WHERE id = ?1')
    .bind(id)
    .first<{ downgraded_at: string | null; groups_before_downgrade: unknown }>();
}

describe('downgradeExpired', () => {
  it('leaves a service that has not ended alone — the legacy bug, refused', async () => {
    await setGroups([3]);
    const id = await giveService('dg-live', 48);
    const { calls, fetchImpl } = fakePanel();

    const summary = await downgradeExpired(db, fetchImpl);

    expect(summary.moved).toBe(0);
    expect(calls).toEqual([]);
    expect((await readMarker(id))?.downgraded_at).toBeNull();
  });

  it('does nothing at all on a panel with no downgrade group set', async () => {
    // The state every panel starts in, and the state all five production panels
    // are in. This is what makes the whole feature inert until somebody asks.
    await setGroups(null);
    const id = await giveService('dg-unset', -1);
    const { calls, fetchImpl } = fakePanel();

    expect((await downgradeExpired(db, fetchImpl)).moved).toBe(0);
    expect(calls).toEqual([]);
    expect((await readMarker(id))?.downgraded_at).toBeNull();
  });

  it('moves an ended service and writes down what it was on', async () => {
    await setGroups([3, 4]);
    const id = await giveService('dg-ended', -1);
    const { calls, fetchImpl } = fakePanel({ groups: [7, 8] });

    const summary = await downgradeExpired(db, fetchImpl);
    expect(summary).toEqual({ moved: 1, failed: 0 });

    // The body, field by field. `group_ids` and nothing else: PUT /api/user is a
    // partial update, so a `status` or `data_limit` in here would silently
    // change something the shop did not decide.
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual({ group_ids: [3, 4] });

    const marker = await readMarker(id);
    expect(marker?.downgraded_at).not.toBeNull();
    // Read from the panel before the write, not from our own plan: the account
    // may have been moved by hand, and the panel is the only place that knows.
    expect(marker?.groups_before_downgrade).toEqual([7, 8]);
  });

  it('does not move the same service twice', async () => {
    await setGroups([3]);
    await giveService('dg-once', -1);
    const first = fakePanel();
    expect((await downgradeExpired(db, first.fetchImpl)).moved).toBe(1);

    const second = fakePanel();
    expect((await downgradeExpired(db, second.fetchImpl)).moved).toBe(0);
    expect(second.calls).toEqual([]);
  });

  it('leaves the row unmarked when the panel refuses, so the next pass retries', async () => {
    await setGroups([3]);
    const id = await giveService('dg-refused', -1);
    const { fetchImpl } = fakePanel({ refuse: true });

    const summary = await downgradeExpired(db, fetchImpl);
    expect(summary).toEqual({ moved: 0, failed: 1 });
    expect((await readMarker(id))?.downgraded_at).toBeNull();
  });

  it('still marks the row when the panel would not say what the account was on', async () => {
    // Losing the «before» is survivable — the renewal path falls back to the
    // plan's own groups, which is what a fresh purchase would have produced.
    // Refusing to downgrade over it would not be.
    await setGroups([3]);
    const id = await giveService('dg-noread', -1);
    const { fetchImpl } = fakePanel({ groups: [] });

    expect((await downgradeExpired(db, fetchImpl)).moved).toBe(1);
    const marker = await readMarker(id);
    expect(marker?.downgraded_at).not.toBeNull();
    expect(marker?.groups_before_downgrade).toBeNull();
  });
});
