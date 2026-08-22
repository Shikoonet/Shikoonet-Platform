/**
 * `GET /api/v1/admin/events` — the filters, and who is allowed to ask.
 *
 * Every assertion here is against rows this file put in `app_events` and
 * counted itself, not against what the route says it returned. That distinction
 * is the reason the file exists: a filter is a claim about which rows are left
 * out, and only the ones left out can prove it.
 *
 * Needs DATABASE_URL and the migrations applied (`pnpm sim:up`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv, pool } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin@example.com';
const REVIEWER = 'reviewer-events@example.com';
const READER = 'reader-events@example.com';
const SVC = 'unit-events';

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

interface Page {
  ok: boolean;
  total: number;
  errors: number;
  warns: number;
  items: Array<{
    evt: string;
    level: string;
    svc: string;
    trace: string | null;
    ref: string | null;
  }>;
}

async function get(path: string, email = ADMIN): Promise<Response> {
  return app.request(path, {}, envAs(email));
}

beforeAll(applySchema);

beforeEach(async () => {
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
    [REVIEWER, 'REVIEWER'],
    [READER, 'READ_ONLY'],
  ] as const) {
    await baseEnv.DB.prepare(
      `INSERT INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)
       ON CONFLICT (email) DO UPDATE SET role = excluded.role, active = 1`,
    )
      .bind(crypto.randomUUID(), email, role, Date.now())
      .run();
  }

  await baseEnv.DB.prepare(`DELETE FROM app_events WHERE svc LIKE ?1`).bind(`${SVC}%`).run();
  await baseEnv.DB.prepare(
    `INSERT INTO app_events (at, level, svc, evt, trace, ref, fields, err) VALUES
       (now(),                       'error', ?1, 'provision.failed',    'u10', 'ORD-1', '{"kind":"pasarguard"}'::jsonb, '{"message":"panel refused: 502"}'),
       (now(),                       'warn',  ?1, 'provision.will_retry','u10', 'ORD-1', '{}'::jsonb, NULL),
       (now(),                       'warn',  ?2, 'sync.panel_skipped',  NULL,  NULL,    '{}'::jsonb, NULL),
       (now() - interval '40 days',  'error', ?1, 'settle.failed',       NULL,  'PAY-9', '{}'::jsonb, NULL)`,
  )
    .bind(SVC, `${SVC}-other`)
    .run();
});

afterAll(async () => {
  await baseEnv.DB.prepare(`DELETE FROM app_events WHERE svc LIKE ?1`).bind(`${SVC}%`).run();
  await baseEnv.DB.prepare(`DELETE FROM access_users WHERE email IN (?1, ?2)`)
    .bind(REVIEWER, READER)
    .run();
  await pool.end();
});

/** Only the rows this file created, whatever else the shared database holds. */
function mine(body: Page) {
  return body.items.filter((i) => i.svc.startsWith(SVC));
}

describe('who may read the shop’s own failures', () => {
  it('answers an ADMIN', async () => {
    expect((await get('/api/v1/admin/events?window=7d')).status).toBe(200);
  });

  it('refuses a REVIEWER, who reviews payments and not stack traces', async () => {
    // The middleware's prefix list stops READ_ONLY; this is the second check,
    // and it is the only thing standing in a REVIEWER's way.
    expect((await get('/api/v1/admin/events?window=7d', REVIEWER)).status).toBe(403);
  });

  it('refuses a READ_ONLY operator before the route is even reached', async () => {
    const res = await get('/api/v1/admin/events?window=7d', READER);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { detail: string }).detail).toContain('نقش شما');
  });
});

describe('the filters', () => {
  it('defaults to the last seven days, so a forty-day-old row is not in it', async () => {
    const body = (await (await get('/api/v1/admin/events')).json()) as Page;
    const evts = mine(body).map((i) => i.evt);
    expect(evts).toContain('provision.failed');
    expect(evts).not.toContain('settle.failed');
  });

  it('reaches the old row when asked for everything', async () => {
    const body = (await (await get('/api/v1/admin/events?window=all')).json()) as Page;
    expect(mine(body).map((i) => i.evt)).toContain('settle.failed');
  });

  it('treats an unknown window as the default rather than as «همه»', async () => {
    // A typo in a query string must not quietly widen what is read.
    const body = (await (await get('/api/v1/admin/events?window=24hours')).json()) as Page;
    expect(mine(body).map((i) => i.evt)).not.toContain('settle.failed');
  });

  it('filters by level, and the counts follow the same query', async () => {
    const body = (await (
      await get(`/api/v1/admin/events?window=7d&level=error&svc=${SVC}`)
    ).json()) as Page;
    expect(mine(body).map((i) => i.evt)).toEqual(['provision.failed']);
    expect(body.total).toBe(1);
    expect(body.errors).toBe(1);
    expect(body.warns).toBe(0);
  });

  it('filters by service', async () => {
    const body = (await (
      await get(`/api/v1/admin/events?window=7d&svc=${SVC}-other`)
    ).json()) as Page;
    expect(mine(body).map((i) => i.evt)).toEqual(['sync.panel_skipped']);
  });

  it('matches a trace exactly, not as a prefix', async () => {
    const both = (await (await get('/api/v1/admin/events?window=7d&trace=u10')).json()) as Page;
    expect(mine(both)).toHaveLength(2);

    // `u1` is a prefix of `u10`. A LIKE here would fold one update into
    // another, which is the opposite of what a correlation id is for.
    const none = (await (await get('/api/v1/admin/events?window=7d&trace=u1')).json()) as Page;
    expect(mine(none)).toHaveLength(0);
  });

  it('searches the order id, the event name and the text of the error', async () => {
    for (const [q, expected] of [
      ['ORD-1', 2],
      ['provision.failed', 1],
      // The sentence an admin actually has in front of them, out of the stack.
      ['panel refused', 1],
      // And inside the jsonb, which is where the panel kind lives.
      ['pasarguard', 1],
    ] as const) {
      const body = (await (
        await get(`/api/v1/admin/events?window=7d&svc=${SVC}&q=${encodeURIComponent(q)}`)
      ).json()) as Page;
      expect(mine(body).length, q).toBe(expected);
    }
  });

  it('puts the newest first, by the clock rather than by insertion order', async () => {
    // The two agree while every row comes from a live process and come apart
    // the moment one is backfilled — which is when somebody is reading this
    // screen. Written here as an explicit out-of-order insert, because a
    // fixture inserted in order cannot tell `ORDER BY id` from `ORDER BY at`.
    await baseEnv.DB.prepare(
      `INSERT INTO app_events (at, level, svc, evt) VALUES
         (now() - interval '2 hours', 'warn', ?1, 'older.but.inserted.last')`,
    )
      .bind(SVC)
      .run();

    const body = (await (await get(`/api/v1/admin/events?window=7d&svc=${SVC}`)).json()) as Page;
    const stamps = mine(body).map((i) => (i as unknown as { at: string }).at);
    expect([...stamps].sort().reverse()).toEqual(stamps);
    expect(mine(body).at(-1)?.evt).toBe('older.but.inserted.last');
  });

  it('lists the services present, for the dropdown', async () => {
    const body = (await (await get('/api/v1/admin/events/facets?window=7d')).json()) as {
      services: string[];
    };
    expect(body.services).toContain(SVC);
    expect(body.services).toContain(`${SVC}-other`);
  });
});
