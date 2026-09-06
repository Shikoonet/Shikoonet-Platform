/**
 * «پاک کردن دیتای فروشگاه» — the panel's route onto `reset.ts`.
 *
 * The engine has its own suite in `packages/migrate/test/reset.test.ts`, which
 * asks Postgres directly about the KEEP set, the CASCADE trap, `RESTART
 * IDENTITY` and the undo recordings. Re-asserting any of that from here would
 * only prove that two files agree.
 *
 * What is unproven and lives here is the route's own judgement: who may ask,
 * what the typed confirmation is compared against, that a running import wins,
 * and that a refusal really refuses — asserted by counting rows rather than by
 * reading the answer the route gives about itself.
 *
 * ## One test in this file commits a reset
 *
 * It has to: «نباید ارور بده» is the whole feature, and a rollback-only test
 * would prove the statement parsed. Vitest runs these files one at a time
 * (`fileParallelism: false`) and every file builds its own fixtures in its own
 * `beforeAll`, so an emptied database is what the next file expects anyway.
 * `access_users` is in KEEP, so this file's own operators survive their own
 * reset — which is exactly the property the KEEP set exists for.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-reset@example.com';
const REVIEWER = 'reviewer-reset@example.com';

/** What `helpers/env.ts` boots this worker as. The route compares against it. */
const ENV_NAME = 'test';

function envAs(email: string, overrides: Record<string, unknown> = {}) {
  return { ...baseEnv, TEST_ACCESS_USER: email, ...overrides };
}

async function post(body: unknown, env: Record<string, unknown>) {
  return app.request(
    '/api/v1/admin/import/reset',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env,
  );
}

async function count(table: string): Promise<number> {
  const row = await baseEnv.DB.prepare(`SELECT count(*)::bigint AS n FROM "${table}"`).first<{
    n: number;
  }>();
  return Number(row!.n);
}

/** A customer nobody else in this file cares about, so a refusal is visible. */
async function customer(telegramId: number): Promise<void> {
  await baseEnv.DB.prepare(
    `INSERT INTO users (telegram_id, status, registered_at) VALUES (?1, 'ACTIVE', now())`,
  )
    .bind(telegramId)
    .run();
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
  await baseEnv.DB.prepare(`DELETE FROM import_runs`).run();
});

describe('who may empty a shop', () => {
  it('refuses a reviewer, and removes nothing', async () => {
    await customer(991_100_001);
    const before = await count('users');

    const res = await post({ confirm: ENV_NAME }, envAs(REVIEWER));

    expect(res.status).toBe(403);
    // The status is the claim; this is the check. A 403 that truncated anyway
    // is the only failure worth writing this test for.
    expect(await count('users')).toBe(before);
  });

  it('refuses a reviewer the preview too', async () => {
    // Read-only, but the answer is a census of the whole shop.
    const res = await app.request('/api/v1/admin/import/reset/preview', {}, envAs(REVIEWER));
    expect(res.status).toBe(403);
  });
});

describe('the typed confirmation', () => {
  it('refuses a phrase that is not this environment name', async () => {
    await customer(991_100_002);
    const before = await count('users');

    const res = await post({ confirm: 'production' }, envAs(ADMIN));

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('wrong_confirmation');
    expect(await count('users')).toBe(before);
  });

  it('refuses a body with no phrase at all', async () => {
    const res = await post({}, envAs(ADMIN));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
  });

  it('refuses a field nobody has considered', async () => {
    // `.strict()`, on the one route where being quietly ignored would matter
    // most: a `force: true` that the server drops without saying so reads to
    // the caller like a `force: true` that worked.
    const res = await post({ confirm: ENV_NAME, force: true }, envAs(ADMIN));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
  });

  it('compares against the server, not against the browser', async () => {
    /**
     * The point of the whole confirmation, and the one thing a test can say
     * about it that reading the code cannot.
     *
     * The phrase is checked against `ENV_NAME` as this worker was booted with
     * — `server.ts` reads it once through `parseEnvName`. Here the boot says
     * `local`, the caller types the `test` the rest of this file uses, and it
     * is refused. Which is the lesson CLAUDE.md records: a uuid in a notes
     * file said «dashboard» and was production.
     *
     * `local` rather than `production` for the mismatch, and the reason is
     * itself a guard: `TEST_ACCESS_USER` is refused outside a relaxed
     * environment, so booting this as production would have answered 403 and
     * proved the login bypass rather than the confirmation.
     */
    await customer(991_100_003);
    const before = await count('users');

    const res = await post({ confirm: 'test' }, envAs(ADMIN, { ENV_NAME: 'local' }));

    expect(res.status).toBe(400);
    expect(await count('users')).toBe(before);
  });
});

describe('while an import is running', () => {
  it('refuses, rather than truncating the tables it is writing to', async () => {
    await customer(991_100_004);
    const before = await count('users');
    await baseEnv.DB.prepare(
      `INSERT INTO import_runs (id, mode, status, dump_path, started_by)
            VALUES (?1, 'APPLY', 'RUNNING', '/tmp/__reset.sql', ?2)`,
    )
      .bind(crypto.randomUUID(), ADMIN)
      .run();

    const res = await post({ confirm: ENV_NAME }, envAs(ADMIN));

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('import_already_running');
    expect(await count('users')).toBe(before);
  });
});

describe('the preview', () => {
  it('counts the shop without touching it', async () => {
    await customer(991_100_005);
    const before = await count('users');

    const res = await app.request('/api/v1/admin/import/reset/preview', {}, envAs(ADMIN));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      wipe: { table: string; rows: number }[];
      keep: { table: string; rows: number }[];
      total: number;
    };
    expect(body.wipe.find((t) => t.table === 'users')?.rows).toBe(before);
    expect(body.keep.some((t) => t.table === 'access_users')).toBe(true);
    expect(body.total).toBeGreaterThan(0);
    expect(await count('users')).toBe(before);
  });

  it('does not tell the caller which environment this is', async () => {
    // The confirmation would be worth nothing if the screen could read the
    // answer off the preview it just fetched.
    const res = await app.request('/api/v1/admin/import/reset/preview', {}, envAs(ADMIN));
    expect(JSON.stringify(await res.json())).not.toContain(ENV_NAME);
  });
});

describe('the reset itself', () => {
  it('empties the shop, keeps the panel, and writes one audit row', async () => {
    await customer(991_100_006);
    expect(await count('users')).toBeGreaterThan(0);
    const operators = await count('access_users');

    const res = await post({ confirm: ENV_NAME }, envAs(ADMIN));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      total: number;
      removed: { table: string; rows: number }[];
    };
    expect(body.ok).toBe(true);
    expect(body.removed.some((t) => t.table === 'users')).toBe(true);

    // Asked of the database, not of the answer above.
    expect(await count('users')).toBe(0);
    // …and the operators who pressed the button are still operators. Without
    // this the panel answers 403 to the person who just used it.
    expect(await count('access_users')).toBe(operators);

    const audits = await baseEnv.DB.prepare(
      `SELECT actor_email, entity_id, after_json FROM audit_logs WHERE action = 'import.reset'`,
    ).all<{ actor_email: string; entity_id: string; after_json: string }>();
    // Exactly one, and it is the first row in a log this reset just emptied —
    // written after the COMMIT for that reason.
    expect(audits.results).toHaveLength(1);
    expect(audits.results?.[0]?.actor_email).toBe(ADMIN);
    expect(audits.results?.[0]?.entity_id).toBe(ENV_NAME);
    expect(audits.results?.[0]?.after_json).toContain('users');
  });
});
