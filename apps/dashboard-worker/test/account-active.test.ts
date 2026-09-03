/**
 * Switching a financial account off, and back on.
 *
 * `active` is not `status`. `status` is the review lifecycle with five routes
 * and a transition table; `active` is the operator's own on/off, written by
 * `POST /accounts/:id/deactivate` in one direction and by `PATCH /accounts/:id`
 * in the other.
 *
 * The second direction did not work. `financial_accounts.active` is
 * `smallint NOT NULL CHECK (active IN (0,1))` and `AccountUpdate` declares
 * `active: z.boolean()`; the PATCH builder pushed the raw JS boolean and
 * `values.push(v as string | number | null)` made the compiler believe that was
 * a number. node-postgres serialised `true` as the text 'true', Postgres
 * answered 22P02, and the route — which catches only 23505 — returned 500
 * `update_failed` with the row untouched.
 *
 * Nothing caught it because nothing PATCHed `active` through the route: every
 * fixture writes the column with a literal, and the money e2e undoes a
 * deactivation with raw SQL rather than the API. So these tests go through
 * `app.request` and then read the COLUMN back, which is the only arrangement
 * that could have failed.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-active@example.com';
const READER = 'reader-active@example.com';
const PREFIX = 'zz-active-';

function envAs(email = ADMIN) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

async function makeAccount(id: string, opts: { active?: 0 | 1; hint?: string | null } = {}) {
  await baseEnv.DB.prepare(
    `INSERT INTO financial_accounts
       (id, bank_name, display_name, account_type, account_hint,
        active, parser_configuration, status, created_at, updated_at)
     VALUES (?1, 'BANK', ?2, 'ACCOUNT', ?3, ?4, '{}', 'ACTIVE', 1, 1)`,
  )
    .bind(id, `حساب ${id}`, opts.hint ?? null, opts.active ?? 0)
    .run();
}

async function activeOf(id: string): Promise<number | null> {
  const row = await baseEnv.DB.prepare(`SELECT active FROM financial_accounts WHERE id = ?1`)
    .bind(id)
    .first<{ active: number }>();
  return row === null ? null : Number(row.active);
}

function patch(id: string, body: unknown, email = ADMIN) {
  return app.request(
    `/api/v1/accounts/${id}`,
    { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    envAs(email),
  );
}

beforeAll(async () => {
  await applySchema();
  const now = Date.now();
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
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
  await baseEnv.DB.prepare(`DELETE FROM financial_accounts WHERE id LIKE ?1`)
    .bind(`${PREFIX}%`)
    .run();
});

describe('turning an account back on', () => {
  it('accepts a JSON boolean and writes the smallint', async () => {
    // THE regression. A JS `true` reaching a smallint column is 22P02, and the
    // route reported it as 500 `update_failed`.
    const id = `${PREFIX}off`;
    await makeAccount(id, { active: 0 });

    const res = await patch(id, { active: true });

    expect(res.status).toBe(200);
    // The column, not the response. The response said `{ok:true}` for the
    // fields that DID bind even while this one failed the whole statement.
    expect(await activeOf(id)).toBe(1);
  });

  it('switches one off the same way', async () => {
    const id = `${PREFIX}on`;
    await makeAccount(id, { active: 1 });

    expect((await patch(id, { active: false })).status).toBe(200);
    expect(await activeOf(id)).toBe(0);
  });

  it('survives the round trip an operator actually makes', async () => {
    // «غیرفعال‌کردن» on the screen, then «فعال‌کردن». Two different routes, and
    // the pair is what Sam could not complete on 2026-09-03.
    const id = `${PREFIX}trip`;
    await makeAccount(id, { active: 1 });

    const off = await app.request(`/api/v1/accounts/${id}/deactivate`, { method: 'POST' }, envAs());
    expect(off.status).toBe(200);
    expect(await activeOf(id)).toBe(0);

    expect((await patch(id, { active: true })).status).toBe(200);
    expect(await activeOf(id)).toBe(1);
  });

  it('still writes the other fields beside it', async () => {
    // The coercion must not eat anything else in the body.
    const id = `${PREFIX}both`;
    await makeAccount(id, { active: 0 });

    expect((await patch(id, { active: true, display_name: 'نام تازه' })).status).toBe(200);

    const row = await baseEnv.DB.prepare(
      `SELECT active, display_name FROM financial_accounts WHERE id = ?1`,
    )
      .bind(id)
      .first<{ active: number; display_name: string }>();
    expect(Number(row?.active)).toBe(1);
    expect(row?.display_name).toBe('نام تازه');
  });

  /**
   * Reactivating can legitimately collide, and it must say so rather than 500.
   *
   * `idx_fa_unique_active_account_hint` is partial — `WHERE account_hint IS NOT
   * NULL AND active = 1` — so an identifier freed by switching one account off
   * can be claimed by another. Turning the first back on then has two accounts
   * answering to one hint, which is exactly what that index refuses.
   *
   * Unreachable until reactivation worked at all, which is why it is asserted
   * in the same change.
   */
  it('answers 409 when the identifier was taken while it was off', async () => {
    const off = `${PREFIX}dupe-off`;
    const live = `${PREFIX}dupe-live`;
    await makeAccount(off, { active: 0, hint: '9001' });
    await makeAccount(live, { active: 1, hint: '9001' });

    const res = await patch(off, { active: true });

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'ACCOUNT_IDENTIFIER_AMBIGUOUS',
    });
    expect(await activeOf(off)).toBe(0);
  });

  it('is not a reader’s decision', async () => {
    const id = `${PREFIX}role`;
    await makeAccount(id, { active: 0 });

    expect((await patch(id, { active: true }, READER)).status).toBe(403);
    expect(await activeOf(id)).toBe(0);
  });
});
