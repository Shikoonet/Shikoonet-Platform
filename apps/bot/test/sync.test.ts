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
 *   - It may FILL an expiry and never overwrite one. Issue #92: every service
 *     imported from the PHP bot arrived with `expires_at` NULL, so the panel is
 *     the only place the date exists — but for a service this bot sold, our
 *     date is the one the customer paid for and a panel must not shorten it.
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
function fakePanel(
  accounts: {
    username: string;
    used: number;
    url?: string | null;
    /** What the panel says about expiry. Left out entirely when undefined,
     *  which is the «this panel does not report one» case. */
    expire?: number | string | null;
  }[],
) {
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
            expire: a.expire,
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
    expiresAtMs?: number | null;
  },
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO subscriptions
         (public_id, user_id, provider_id, plan_name_at_sale, price_irr,
          remote_username, subscription_url, used_bytes, volume_gb,
          status, purchased_at, last_synced_at, expires_at)
       VALUES (?1, ?2, ?3, 'sync fixture', 1950000, ?4, ?5, ?6, 50, ?7, now(),
               CASE WHEN ?8::bigint IS NULL THEN NULL ELSE to_timestamp(?8 / 1000.0) END,
               CASE WHEN ?9::bigint IS NULL THEN NULL ELSE to_timestamp(?9 / 1000.0) END)
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
      fields.expiresAtMs ?? null,
    )
    .first<{ id: number }>();
  if (!row) throw new Error('sync fixture failed');
  return row.id;
}

async function readService(id: number) {
  return db
    .prepare(
      `SELECT used_bytes, subscription_url, last_synced_at, expires_at
         FROM subscriptions WHERE id = ?1`,
    )
    .bind(id)
    .first<{
      used_bytes: number | null;
      subscription_url: string | null;
      last_synced_at: string | null;
      expires_at: string | null;
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

/**
 * The half of issue #92 that lives here.
 *
 * The importer has no expiry to read: the legacy `invoice` table never stored
 * one, and `legacy_attrs` carries an `expire` key on zero rows of 8,428. So the
 * 5,352 services this shop inherited reached Postgres with `expires_at` NULL,
 * and every screen and sweep that reads a date -- the ⌛ on «سرویس های
 * من», the two-day warning in `warn.ts` -- has been silent for all of them.
 *
 * The panel holds the date. These four tests are the whole contract: fill a
 * gap, never overwrite, and treat «the panel named no date» as the third
 * answer it actually is rather than as zero.
 */
describe('the expiry an imported service never had', () => {
  const PANEL_EXPIRY_S = Math.floor(Date.UTC(2026, 8, 1, 6, 0, 0) / 1000);

  it('fills a date the importer could not supply', async () => {
    const userId = await makeCustomer(nextTelegramId());
    const id = await makeService(userId, panelId, {
      publicId: 'sync-exp-a',
      username: 'u_exp_a',
      expiresAtMs: null,
    });
    const panel = fakePanel([{ username: 'u_exp_a', used: GIB, expire: PANEL_EXPIRY_S }]);

    await syncSubscriptions(db, panel.fetchImpl, NOW_MS);

    const after = await readService(id);
    expect(Date.parse(after!.expires_at!)).toBe(PANEL_EXPIRY_S * 1000);
  });

  /**
   * The guard, and the reason the statement says COALESCE rather than plain
   * assignment.
   *
   * We sold this one, so the date is what the customer paid for. A panel with a
   * wrong clock -- or an account somebody shortened there by hand -- must not be
   * able to take days off it, least of all silently. Remove the COALESCE and
   * this is the test that goes red.
   */
  it('never overwrites a date we already hold', async () => {
    const ours = Date.UTC(2026, 9, 20, 0, 0, 0);
    const userId = await makeCustomer(nextTelegramId());
    const id = await makeService(userId, panelId, {
      publicId: 'sync-exp-b',
      username: 'u_exp_b',
      expiresAtMs: ours,
    });
    // The panel says the account runs out seven weeks earlier than we sold.
    const panel = fakePanel([{ username: 'u_exp_b', used: GIB, expire: PANEL_EXPIRY_S }]);

    await syncSubscriptions(db, panel.fetchImpl, NOW_MS);

    const after = await readService(id);
    expect(Date.parse(after!.expires_at!)).toBe(ours);
  });

  /**
   * «No expiry» is not «expires at the epoch».
   *
   * An unmetered account, and one the panel is holding until its first
   * connection, both come back with `expire` absent or zero. Reading either as
   * a timestamp would date every one of them 1970 -- and `menu.serviceState`
   * would then show a service the customer is using as ⌛ expired.
   */
  it('leaves the column alone when the panel names no date', async () => {
    const userId = await makeCustomer(nextTelegramId());
    const zero = await makeService(userId, panelId, {
      publicId: 'sync-exp-c',
      username: 'u_exp_c',
      expiresAtMs: null,
    });
    const absent = await makeService(userId, panelId, {
      publicId: 'sync-exp-d',
      username: 'u_exp_d',
      expiresAtMs: null,
    });
    const panel = fakePanel([
      { username: 'u_exp_c', used: GIB, expire: 0 },
      // `expire` left out entirely: the key never reaches the JSON.
      { username: 'u_exp_d', used: GIB },
    ]);

    await syncSubscriptions(db, panel.fetchImpl, NOW_MS);

    expect((await readService(zero))?.expires_at).toBeNull();
    expect((await readService(absent))?.expires_at).toBeNull();
    // And the sweep still did its ordinary work on both rows, so this is a
    // column left alone rather than an update that never happened.
    expect((await readService(zero))?.used_bytes).toBe(GIB);
    expect((await readService(absent))?.used_bytes).toBe(GIB);
  });

  /**
   * The same field, the other shape.
   *
   * This panel reports `expire` as a unix number on one version and an ISO
   * string on another -- which is why `expiryMs` exists in the adapter and why
   * `listAccounts` calls it instead of reading the field itself. Asserted here
   * because it is the shape that would fail silently: an unparsed string reads
   * as «no expiry», which looks exactly like a correct no-op.
   */
  it('reads the date whichever way the panel spells it', async () => {
    const userId = await makeCustomer(nextTelegramId());
    const id = await makeService(userId, panelId, {
      publicId: 'sync-exp-e',
      username: 'u_exp_e',
      expiresAtMs: null,
    });
    const panel = fakePanel([
      { username: 'u_exp_e', used: GIB, expire: new Date(PANEL_EXPIRY_S * 1000).toISOString() },
    ]);

    await syncSubscriptions(db, panel.fetchImpl, NOW_MS);

    expect(Date.parse((await readService(id))!.expires_at!)).toBe(PANEL_EXPIRY_S * 1000);
  });
});
