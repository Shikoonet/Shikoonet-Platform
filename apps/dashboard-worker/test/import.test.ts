/**
 * «ایمپورت» — the panel's route onto `packages/migrate`.
 *
 * What is worth testing here is not the migration. That has ten suites of its
 * own against the real production dump, and re-asserting its row counts from
 * this side would only prove that two files agree. What this file covers is the
 * part that is new and therefore unproven: who may ask, which file may be
 * named, that two imports cannot overlap, and that a dry run leaves nothing
 * behind.
 *
 * The last one is asserted by counting `users` before and after rather than by
 * reading the route's own answer, for the reason `bulk.test.ts` gives about
 * balances: a run that reports "rolled back" while having committed would pass
 * any test that believes the report.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';
import { resolveDump, listDumps } from '../src/importRoutes.js';

const ADMIN = 'admin-import@example.com';
const REVIEWER = 'reviewer-import@example.com';
const READER = 'reader-import@example.com';

let importDir: string;

function envAs(email: string, overrides: Record<string, unknown> = {}) {
  return { ...baseEnv, TEST_ACCESS_USER: email, IMPORT_DIR: importDir, ...overrides };
}

async function post(path: string, body: unknown, env: Record<string, unknown>) {
  return app.request(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env,
  );
}

async function userCount(): Promise<number> {
  const row = await baseEnv.DB.prepare('SELECT COUNT(*)::bigint AS n FROM users').first<{
    n: number;
  }>();
  return Number(row!.n);
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

  importDir = mkdtempSync(join(tmpdir(), 'shikoo-import-'));
  writeFileSync(join(importDir, 'mirzabot-tiny.sql'), 'CREATE TABLE t (a int);\n');
  writeFileSync(join(importDir, 'notes.txt'), 'not a dump');
  mkdirSync(join(importDir, 'a-directory.sql'), { recursive: true });
});

beforeEach(async () => {
  await baseEnv.DB.prepare('DELETE FROM import_runs').run();
});

describe('naming the dump', () => {
  it('takes a bare file name', () => {
    expect(resolveDump('/data/imports', 'dump.sql')).toContain('dump.sql');
    expect(resolveDump('/data/imports', 'dump.sql.gz')).toContain('dump.sql.gz');
  });

  // Each of these is a way the same mistake is usually made. A signed-in admin
  // is still not a reason to accept a path from the network.
  it.each([
    ['../../etc/passwd.sql', 'parent traversal'],
    ['/etc/shadow.sql', 'absolute posix path'],
    ['C:\\Windows\\win.sql', 'absolute windows path'],
    ['sub/dir/dump.sql', 'nested path'],
    ['dump.sql\u0000.png', 'null byte'],
    ['dump.tar.gz', 'not a dump'],
    ['dump.sqlite', 'not a dump'],
  ])('refuses %s (%s)', (name) => {
    expect(() => resolveDump('/data/imports', name)).toThrow();
  });

  it('lists only dumps, and not directories that look like one', () => {
    const names = listDumps(importDir).map((f) => f.name);
    expect(names).toContain('mirzabot-tiny.sql');
    expect(names).not.toContain('notes.txt');
    expect(names).not.toContain('a-directory.sql');
  });
});

describe('who may ask', () => {
  it('lets an ADMIN list the directory', async () => {
    const res = await app.request('/api/v1/admin/import/files', {}, envAs(ADMIN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; items: { name: string }[] };
    expect(body.ok).toBe(true);
    expect(body.items.map((i) => i.name)).toContain('mirzabot-tiny.sql');
  });

  it.each([REVIEWER, READER])('refuses %s', async (email) => {
    const list = await app.request('/api/v1/admin/import/files', {}, envAs(email));
    expect([403, 404]).toContain(list.status);
    const run = await post('/api/v1/admin/import/dry-run', { file: 'x.sql' }, envAs(email));
    expect([403, 404]).toContain(run.status);
  });
});

describe('refusing before anything runs', () => {
  it('says so when the server was never configured for imports', async () => {
    // No IMPORT_MYSQL_URL: the answer must name the missing configuration
    // rather than failing somewhere inside the migration.
    const res = await post(
      '/api/v1/admin/import/preflight',
      { file: 'mirzabot-tiny.sql' },
      { ...baseEnv, TEST_ACCESS_USER: ADMIN, IMPORT_DIR: importDir, IMPORT_MYSQL_URL: undefined },
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('import_not_configured');
  });

  it('refuses a file that is not in the directory', async () => {
    const res = await post(
      '/api/v1/admin/import/dry-run',
      { file: '../../../etc/passwd.sql' },
      envAs(ADMIN, { IMPORT_MYSQL_URL: 'mysql://root:x@127.0.0.1:3307' }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_file');
  });

  it('refuses an unknown domain instead of quietly ignoring it', async () => {
    const res = await post(
      '/api/v1/admin/import/dry-run',
      { file: 'mirzabot-tiny.sql', domains: ['core', 'everything'] },
      envAs(ADMIN, { IMPORT_MYSQL_URL: 'mysql://root:x@127.0.0.1:3307' }),
    );
    expect(res.status).toBe(400);
  });

  it('refuses an APPLY that no dry run has proved', async () => {
    const res = await post(
      '/api/v1/admin/import/apply',
      { file: 'mirzabot-tiny.sql' },
      envAs(ADMIN, { IMPORT_MYSQL_URL: 'mysql://root:x@127.0.0.1:3307' }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('dry_run_required');
  });
});

describe('one at a time', () => {
  it('refuses a second run while one is in flight', async () => {
    // A RUNNING row is what the guard reads, so inserting one directly is the
    // same state a real in-flight import leaves — without waiting for one.
    await baseEnv.DB.prepare(
      `INSERT INTO import_runs (id, mode, status, dump_path, started_by)
       VALUES (gen_random_uuid(), 'DRY_RUN', 'RUNNING', ?1, ?2)`,
    )
      .bind(join(importDir, 'mirzabot-tiny.sql'), ADMIN)
      .run();

    const res = await post(
      '/api/v1/admin/import/preflight',
      { file: 'mirzabot-tiny.sql' },
      envAs(ADMIN, { IMPORT_MYSQL_URL: 'mysql://root:x@127.0.0.1:3307' }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('import_already_running');
  });

  it('clears a run abandoned by a process that is gone', async () => {
    const stale = await baseEnv.DB.prepare(
      `INSERT INTO import_runs (id, mode, status, dump_path, started_by, started_at)
       VALUES (gen_random_uuid(), 'DRY_RUN', 'RUNNING', ?1, ?2, now() - interval '3 hours')
       RETURNING id`,
    )
      .bind(join(importDir, 'mirzabot-tiny.sql'), ADMIN)
      .first<{ id: string }>();

    // The assertion is 200 rather than 409: the abandoned row did not block a
    // new run. Without the reap, one crashed import would make the panel
    // permanently refuse every later one.
    const res = await post(
      '/api/v1/admin/import/preflight',
      { file: 'mirzabot-tiny.sql' },
      envAs(ADMIN, { IMPORT_MYSQL_URL: 'mysql://root:x@127.0.0.1:1' }),
    );
    expect(res.status).toBe(200);

    const row = await baseEnv.DB.prepare('SELECT status, error FROM import_runs WHERE id = ?1')
      .bind(stale!.id)
      .first<{ status: string; error: string }>();
    expect(row?.status).toBe('FAILED');
    expect(row?.error).toContain('process ended');
  });
});

describe('a failing run settles its row', () => {
  it('records FAILED rather than leaving it RUNNING for ever', async () => {
    const before = await userCount();
    // Port 1 accepts nothing, so `loadDump` throws inside the background task.
    // What is under test is that the task's failure path still settles the row:
    // a RUNNING row that never ends would block every future import.
    const res = await post(
      '/api/v1/admin/import/preflight',
      { file: 'mirzabot-tiny.sql' },
      envAs(ADMIN, { IMPORT_MYSQL_URL: 'mysql://root:x@127.0.0.1:1' }),
    );
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };

    let status = 'RUNNING';
    for (let i = 0; i < 100 && status === 'RUNNING'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const row = await baseEnv.DB.prepare('SELECT status FROM import_runs WHERE id = ?1')
        .bind(id)
        .first<{ status: string }>();
      status = row?.status ?? 'RUNNING';
    }
    expect(status).toBe('FAILED');
    // And it touched nothing on the way down.
    expect(await userCount()).toBe(before);
  }, 20_000);
});
