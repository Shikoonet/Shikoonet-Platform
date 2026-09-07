/**
 * «نمایندگان» — what the screen may say, and who may change it.
 *
 * Three things are worth asserting here and only one of them is a route test:
 *
 *   - The billable figure is a MAX over the ledger, never a SUM and never the
 *     newest row. A sweep that ran twice must not double an invoice, and a
 *     panel that reset its counter must not make a bill go down.
 *   - "Never read" must be `null`, not `0`. On an invoice those are the same
 *     glyph and opposite facts.
 *   - The writes decide whether somebody else's business keeps running, so
 *     they are ADMIN; the reads are shop operation and are not.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-reseller@example.com';
const REVIEWER = 'reviewer-reseller@example.com';
const GIB = 1024 ** 3;

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

async function seedOperators(): Promise<void> {
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
    [REVIEWER, 'READ_ONLY'],
  ] as const) {
    // `id` is not generated on this table — the same explicit shape
    // `access.test.ts` uses. Derived from the email so a re-run is idempotent.
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
    )
      .bind(`res-fixture-${role.toLowerCase()}`, email, role, Date.now())
      .run();
  }
}

let userId: number;
let providerId: number;

async function fixtures(): Promise<void> {
  const user = await baseEnv.DB.prepare(
    `INSERT INTO users (telegram_id, username, registered_at)
     VALUES (-880000001, 'reseller-fixture', now())
     ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username
     RETURNING id`,
  ).first<{ id: number }>();
  userId = user!.id;

  const provider = await baseEnv.DB.prepare(
    `INSERT INTO provisioning_providers (code, name, kind, base_url, status)
     VALUES ('res-route-panel', 'panel for resellers', 'pasarguard', 'https://x.invalid', 'ACTIVE')
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
  ).first<{ id: number }>();
  providerId = provider!.id;
}

/** Snapshots refuse DELETE, so the whole pair is truncated between tests. */
async function purge(): Promise<void> {
  await baseEnv.DB.prepare(
    `TRUNCATE reseller_usage_snapshots, reseller_accounts RESTART IDENTITY`,
  ).run();
}

async function makeReseller(name: string, over: Record<string, unknown> = {}): Promise<number> {
  const res = await app.request(
    '/api/v1/admin/resellers',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId,
        providerId,
        panelAdminUsername: name.replace(/\s+/g, '_'),
        name,
        dataLimitBytes: 100 * GIB,
        expiresAtMs: null,
        installationUrl: null,
        note: null,
        ...over,
      }),
    },
    envAs(ADMIN),
  );
  const body = (await res.json()) as { ok: boolean; id?: number };
  if (!body.ok) throw new Error(`fixture reseller failed: ${JSON.stringify(body)}`);
  return body.id!;
}

async function reading(id: number, used: number, lifetime: number, at: string): Promise<void> {
  await baseEnv.DB.prepare(
    `INSERT INTO reseller_usage_snapshots
       (reseller_id, used_bytes, lifetime_used_bytes, total_users, taken_at)
     VALUES (?1, ?2, ?3, 4, ?4::timestamptz)`,
  )
    .bind(id, used, lifetime, at)
    .run();
}

async function list(email = ADMIN) {
  const res = await app.request('/api/v1/admin/resellers', {}, envAs(email));
  return { status: res.status, body: (await res.json()) as { ok: boolean; items: never[] } };
}

beforeAll(async () => {
  await applySchema();
  await seedOperators();
  await fixtures();
});

beforeEach(purge);

describe('what the screen says', () => {
  it('says «not read yet» as null rather than as zero', async () => {
    // The distinction that matters on an invoice: a franchise nobody has
    // metered yet and one that used nothing are the same number and opposite
    // facts. Only `null` can say the first.
    await makeReseller('brand new');

    const { body } = await list();

    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      name: 'brand new',
      billableBytes: null,
      lastReadAt: null,
      readings: 0,
    });
  });

  it('bills the maximum of the ledger, not the sum of it', async () => {
    /**
     * The sweep is allowed to run twice — a restart, two processes, a retry —
     * and the ledger is append-only, so duplicate readings are expected. A SUM
     * here would invoice a franchise three times for one month's traffic.
     */
    const id = await makeReseller('read three times');
    await reading(id, GIB, 9 * GIB, '2026-09-01T00:00:00Z');
    await reading(id, GIB, 9 * GIB, '2026-09-01T01:00:00Z');
    await reading(id, GIB, 9 * GIB, '2026-09-01T02:00:00Z');

    const { body } = await list();

    expect(body.items[0]).toMatchObject({ billableBytes: 9 * GIB, readings: 3 });
  });

  it('does not let a panel that reset its counter shrink the bill', async () => {
    /**
     * `used_traffic` resets when the panel resets it;
     * `lifetime_used_traffic` does not. Reading the newest row would make an
     * invoice go DOWN the day somebody pressed reset on the panel — which is
     * exactly the button an operator presses at the start of a month.
     */
    const id = await makeReseller('counter reset');
    await reading(id, 40 * GIB, 40 * GIB, '2026-09-01T00:00:00Z');
    // The panel was reset: `used` back to nothing, lifetime carries on.
    await reading(id, 0, 41 * GIB, '2026-09-02T00:00:00Z');

    const { body } = await list();

    expect(body.items[0]).toMatchObject({
      billableBytes: 41 * GIB,
      // The newest reading is still shown beside it, because "this period" is
      // a real question — it is just not the bill.
      latestUsedBytes: 0,
    });
  });

  it('shows the newest reading, not an older one that sorts higher', async () => {
    const id = await makeReseller('ordering');
    await reading(id, 5 * GIB, 5 * GIB, '2026-09-01T00:00:00Z');
    await reading(id, 1 * GIB, 6 * GIB, '2026-09-05T00:00:00Z');

    const { body } = await list();

    expect(body.items[0]).toMatchObject({ latestUsedBytes: 1 * GIB });
  });

  it('lists the readings behind the number', async () => {
    // The whole reason the ledger is append-only: a reseller asking why the
    // bill is what it is gets a list with times on it.
    const id = await makeReseller('audited');
    await reading(id, GIB, 2 * GIB, '2026-09-01T00:00:00Z');
    await reading(id, 2 * GIB, 3 * GIB, '2026-09-02T00:00:00Z');

    const res = await app.request(`/api/v1/admin/resellers/${id}/readings`, {}, envAs(ADMIN));
    const body = (await res.json()) as { items: { lifetimeUsedBytes: number }[] };

    expect(body.items.map((r) => r.lifetimeUsedBytes)).toEqual([3 * GIB, 2 * GIB]);
  });

  it('names no customer of the reseller anywhere', async () => {
    /**
     * The boundary this whole feature rests on: their customers never reach
     * this database, so no field here can carry one. Asserted on the shape
     * rather than on a value, because the failure would be a new field that
     * looked harmless — `users`, `accounts`, `subscribers`.
     */
    const id = await makeReseller('boundary');
    await reading(id, GIB, GIB, '2026-09-01T00:00:00Z');

    const { body } = await list();

    expect(Object.keys(body.items[0]!).sort()).toEqual(
      [
        'billableBytes',
        'dataLimitBytes',
        'expiresAt',
        'id',
        'installationUrl',
        'lastReadAt',
        'latestPanelIsLimited',
        'latestPanelStatus',
        'latestTotalUsers',
        'latestUsedBytes',
        'name',
        'note',
        'panelAdminUsername',
        'providerId',
        'providerName',
        'readings',
        'status',
        'telegramId',
        'username',
      ].sort(),
    );
  });
});

describe('who may change it', () => {
  it('lets a reader see the screen', async () => {
    // Shop operation, the same line «تنظیمات» sits on. No customer of a
    // reseller's is on it, which is what makes that line drawable at all.
    await makeReseller('visible');

    const { status, body } = await list(REVIEWER);

    expect(status).toBe(200);
    expect(body.items).toHaveLength(1);
  });

  it('refuses a reader who tries to create one', async () => {
    const res = await app.request(
      '/api/v1/admin/resellers',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId,
          providerId,
          panelAdminUsername: 'sneaky',
          name: 'sneaky',
          dataLimitBytes: null,
          expiresAtMs: null,
          installationUrl: null,
          note: null,
        }),
      },
      envAs(REVIEWER),
    );

    expect(res.status).toBe(403);
  });

  it('refuses a reader who tries to suspend one', async () => {
    const id = await makeReseller('protected');

    const res = await app.request(
      `/api/v1/admin/resellers/${id}/status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'SUSPENDED' }),
      },
      envAs(REVIEWER),
    );

    expect(res.status).toBe(403);
  });

  it('refuses a second franchise on one panel admin, whatever the case', async () => {
    // Two rows on one panel admin is two meters reading one number, and both
    // would bill it. The unique index enforces it; this answers with a
    // sentence instead of a constraint violation.
    await makeReseller('first', { panelAdminUsername: 'AgentOne' });

    const res = await app.request(
      '/api/v1/admin/resellers',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId,
          providerId,
          panelAdminUsername: 'agentone',
          name: 'second',
          dataLimitBytes: null,
          expiresAtMs: null,
          installationUrl: null,
          note: null,
        }),
      },
      envAs(ADMIN),
    );

    expect(res.status).toBe(409);
  });

  it('suspends and reactivates without touching the ledger', async () => {
    // Suspension is a row here and no call to the panel — see the route's own
    // comment. The readings must survive it: a franchise that comes back owes
    // what it owed.
    const id = await makeReseller('paused');
    await reading(id, GIB, 7 * GIB, '2026-09-01T00:00:00Z');

    for (const status of ['SUSPENDED', 'ACTIVE'] as const) {
      const res = await app.request(
        `/api/v1/admin/resellers/${id}/status`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status }),
        },
        envAs(ADMIN),
      );
      expect(res.status).toBe(200);
    }

    const { body } = await list();
    expect(body.items[0]).toMatchObject({ status: 'ACTIVE', billableBytes: 7 * GIB });
  });

  it('refuses a body carrying a field nobody declared', async () => {
    // `.strict()`, and the reason it is not decoration: `panelAdminUsername`
    // is deliberately absent from the edit schema, so a client that sent one
    // would silently point the meter at a different counter.
    const id = await makeReseller('strict');

    const res = await app.request(
      `/api/v1/admin/resellers/${id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'strict',
          dataLimitBytes: null,
          expiresAtMs: null,
          installationUrl: null,
          note: null,
          panelAdminUsername: 'somebody_elses_meter',
        }),
      },
      envAs(ADMIN),
    );

    expect(res.status).toBe(400);
  });
});
