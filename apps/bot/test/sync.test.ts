/**
 * The sweep that keeps the service screen honest.
 *
 * Two properties matter more than the happy path:
 *
 *   - A panel that will not answer must change nothing. The alternative — a
 *     row whose usage is blanked because a panel had a bad minute — reads to
 *     the customer as data loss.
 *   - It must not run on every poll cycle. At 25 seconds a cycle that is 144
 *     listings an hour per panel for a number that moves slowly.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYNC_INTERVAL_MS, syncSubscriptions } from '../src/sync.js';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer, providerId } from './helpers/shop.js';

const NOW_MS = Date.UTC(2026, 7, 13, 12, 0, 0);
const GIB = 1024 ** 3;
const PROVIDER_CODE = 'sim-sync-panel';

let seq = 0;
function nextTelegramId(): number {
  seq += 1;
  return 690_000 + seq * 13;
}

/** A panel that reports usage for whatever accounts it was given. */
function fakePanel(accounts: { username: string; used: number; url?: string | null }[]) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/api/admin/token')) {
      return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
    }
    if (url.includes('/api/users?')) {
      return new Response(
        JSON.stringify({
          users: accounts.map((a) => ({
            username: a.username,
            used_traffic: a.used,
            subscription_url: a.url === undefined ? `/sub/${a.username}` : a.url,
          })),
          total: accounts.length,
        }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 500 });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

const deadPanel = (async () =>
  Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof globalThis.fetch;

async function makeService(
  userId: number,
  provider: number,
  fields: {
    publicId: string;
    username: string | null;
    url?: string | null;
    usedBytes?: number | null;
    status?: string;
    syncedAtMs?: number | null;
  },
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO subscriptions
         (public_id, user_id, provider_id, plan_name_at_sale, price_irr,
          remote_username, subscription_url, used_bytes, volume_gb,
          status, purchased_at, last_synced_at)
       VALUES (?1, ?2, ?3, 'sync fixture', 1950000, ?4, ?5, ?6, 50, ?7, now(),
               CASE WHEN ?8::bigint IS NULL THEN NULL ELSE to_timestamp(?8 / 1000.0) END)
       RETURNING id`,
    )
    .bind(
      fields.publicId,
      userId,
      provider,
      fields.username,
      fields.url ?? null,
      fields.usedBytes ?? null,
      fields.status ?? 'ACTIVE',
      fields.syncedAtMs ?? null,
    )
    .first<{ id: number }>();
  if (!row) throw new Error('sync fixture failed');
  return row.id;
}

async function readService(id: number) {
  return db
    .prepare(`SELECT used_bytes, subscription_url, last_synced_at FROM subscriptions WHERE id = ?1`)
    .bind(id)
    .first<{
      used_bytes: number | null;
      subscription_url: string | null;
      last_synced_at: string | null;
    }>();
}

/** Nothing else in the database may be ACTIVE with a remote username, or the
 *  sweep would call panels these tests know nothing about. */
async function clearOtherServices(): Promise<void> {
  await db.prepare(`DELETE FROM subscriptions`).run();
}

let panelId: number;

beforeAll(async () => {
  await ensureCatalog();
  process.env[`PANEL_${PROVIDER_CODE.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = 'admin:secret';
  panelId = await providerId('sim-vip');
  await db
    .prepare(
      `UPDATE provisioning_providers
          SET base_url = 'https://sync.test', secret_ref = ?2, kind = 'pasarguard'
        WHERE id = ?1`,
    )
    .bind(panelId, PROVIDER_CODE)
    .run();
});

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  await clearOtherServices();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('refreshing what the customer sees', () => {
  it('writes usage and the link onto the matching subscription', async () => {
    const userId = await makeCustomer(nextTelegramId());
    const id = await makeService(userId, panelId, {
      publicId: 'sync-a',
      username: 'u_a',
      url: null,
      usedBytes: null,
    });
    const panel = fakePanel([{ username: 'u_a', used: 3 * GIB }]);

    const summary = await syncSubscriptions(db, panel.fetchImpl, NOW_MS);

    expect(summary).toMatchObject({ panels: 1, updated: 1, failed: 0 });
    const after = await readService(id);
    expect(after?.used_bytes).toBe(3 * GIB);
    expect(after?.subscription_url).toBe('https://sync.test/sub/u_a');
    expect(after?.last_synced_at).not.toBeNull();
  });

  it('leaves accounts that belong to nobody here alone', async () => {
    const userId = await makeCustomer(nextTelegramId());
    const id = await makeService(userId, panelId, {
      publicId: 'sync-b',
      username: 'u_b',
      usedBytes: GIB,
    });
    // The panel holds a hundred accounts the bot never sold.
    const panel = fakePanel([
      { username: 'someone_else', used: 99 * GIB },
      { username: 'u_b', used: 2 * GIB },
    ]);

    const summary = await syncSubscriptions(db, panel.fetchImpl, NOW_MS);

    expect(summary.updated).toBe(1);
    expect((await readService(id))?.used_bytes).toBe(2 * GIB);
  });

  it('does not erase a link the panel stopped returning', async () => {
    const userId = await makeCustomer(nextTelegramId());
    const id = await makeService(userId, panelId, {
      publicId: 'sync-c',
      username: 'u_c',
      url: 'https://sync.test/sub/u_c',
    });
    const panel = fakePanel([{ username: 'u_c', used: GIB, url: null }]);

    await syncSubscriptions(db, panel.fetchImpl, NOW_MS);

    expect((await readService(id))?.subscription_url).toBe('https://sync.test/sub/u_c');
  });

  it('never touches a subscription that is not active', async () => {
    const userId = await makeCustomer(nextTelegramId());
    // One live row so the sweep has a reason to call this panel at all.
    await makeService(userId, panelId, { publicId: 'sync-live', username: 'u_live' });
    const dead = await makeService(userId, panelId, {
      publicId: 'sync-dead',
      username: 'u_dead',
      usedBytes: 5 * GIB,
      status: 'DISABLED',
    });
    const panel = fakePanel([
      { username: 'u_live', used: GIB },
      { username: 'u_dead', used: 40 * GIB },
    ]);

    await syncSubscriptions(db, panel.fetchImpl, NOW_MS);

    expect((await readService(dead))?.used_bytes).toBe(5 * GIB);
  });
});

describe('when the panel will not answer', () => {
  it('changes nothing and says which panel', async () => {
    const userId = await makeCustomer(nextTelegramId());
    const id = await makeService(userId, panelId, {
      publicId: 'sync-d',
      username: 'u_d',
      url: 'https://sync.test/sub/u_d',
      usedBytes: 7 * GIB,
    });

    const summary = await syncSubscriptions(db, deadPanel, NOW_MS);

    expect(summary).toMatchObject({ panels: 0, updated: 0, failed: 1 });
    const after = await readService(id);
    // Slightly old numbers, not missing ones.
    expect(after?.used_bytes).toBe(7 * GIB);
    expect(after?.subscription_url).toBe('https://sync.test/sub/u_d');
  });
});

describe('how often it runs', () => {
  it('does nothing while the figures are still fresh', async () => {
    const userId = await makeCustomer(nextTelegramId());
    await makeService(userId, panelId, {
      publicId: 'sync-e',
      username: 'u_e',
      syncedAtMs: NOW_MS - 60_000,
    });
    const panel = fakePanel([{ username: 'u_e', used: GIB }]);

    const summary = await syncSubscriptions(db, panel.fetchImpl, NOW_MS);

    expect(summary).toMatchObject({ panels: 0, updated: 0, failed: 0 });
    // The point of the interval: the panel was not called at all.
    expect(panel.calls).toHaveLength(0);
  });

  it('runs again once the interval has passed', async () => {
    const userId = await makeCustomer(nextTelegramId());
    await makeService(userId, panelId, {
      publicId: 'sync-f',
      username: 'u_f',
      syncedAtMs: NOW_MS - SYNC_INTERVAL_MS - 1,
    });
    const panel = fakePanel([{ username: 'u_f', used: GIB }]);

    const summary = await syncSubscriptions(db, panel.fetchImpl, NOW_MS);

    expect(summary.updated).toBe(1);
  });

  it('runs when nothing has ever been synced', async () => {
    const userId = await makeCustomer(nextTelegramId());
    await makeService(userId, panelId, { publicId: 'sync-g', username: 'u_g', syncedAtMs: null });
    const panel = fakePanel([{ username: 'u_g', used: GIB }]);

    expect((await syncSubscriptions(db, panel.fetchImpl, NOW_MS)).updated).toBe(1);
  });
});
