/**
 * «صف پیام همگانی» — what is going, what waits behind it, and «لغو» (0100).
 *
 * The order is the sender's own: `claimBroadcastBatch` takes the oldest
 * broadcast's rows first. What these tests pin is that the screen reports that
 * same order, that the header bar follows the one actually going rather than
 * the newest, and that a cancel stops what has not gone without touching what
 * has — ADMIN only.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv, deleteFixtureUsers, FIXTURE_TG_BASE } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'broadcast-queue-admin@example.com';
const REVIEWER = 'broadcast-queue-reviewer@example.com';
/** Its own million: no other suite in this package uses 981,000,000. */
const TG_BASE = FIXTURE_TG_BASE + 981_000_000;

const envAs = (email: string) => ({ ...baseEnv, TEST_ACCESS_USER: email });

let seq = 0;
async function makeCustomer(): Promise<void> {
  await baseEnv.DB.prepare(
    `INSERT INTO users (telegram_id, username, status, registered_at)
     VALUES (?1, ?2, 'ACTIVE', now())`,
  )
    .bind(TG_BASE + ++seq, `queue-${seq}`)
    .run();
}

async function send(body: string): Promise<{ id: string; ahead: number }> {
  const id = crypto.randomUUID();
  const res = await app.fetch(
    new Request('https://example.com/api/v1/admin/bulk/broadcast', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://example.com' },
      body: JSON.stringify({ body, broadcastId: id }),
    }),
    envAs(ADMIN),
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { ahead: number };
  return { id, ahead: json.ahead };
}

async function get<T>(path: string): Promise<T> {
  const res = await app.fetch(new Request(`https://example.com${path}`), envAs(ADMIN));
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

interface QueueItem {
  id: string;
  preview: string | null;
  by: string | null;
  cancelledAt: number | null;
  total: number;
  sent: number;
  failed: number;
  cancelled: number;
}
const queue = async () => (await get<{ items: QueueItem[] }>('/api/v1/admin/bulk/queue')).items;

function cancel(id: string, as = ADMIN) {
  return app.fetch(
    new Request(`https://example.com/api/v1/admin/bulk/broadcast/${id}/cancel`, {
      method: 'POST',
      headers: { origin: 'https://example.com' },
    }),
    envAs(as),
  );
}

beforeAll(applySchema);

beforeEach(async () => {
  const now = Date.now();
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
    [REVIEWER, 'REVIEWER'],
  ] as const) {
    await baseEnv.DB.prepare(
      `INSERT INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)
       ON CONFLICT (email) DO UPDATE SET role = excluded.role, active = 1`,
    )
      .bind(crypto.randomUUID(), email, role, now)
      .run();
  }
  // `bulk.test.ts` and `bulk-recent.test.ts` credit EVERY active customer,
  // these included, so their wallets go first — the same truncate those
  // suites start with.
  await baseEnv.DB.prepare(`TRUNCATE wallet_entries, wallets RESTART IDENTITY CASCADE`).run();
  await baseEnv.DB.prepare(`TRUNCATE broadcast_recipients, broadcasts CASCADE`).run();
  await deleteFixtureUsers(TG_BASE);
  await makeCustomer();
  await makeCustomer();
});

// Left behind, these would be «every active customer» in the next suite.
afterAll(async () => {
  await baseEnv.DB.prepare(`TRUNCATE broadcast_recipients, broadcasts CASCADE`).run();
  await deleteFixtureUsers(TG_BASE);
});

describe('the queue', () => {
  it('lists what is going first, then what waits, and the bar follows the first', async () => {
    const first = await send('اولی');
    const second = await send('دومی');
    expect(first.ahead).toBe(0);
    expect(second.ahead).toBe(1);

    const items = await queue();
    expect(items.map((i) => i.id)).toEqual([first.id, second.id]);
    expect(items[0]).toMatchObject({ preview: 'اولی', by: ADMIN, cancelledAt: null, sent: 0 });
    expect(items[0]!.total).toBeGreaterThan(0);

    // The newest is `second`; the bar must still show `first`, which is the
    // one the sender is working through.
    const recent = await get<{ broadcast: { id: string } | null }>('/api/v1/admin/bulk/recent');
    expect(recent.broadcast?.id).toBe(first.id);
  });

  it('a finished broadcast leaves the queue and the bar moves to the next', async () => {
    const first = await send('اولی');
    const second = await send('دومی');
    await baseEnv.DB.prepare(
      `UPDATE broadcast_recipients SET status = 'SENT', sent_at = now() WHERE broadcast_id = ?1::uuid`,
    )
      .bind(first.id)
      .run();
    await baseEnv.DB.prepare(`UPDATE broadcasts SET finished_at = now() WHERE id = ?1::uuid`)
      .bind(first.id)
      .run();

    expect((await queue()).map((i) => i.id)).toEqual([second.id]);
    const recent = await get<{ broadcast: { id: string } | null }>('/api/v1/admin/bulk/recent');
    expect(recent.broadcast?.id).toBe(second.id);
  });
});

describe('«لغو»', () => {
  it('closes what has not gone, keeps what has, and is not a failure', async () => {
    const first = await send('اولی');
    const second = await send('دومی');
    // One of the second's recipients already went (as if it had started).
    await baseEnv.DB.prepare(
      `UPDATE broadcast_recipients SET status = 'SENT', sent_at = now()
        WHERE broadcast_id = ?1::uuid
          AND user_id = (SELECT min(user_id) FROM broadcast_recipients WHERE broadcast_id = ?1::uuid)`,
    )
      .bind(second.id)
      .run();

    const res = await cancel(second.id);
    expect(res.status).toBe(200);
    const { notSent } = (await res.json()) as { notSent: number };

    const item = (await queue()).find((i) => i.id === second.id)!;
    expect(item.cancelledAt).not.toBeNull();
    expect(item.sent).toBe(1);
    expect(item.cancelled).toBe(notSent);
    expect(item.cancelled).toBe(item.total - 1);
    // Nobody tried, so nobody «did not get it»: the failures list stays empty.
    expect(item.failed).toBe(0);
    const failures = await get<{ items: unknown[] }>(
      `/api/v1/admin/bulk/broadcast/${second.id}/failures`,
    );
    expect(failures.items).toEqual([]);

    // The first is untouched and still what the bar shows.
    expect((await queue()).find((i) => i.id === first.id)?.cancelledAt).toBeNull();
    const recent = await get<{ broadcast: { id: string } | null }>('/api/v1/admin/bulk/recent');
    expect(recent.broadcast?.id).toBe(first.id);

    const audit = await baseEnv.DB.prepare(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE action = 'customers.broadcast_cancelled' AND entity_id = ?1`,
    )
      .bind(second.id)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it('refuses a second cancel, and anyone but an admin', async () => {
    const { id } = await send('اولی');
    expect((await cancel(id, REVIEWER)).status).toBe(403);
    expect((await queue())[0]?.cancelledAt).toBeNull();

    expect((await cancel(id)).status).toBe(200);
    expect((await cancel(id)).status).toBe(409);
  });
});
