/**
 * «کمپین‌ها» (#471), from the panel.
 *
 * The tool this replaces showed two different totals for one campaign — the
 * list all-time, the panel the last 24 hours — and never knew who bought. So
 * the assertions that matter are about agreement and about money:
 *
 * - revenue is checked against a fixture table where every order says by hand
 *   whether it counts, and the expected figures are summed from THAT, not from
 *   the function under test (CLAUDE.md rule 6);
 * - a top-up, a free order, an order before the start and one after 30 days
 *   are each a separate way to count money twice or count money that is not
 *   the campaign's;
 * - the list, the detail and the daily chart add up to the same numbers.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index.js';

/**
 * An audit table that refuses, on demand. The two writes put their audit row
 * in the same transaction as the change (CodeRabbit on #475): a campaign must
 * never exist, or change, without the record of who did it.
 */
const auditDown = vi.hoisted(() => ({ on: false }));
vi.mock('../src/adminAudit.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/adminAudit.js')>();
  return {
    ...real,
    audit: async (...args: Parameters<typeof real.audit>) => {
      if (auditDown.on) throw new Error('audit_logs refused the row');
      return real.audit(...args);
    },
  };
});
import { applySchema, deleteFixtureUsers, env as baseEnv, FIXTURE_TG_BASE } from './helpers/env.js';

const ADMIN = 'admin-campaigns@example.com';
const REVIEWER = 'reviewer-campaigns@example.com';
const TG = FIXTURE_TG_BASE + 955_000_000;
/**
 * The clock every «کل» window ends at (CLAUDE.md rule 5). Unpinned, the end of
 * the window is the machine's today, and on a clock before the fixtures below
 * every expectation would be about orders the window no longer holds.
 */
const NOW_MS = Date.UTC(2026, 8, 26, 9, 0, 0);

const envAs = (email: string) => ({ ...baseEnv, TEST_ACCESS_USER: email });
const send = (method: string, path: string, body: unknown, email = ADMIN) =>
  app.request(
    path,
    { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    envAs(email),
  );
const get = (path: string, email = ADMIN) => app.request(path, {}, envAs(email));

interface Funnel {
  id: number;
  slug: string;
  status: string;
  starts: number;
  newUsers: number;
  buyers: number;
  newBuyers: number;
  revenueIrr: number;
  newRevenueIrr: number;
}

async function purge(): Promise<void> {
  // Customers (and their orders) first; their starts go with them, and then
  // nothing holds the campaigns back.
  await deleteFixtureUsers(TG);
  await baseEnv.DB.prepare(`DELETE FROM campaigns WHERE slug LIKE 'zz-cmp-%'`).run();
}

async function campaign(slug: string): Promise<number> {
  const res = await send('POST', '/api/v1/admin/campaigns', { slug, name: slug });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: number }).id;
}

async function customer(n: number): Promise<number> {
  const row = await baseEnv.DB.prepare(
    `INSERT INTO users (telegram_id, username, registered_at) VALUES (?1, ?2, now()) RETURNING id`,
  )
    .bind(TG + n, `zzcmp${n}`)
    .first<{ id: number }>();
  return Number(row!.id);
}

async function started(campaignId: number, userId: number, isNew: boolean, at: string) {
  await baseEnv.DB.prepare(
    `INSERT INTO campaign_starts (campaign_id, user_id, is_new_user, first_at)
     VALUES (?1, ?2, ?3, ?4::timestamptz)`,
  )
    .bind(campaignId, userId, isNew, at)
    .run();
}

let orderSeq = 0;
interface Order {
  user: 'u1' | 'u2' | 'u3';
  kind: string;
  unit: number;
  discount?: number;
  status: string;
  completedAt: string | null;
  /** Whether campaign A's revenue includes it — decided here, by hand. */
  counts: boolean;
  why: string;
}

/**
 * Campaign A's customers and everything they ordered. Times are Tehran's.
 * u1 arrived new on 2026-08-01 at 10:00; u2 was already a customer and arrived
 * at 11:00; u3 arrived new on 08-04, and their only order was free — so they
 * are no buyer, however the free order is counted.
 */
const ORDERS: Order[] = [
  {
    user: 'u1',
    kind: 'NEW_PURCHASE',
    unit: 2_000_000,
    status: 'COMPLETED',
    completedAt: '2026-08-02T12:00:00+03:30',
    counts: true,
    why: 'a sale, a day after the start',
  },
  {
    user: 'u1',
    kind: 'WALLET_TOPUP',
    unit: 5_000_000,
    status: 'COMPLETED',
    completedAt: '2026-08-02T13:00:00+03:30',
    counts: false,
    why: 'money into their own wallet',
  },
  {
    user: 'u3',
    kind: 'NEW_PURCHASE',
    unit: 1_000_000,
    discount: 1_000_000,
    status: 'COMPLETED',
    completedAt: '2026-08-04T14:00:00+03:30',
    counts: false,
    why: 'free — nobody paid',
  },
  {
    user: 'u1',
    kind: 'RENEWAL',
    unit: 1_000_000,
    status: 'COMPLETED',
    completedAt: '2026-09-05T12:00:00+03:30',
    counts: false,
    why: 'past the 30 days',
  },
  {
    user: 'u1',
    kind: 'NEW_PURCHASE',
    unit: 700_000,
    status: 'PAID',
    completedAt: null,
    counts: false,
    why: 'not completed',
  },
  {
    user: 'u2',
    kind: 'RENEWAL',
    unit: 900_000,
    status: 'COMPLETED',
    completedAt: '2026-07-30T12:00:00+03:30',
    counts: false,
    why: 'before they arrived',
  },
  {
    user: 'u2',
    kind: 'RENEWAL',
    unit: 3_000_000,
    status: 'COMPLETED',
    completedAt: '2026-08-03T09:00:00+03:30',
    counts: true,
    why: 'an existing customer, renewing',
  },
];

let A = 0;
let B = 0;
const users: Record<string, number> = {};

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
  await purge();

  A = await campaign('zz-cmp-a');
  B = await campaign('zz-cmp-b');
  users.u1 = await customer(1);
  users.u2 = await customer(2);
  users.u3 = await customer(3);
  await started(A, users.u1, true, '2026-08-01T10:00:00+03:30');
  await started(A, users.u2, false, '2026-08-01T11:00:00+03:30');
  await started(A, users.u3, true, '2026-08-04T09:00:00+03:30');
  // u2 also came through B, a day later: the same renewal counts for both.
  await started(B, users.u2, false, '2026-08-02T08:00:00+03:30');

  for (const o of ORDERS) {
    orderSeq += 1;
    const discount = o.discount ?? 0;
    await baseEnv.DB.prepare(
      `INSERT INTO orders (public_id, user_id, kind, unit_price_irr, discount_irr, total_irr,
                           status, completed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8::timestamptz)`,
    )
      .bind(
        `zzcmp-${orderSeq}`,
        users[o.user],
        o.kind,
        o.unit,
        discount,
        o.unit - discount,
        o.status,
        o.completedAt,
      )
      .run();
  }
});

afterAll(purge);

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Who arrived new — the `is_new_user` the starts above were written with. */
const NEW = new Set(['u1', 'u3']);

/** The hand-summed truth for campaign A, from the flags above. */
function expected(filter: (o: Order) => boolean = () => true) {
  const counted = ORDERS.filter((o) => o.counts && filter(o));
  const irr = (os: Order[]) => os.reduce((s, o) => s + o.unit - (o.discount ?? 0), 0);
  return {
    buyers: new Set(counted.map((o) => o.user)).size,
    newBuyers: new Set(counted.filter((o) => NEW.has(o.user)).map((o) => o.user)).size,
    revenueIrr: irr(counted),
    newRevenueIrr: irr(counted.filter((o) => NEW.has(o.user))),
  };
}

async function list(query = '') {
  const res = await get(`/api/v1/admin/campaigns${query}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Funnel[] };
  const find = (id: number) => body.items.find((i) => i.id === id)!;
  return { a: find(A), b: find(B), items: body.items };
}

describe('the funnel', () => {
  it('counts starts, and only the money the campaign earned', async () => {
    const { a } = await list();
    expect(a).toMatchObject({ starts: 3, newUsers: 2, ...expected() });
    // Named, so a regression says which door the money came through.
    expect(a.revenueIrr).toBe(5_000_000);
    expect(a.newRevenueIrr).toBe(2_000_000);
  });

  it('counts a customer in every campaign that brought them', async () => {
    const { b } = await list();
    expect(b).toMatchObject({
      starts: 1,
      newUsers: 0,
      buyers: 1,
      newBuyers: 0,
      revenueIrr: 3_000_000,
      newRevenueIrr: 0,
    });
  });

  it('windows money by when it was completed, not by when the customer arrived', async () => {
    // 08-03 holds u2's renewal and no starts: a day can have sales and no
    // arrivals, and a card that said «0 buyers» there would be wrong.
    const { a } = await list('?range=day&day=2026-08-03');
    expect(a).toMatchObject({
      starts: 0,
      newUsers: 0,
      ...expected((o) => o.completedAt?.startsWith('2026-08-03') ?? false),
    });
  });

  it('draws a chart that adds up to the cards, empty days included', async () => {
    const q = '?range=between&day=2026-08-01&to=2026-08-05';
    const res = await get(`/api/v1/admin/campaigns/${A}${q}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      campaign: Funnel;
      byDay: Array<{ day: string; starts: number; revenueIrr: number }>;
    };

    expect(body.byDay).toEqual([
      { day: '2026-08-01', starts: 2, revenueIrr: 0 },
      { day: '2026-08-02', starts: 0, revenueIrr: 2_000_000 },
      { day: '2026-08-03', starts: 0, revenueIrr: 3_000_000 },
      { day: '2026-08-04', starts: 1, revenueIrr: 0 },
      { day: '2026-08-05', starts: 0, revenueIrr: 0 },
    ]);
    const sum = (k: 'starts' | 'revenueIrr') => body.byDay.reduce((s, d) => s + d[k], 0);
    expect(sum('starts')).toBe(body.campaign.starts);
    expect(sum('revenueIrr')).toBe(body.campaign.revenueIrr);

    // …and the list, for the same window, says the same thing as the detail.
    const { a } = await list(q);
    expect(a).toEqual(body.campaign);
  });
});

describe('the detail', () => {
  it('says when the chart is cut to the last 120 days, and not before', async () => {
    type Detail = { byDay: unknown[]; chartCapped: boolean };
    const detail = async (q: string) =>
      (await (await get(`/api/v1/admin/campaigns/${A}${q}`)).json()) as Detail;

    const long = await detail('?range=between&day=2026-01-01&to=2026-08-05');
    expect(long.chartCapped).toBe(true);
    expect(long.byDay.length).toBeLessThanOrEqual(121);

    expect((await detail('?range=between&day=2026-08-01&to=2026-08-05')).chartCapped).toBe(false);
  });

  it('answers a malformed or impossible id with 400, not a database error', async () => {
    for (const raw of ['1e3', '0x10', '99999999999999999999', '-1', '0']) {
      expect((await get(`/api/v1/admin/campaigns/${raw}`)).status, raw).toBe(400);
      expect(
        (await send('PATCH', `/api/v1/admin/campaigns/${raw}`, { name: 'x' })).status,
        raw,
      ).toBe(400);
    }
    expect((await get('/api/v1/admin/campaigns/999999999')).status).toBe(404);
  });
});

describe('creating and editing', () => {
  it('takes a slug in lower case and refuses one already taken', async () => {
    const res = await send('POST', '/api/v1/admin/campaigns', {
      slug: '  ZZ-CMP-Case ',
      name: 'x',
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: number };
    const row = await baseEnv.DB.prepare(`SELECT slug FROM campaigns WHERE id = ?1`)
      .bind(id)
      .first<{ slug: string }>();
    expect(row?.slug).toBe('zz-cmp-case');

    const again = await send('POST', '/api/v1/admin/campaigns', { slug: 'zz-cmp-case', name: 'y' });
    expect(again.status).toBe(409);
  });

  it('refuses the source channel posts own — the table ties it to their post- slugs', async () => {
    const res = await send('POST', '/api/v1/admin/campaigns', {
      slug: 'zz-cmp-src',
      name: 'x',
      source: 'channel',
    });
    expect(res.status).toBe(400);
    const id = await campaign('zz-cmp-src2');
    expect(
      (await send('PATCH', `/api/v1/admin/campaigns/${id}`, { source: 'channel' })).status,
    ).toBe(400);
  });

  it('refuses a slug Telegram cannot carry, and the prefix channel posts own', async () => {
    for (const slug of [
      'ab',
      'zz cmp',
      'zz_cmp',
      '-zzcmp',
      'zz-cmp-é',
      `zz-${'x'.repeat(60)}`,
      'post-12',
    ]) {
      const res = await send('POST', '/api/v1/admin/campaigns', { slug, name: 'x' });
      expect(res.status, slug).toBe(400);
    }
  });

  it('edits the name and archives, but never the slug', async () => {
    const id = await campaign('zz-cmp-edit');

    expect(
      (await send('PATCH', `/api/v1/admin/campaigns/${id}`, { slug: 'zz-cmp-moved' })).status,
    ).toBe(400);
    expect(
      (await send('PATCH', `/api/v1/admin/campaigns/${id}`, { name: 'بهار', status: 'ARCHIVED' }))
        .status,
    ).toBe(200);

    const row = await baseEnv.DB.prepare(`SELECT slug, name, status FROM campaigns WHERE id = ?1`)
      .bind(id)
      .first<{ slug: string; name: string; status: string }>();
    expect(row).toEqual({ slug: 'zz-cmp-edit', name: 'بهار', status: 'ARCHIVED' });

    const audited = await baseEnv.DB.prepare(
      `SELECT action FROM audit_logs WHERE entity_type = 'CAMPAIGN' AND entity_id = ?1 ORDER BY created_at`,
    )
      .bind(String(id))
      .all<{ action: string }>();
    // The «before» is the row the edit replaced — read in the same statement.
    const edited = await baseEnv.DB.prepare(
      `SELECT before_json FROM audit_logs
        WHERE entity_type = 'CAMPAIGN' AND entity_id = ?1 AND action = 'campaign.updated'`,
    )
      .bind(String(id))
      .first<{ before_json: unknown }>();
    const before =
      typeof edited?.before_json === 'string'
        ? JSON.parse(edited.before_json)
        : edited?.before_json;
    expect(before).toMatchObject({ name: 'zz-cmp-edit', status: 'ACTIVE' });

    // Which actions, not their order: the clock is pinned, so both rows carry
    // the same stamp.
    expect((audited.results ?? []).map((r) => r.action).sort()).toEqual([
      'campaign.created',
      'campaign.updated',
    ]);

    // Archived campaigns sort after the live ones.
    const { items } = await list();
    const archivedAt = items.findIndex((i) => i.id === id);
    expect(items.slice(0, archivedAt).every((i) => i.status === 'ACTIVE')).toBe(true);
  });

  it('keeps no change the audit log could not record', async () => {
    const id = await campaign('zz-cmp-audited');
    auditDown.on = true;
    try {
      const made = await send('POST', '/api/v1/admin/campaigns', {
        slug: 'zz-cmp-orphan',
        name: 'x',
      });
      expect(made.status).toBeGreaterThanOrEqual(500);
      const edited = await send('PATCH', `/api/v1/admin/campaigns/${id}`, { name: 'بی‌رد' });
      expect(edited.status).toBeGreaterThanOrEqual(500);
    } finally {
      auditDown.on = false;
    }

    const orphan = await baseEnv.DB.prepare(
      `SELECT 1 FROM campaigns WHERE slug = 'zz-cmp-orphan'`,
    ).first();
    expect(orphan).toBeNull();
    const row = await baseEnv.DB.prepare(`SELECT name FROM campaigns WHERE id = ?1`)
      .bind(id)
      .first<{ name: string }>();
    expect(row?.name).toBe('zz-cmp-audited');
  });

  it('lets a reviewer read, and nothing more', async () => {
    expect((await get('/api/v1/admin/campaigns', REVIEWER)).status).toBe(200);
    expect(
      (await send('POST', '/api/v1/admin/campaigns', { slug: 'zz-cmp-rev', name: 'x' }, REVIEWER))
        .status,
    ).toBe(403);
    expect(
      (await send('PATCH', `/api/v1/admin/campaigns/${A}`, { name: 'x' }, REVIEWER)).status,
    ).toBe(403);
  });
});
