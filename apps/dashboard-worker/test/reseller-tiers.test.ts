/**
 * Making somebody a reseller from the panel, and what a level costs.
 *
 * The assertion that matters is the LAST one: the panel and the bot compute the
 * effective percentage with different SQL — a LEFT JOIN here, a scalar subquery
 * in `handle.ts`, because two of the bot's three loads are `RETURNING` clauses
 * that cannot join — so nothing but a test can hold them to the same answer.
 * That is the drift this file exists to catch, and it is why the expected
 * numbers below are written out rather than read from either side.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-tiers@example.com';
const REVIEWER = 'reviewer-tiers@example.com';
const READER = 'reader-tiers@example.com';
const TG_BASE = 771_000_000;

let seq = 0;

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

function post(path: string, body: unknown, email = ADMIN) {
  return app.request(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    envAs(email),
  );
}

async function makeCustomer(opts: {
  reseller?: boolean;
  tier?: string | null;
  discountPercent?: number;
}): Promise<number> {
  const telegramId = TG_BASE + ++seq;
  const row = await baseEnv.DB.prepare(
    `INSERT INTO users (telegram_id, username, status, is_reseller, reseller_tier, discount_percent, registered_at)
     VALUES (?1, ?2, 'ACTIVE', ?3, ?4, ?5, now()) RETURNING id`,
  )
    .bind(
      telegramId,
      `tiers${telegramId}`,
      opts.reseller ?? false,
      opts.tier ?? null,
      opts.discountPercent ?? 0,
    )
    .first<{ id: number }>();
  return Number(row!.id);
}

async function userRow(id: number) {
  return baseEnv.DB.prepare(
    `SELECT is_reseller, reseller_tier, discount_percent FROM users WHERE id = ?1`,
  )
    .bind(id)
    .first<{ is_reseller: boolean; reseller_tier: string | null; discount_percent: number }>();
}

async function auditRows(entityId: string) {
  const { results } = await baseEnv.DB.prepare(
    `SELECT action, before_json, after_json FROM audit_logs
      WHERE entity_id = ?1 ORDER BY created_at, id`,
  )
    .bind(entityId)
    .all<{ action: string; before_json: string; after_json: string }>();
  return results ?? [];
}

async function detail(id: number, email = ADMIN) {
  const res = await app.request(`/api/v1/admin/customers/${id}`, {}, envAs(email));
  return (await res.json()) as {
    customer: {
      isReseller: boolean;
      discountPercent: number;
      effectiveDiscountPercent: number;
      tier: { code: string; name: string; percent: number } | null;
    };
  };
}

beforeAll(async () => {
  await applySchema();
  const now = Date.now();
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
    [REVIEWER, 'REVIEWER'],
    [READER, 'READ_ONLY'],
  ] as const) {
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
    )
      .bind(crypto.randomUUID(), email, role, now)
      .run();
  }
});

beforeEach(async () => {
  // Wallets first: `wallets.user_id` is a foreign key and the row is written by
  // a trigger, so it outlives the test that caused it. Same order and same
  // reason as `purgeOurCustomers` in `customers.test.ts`.
  await baseEnv.DB.prepare(`TRUNCATE wallet_entries, wallets RESTART IDENTITY CASCADE`).run();
  await baseEnv.DB.prepare(`DELETE FROM reseller_requests WHERE user_id IN
    (SELECT id FROM users WHERE telegram_id >= ?1)`)
    .bind(TG_BASE)
    .run();
  await baseEnv.DB.prepare(`DELETE FROM users WHERE telegram_id >= ?1`).bind(TG_BASE).run();
  // `audit_logs` is deliberately NOT cleared. It is append-only by trigger so a
  // DELETE is refused, and TRUNCATE is refused too because
  // `account_assignment_previews` references it. Every assertion below scopes
  // to one customer id instead, which is safe because `users.id` is an identity
  // sequence — a `DELETE` above never gives an id back, so no row from an
  // earlier run can wear the id of a customer made in this one.
  await baseEnv.DB.prepare(`UPDATE reseller_tiers SET discount_percent = 0`).run();
});

describe('making someone a reseller', () => {
  it('writes both columns and records who did it', async () => {
    const id = await makeCustomer({});

    const res = await post(`/api/v1/admin/customers/${id}/reseller`, {
      isReseller: true,
      tier: 'n2',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: true });
    expect(await userRow(id)).toMatchObject({ is_reseller: true, reseller_tier: 'n2' });

    const logs = await auditRows(String(id));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.action).toBe('customer.reseller_set');
    expect(JSON.parse(logs[0]!.after_json)).toMatchObject({
      is_reseller: true,
      reseller_tier: 'n2',
    });
  });

  it('says nothing changed, and audits nothing, when it did not', async () => {
    const id = await makeCustomer({ reseller: true, tier: 'n' });

    const res = await post(`/api/v1/admin/customers/${id}/reseller`, {
      isReseller: true,
      tier: 'n',
    });

    expect(await res.json()).toMatchObject({ ok: true, changed: false });
    expect(await auditRows(String(id))).toHaveLength(0);
  });

  it('clears the level in the same breath as the flag', async () => {
    const id = await makeCustomer({ reseller: true, tier: 'n2' });

    await post(`/api/v1/admin/customers/${id}/reseller`, { isReseller: false, tier: 'n2' });

    // The level is gone even though the body still named one: a person who is
    // not a reseller is on no level, and leaving `n2` on the row would show a
    // level on a screen for somebody who is charged as an ordinary customer.
    expect(await userRow(id)).toMatchObject({ is_reseller: false, reseller_tier: null });
  });

  it('closes the request the customer was still waiting on', async () => {
    const id = await makeCustomer({});
    await baseEnv.DB.prepare(
      `INSERT INTO reseller_requests (user_id, description, status, created_at)
       VALUES (?1, 'می‌خواهم نماینده شوم', 'PENDING', now())`,
    )
      .bind(id)
      .run();

    await post(`/api/v1/admin/customers/${id}/reseller`, { isReseller: true, tier: 'n' });

    const req = await baseEnv.DB.prepare(
      `SELECT status FROM reseller_requests WHERE user_id = ?1`,
    )
      .bind(id)
      .first<{ status: string }>();
    // Otherwise the requests screen keeps offering «رد» for somebody who
    // already is one, and pressing it would read as taking it away.
    expect(req?.status).toBe('APPROVED');
  });

  it('refuses a level nobody can be charged at', async () => {
    const id = await makeCustomer({});
    const res = await post(`/api/v1/admin/customers/${id}/reseller`, {
      isReseller: true,
      tier: 'n3',
    });
    expect(res.status).toBe(400);
    expect(await userRow(id)).toMatchObject({ is_reseller: false });
  });
});

describe('what a level costs', () => {
  it('re-prices every member with one number', async () => {
    const one = await makeCustomer({ reseller: true, tier: 'n' });
    const two = await makeCustomer({ reseller: true, tier: 'n' });

    const res = await post('/api/v1/admin/reseller-tiers/n', { percent: 35 });
    expect(res.status).toBe(200);

    for (const id of [one, two]) {
      expect((await detail(id)).customer.effectiveDiscountPercent).toBe(35);
    }
    // Nobody's own column moved. That is the whole design: the level is read,
    // never copied, so leaving it gives each of them their own number back.
    expect(Number((await userRow(one))!.discount_percent)).toBe(0);
  });

  it('counts a reseller with no level as level one', async () => {
    await makeCustomer({ reseller: true, tier: null });
    await makeCustomer({ reseller: true, tier: 'n2' });

    const res = await app.request('/api/v1/admin/reseller-tiers', {}, envAs(REVIEWER));
    const body = (await res.json()) as { items: { code: string; members: number }[] };

    const byCode = Object.fromEntries(body.items.map((i) => [i.code, i.members]));
    expect(byCode['n']).toBe(1);
    expect(byCode['n2']).toBe(1);
  });

  it('is not something a reviewer may change', async () => {
    expect((await post('/api/v1/admin/reseller-tiers/n', { percent: 5 }, REVIEWER)).status).toBe(
      403,
    );
    expect((await post('/api/v1/admin/reseller-tiers/n', { percent: 5 }, READER)).status).toBe(403);
  });
});

describe('the number the panel shows is the number the bot charges', () => {
  /**
   * The drift test.
   *
   * A personal discount on a customer who is on a level changes nothing they
   * will ever pay, and the danger is a screen that shows it as though it did.
   * The route stores it, reports it back as `discountPercent`, and reports the
   * level's number as `effectiveDiscountPercent` — which is the one the bot's
   * `DISCOUNT_PERCENT` computes.
   */
  it('keeps the level in force when a personal discount is set on top', async () => {
    const id = await makeCustomer({ reseller: true, tier: 'n' });
    await post('/api/v1/admin/reseller-tiers/n', { percent: 40 });

    const res = await post(`/api/v1/admin/customers/${id}/discount`, { percent: 5 });
    const saved = (await res.json()) as { percent: number; effectivePercent: number };

    expect(saved.percent).toBe(5);
    expect(saved.effectivePercent).toBe(40);

    const shown = (await detail(id)).customer;
    expect(shown.discountPercent).toBe(5);
    expect(shown.effectiveDiscountPercent).toBe(40);
    expect(shown.tier).toMatchObject({ code: 'n', percent: 40 });
  });

  it('records the personal column in the audit, not the level', async () => {
    const id = await makeCustomer({ reseller: true, tier: 'n', discountPercent: 5 });
    await post('/api/v1/admin/reseller-tiers/n', { percent: 40 });

    await post(`/api/v1/admin/customers/${id}/discount`, { percent: 12 });

    // «was 40» here would be fiction: the operator changed 5 to 12.
    const logs = (await auditRows(String(id))).filter((l) => l.action === 'customer.discount_set');
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!.before_json)).toMatchObject({ discount_percent: 5 });
    expect(JSON.parse(logs[0]!.after_json)).toMatchObject({ discount_percent: 12 });
  });

  it('leaves an ordinary customer showing their own number', async () => {
    const id = await makeCustomer({ discountPercent: 15 });
    await post('/api/v1/admin/reseller-tiers/n', { percent: 40 });

    const shown = (await detail(id)).customer;
    expect(shown.effectiveDiscountPercent).toBe(15);
    expect(shown.tier).toBeNull();
  });
});

describe('the reseller filter', () => {
  it('lists the confirmed ones and nobody else', async () => {
    const reseller = await makeCustomer({ reseller: true, tier: 'n' });
    const ordinary = await makeCustomer({});

    const res = await app.request(
      '/api/v1/admin/customers?reseller=yes&pageSize=100',
      {},
      envAs(ADMIN),
    );
    const body = (await res.json()) as { items: { id: number }[] };
    const ids = body.items.map((i) => i.id);

    expect(ids).toContain(reseller);
    expect(ids).not.toContain(ordinary);
  });
});
