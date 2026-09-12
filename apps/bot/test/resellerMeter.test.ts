/**
 * The sweep that bills a franchise.
 *
 * Four properties matter more than the happy path, and each one is a way the
 * meter could be quietly wrong about money:
 *
 *   - A panel that will not answer must write NOTHING. A reading of zero is an
 *     invoice for nothing, and it looks identical to a franchise that stopped
 *     selling.
 *   - Reading twice must not change what is owed. The ledger is append-only
 *     and the bill is `max(lifetime)`, so a second pass adds a row and moves
 *     no total — which is the only reason this sweep is safe to re-run.
 *   - A term that has run out must SUSPEND, because the panel will not. There
 *     is no expiry field on a panel admin at all — checked against the live
 *     panel, see `resellerMeter.ts`.
 *   - It must ask each panel once, not once per reseller.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { METER_INTERVAL_MS, meterResellers } from '../src/resellerMeter.js';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer } from './helpers/shop.js';

const NOW_MS = Date.UTC(2026, 8, 7, 12, 0, 0);
const GIB = 1024 ** 3;
const SECRET_REF = 'sim-meter-panel';

let seq = 0;
function nextTelegramId(): number {
  seq += 1;
  return 780_000 + seq * 17;
}

/** A panel that reports whatever admins it was given, in the real envelope. */
function fakePanel(
  admins: {
    username: string;
    used?: number | string | null;
    lifetime?: number | string | null;
    dataLimit?: number | null;
    totalUsers?: number;
    status?: string;
    limited?: boolean;
  }[],
) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/api/admin/token')) {
      return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
    }
    if (url.includes('/api/admins')) {
      return new Response(
        JSON.stringify({
          total: admins.length,
          admins: admins.map((a) => ({
            username: a.username,
            used_traffic: a.used ?? 0,
            lifetime_used_traffic: a.lifetime ?? 0,
            data_limit: a.dataLimit ?? null,
            total_users: a.totalUsers ?? 0,
            status: a.status ?? 'active',
            is_disabled: false,
            is_limited: a.limited ?? false,
          })),
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

async function makeReseller(fields: {
  name: string;
  adminUsername: string;
  expiresAtMs?: number | null;
  status?: string;
}): Promise<number> {
  const userId = await makeCustomer(nextTelegramId());
  const provider = panelId;
  const row = await db
    .prepare(
      `INSERT INTO reseller_accounts
         (user_id, provider_id, panel_admin_username, name, status, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5,
               CASE WHEN ?6::bigint IS NULL THEN NULL ELSE to_timestamp(?6 / 1000.0) END)
       RETURNING id`,
    )
    .bind(
      userId,
      provider,
      fields.adminUsername,
      fields.name,
      fields.status ?? 'ACTIVE',
      fields.expiresAtMs ?? null,
    )
    .first<{ id: number }>();
  if (!row) throw new Error('reseller fixture failed');
  return row.id;
}

async function readings(resellerId: number) {
  const { results } = await db
    .prepare(
      `SELECT used_bytes, lifetime_used_bytes, data_limit_bytes, total_users,
              panel_status, panel_is_limited
         FROM reseller_usage_snapshots WHERE reseller_id = ?1 ORDER BY id`,
    )
    .bind(resellerId)
    .all<Record<string, unknown>>();
  return results ?? [];
}

async function statusOf(resellerId: number): Promise<string> {
  const row = await db
    .prepare(`SELECT status FROM reseller_accounts WHERE id = ?1`)
    .bind(resellerId)
    .first<{ status: string }>();
  return row!.status;
}

/**
 * Snapshots are append-only, so a test cannot delete its own rows. It removes
 * the reseller instead — which the FK refuses while readings exist, so the
 * readings go first through the one door the trigger leaves open: none.
 *
 * TRUNCATE, then: row triggers do not fire on it, which is exactly the hazard
 * `reset.ts` documents. Safe here because both tables are ours alone and this
 * file is the only thing that writes them.
 */
async function purge(): Promise<void> {
  await db.prepare(`TRUNCATE reseller_usage_snapshots, reseller_accounts RESTART IDENTITY`).run();
}

let panelId: number;

/**
 * A panel OF THIS FILE'S OWN, rather than a borrowed seeded one.
 *
 * `sync.test.ts` repoints `sim-vip` at a fake host, and this file used to do
 * the same. That leaves `sim-vip` carrying `base_url = 'https://meter.test'`
 * and a secret ref only this process holds — the bot suites share one database
 * and run in one worker, so the next file to reach for that panel inherits it
 * until the next `ensureCatalog()` puts the fixture's own address and ref back
 * (it converges all three since #182; it used to put back `kind` alone).
 *
 * So this suite creates its own provider and leaves every seeded row alone.
 * Cheaper than an `afterAll` that restores fields, and it cannot forget.
 */
beforeAll(async () => {
  await ensureCatalog();
  process.env[`PANEL_${SECRET_REF.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = 'admin:secret';
  const row = await db
    .prepare(
      `INSERT INTO provisioning_providers (code, name, kind, base_url, secret_ref, status)
       VALUES ('sim-meter-panel', 'panel for the meter suite', 'pasarguard',
               'https://meter.test', ?1, 'ACTIVE')
       ON CONFLICT (code) DO UPDATE
         SET base_url = EXCLUDED.base_url, secret_ref = EXCLUDED.secret_ref,
             kind = EXCLUDED.kind
       RETURNING id`,
    )
    .bind(SECRET_REF)
    .first<{ id: number }>();
  panelId = row!.id;
});

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  await purge();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reading the meter', () => {
  it('records what the panel says, once per reseller', async () => {
    const id = await makeReseller({ name: 'agent one', adminUsername: 'agent_one' });
    const panel = fakePanel([
      {
        username: 'agent_one',
        used: 3 * GIB,
        lifetime: 40 * GIB,
        dataLimit: 100 * GIB,
        totalUsers: 12,
        limited: false,
      },
    ]);

    const summary = await meterResellers(db, panel.fetchImpl, NOW_MS);

    expect(summary).toMatchObject({ panels: 1, readings: 1, failed: 0, missing: 0 });
    expect(await readings(id)).toEqual([
      {
        used_bytes: 3 * GIB,
        lifetime_used_bytes: 40 * GIB,
        data_limit_bytes: 100 * GIB,
        total_users: 12,
        panel_status: 'active',
        panel_is_limited: false,
      },
    ]);
  });

  it('matches the panel admin whatever case it was typed in', async () => {
    // The unique index is on `lower(panel_admin_username)`, so an operator who
    // typed a capital must still be metered. Matching case-sensitively here
    // would bill nobody, silently, and look exactly like a missing admin.
    const id = await makeReseller({ name: 'agent two', adminUsername: 'Agent_Two' });
    const panel = fakePanel([{ username: 'agent_two', lifetime: 5 * GIB }]);

    await meterResellers(db, panel.fetchImpl, NOW_MS);

    expect(await readings(id)).toHaveLength(1);
  });

  it('writes nothing at all when the panel will not answer', async () => {
    // The property that matters most: an unreachable panel must leave a GAP.
    // A zero here is an invoice saying they owe nothing.
    const id = await makeReseller({ name: 'agent three', adminUsername: 'agent_three' });

    const summary = await meterResellers(db, deadPanel, NOW_MS);

    expect(summary.failed).toBe(1);
    expect(summary.readings).toBe(0);
    expect(await readings(id)).toEqual([]);
  });

  it('leaves a gap rather than a zero when the counter is unreadable', async () => {
    // A panel mid-restart reporting a negative counter. Same rule as above, one
    // reseller at a time rather than a whole panel.
    const id = await makeReseller({ name: 'agent four', adminUsername: 'agent_four' });
    const panel = fakePanel([{ username: 'agent_four', used: -1, lifetime: 'nonsense' }]);

    const summary = await meterResellers(db, panel.fetchImpl, NOW_MS);

    expect(summary.panels).toBe(1);
    expect(summary.readings).toBe(0);
    expect(await readings(id)).toEqual([]);
  });

  it('counts a reseller whose panel admin has gone, rather than passing over it', async () => {
    // An admin renamed or deleted on the panel leaves a franchise that looks
    // healthy on our screen and is billed from a stale reading. Counted so the
    // sweep's own summary says it happened.
    const id = await makeReseller({ name: 'agent five', adminUsername: 'not_on_panel' });
    const panel = fakePanel([{ username: 'somebody_else', lifetime: GIB }]);

    const summary = await meterResellers(db, panel.fetchImpl, NOW_MS);

    expect(summary.missing).toBe(1);
    expect(await readings(id)).toEqual([]);
  });

  it('asks the panel once however many franchises sit on it', async () => {
    await makeReseller({ name: 'a', adminUsername: 'a' });
    await makeReseller({ name: 'b', adminUsername: 'b' });
    await makeReseller({ name: 'c', adminUsername: 'c' });
    const panel = fakePanel([
      { username: 'a', lifetime: GIB },
      { username: 'b', lifetime: 2 * GIB },
      { username: 'c', lifetime: 3 * GIB },
    ]);

    const summary = await meterResellers(db, panel.fetchImpl, NOW_MS);

    expect(summary.readings).toBe(3);
    expect(panel.calls.filter((u) => u.includes('/api/admins'))).toHaveLength(1);
  });

  it('reading twice adds a row and changes nothing that is owed', async () => {
    /**
     * The whole reason the ledger is append-only and the bill is a MAX.
     *
     * A sweep that ran twice — a restart, two processes, a retry — must not
     * double anybody's invoice. Asserted on the derived total rather than on
     * the row count, because the row count going up is expected and harmless.
     */
    const id = await makeReseller({ name: 'agent six', adminUsername: 'agent_six' });
    const panel = fakePanel([{ username: 'agent_six', used: GIB, lifetime: 9 * GIB }]);

    await meterResellers(db, panel.fetchImpl, NOW_MS);
    // Past the interval gate, so the second pass really runs.
    await meterResellers(db, panel.fetchImpl, NOW_MS + METER_INTERVAL_MS + 1);

    const billed = await db
      .prepare(
        `SELECT max(lifetime_used_bytes)::bigint AS owed, count(*)::int AS rows
           FROM reseller_usage_snapshots WHERE reseller_id = ?1`,
      )
      .bind(id)
      .first<{ owed: number; rows: number }>();
    expect(billed).toEqual({ owed: 9 * GIB, rows: 2 });
  });

  it('does not run again before the interval is up', async () => {
    // Hourly, not per cycle. At 25 seconds a cycle this would otherwise be
    // 144 panel listings an hour for a number an invoice reads once a month.
    const id = await makeReseller({ name: 'agent seven', adminUsername: 'agent_seven' });
    const panel = fakePanel([{ username: 'agent_seven', lifetime: GIB }]);

    await meterResellers(db, panel.fetchImpl, NOW_MS);
    await meterResellers(db, panel.fetchImpl, NOW_MS + 60_000);

    expect(await readings(id)).toHaveLength(1);
  });
});

describe('the term, which the panel does not enforce', () => {
  it('suspends a reseller whose term has run out', async () => {
    const id = await makeReseller({
      name: 'expired',
      adminUsername: 'expired',
      expiresAtMs: NOW_MS - 1000,
    });
    const panel = fakePanel([{ username: 'expired', lifetime: GIB }]);

    const summary = await meterResellers(db, panel.fetchImpl, NOW_MS);

    expect(summary.suspended).toBe(1);
    expect(await statusOf(id)).toBe('SUSPENDED');
  });

  it('does not meter the period a suspended reseller has already left', async () => {
    // Suspension happens BEFORE the reading, so the last act of a franchise's
    // life is not one more reading attributed to a term that had ended.
    const id = await makeReseller({
      name: 'expired too',
      adminUsername: 'expired_too',
      expiresAtMs: NOW_MS - 1000,
    });
    const panel = fakePanel([{ username: 'expired_too', lifetime: 50 * GIB }]);

    await meterResellers(db, panel.fetchImpl, NOW_MS);

    expect(await readings(id)).toEqual([]);
  });

  it('leaves a term that has not ended alone', async () => {
    const id = await makeReseller({
      name: 'still running',
      adminUsername: 'still_running',
      expiresAtMs: NOW_MS + 86_400_000,
    });
    const panel = fakePanel([{ username: 'still_running', lifetime: GIB }]);

    const summary = await meterResellers(db, panel.fetchImpl, NOW_MS);

    expect(summary.suspended).toBe(0);
    expect(await statusOf(id)).toBe('ACTIVE');
    expect(await readings(id)).toHaveLength(1);
  });

  it('leaves an open-ended reseller alone for ever', async () => {
    // NULL is "no term", not "a term of zero" — the same distinction the cap
    // makes, and getting it backwards would suspend every franchise at once.
    const id = await makeReseller({
      name: 'open ended',
      adminUsername: 'open_ended',
      expiresAtMs: null,
    });
    const panel = fakePanel([{ username: 'open_ended', lifetime: GIB }]);

    const summary = await meterResellers(db, panel.fetchImpl, NOW_MS);

    expect(summary.suspended).toBe(0);
    expect(await statusOf(id)).toBe('ACTIVE');
  });

  it('does not meter a reseller who was already suspended', async () => {
    const id = await makeReseller({
      name: 'already off',
      adminUsername: 'already_off',
      status: 'SUSPENDED',
    });
    const panel = fakePanel([{ username: 'already_off', lifetime: GIB }]);

    await meterResellers(db, panel.fetchImpl, NOW_MS);

    expect(await readings(id)).toEqual([]);
  });
});
