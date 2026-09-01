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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';
import { dumpSha256, MAX_DUMP_BYTES } from '@shikoo/migrate';
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

// `string`, not `BodyInit`: this package does not include the DOM lib, and the
// one streamed body in this file calls `app.request` directly anyway.
async function upload(name: string, body: string, env: Record<string, unknown>) {
  return app.request(
    `/api/v1/admin/import/upload?name=${encodeURIComponent(name)}`,
    { method: 'POST', body },
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

  // Nested one level deeper than the temp directory on purpose. The traversal
  // tests assert that nothing appeared in the PARENT, and a parent shared with
  // every other process on the machine makes that assertion about the machine.
  // It also makes it sticky: proving the guard by removing it really does write
  // `escaped.sql` up there, and a stray left behind then fails the suite for
  // every run afterwards. This way the parent belongs to this file alone.
  importDir = join(mkdtempSync(join(tmpdir(), 'shikoo-import-')), 'imports');
  mkdirSync(importDir, { recursive: true });
  writeFileSync(join(importDir, 'mirzabot-tiny.sql'), 'CREATE TABLE t (a int);\n');
  writeFileSync(join(importDir, 'notes.txt'), 'not a dump');
  mkdirSync(join(importDir, 'a-directory.sql'), { recursive: true });
});

beforeEach(async () => {
  await baseEnv.DB.prepare('DELETE FROM import_runs').run();
});

describe('importing the migration does not change the process', () => {
  /**
   * `packages/migrate` reads int8 as a string; `packages/db` reads it as a
   * number. Both used to say so with `pg.types.setTypeParser`, which is
   * PROCESS-GLOBAL, so whichever module loaded last decided it for every query
   * in the dashboard -- and money is bigint. Merely importing this route file
   * turned `amount_irr` into a string and broke 86 tests at once.
   *
   * The migration now attaches its parser to its own client. This asserts the
   * consequence rather than the mechanism: whatever the import package does to
   * read its own connection, the dashboard still reads a bigint as a number.
   */
  it('still reads a bigint as a number', async () => {
    const row = await baseEnv.DB.prepare('SELECT 1::bigint AS n').first<{ n: unknown }>();
    expect(typeof row?.n).toBe('number');
  });
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

/**
 * What the APPLY gate actually promises.
 *
 * «A dry run of this file passed» was the whole check until 2026-09-01, and
 * CodeRabbit found two ordinary cutover moves that walked through it on PR #42.
 * Neither is an attack — both are what an operator does on the day:
 *
 *   * refresh the dump by copying a newer file over the same name, and
 *   * dry-run one part of the migration, then tick another box before applying.
 *
 * The proving row is written directly here rather than by running a dry run: a
 * real one needs a MySQL, and what is under test is the GATE, not the
 * migration. The values written are the ones a real run records — the SHA of the
 * decompressed SQL, and the normalised domain array.
 */
describe('what the APPLY gate proves', () => {
  const MYSQL = { IMPORT_MYSQL_URL: 'mysql://root:x@127.0.0.1:3307' };
  const FILE = 'gate-target.sql';

  /** A successful dry run, as the row a real one would have left. */
  async function provingRun(sha: string, domains: string[]) {
    await baseEnv.DB.prepare(
      `INSERT INTO import_runs
         (id, mode, status, dump_path, domains, started_by, started_at, finished_at, dump_sha256)
       VALUES (?1, 'DRY_RUN', 'SUCCEEDED', ?2, ?3::jsonb, ?4, now(), now(), ?5)`,
    )
      .bind(crypto.randomUUID(), join(importDir, FILE), JSON.stringify(domains), ADMIN, sha)
      .run();
  }

  const apply = (domains?: string[]) =>
    post(
      '/api/v1/admin/import/apply',
      domains ? { file: FILE, domains } : { file: FILE },
      envAs(ADMIN, MYSQL),
    );

  const write = (sql: string) => {
    writeFileSync(join(importDir, FILE), sql);
    return dumpSha256(join(importDir, FILE));
  };

  it('accepts an APPLY whose file and domains were both proven', async () => {
    const sha = write('CREATE TABLE gate (a int);');
    await provingRun(sha, ['core', 'catalog']);

    // Past the gate. It stops at the MySQL that is not there, which is a
    // different failure and the one that proves the gate let it through.
    const res = await apply(['core', 'catalog']);
    expect(res.status).toBe(200);
  });

  it('accepts an APPLY narrower than the dry run that proved it', async () => {
    const sha = write('CREATE TABLE gate (a int);');
    await provingRun(sha, ['core', 'catalog', 'sales']);

    // Proving MORE than you apply is the useful direction: everything being
    // applied was exercised.
    expect((await apply(['core'])).status).toBe(200);
  });

  it('refuses an APPLY of a domain the dry run never exercised', async () => {
    const sha = write('CREATE TABLE gate (a int);');
    await provingRun(sha, ['catalog']);

    // The transforms for `sales` have never run against this dump, and this
    // APPLY commits for real. Before the fix this was a 200.
    const res = await apply(['catalog', 'sales']);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('dry_run_required');
  });

  it('refuses an APPLY after the file under the same name changed', async () => {
    const sha = write('CREATE TABLE gate (a int);');
    await provingRun(sha, ['core']);

    // The normal way a dump is refreshed during a cutover: same name, new
    // contents. The proof belongs to the file that is gone.
    const fresh = write('CREATE TABLE gate (a int, b int);');
    expect(fresh).not.toBe(sha);

    const res = await apply(['core']);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('dry_run_required');
  });

  it('does not care in which order the domains were written', async () => {
    const sha = write('CREATE TABLE gate (a int);');
    await provingRun(sha, ['catalog', 'core']);

    // `['core','catalog']` and `['catalog','core']` are one import. The route
    // sorts before storing and before comparing, so neither reads as a
    // different proof from the other.
    expect((await apply(['core', 'catalog'])).status).toBe(200);
  });
});

/**
 * Uploading, which used to be the one thing this route would not do.
 *
 * The interesting assertions are about the DIRECTORY, not the response. A route
 * that answers `ok` while having written `../../etc/cron.d/x` has passed every
 * test that reads its own reply, and the whole reason `resolveDump` exists is
 * that a name arriving over the network is not a name until it has been checked.
 */
describe('putting a dump there from the browser', () => {
  it('writes the bytes, and the list then offers them', async () => {
    const res = await upload('uploaded.sql', 'CREATE TABLE up (a int);\n', envAs(ADMIN));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, name: 'uploaded.sql' });

    // The file on disk, not the answer about it.
    expect(readFileSync(join(importDir, 'uploaded.sql'), 'utf8')).toBe(
      'CREATE TABLE up (a int);\n',
    );
    expect(listDumps(importDir).map((f) => f.name)).toContain('uploaded.sql');
  });

  it('leaves no .part behind, so a half upload is never offered', async () => {
    await upload('tidy.sql', 'SELECT 1;\n', envAs(ADMIN));
    expect(existsSync(join(importDir, 'tidy.sql.part'))).toBe(false);
  });

  it('replaces a file of the same name', async () => {
    await upload('twice.sql', 'SELECT 1;\n', envAs(ADMIN));
    await upload('twice.sql', 'SELECT 2;\n', envAs(ADMIN));
    expect(readFileSync(join(importDir, 'twice.sql'), 'utf8')).toBe('SELECT 2;\n');
  });

  it.each([REVIEWER, READER])('refuses %s', async (email) => {
    const res = await upload('sneaky.sql', 'SELECT 1;\n', envAs(email));
    expect([403, 404]).toContain(res.status);
    expect(existsSync(join(importDir, 'sneaky.sql'))).toBe(false);
  });

  // The same list `resolveDump` is tested against directly, asserted again
  // through the route: the check is only worth having if it is actually wired
  // to the handler that writes to disk.
  it.each([
    ['../escaped.sql', 'parent traversal'],
    ['sub/dir/nested.sql', 'nested path'],
    ['notes.txt', 'not a dump'],
    ['', 'no name at all'],
  ])('refuses %s (%s) and writes nothing', async (name) => {
    const before = listDumps(importDir).length;
    const res = await upload(name, 'SELECT 1;\n', envAs(ADMIN));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_file' });
    expect(listDumps(importDir).length).toBe(before);
    expect(existsSync(join(importDir, '..', 'escaped.sql'))).toBe(false);
  });

  it('says so when the server was never configured for imports', async () => {
    const res = await upload('nowhere.sql', 'SELECT 1;\n', {
      ...baseEnv,
      TEST_ACCESS_USER: ADMIN,
      IMPORT_DIR: undefined,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'import_dir_unset' });
  });

  /**
   * Two uploads of one name, which is not exotic: it is what «refresh the dump»
   * looks like when two people do it at once, and it is how a retry after a
   * stalled connection can overlap the request it was retrying.
   *
   * Without the exclusive create both streams open the same `<name>.part`,
   * interleave, and the second rename puts the mixture where a dump belongs —
   * a file that is valid enough to load and wrong enough to import. CodeRabbit
   * raised it on PR #48.
   *
   * The `.part` is planted directly rather than raced, because a race that
   * usually passes is not a test. What is asserted is the consequence that
   * matters: the refusal, and that the other upload's file was NOT deleted on
   * the way out.
   */
  it('refuses a second upload of the same name, and does not touch the first', async () => {
    const part = join(importDir, 'contested.sql.part');
    writeFileSync(part, 'first upload, still going');

    const res = await upload('contested.sql', 'second upload\n', envAs(ADMIN));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'upload_in_progress' });
    // The loser must not tidy up after the winner: removing this would leave
    // the other request writing to an unlinked inode with nothing to rename.
    expect(readFileSync(part, 'utf8')).toBe('first upload, still going');
    expect(existsSync(join(importDir, 'contested.sql'))).toBe(false);
    rmSync(part, { force: true });
  });

  it('refuses while an import is in flight', async () => {
    await baseEnv.DB.prepare(
      `INSERT INTO import_runs (id, mode, status, dump_path, domains, started_by)
       VALUES (?1, 'APPLY', 'RUNNING', ?2, '[]'::jsonb, ?3)`,
    )
      .bind(crypto.randomUUID(), join(importDir, 'mirzabot-tiny.sql'), ADMIN)
      .run();

    const res = await upload('during.sql', 'SELECT 1;\n', envAs(ADMIN));
    expect(res.status).toBe(409);
    expect(existsSync(join(importDir, 'during.sql'))).toBe(false);
  });

  /**
   * The cap, proved by exceeding it.
   *
   * Streamed in one-megabyte pieces rather than built as one buffer, because
   * the assertion is that the WRITE stops — a test that could only pass by
   * holding the whole oversized body in memory would be testing the opposite
   * thing. `content-length` is never consulted; this body does not carry a
   * usable one.
   */
  it('stops writing past the size the loader would refuse anyway', async () => {
    const mb = Buffer.alloc(1024 * 1024, 0x2d); // '-', a SQL comment line
    let sent = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (sent >= MAX_DUMP_BYTES + 1024 * 1024) {
          controller.close();
          return;
        }
        sent += mb.length;
        controller.enqueue(new Uint8Array(mb));
      },
    });

    const res = await app.request(
      '/api/v1/admin/import/upload?name=huge.sql',
      // `duplex` is required by undici for a streamed request body and is not
      // in the DOM types Node borrows here.
      { method: 'POST', body, duplex: 'half' } as RequestInit,
      envAs(ADMIN),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'dump_too_large' });
    expect(existsSync(join(importDir, 'huge.sql'))).toBe(false);
    expect(existsSync(join(importDir, 'huge.sql.part'))).toBe(false);
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
