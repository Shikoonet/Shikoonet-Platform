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

/**
 * Every fixture panel this file makes, not just the main one.
 *
 * A test that ends in a throw never reaches its own cleanup lines, and the row
 * it left behind then fails the NEXT test — which is how removing the per-row
 * try produced two red tests instead of one. The second was a cascade and said
 * nothing about the guard. Cleaning up by prefix here makes each failure mean
 * only itself.
 */
afterEach(async () => {
  await db
    .prepare(
      `DELETE FROM subscriptions WHERE provider_id IN
         (SELECT id FROM provisioning_providers WHERE code LIKE ?1)`,
    )
    .bind(`${PANEL_CODE}%`)
    .run();
  await db
    .prepare(
      `DELETE FROM provider_secrets WHERE provider_id IN
         (SELECT id FROM provisioning_providers WHERE code LIKE ?1 AND code <> ?2)`,
    )
    .bind(`${PANEL_CODE}%`, PANEL_CODE)
    .run();
  await db
    .prepare('DELETE FROM provisioning_providers WHERE code LIKE ?1 AND code <> ?2')
    .bind(`${PANEL_CODE}%`, PANEL_CODE)
    .run();
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
       -- The name is the public id, so it is unique per row: 0051 makes
       -- (provider_id, remote_username) unique the way a real panel does.
       VALUES (?1, ?2, ?3, 'سرویس تست تنزل', 1000, 'acct' || ?1, 'ACTIVE', now(),
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

  /**
   * The batch bug, and why it needs a second panel to show at all.
   *
   * `BATCH` is 50. Fill it with expired services on a panel that has NO
   * downgrade group, put one eligible service behind them, and the version
   * that filtered in TypeScript after the LIMIT returns «0 moved» — for ever,
   * on every pass, because the same fifty come back first each time.
   *
   * 60 rows rather than 51: the ordering is by `expires_at`, so the blockers
   * are given older expiries and the eligible one the newest. A test that
   * merely inserted more rows than the batch could pass by luck of ordering.
   */
  it('does not let unconfigured panels fill the batch', async () => {
    await setGroups(null);
    for (let i = 0; i < 60; i++) {
      await giveService(`dg-blocker-${i}`, -48);
    }

    const other = await db
      .prepare(
        `INSERT INTO provisioning_providers (code, name, kind, status, base_url, secret_ref, config)
         VALUES (?1, 'پنل تنزل دوم', 'pasarguard', 'ACTIVE', 'https://downgrade2.invalid', ?2,
                 '{"downgrade_group_ids": [9]}'::jsonb)
         ON CONFLICT (code) DO UPDATE SET status = 'ACTIVE'
         RETURNING id`,
      )
      .bind(`${PANEL_CODE}-2`, SECRET_REF)
      .first<{ id: number }>();

    // Newest expiry of the lot, so it sorts LAST and only a query that has
    // already dropped the sixty blockers can reach it.
    await db
      .prepare(
        `INSERT INTO subscriptions
           (public_id, user_id, provider_id, plan_name_at_sale, price_irr,
            remote_username, status, purchased_at, expires_at)
         VALUES ('dg-behind', ?1, ?2, 'سرویس پشت صف', 1000, 'acct', 'ACTIVE', now(),
                 now() - make_interval(secs => 60))`,
      )
      .bind(userId, other!.id)
      .run();

    const { fetchImpl } = fakePanel();
    const summary = await downgradeExpired(db, fetchImpl);
    expect(summary.moved).toBe(1);

    await db.prepare('DELETE FROM subscriptions WHERE provider_id = ?1').bind(other!.id).run();
    await db.prepare('DELETE FROM provisioning_providers WHERE id = ?1').bind(other!.id).run();
  });

  /**
   * A sealed credential that will not open, which is the only thing on this
   * path that throws where nothing catches it.
   *
   * The FIRST version of this test threw from the fake `fetch` and passed with
   * the guard removed — because `marzbanAdapter.act` has its own outer
   * try/catch and turns any throw into `{ok:false, retryable:true}`. So it was
   * green for the adapter's reason, not for this file's, and proved nothing.
   *
   * `credentialsFor` is outside that. It throws on a sealed row it cannot open
   * — whether because `PANEL_SECRET_KEY` is absent or because the row will not
   * authenticate; both land in the same catch, which is why this test sets no
   * key of its own. It did once, and `fileParallelism: false` means one process
   * for every file in this package, so a bogus key left in `process.env` turned
   * five renewal tests red two files later.
   * — `provision.ts` keeps it that way deliberately, because answering «no
   * credential» there would refund a paying customer over a wrong
   * `PANEL_SECRET_KEY`. Before the per-row try, one such row aborted the whole
   * sweep and every other customer's ended service waited behind it.
   */
  it('keeps sweeping when one row cannot open its credential', async () => {
    await setGroups([3]);
    await giveService('dg-after-throw', -1);

    // A second panel whose SEALED credential is garbage. Sealed, not the
    // environment path: `credentialsFor` answers null for a missing env var
    // and only throws for a sealed row, so this is the one shape that
    // reproduces it.
    const broken = await db
      .prepare(
        `INSERT INTO provisioning_providers (code, name, kind, status, base_url, config)
         VALUES (?1, 'پنل با رمز خراب', 'pasarguard', 'ACTIVE', 'https://broken.invalid',
                 '{"downgrade_group_ids": [5]}'::jsonb)
         ON CONFLICT (code) DO UPDATE SET status = 'ACTIVE'
         RETURNING id`,
      )
      .bind(`${PANEL_CODE}-broken`)
      .first<{ id: number }>();
    await db
      .prepare(
        `INSERT INTO provider_secrets (provider_id, sealed, key_id)
         VALUES (?1, 'not-a-sealed-value', 'test')
         ON CONFLICT (provider_id) DO UPDATE SET sealed = EXCLUDED.sealed`,
      )
      .bind(broken!.id)
      .run();
    // Oldest expiry, so it is swept FIRST and anything escaping it would
    // reach the healthy row behind it.
    await db
      .prepare(
        `INSERT INTO subscriptions
           (public_id, user_id, provider_id, plan_name_at_sale, price_irr,
            remote_username, status, purchased_at, expires_at)
         VALUES ('dg-broken-secret', ?1, ?2, 'سرویس رمزخراب', 1000, 'acct', 'ACTIVE', now(),
                 now() - make_interval(secs => 86400))`,
      )
      .bind(userId, broken!.id)
      .run();

    const { fetchImpl } = fakePanel();
    const summary = await downgradeExpired(db, fetchImpl);
    // One counted as failed, one still moved. Without the per-row try the
    // whole call rejects and neither number exists.
    expect(summary).toEqual({ moved: 1, failed: 1 });

    await db.prepare('DELETE FROM subscriptions WHERE provider_id = ?1').bind(broken!.id).run();
    await db.prepare('DELETE FROM provider_secrets WHERE provider_id = ?1').bind(broken!.id).run();
    await db.prepare('DELETE FROM provisioning_providers WHERE id = ?1').bind(broken!.id).run();
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
