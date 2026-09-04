/**
 * Discount codes.
 *
 * The important assertions here are not about this route in isolation. Two of
 * them measure it against the bot, which is the code that will actually spend
 * these rows:
 *
 *   - the case-insensitive uniqueness check, verified by showing that the
 *     lookup the bot performs (`WHERE lower(code) = ?`) would find more than
 *     one row if the check were absent, and
 *   - the derived state, verified against the conditions `checkCode` applies
 *     rather than against a column this route writes.
 *
 * A code with a stored `status` column would let this file agree with itself
 * while the customer got a different answer — rule 6.
 */

import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv, deleteFixtureUsers } from './helpers/env.js';
import { app } from '../src/index.js';
import { MAX_SINGLE_PAYMENT_IRR } from '@shikoo/contracts';

const ADMIN = 'admin@example.com';
const REVIEWER = 'reviewer-discounts@example.com';
const PREFIX = 'zzdisc';
const TG_BASE = 960_000_000;
let seq = 0;

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

async function create(body: Record<string, unknown>, email = ADMIN) {
  return app.request(
    '/api/v1/admin/discounts',
    { method: 'POST', body: JSON.stringify(body) },
    envAs(email),
  );
}

/** A valid GIFT_BALANCE body with the fields under test overridden. */
function gift(code: string, extra: Record<string, unknown> = {}) {
  return { code, kind: 'GIFT_BALANCE', amountIrr: 500_000, ...extra };
}

async function codeRow(id: number) {
  return baseEnv.DB.prepare(
    `SELECT code, kind, amount_irr, percent, max_uses, applies_to, expires_at
       FROM discount_codes WHERE id = ?1`,
  )
    .bind(id)
    .first<{
      code: string;
      kind: string;
      amount_irr: number | null;
      percent: number | null;
      max_uses: number | null;
      applies_to: string;
      expires_at: string | null;
    }>();
}

/**
 * The lookup `apps/bot/src/discount.ts:94` performs, run verbatim.
 *
 * `findCode` uses `LIMIT 1`; this deliberately does not, so the test can see
 * whether the database holds an ambiguity the bot would resolve arbitrarily.
 */
async function rowsTheBotWouldMatch(typed: string): Promise<string[]> {
  const rows = await baseEnv.DB.prepare(`SELECT code FROM discount_codes WHERE lower(code) = ?1`)
    .bind(typed.trim().toLowerCase())
    .all<{ code: string }>();
  return (rows.results ?? []).map((r) => r.code);
}

async function makeUser(): Promise<number> {
  const row = await baseEnv.DB.prepare(
    `INSERT INTO users (telegram_id, username, registered_at) VALUES (?1, ?2, now()) RETURNING id`,
  )
    .bind(TG_BASE + ++seq, `${PREFIX}_user_${seq}`)
    .first<{ id: number }>();
  return Number(row!.id);
}

async function purge(): Promise<void> {
  await baseEnv.DB.prepare(
    `DELETE FROM discount_redemptions WHERE code_id IN
       (SELECT id FROM discount_codes WHERE lower(code) LIKE ?1)`,
  )
    .bind(`${PREFIX}%`)
    .run();
  await baseEnv.DB.prepare(`DELETE FROM discount_codes WHERE lower(code) LIKE ?1`)
    .bind(`${PREFIX}%`)
    .run();
  await deleteFixtureUsers(TG_BASE);
}

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
});

beforeEach(async () => {
  await purge();
  await baseEnv.DB.prepare(`TRUNCATE audit_logs CASCADE`).run();
});

afterAll(purge);

describe('creating a code', () => {
  it('stores it and records who made it', async () => {
    const res = await create(gift(`${PREFIX}welcome`, { maxUses: 10 }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { discount: { id: number; state: string; used: number } };

    const row = (await codeRow(body.discount.id))!;
    expect(row.code).toBe(`${PREFIX}welcome`);
    expect(row.kind).toBe('GIFT_BALANCE');
    expect(Number(row.amount_irr)).toBe(500_000);
    expect(row.max_uses).toBe(10);
    expect(body.discount.used).toBe(0);
    expect(body.discount.state).toBe('USABLE');

    const logs = await baseEnv.DB.prepare(
      `SELECT action, actor_email FROM audit_logs WHERE entity_type = 'DISCOUNT_CODE'`,
    ).all<{ action: string; actor_email: string }>();
    expect(logs.results).toHaveLength(1);
    expect(logs.results![0]!.action).toBe('discount.created');
    expect(logs.results![0]!.actor_email).toBe(ADMIN);
  });

  it('refuses a code that differs only in case, because the bot matches on lower(code)', async () => {
    expect((await create(gift(`${PREFIX}Off15`))).status).toBe(201);

    // Postgres would accept this: the UNIQUE constraint is on the exact text.
    const clash = await create(gift(`${PREFIX}OFF15`));
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as { error: string }).error).toBe('code_exists');

    // The proof that the guard matters: the bot's own lookup finds exactly one
    // row, so there is nothing for it to choose between.
    expect(await rowsTheBotWouldMatch(`${PREFIX}off15`)).toEqual([`${PREFIX}Off15`]);
  });

  it('refuses an exact duplicate before the database has to', async () => {
    expect((await create(gift(`${PREFIX}dup`))).status).toBe(201);
    expect((await create(gift(`${PREFIX}dup`))).status).toBe(409);
  });

  it('refuses a code with a space or a Persian digit in it', async () => {
    // A trailing space is invisible in a Telegram message, and `normalizeCode`
    // only lowercases — it would not fold ۱ onto 1.
    expect((await create(gift(`${PREFIX} sp`))).status).toBe(400);
    expect((await create(gift(`${PREFIX}۱۲۳`))).status).toBe(400);
    expect((await create(gift('ab'))).status).toBe(400);
  });

  it('holds the percent-or-amount rule the table also holds', async () => {
    expect((await create({ code: `${PREFIX}p1`, kind: 'PERCENT_OFF', percent: 15 })).status).toBe(
      201,
    );
    // PERCENT_OFF with no percent
    expect(
      (await create({ code: `${PREFIX}p2`, kind: 'PERCENT_OFF', amountIrr: 1000 })).status,
    ).toBe(400);
    // AMOUNT_OFF with no amount
    expect((await create({ code: `${PREFIX}p3`, kind: 'AMOUNT_OFF', percent: 10 })).status).toBe(
      400,
    );
    // Both at once
    expect(
      (await create({ code: `${PREFIX}p4`, kind: 'PERCENT_OFF', percent: 10, amountIrr: 1000 }))
        .status,
    ).toBe(400);
  });

  it('refuses a percent outside 0 to 100', async () => {
    expect((await create({ code: `${PREFIX}p5`, kind: 'PERCENT_OFF', percent: 0 })).status).toBe(
      400,
    );
    expect((await create({ code: `${PREFIX}p6`, kind: 'PERCENT_OFF', percent: 101 })).status).toBe(
      400,
    );
  });

  it('refuses an amount above the ceiling', async () => {
    expect((await create(gift(`${PREFIX}max`, { amountIrr: MAX_SINGLE_PAYMENT_IRR }))).status).toBe(
      201,
    );
    expect(
      (await create(gift(`${PREFIX}over`, { amountIrr: MAX_SINGLE_PAYMENT_IRR + 1 }))).status,
    ).toBe(400);
  });

  it('refuses to narrow a gift code to a product, panel or action', async () => {
    // A gift credits a wallet; `checkCode` refuses GIFT_BALANCE outright, so
    // these fields would be settings that silently do nothing.
    expect((await create(gift(`${PREFIX}g1`, { appliesTo: 'BUY' }))).status).toBe(400);
    expect((await create(gift(`${PREFIX}g2`, { productId: 1 }))).status).toBe(400);
    expect((await create(gift(`${PREFIX}g3`, { providerId: 1 }))).status).toBe(400);
  });

  it('refuses a product or panel that does not exist', async () => {
    expect(
      (
        await create({
          code: `${PREFIX}np`,
          kind: 'PERCENT_OFF',
          percent: 10,
          productId: 2_000_000_003,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await create({
          code: `${PREFIX}nl`,
          kind: 'PERCENT_OFF',
          percent: 10,
          providerId: 2_000_000_003,
        })
      ).status,
    ).toBe(400);
  });

  it('refuses a field it does not know', async () => {
    expect((await create({ ...gift(`${PREFIX}x`), status: 'ACTIVE' })).status).toBe(400);
  });

  it('is refused for a reviewer', async () => {
    expect((await create(gift(`${PREFIX}rev`), REVIEWER)).status).toBe(403);
    expect(await rowsTheBotWouldMatch(`${PREFIX}rev`)).toEqual([]);
  });
});

describe('the state of a code', () => {
  async function stateOf(code: string): Promise<string> {
    const res = await app.request(`/api/v1/admin/discounts?q=${code}`, {}, envAs(ADMIN));
    const body = (await res.json()) as { items: Array<{ code: string; state: string }> };
    return body.items.find((i) => i.code.toLowerCase() === code.toLowerCase())!.state;
  }

  it('is USABLE, EXPIRED or USED_UP on the same conditions the bot applies', async () => {
    // Usable.
    await create(gift(`${PREFIX}live`, { maxUses: 2 }));
    expect(await stateOf(`${PREFIX}live`)).toBe('USABLE');

    // Expired: the bot's rule is `expires_at <= now`.
    const expiring = await create(gift(`${PREFIX}old`));
    const expId = ((await expiring.json()) as { discount: { id: number } }).discount.id;
    await baseEnv.DB.prepare(
      `UPDATE discount_codes SET expires_at = now() - interval '1 minute' WHERE id = ?1`,
    )
      .bind(expId)
      .run();
    expect(await stateOf(`${PREFIX}old`)).toBe('EXPIRED');

    // Used up: redemptions reach max_uses.
    const limited = await create(gift(`${PREFIX}spent`, { maxUses: 1 }));
    const spentId = ((await limited.json()) as { discount: { id: number } }).discount.id;
    await baseEnv.DB.prepare(
      `INSERT INTO discount_redemptions (code_id, user_id, amount_irr) VALUES (?1, ?2, 0)`,
    )
      .bind(spentId, await makeUser())
      .run();
    expect(await stateOf(`${PREFIX}spent`)).toBe('USED_UP');
  });

  it('counts an unlimited code as usable however many times it has been spent', async () => {
    const res = await create(gift(`${PREFIX}unlimited`));
    const id = ((await res.json()) as { discount: { id: number } }).discount.id;
    for (let i = 0; i < 3; i++) {
      await baseEnv.DB.prepare(
        `INSERT INTO discount_redemptions (code_id, user_id, amount_irr) VALUES (?1, ?2, 0)`,
      )
        .bind(id, await makeUser())
        .run();
    }
    const list = await app.request(
      `/api/v1/admin/discounts?q=${PREFIX}unlimited`,
      {},
      envAs(ADMIN),
    );
    const body = (await list.json()) as { items: Array<{ used: number; state: string }> };
    expect(body.items[0]!.used).toBe(3);
    expect(body.items[0]!.state).toBe('USABLE');
  });
});

describe('retiring a code', () => {
  async function expire(id: number, email = ADMIN) {
    return app.request(`/api/v1/admin/discounts/${id}/expire`, { method: 'POST' }, envAs(email));
  }

  it('expires it instead of deleting it, so the redemptions survive', async () => {
    const res = await create(gift(`${PREFIX}retire`));
    const id = ((await res.json()) as { discount: { id: number } }).discount.id;
    await baseEnv.DB.prepare(
      `INSERT INTO discount_redemptions (code_id, user_id, amount_irr) VALUES (?1, ?2, 500000)`,
    )
      .bind(id, await makeUser())
      .run();

    const out = await expire(id);
    expect(out.status).toBe(200);
    expect(((await out.json()) as { discount: { state: string } }).discount.state).toBe('EXPIRED');

    // The row is still there, and so is the record of who spent it — which is
    // also what stops that customer redeeming it a second time.
    expect(await codeRow(id)).not.toBeNull();
    const kept = await baseEnv.DB.prepare(
      `SELECT COUNT(*)::int AS n FROM discount_redemptions WHERE code_id = ?1`,
    )
      .bind(id)
      .first<{ n: number }>();
    expect(kept!.n).toBe(1);
  });

  it('is a no-op on a code that has already expired, and writes no second audit row', async () => {
    const res = await create(gift(`${PREFIX}twice`));
    const id = ((await res.json()) as { discount: { id: number } }).discount.id;
    await expire(id);
    const again = await expire(id);
    expect(((await again.json()) as { changed: boolean }).changed).toBe(false);

    const logs = await baseEnv.DB.prepare(
      `SELECT COUNT(*)::int AS n FROM audit_logs
        WHERE entity_type = 'DISCOUNT_CODE' AND action = 'discount.expired' AND entity_id = ?1`,
    )
      .bind(String(id))
      .first<{ n: number }>();
    expect(logs!.n).toBe(1);
  });

  it('is refused for a reviewer', async () => {
    const res = await create(gift(`${PREFIX}revexp`));
    const id = ((await res.json()) as { discount: { id: number } }).discount.id;
    expect((await expire(id, REVIEWER)).status).toBe(403);
    expect((await codeRow(id))!.expires_at).toBeNull();
  });

  it('404s on a code that does not exist', async () => {
    expect((await expire(2_000_000_004)).status).toBe(404);
  });
});

describe('GET /api/v1/admin/discounts/:id/redemptions', () => {
  it('names the customers who spent it', async () => {
    const res = await create(gift(`${PREFIX}who`));
    const id = ((await res.json()) as { discount: { id: number } }).discount.id;
    const userId = await makeUser();
    await baseEnv.DB.prepare(
      `INSERT INTO discount_redemptions (code_id, user_id, amount_irr) VALUES (?1, ?2, 500000)`,
    )
      .bind(id, userId)
      .run();

    const out = await app.request(`/api/v1/admin/discounts/${id}/redemptions`, {}, envAs(ADMIN));
    const body = (await out.json()) as {
      items: Array<{ telegramId: number; amountIrr: number }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.amountIrr).toBe(500_000);
    expect(body.items[0]!.telegramId).toBeGreaterThanOrEqual(TG_BASE);
  });
});
