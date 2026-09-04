/**
 * «برای چه کسانی» — the audience on a broadcast.
 *
 * A broadcast went to every active customer and there was no way to say
 * otherwise. What makes an audience dangerous rather than merely useful is the
 * preview: an operator reads a number, believes it, and presses a button with
 * no undo. So the property these tests exist for is not «the filter works» —
 * it is that **the number shown and the number sent are the same number**.
 *
 * That is asserted against the rows actually written, not against a second
 * count computed the same way. `audienceSql` is one predicate used by both
 * sides precisely so this can be true; the test is what stops it quietly
 * becoming two.
 *
 * The second thing here is membership, and it is deliberately about the cases
 * that are easy to get backwards: somebody whose service ended but who has a
 * live one as well is NOT «سرویسش تمام شده», and somebody who bought once is
 * not «هیچ خریدی نکرده» however long ago it was.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-aud@example.com';

function envAs(email = ADMIN) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

/** Telegram ids far above anything another suite seeds. */
const TG = 996_100_000;
let ids = 0;
/** The uuid namespace this file owns outright, so its cleanup can find it. */
const NS = '00000000-0000-4000-a000-';
const uuid = () => `${NS}${String(++ids).padStart(12, '0')}`;
const NOW_MS = Date.UTC(2026, 8, 4, 6, 0, 0);

/**
 * This file's own customers, by the telegram id each one keeps.
 *
 * Fixed rather than drawn, so a second run finds the SAME people — and so the
 * cleanup below can find last run's leftovers. The first draft of this file
 * counted ids from zero and inserted fresh orders every time: it passed once
 * and failed on the second run with a duplicate `orders_public_id_key`, which
 * is a test that proves nothing about the run after the one you watched.
 */
const PEOPLE = ['never', 'bought', 'ended', 'both', 'panel-a'] as const;
const tgOf = (tag: (typeof PEOPLE)[number]) => TG + PEOPLE.indexOf(tag);

/** The panel this file's fixtures sell from, and one it does not. */
let providerA = 0;
let providerB = 0;

async function customer(tag: (typeof PEOPLE)[number]): Promise<number> {
  const row = await baseEnv.DB.prepare(
    `INSERT INTO users (telegram_id, username, status, registered_at)
     VALUES (?1, ?2, 'ACTIVE', now())
     ON CONFLICT (telegram_id) DO UPDATE SET status = 'ACTIVE'
     RETURNING id`,
  )
    .bind(tgOf(tag), `aud-${tag}`)
    .first<{ id: number }>();
  return Number(row!.id);
}

async function completedOrder(userId: number): Promise<void> {
  await baseEnv.DB.prepare(
    `INSERT INTO orders (public_id, user_id, kind, unit_price_irr, total_irr, status, completed_at)
     VALUES (?1, ?2, 'NEW_PURCHASE', 1000, 1000, 'COMPLETED', now())`,
  )
    .bind(uuid(), userId)
    .run();
}

async function service(userId: number, status: string, providerId: number | null): Promise<void> {
  await baseEnv.DB.prepare(
    `INSERT INTO subscriptions
       (public_id, user_id, plan_name_at_sale, price_irr, status, provider_id, purchased_at)
     VALUES (?1, ?2, 'تست', 1000, ?3, ?4, now())`,
  )
    .bind(uuid(), userId, status, providerId)
    .run();
}

async function provider(name: string): Promise<number> {
  const row = await baseEnv.DB.prepare(
    `INSERT INTO provisioning_providers (code, name, kind, status)
     VALUES (?1, ?2, 'manual', 'ACTIVE')
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
  )
    .bind(name, name)
    .first<{ id: number }>();
  return Number(row!.id);
}

/** What the screen would show for this audience. */
async function reach(query: string): Promise<number> {
  const res = await app.request(`/api/v1/admin/bulk/reach?${query}`, {}, envAs());
  const body = (await res.json()) as { reach: number };
  return body.reach;
}

/** What the send actually queues, and to whom. */
async function send(audience: unknown): Promise<{ queued: number; broadcastId: string }> {
  const broadcastId = uuid();
  const res = await app.request(
    '/api/v1/admin/bulk/broadcast',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'سلام', broadcastId, audience }),
    },
    envAs(),
  );
  const body = (await res.json()) as { queued: number };
  return { queued: body.queued, broadcastId };
}

async function got(broadcastId: string, userId: number): Promise<boolean> {
  const row = await baseEnv.DB.prepare(
    `SELECT 1 AS hit FROM broadcast_recipients WHERE broadcast_id = ?1 AND user_id = ?2`,
  )
    .bind(broadcastId, userId)
    .first<{ hit: number }>();
  return row !== null && row !== undefined;
}

/** Everybody this file made, so the assertions do not depend on the shop. */
let never = 0;
let bought = 0;
let ended = 0;
let endedButAlsoLive = 0;
let onPanelA = 0;

beforeAll(async () => {
  await applySchema();
  await baseEnv.DB.prepare(
    `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
     VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)`,
  )
    .bind(uuid(), ADMIN, NOW_MS)
    .run();

  providerA = await provider('aud-panel-a');
  providerB = await provider('aud-panel-b');

  /*
   * Last run's rows, removed before this run's are written.
   *
   * Scoped by the `public_id` PREFIX this file owns rather than by user, and
   * that is the point: a row left by an earlier shape of this fixture belongs
   * to a customer these ids no longer name, and cleaning up by customer would
   * miss exactly those. The customers themselves are upserted and keep their
   * ids — eleven tables hold RESTRICT references to `users`, so deleting them
   * is not the cleanup it looks like.
   *
   * Subscriptions first: they carry the foreign key to orders.
   */
  const MINE = `${NS}%`;
  await baseEnv.DB.prepare(`DELETE FROM subscriptions WHERE public_id LIKE ?1`).bind(MINE).run();
  await baseEnv.DB.prepare(`DELETE FROM orders WHERE public_id LIKE ?1`).bind(MINE).run();

  // Started the bot, never completed an order.
  never = await customer('never');

  // Bought once. Not «هیچ خریدی نکرده», however long ago.
  bought = await customer('bought');
  await completedOrder(bought);

  // Had a service, has none now.
  ended = await customer('ended');
  await completedOrder(ended);
  await service(ended, 'DISABLED', providerA);

  // The case that is easy to get backwards: an ended service AND a live one.
  endedButAlsoLive = await customer('both');
  await completedOrder(endedButAlsoLive);
  await service(endedButAlsoLive, 'REMOVED', providerA);
  await service(endedButAlsoLive, 'ACTIVE', providerB);

  // A live service on panel A.
  onPanelA = await customer('panel-a');
  await completedOrder(onPanelA);
  await service(onPanelA, 'ACTIVE', providerA);
});

beforeEach(async () => {
  await baseEnv.DB.prepare(`TRUNCATE broadcast_recipients, broadcasts CASCADE`).run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the audience on a broadcast', () => {
  /**
   * The assertion this file exists for.
   *
   * Not «the count is N» — that depends on what else the shop holds — but that
   * the count an operator approved is the count of rows the send then wrote.
   * Run for every audience, because a predicate used in two places drifts in
   * one of them.
   */
  it.each([
    ['audience=all', { kind: 'all' }],
    ['audience=never_bought', { kind: 'never_bought' }],
    ['audience=service_ended', { kind: 'service_ended' }],
  ])('sends to exactly as many as it promised: %s', async (query, audience) => {
    const promised = await reach(query);
    const { queued, broadcastId } = await send(audience);

    expect(queued).toBe(promised);
    const rows = await baseEnv.DB.prepare(
      `SELECT count(*)::int AS n FROM broadcast_recipients WHERE broadcast_id = ?1`,
    )
      .bind(broadcastId)
      .first<{ n: number }>();
    expect(Number(rows?.n)).toBe(promised);
  });

  it('promises and sends the same number for one panel', async () => {
    const promised = await reach(`audience=provider&providerId=${providerA}`);
    const { queued } = await send({ kind: 'provider', providerId: providerA });
    expect(queued).toBe(promised);
  });

  it('leaves out anybody who has completed an order', async () => {
    const { broadcastId } = await send({ kind: 'never_bought' });
    expect(await got(broadcastId, never)).toBe(true);
    expect(await got(broadcastId, bought)).toBe(false);
    expect(await got(broadcastId, onPanelA)).toBe(false);
  });

  /**
   * The one that is easy to get backwards. Somebody whose old service was
   * removed but who is a paying customer today must NOT be told «سرویست تمام
   * شده» — that is the message that loses a customer who is still here.
   */
  it('does not call somebody lapsed while they still have a live service', async () => {
    const { broadcastId } = await send({ kind: 'service_ended' });
    expect(await got(broadcastId, ended)).toBe(true);
    expect(await got(broadcastId, endedButAlsoLive)).toBe(false);
    expect(await got(broadcastId, never)).toBe(false);
  });

  it('picks a panel by its id, and only that panel', async () => {
    const { broadcastId } = await send({ kind: 'provider', providerId: providerA });
    expect(await got(broadcastId, onPanelA)).toBe(true);
    // Their live service is on B; the removed one on A must not qualify them.
    expect(await got(broadcastId, endedButAlsoLive)).toBe(false);
    expect(await got(broadcastId, ended)).toBe(false);
    expect(await got(broadcastId, never)).toBe(false);
  });

  it('still reaches everybody when nothing is said about the audience', async () => {
    const { broadcastId } = await send(undefined);
    for (const id of [never, bought, ended, endedButAlsoLive, onPanelA]) {
      expect(await got(broadcastId, id)).toBe(true);
    }
  });

  it('refuses an audience it cannot read rather than counting everybody', async () => {
    const res = await app.request('/api/v1/admin/bulk/reach?audience=whoever', {}, envAs());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_audience');

    // And the same on the way in, where it would have sent to everybody.
    const bad = await app.request(
      '/api/v1/admin/bulk/broadcast',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'سلام', broadcastId: uuid(), audience: { kind: 'whoever' } }),
      },
      envAs(),
    );
    expect(bad.status).toBe(400);
  });

  /**
   * A panel nobody holds a service on. The send must refuse rather than queue
   * nothing and report success: «۰ نفر در صف قرار گرفت» reads as done.
   */
  it('refuses when the audience is empty instead of reporting a send', async () => {
    expect(await reach(`audience=provider&providerId=${providerB}`)).toBeGreaterThan(0);
    const lonely = await provider('aud-panel-empty');
    expect(await reach(`audience=provider&providerId=${lonely}`)).toBe(0);

    const res = await app.request(
      '/api/v1/admin/bulk/broadcast',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          body: 'سلام',
          broadcastId: uuid(),
          audience: { kind: 'provider', providerId: lonely },
        }),
      },
      envAs(),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('no_active_customers');
  });
});
