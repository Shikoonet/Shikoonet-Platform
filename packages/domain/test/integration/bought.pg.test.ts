/**
 * «این مشتری خریده؟», against a real Postgres.
 *
 * The expectations are Sam's rules, not the SQL's: a free trial is not a
 * purchase (2026-09-16) whichever bot handed it out, and a trial the customer
 * then paid to renew is (2026-09-13 made that renewal possible; 2026-09-25
 * found it still read as «never bought»). The two PHP-shaped rows are the
 * importer's own shape — `migrateInvoiceOrders` — because that is what 849
 * production customers actually carry.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresD1 } from '@shikoo/db';
import {
  COMPLETED_A_PURCHASE_SQL,
  OWNS_PAID_SERVICE_SQL,
  paidServiceSql,
} from '../../src/bought.js';

const { db, pool } = createPostgresD1();

const TG = 934_100_000;
const TAG = 'zz-bought';
let seq = 0;

async function cleanUp(): Promise<void> {
  const mine = `SELECT id FROM users WHERE username = '${TAG}'`;
  await db.prepare(`DELETE FROM subscriptions WHERE user_id IN (${mine})`).run();
  await db.prepare(`DELETE FROM orders WHERE user_id IN (${mine})`).run();
  await db.prepare(`DELETE FROM users WHERE username = '${TAG}'`).run();
  await db.prepare(`DELETE FROM provisioning_providers WHERE code = '${TAG}'`).run();
}

async function panel(): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO provisioning_providers (code, name, kind) VALUES ('${TAG}', '${TAG}', 'manual')
       RETURNING id`,
    )
    .first<{ id: number }>();
  return Number(row!.id);
}

async function customer(): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO users (telegram_id, username, registered_at) VALUES (?1, '${TAG}', now())
       RETURNING id`,
    )
    .bind(TG + ++seq)
    .first<{ id: number }>();
  return Number(row!.id);
}

async function order(
  userId: number,
  o: {
    kind: string;
    totalIrr: number;
    status?: string;
    legacyRef?: string;
    name?: string;
    target?: number;
    createdAt?: string;
  },
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO orders
         (public_id, user_id, kind, provider_id, unit_price_irr, total_irr, status,
          legacy_ref, plan_name_at_sale, target_subscription_id, created_at)
       VALUES (?1, ?2, ?3, (SELECT id FROM provisioning_providers WHERE code = '${TAG}'),
               ?4, ?4, ?5, ?6, ?7, ?8, COALESCE(?9::timestamptz, now()))
       RETURNING id`,
    )
    .bind(
      `${TAG}-o-${++seq}`,
      userId,
      o.kind,
      o.totalIrr,
      o.status ?? 'COMPLETED',
      o.legacyRef ?? null,
      o.name ?? null,
      o.target ?? null,
      o.createdAt ?? null,
    )
    .first<{ id: number }>();
  return Number(row!.id);
}

async function service(userId: number, orderId: number | null): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO subscriptions
         (public_id, user_id, order_id, plan_name_at_sale, price_irr, status, purchased_at)
       VALUES (?1, ?2, ?3, 'fixture', 0, 'ACTIVE', now())
       RETURNING id`,
    )
    .bind(`${TAG}-s-${++seq}`, userId, orderId)
    .first<{ id: number }>();
  return Number(row!.id);
}

async function asked(userId: number): Promise<{ owns: boolean; completed: boolean }> {
  const row = await db
    .prepare(
      `SELECT ${OWNS_PAID_SERVICE_SQL} AS owns, ${COMPLETED_A_PURCHASE_SQL} AS completed
         FROM users u WHERE u.id = ?1`,
    )
    .bind(userId)
    .first<{ owns: boolean; completed: boolean }>();
  return { owns: row!.owns, completed: row!.completed };
}

/** What the PHP bot wrote for a trial, as the importer carries it over. */
const PHP_TRIAL = { kind: 'NEW_PURCHASE', totalIrr: 0, name: 'سرویس تست' };

/** A trial on this bot: the shape `placeTrialOrder` writes. */
async function ourTrial(userId: number): Promise<number> {
  return service(userId, await order(userId, { kind: 'TRIAL', totalIrr: 0 }));
}

beforeEach(async () => {
  await cleanUp();
  await panel();
});

afterAll(async () => {
  await cleanUp();
  await pool.end();
});

describe('has this customer bought', () => {
  it('nothing yet: no', async () => {
    expect(await asked(await customer())).toEqual({ owns: false, completed: false });
  });

  it('only our free trial: no', async () => {
    const u = await customer();
    await ourTrial(u);
    expect(await asked(u)).toEqual({ owns: false, completed: false });
  });

  it('only a PHP-bot trial: no — the importer wrote it as a zero-Toman sale', async () => {
    const u = await customer();
    await service(u, await order(u, { ...PHP_TRIAL, legacyRef: `invoice:${TAG}-${seq}` }));
    expect(await asked(u)).toEqual({ owns: false, completed: false });
  });

  it('a real PHP-bot sale: yes', async () => {
    const u = await customer();
    await service(
      u,
      await order(u, {
        kind: 'NEW_PURCHASE',
        totalIrr: 11_900_000,
        name: 'سرویس الماس',
        legacyRef: `invoice:${TAG}-${seq}`,
      }),
    );
    expect(await asked(u)).toEqual({ owns: true, completed: true });
  });

  it('an imported service with no order at all: yes', async () => {
    const u = await customer();
    await service(u, null);
    expect((await asked(u)).owns).toBe(true);
  });

  it('a trial renewed into a paid tier: yes', async () => {
    const u = await customer();
    const trial = await ourTrial(u);
    await order(u, { kind: 'RENEWAL', totalIrr: 11_900_000, target: trial });
    expect(await asked(u)).toEqual({ owns: true, completed: true });
  });

  it('a PHP-bot trial renewed into a paid tier here: yes', async () => {
    const u = await customer();
    const trial = await service(
      u,
      await order(u, { ...PHP_TRIAL, legacyRef: `invoice:${TAG}-${seq}` }),
    );
    await order(u, { kind: 'RENEWAL', totalIrr: 11_900_000, target: trial });
    expect(await asked(u)).toEqual({ owns: true, completed: true });
  });

  it('a trial whose renewal failed, or cost nothing: still no service paid for', async () => {
    const u = await customer();
    const trial = await ourTrial(u);
    await order(u, { kind: 'RENEWAL', totalIrr: 11_900_000, target: trial, status: 'FAILED' });
    await order(u, { kind: 'RENEWAL', totalIrr: 0, target: trial });
    expect((await asked(u)).owns).toBe(false);
  });
});

describe('paidServiceSql as of a moment', () => {
  it('a trial is paid for only from the renewal on', async () => {
    const u = await customer();
    const trial = await ourTrial(u);
    await order(u, {
      kind: 'RENEWAL',
      totalIrr: 11_900_000,
      target: trial,
      createdAt: '2026-09-10T12:00:00Z',
    });
    const at = async (when: string): Promise<boolean> => {
      const row = await db
        .prepare(
          `SELECT ${paidServiceSql('s', 'so', '?2::timestamptz')} AS paid
             FROM subscriptions s LEFT JOIN orders so ON so.id = s.order_id
            WHERE s.id = ?1`,
        )
        .bind(trial, when)
        .first<{ paid: boolean }>();
      return row!.paid;
    };
    expect(await at('2026-09-10T11:00:00Z')).toBe(false);
    expect(await at('2026-09-10T13:00:00Z')).toBe(true);
  });
});
